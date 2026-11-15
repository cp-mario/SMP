// SMP start.js - Starts the Bun server (API + static panel) and opens the browser
import { spawn, execSync } from "child_process";
import { existsSync, readdirSync, lstatSync, copyFileSync, renameSync, rmSync } from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import readline from "readline";
import { bunCommand } from "./scripts/bun-bin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const serverDir = path.join(root, "server");
const webDir = path.join(root, "web");
const DEFAULT_PORT = Number(process.env.SMP_PORT || 3001);

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

// Termux/PRoot (proot-distro) cannot create real hardlinks, so it emulates them
// with symlinks into a hidden store. The kernel still hands the store path back
// through /proc, so Bun resolves an installed file to something like
// /.l2s/.l2s.bin.js0003.0002 and then fails to load its relative imports.
// Installing with the copy backend and de-sharing existing hardlinks keeps
// module resolution intact inside those guests.
function usesProotLink2Symlink() {
  if (process.platform !== "linux") return false;
  return existsSync(process.env.PROOT_L2S_DIR || "/.l2s");
}

function installArgs() {
  return usesProotLink2Symlink() ? ["install", "--backend=copyfile"] : ["install"];
}

function unshareHardlinks(dir) {
  let fixed = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = readdirSync(current); } catch { continue; }
    for (const name of entries) {
      const target = path.join(current, name);
      let st;
      try { st = lstatSync(target); } catch { continue; }
      // Real symlinks (package bin shims) are fine and must be left alone;
      // link2symlink entries are masked as regular files with nlink > 1.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { pending.push(target); continue; }
      if (!st.isFile() || st.nlink <= 1) continue;
      const tmp = `${target}.smp-unshare-${process.pid}`;
      try {
        copyFileSync(target, tmp);
        try { renameSync(tmp, target); }
        catch { rmSync(target, { force: true }); renameSync(tmp, target); }
        fixed++;
      } catch {
        try { rmSync(tmp, { force: true }); } catch {}
      }
    }
  }
  return fixed;
}

async function ensureDependencies(dir, label) {
  const nodeModules = path.join(dir, "node_modules");
  const link2symlink = usesProotLink2Symlink();
  const skipInstall = process.env.SMP_SKIP_INSTALL === "1";
  const needsInstall = existsSync(nodeModules) ? link2symlink : !skipInstall;
  if (needsInstall) {
    console.log(`Installing ${label} dependencies...`);
    const code = await run(bunCommand(), installArgs(), dir, `${label}-install`);
    if (code !== 0) { console.error(`Could not install ${label} dependencies.`); process.exit(code); }
  }
  if (link2symlink && existsSync(nodeModules)) {
    process.stdout.write(`Preparing ${label} dependencies for this environment...`);
    const fixed = unshareHardlinks(nodeModules);
    console.log(fixed ? ` done (${fixed} file${fixed === 1 ? "" : "s"}).` : " done.");
  }
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

  await ensureDependencies(serverDir, "server");
  await ensureDependencies(webDir, "web");

  if (process.env.SMP_SKIP_BUILD !== "1") {
    console.log("Building web app...");
    // Build with the plain Vite CLI (rolldown) through Bun, no Node involved.
    const viteBin = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
    const buildCode = await run(bunCommand(), [viteBin, "build"], webDir, "web-build");
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
