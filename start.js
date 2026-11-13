// SMP start.js - Starts the Bun server (API + static panel) and opens the browser
import { spawn, execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const serverDir = path.join(root, "server");
const webDir = path.join(root, "web");
const DEFAULT_PORT = Number(process.env.SMP_PORT || 3001);

function bunCommand() {
  // Prefer a real bun executable over a shell shim on Windows.
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const candidates = [
      path.join(home, ".bun", "bin", "bun.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "bun.exe"),
      path.join(process.env.APPDATA || "", "npm", "bun.cmd"),
    ];
    for (const c of candidates) if (c && existsSync(c)) return c;
  }
  return "bun";
}

function run(cmd, args, cwd, label) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) console.error(`[${label}] exited with code ${code}`);
      resolve(code ?? 0);
    });
    child.on("error", (e) => {
      console.error(`[${label}] failed to spawn: ${e?.message || e}`);
      resolve(1);
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start) {
  let p = start;
  for (let i = 0; i < 50; i++, p++) if (await isPortFree(p)) return p;
  return start + 1;
}

async function probePanel(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return { up: true, smp: false };
    const j = await res.json().catch(() => ({}));
    return { up: true, smp: j?.service === "smp" || j?.ok === true, info: j };
  } catch {
    return { up: !(await isPortFree(port)), smp: false };
  }
}

function pidsOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  } catch { return []; }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(pid, "SIGTERM");
    } catch {}
  }
}

async function askChoice(port, probe) {
  if (!process.stdin.isTTY) {
    console.log(`Port ${port} is in use and no TTY available; not starting another instance.`);
    return "2";
  }
  const who = probe.smp ? `an SMP panel instance${probe.info?.pid ? ` (pid ${probe.info.pid})` : ""}` : `another process`;
  console.log(`\nDetected ${who} already using http://localhost:${port}`);
  console.log("    1) Close the previous instance and start this one [Default]");
  console.log("    2) Do not start this instance");
  console.log("    3) Start both (Not recommended, may cause errors)\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = (s) => new Promise(r => rl.question(s, r));
  while (true) {
    const ans = (await q("Choose [1/2/3] (default 1): ")).trim();
    if (ans === "" || ans === "1") { rl.close(); return "1"; }
    if (ans === "2" || ans === "3") { rl.close(); return ans; }
    console.log("Please enter 1, 2, or 3 (Enter = 1).");
  }
}

(async () => {
  console.log("Starting SMP...");
  let port = DEFAULT_PORT;
  let probe = await probePanel(port);
  // The self-updater relaunches the panel right after the old process exits:
  // there is no terminal to answer the prompt, so wait for the port instead.
  if (probe.up && process.env.SMP_UPDATE_RELAUNCH === "1") {
    console.log(`Waiting for port ${port} to be released by the previous instance...`);
    for (let i = 0; i < 120 && !(await isPortFree(port)); i++) await new Promise(r => setTimeout(r, 500));
    probe = await probePanel(port);
  }
  if (probe.up) {
    const choice = await askChoice(port, probe);
    if (choice === "2") { console.log("Cancelled."); process.exit(0); }
    if (choice === "1") {
      const pids = pidsOnPort(port);
      if (pids.length) { console.log(`Stopping previous instance on port ${port} (pid ${pids.join(", ")})...`); killPids(pids); }
      for (let i = 0; i < 30 && !(await isPortFree(port)); i++) await new Promise(r => setTimeout(r, 300));
      if (!(await isPortFree(port))) console.warn(`Port ${port} still busy; attempting to start anyway.`);
    } else if (choice === "3") {
      port = await findFreePort(port + 1);
      console.log(`Starting additional instance on http://localhost:${port} (NOT recommended).`);
    }
  }

  if (process.env.SMP_SKIP_INSTALL !== "1" && !existsSync(path.join(serverDir, "node_modules"))) {
    console.log("Installing server dependencies...");
    await run(bunCommand(), ["install"], serverDir, "server-install");
  }
  if (process.env.SMP_SKIP_INSTALL !== "1" && !existsSync(path.join(webDir, "node_modules"))) {
    console.log("Installing web dependencies...");
    await run(bunCommand(), ["install"], webDir, "web-install");
  }

  if (process.env.SMP_SKIP_BUILD !== "1") {
    console.log("Building web app...");
    // Run the Vite+ CLI with Bun directly. `bun --bun run build` still resolved
    // the package script to the Node shim on Windows, so invoke the JS entry.
    const vpBin = path.join(webDir, "node_modules", "vite-plus", "dist", "bin.js");
    const buildCode = await run(bunCommand(), [vpBin, "build"], webDir, "web-build");
    if (buildCode !== 0) { console.error("Web build failed; aborting."); process.exit(buildCode); }
  } else {
    console.log("Skipping web build (SMP_SKIP_BUILD=1).");
  }

  const url = `http://localhost:${port}`;
  console.log("Starting server...");
  const env = { ...process.env, SMP_PORT: String(port), PORT: String(port) };
  const server = spawn(bunCommand(), ["run", "src/index.js"], { cwd: serverDir, stdio: "inherit", detached: false, env });
  server.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => { try { server.kill("SIGTERM"); } catch {} process.exit(0); });
  process.on("SIGTERM", () => { try { server.kill("SIGTERM"); } catch {} process.exit(0); });

  await new Promise(() => {});
})();
