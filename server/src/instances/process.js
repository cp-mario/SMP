import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";
import { getSetting } from "../core/db.js";
import { JAVA_DIR, serverFilesDir, isValidServerId } from "../core/config.js";
import { logLine, clearLogs, flushLogs } from "../core/logs.js";
import { getServerRow, setServerPid, readServerEula, writeServerEula, ensureServerDir } from "./servers.js";
import { parseExec, execFileAsync } from "../core/util.js";
import { getLoader } from "../loaders/index.js";
import { resolveJavaForServer } from "../runtime/java.js";
import { checkServerStartupPorts, serverPortsStatus, formatPortConflict } from "../runtime/ports.js";
import { startPortGuard, stopPortGuard } from "../runtime/portGuard.js";

export const runningServers = new Map();

function isRunning(id) {
  const r = runningServers.get(id);
  return !!(r && r.proc && r.proc.exitCode == null && !r.proc.killed);
}

/**
 * Gracefully stops a running server: "stop" on stdin, then SIGTERM/SIGKILL.
 * Returns true when a process was actually stopped.
 */
async function stopServerProcess(id, { timeoutMs = 12000 } = {}) {
  const r = runningServers.get(id);
  const proc = r?.proc;
  if (!proc || proc.exitCode != null) {
    setServerPid(id, null);
    return false;
  }
  stopPortGuard(id);
  logLine(id, "Stopping...");
  try { proc.stdin?.write("stop\n"); } catch {}
  const exited = await new Promise((resolveStop) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveStop(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once("close", () => finish(true));
    if (proc.exitCode != null) finish(true);
  });
  if (!exited) {
    try { proc.kill("SIGTERM"); } catch {}
    await new Promise((resolveStop) => setTimeout(resolveStop, 2000));
    if (proc.exitCode == null) try { proc.kill("SIGKILL"); } catch {}
  }
  runningServers.delete(id);
  setServerPid(id, null);
  return true;
}

/**
 * Kills the server process immediately. No graceful "stop" command is sent, so
 * the world may be left mid-save: callers must warn the user first.
 * Returns true when the process was actually terminated.
 */
async function forceStopServerProcess(id) {
  const r = runningServers.get(id);
  const proc = r?.proc;
  if (!proc || proc.exitCode != null) {
    runningServers.delete(id);
    setServerPid(id, null);
    return false;
  }
  const pid = proc.pid;
  stopPortGuard(id);
  logLine(id, "Force stopping: killing the process immediately...");
  if (process.platform === "win32" && pid) {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
    } catch {
      try { proc.kill("SIGKILL"); } catch {}
    }
  } else {
    // Kill wrapper children first, then the direct child (Java is usually direct).
    if (pid) { try { await execFileAsync("pkill", ["-9", "-P", String(pid)], { timeout: 5000 }); } catch {} }
    try { proc.kill("SIGKILL"); } catch {}
  }

  const exited = await new Promise((resolveStop) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveStop(value);
    };
    const timer = setTimeout(() => finish(proc.exitCode == null), 5000);
    proc.once("close", () => finish(true));
    if (proc.exitCode != null) finish(true);
  });

  if (!exited) {
    try { proc.kill("SIGKILL"); } catch {}
    await new Promise((resolveStop) => setTimeout(resolveStop, 1500));
  }
  const killed = proc.exitCode != null;
  runningServers.delete(id);
  if (pid) procUsageSamples.delete(pid);
  setServerPid(id, null);
  if (!killed) logLine(id, "Force stop: the process is still running (check system permissions).");
  return killed;
}

// CPU% needs two samples: keep the previous reading per process id.
const procUsageSamples = new Map();

function parsePsTime(value) {
  const m = String(value || "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
}

// PowerShell 7 starts much faster than Windows PowerShell (fallback when FFI is unavailable).
let winPsExe = null;
function windowsPowerShell() {
  if (winPsExe) return winPsExe;
  try {
    const pwsh = join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    if (existsSync(pwsh)) { winPsExe = pwsh; return winPsExe; }
  } catch { /* fall back */ }
  winPsExe = "powershell.exe";
  return winPsExe;
}

// Windows: read the process counters through Bun FFI. No child process is spawned,
// so 1 s polling stays cheap. Falls back to PowerShell when FFI is unavailable.
let winApi;
async function getWinApi() {
  if (winApi !== undefined) return winApi;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    const psapi = dlopen("psapi.dll", {
      GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    winApi = { kernel32, psapi, ptr };
  } catch {
    winApi = null;
  }
  return winApi;
}

function readWinProcessUsage(api, pid) {
  const { kernel32, psapi, ptr } = api;
  const handle = kernel32.symbols.OpenProcess(0x1010, 0, pid); // QUERY_LIMITED_INFORMATION | VM_READ
  if (!handle) return null;
  try {
    const creation = new BigUint64Array(1);
    const exit = new BigUint64Array(1);
    const kernel = new BigUint64Array(1);
    const user = new BigUint64Array(1);
    if (!kernel32.symbols.GetProcessTimes(handle, ptr(creation), ptr(exit), ptr(kernel), ptr(user))) return null;
    const is64 = process.arch === "x64" || process.arch === "arm64";
    const counters = new Uint8Array(is64 ? 80 : 44);
    new DataView(counters.buffer).setUint32(0, counters.length, true);
    if (!psapi.symbols.GetProcessMemoryInfo(handle, ptr(counters), counters.length)) return null;
    const workingSet = Number(new DataView(counters.buffer).getBigUint64(is64 ? 16 : 12, true));
    const cpuSeconds = Number(kernel[0] + user[0]) / 10_000_000; // FILETIME = 100 ns
    return { cpuSeconds, memoryBytes: workingSet };
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}

/** CPU seconds + resident memory for a process id, or null when it cannot be read. */
async function readProcessUsage(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const statm = readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
      const rssPages = Number(statm[1] || 0);
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // After "comm)" the fields start at state (field 3): utime=field 14, stime=field 15.
      const f = stat.slice(close + 2).split(/\s+/);
      const cpuSeconds = (Number(f[11] || 0) + Number(f[12] || 0)) / 100; // USER_HZ
      return { cpuSeconds, memoryBytes: rssPages * 4096 };
    }
    if (process.platform === "win32") {
      const api = await getWinApi();
      if (api) {
        const fast = readWinProcessUsage(api, pid);
        if (fast) return fast;
      }
      const { stdout } = await execFileAsync(windowsPowerShell(),
        ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command",
          `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){ "$($p.CPU)|$($p.WorkingSet64)" }`],
        { windowsHide: true, timeout: 4000 });
      const [cpu, mem] = String(stdout || "").trim().split("|").map(Number);
      if (!Number.isFinite(cpu) || !Number.isFinite(mem)) return null;
      return { cpuSeconds: cpu, memoryBytes: mem };
    }
    const { stdout } = await execFileAsync("ps", ["-o", "time=,rss=", "-p", String(pid)], { timeout: 4000 });
    const m = String(stdout || "").trim().match(/^(\S+)\s+(\d+)$/);
    if (!m) return null;
    return { cpuSeconds: parsePsTime(m[1]), memoryBytes: Number(m[2]) * 1024 };
  } catch {
    return null;
  }
}

async function startServerById(id, row) {
  if (!isValidServerId(id)) return new Response(JSON.stringify({ ok: false, error: "Invalid server id." }), { status: 400, headers: { "Content-Type": "application/json" } });
  if (isRunning(id)) return { ok: true, already: true, pid: runningServers.get(id)?.pid };
  const r = row || getServerRow(id);
  if (!r) return { ok: false, error: "Not found" };
  ensureServerDir(id);
  const loader = getLoader(r.loader) || getLoader("vanilla");
  if (loader && loader.requiresEula()) {
    const eula = readServerEula(id);
    if (!eula.accepted) {
      return new Response(JSON.stringify({ ok: false, error: "Minecraft EULA not accepted for this server.", eulaRequired: true, serverId: id }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
  }
  const dir = serverFilesDir(id);
  // Fail fast with a readable error instead of letting the server crash on bind.
  // Checks every port the loader will open (Java TCP, query UDP, RCON, Bedrock UDP/IPv6).
  const portConflicts = (await checkServerStartupPorts(r, dir)).filter((p) => p.reason);
  if (portConflicts.length) {
    const msg = `Cannot start: ${portConflicts.map(formatPortConflict).join(" ")}`;
    logLine(id, `Error: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: msg, conflicts: portConflicts }), { status: 409, headers: { "Content-Type": "application/json" } });
  }
  clearLogs(id);
  const savedExec = parseExec(r.exec);
  const jar = r.jar || "server.jar";
  const exec = (savedExec && typeof savedExec === "object") ? { ...savedExec, command: savedExec.command || "java" }
    : loader ? loader.getExecution({ jar, row: r, dir }) : { type: "java", command: "java", args: [`-Xmx${r.memory_max || "2G"}`, `-Xms${r.memory_min || "512M"}`, "-jar", jar, "nogui"], jar };
  const targetPath = exec.command && !exec.command.includes("/") && !exec.command.includes("\\") ? null : resolve(dir, exec.command || jar);
  if (exec.type === "custom") {
    if (!exec.command) {
      logLine(id, `Error: Custom loader has no launch command configured. Set it in Settings → Start command.`);
      return new Response(JSON.stringify({ ok: false, error: "Custom loader: no launch command configured." }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    // The command is user-provided: only check an explicit executable/script
    // path. A bare command (java, node…) is resolved through PATH, and the jar
    // used may not be server.jar, so it must not be required here.
    if (targetPath && !existsSync(targetPath)) {
      const hint = `Start command not found (${targetPath}). Check the command in Settings → Start command.`;
      logLine(id, `Error: ${hint}`);
      return new Response(JSON.stringify({ ok: false, error: hint }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  } else {
    let mustExist = null;
    if (exec.argsFile) mustExist = resolve(dir, exec.argsFile);
    else if (exec.type === "java") mustExist = join(dir, exec.jar || jar);
    else mustExist = targetPath || join(dir, exec.jar || jar);
    if (mustExist && !existsSync(mustExist)) {
      const hint = exec.argsFile ? `Server launch args file not found (${exec.argsFile}). Reinstall the server.`
        : exec.type === "java" ? `JAR not found (${basename(mustExist)}). Download/install the server first.`
        : `Server executable not found (${basename(mustExist)}). Install/place the server files first.`;
      logLine(id, `Error: ${hint}`);
      return new Response(JSON.stringify({ ok: false, error: hint }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  }
  if (loader && loader.requiresEula()) try { writeServerEula(id, true); } catch {}

  let command = exec.command;
  let args = Array.isArray(exec.args) ? [...exec.args] : [];
  // Java runtimes need the same memory/JVM args regardless of who described the launch.
  if (exec.type === "java") {
    const base = loader ? loader.getExecution({ jar, row: r, dir }) : null;
    const managed = base && Array.isArray(base.args) ? base.args.filter((a) => typeof a === "string") : args;
    // Drop any previous heap flags, then re-insert them *before* `-jar` (or before the
    // @args-file). Appending them at the end made the JVM pass `-Xmx…` to the Minecraft
    // main class, which failed with "X is not a recognized option".
    const cleaned = managed.filter((a) => !String(a).startsWith("-Xmx") && !String(a).startsWith("-Xms"));
    const memory = [`-Xmx${r.memory_max || "2G"}`, `-Xms${r.memory_min || "512M"}`];
    const jarIndex = cleaned.indexOf("-jar");
    if (jarIndex >= 0) args = [...cleaned.slice(0, jarIndex), ...memory, ...cleaned.slice(jarIndex)];
    else args = [...memory, ...cleaned];
    if (!args.includes("nogui")) args.push("nogui");
    const javaLaunch = await resolveJavaForServer(JAVA_DIR, r.java_version);
    if (!javaLaunch.ok) {
      logLine(id, `Error: ${javaLaunch.error}`);
      return new Response(JSON.stringify({ ok: false, error: javaLaunch.error, javaRequired: true, javaVersion: javaLaunch.javaVersion || null }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    command = javaLaunch.command;
  } else if (exec.type === "bedrock") {
    const bedrockExe = process.platform === "win32" ? "bedrock_server.exe" : "bedrock_server";
    command = join(dir, bedrockExe);
    args = [];
  }
  if (!command) {
    return new Response(JSON.stringify({ ok: false, error: "No launch command for this loader." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  let proc;
  try {
    proc = spawn(command, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  } catch (e) {
    logLine(id, `Error starting process: ${e.message}`);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  runningServers.set(id, { proc, pid: proc.pid });
  setServerPid(id, proc.pid);
    logLine(id, `Starting ${r.name} (${r.loader || "unknown"} ${r.loader_version || ""}${r.loader_build ? ` / ${r.loader_build}` : ""}) pid=${proc.pid}`);
  logLine(id, `Exec: ${command}${args.length ? " " + args.join(" ") : ""}`);
  if (getSetting(`ports_strict_${id}`, "0") === "1") {
    const allowed = new Set(serverPortsStatus(r).map((p) => `${p.protocol}:${p.port}`));
    startPortGuard({
      id,
      pid: proc.pid,
      allowed,
      log: (line) => logLine(id, line),
      stop: async () => { await stopServerProcess(id); },
    });
  }
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += String(d);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const l of parts) if (l !== "") logLine(id, l);
    });
    stream.on("end", () => { if (buf) logLine(id, buf); });
    stream.on("error", (e) => logLine(id, `Stream error: ${e?.message || e}`));
  };
  if (proc.stdout) pipe(proc.stdout);
  if (proc.stderr) pipe(proc.stderr);
  proc.on("close", (code, signal) => {
    stopPortGuard(id);
    runningServers.delete(id);
    procUsageSamples.delete(proc.pid);
    setServerPid(id, null);
    logLine(id, `Process exited (code=${code ?? "?"}${signal ? `, signal=${signal}` : ""})`);
    flushLogs(id);
  });
  proc.on("error", (e) => {
    stopPortGuard(id);
    runningServers.delete(id);
    procUsageSamples.delete(proc.pid);
    setServerPid(id, null);
    logLine(id, `Process error: ${e.message}`);
    flushLogs(id);
  });
  return { ok: true, pid: proc.pid };
}

async function stopAllServers({ timeoutMs = 8000 } = {}) {
  const ids = [...runningServers.keys()];
  const stopped = [];
  for (const id of ids) {
    try {
      if (await stopServerProcess(id, { timeoutMs })) stopped.push(id);
    } catch (e) {
      console.error(`[panel] could not stop ${id}: ${e?.message || e}`);
    }
  }
  return { ids, stopped };
}

export { isRunning, startServerById, stopServerProcess, forceStopServerProcess, readProcessUsage, procUsageSamples, stopAllServers };
