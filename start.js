// SMP start.js - Starts the Bun server (API + static panel)
//
// The launcher stays in the foreground for the whole life of the panel:
// `bun run start` blocks the terminal and Ctrl+C stops the panel. A self-update
// keeps the terminal attached too: the panel exits with UPDATE_RESTART_EXIT, the
// detached updater swaps the installation, and this process starts the new
// version in the foreground.
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import path from "path";
import net from "net";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import readline from "readline";
import { bunCommand } from "./scripts/bun-bin.js";
import { ensureWebBuild } from "./scripts/build-web.js";
import { installDependencies, depsChanged, needsUnshare, unshareHardlinks, writeUnshareMarker, usesProotLink2Symlink } from "./scripts/deps.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;
const serverDir = path.join(root, "server");
const webDir = path.join(root, "web");
const DEFAULT_PORT = Number(process.env.SMP_PORT || 3001);

// Must match UPDATE_RESTART_EXIT in server/src/core/version.js: the panel exits
// with it after handing an update to the detached updater, and this process then
// waits for the swap and restarts the panel.
const UPDATE_RESTART_EXIT = 86;
// The detached updater writes the result of the file swap here.
const UPDATE_STATUS_FILE = path.join(tmpdir(), `smp-update-${process.pid}.json`);
const UPDATE_WAIT_MS = 5 * 60 * 1000;

let currentServer = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const child = currentServer;
  currentServer = null;
  if (child) { try { child.kill(); } catch {} }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function ensureDependencies(dir, label) {
  const nodeModules = path.join(dir, "node_modules");
  const link2symlink = usesProotLink2Symlink();
  const skipInstall = process.env.SMP_SKIP_INSTALL === "1";

  if (skipInstall) {
    if (!existsSync(nodeModules)) {
      console.warn(`[${label}] SMP_SKIP_INSTALL=1 and node_modules is missing; the panel may fail to start.`);
    }
  } else if (!existsSync(nodeModules) || depsChanged(dir)) {
    try {
      await installDependencies(dir, label);
    } catch (error) {
      // A frozen install fails when a release shipped an out-of-sync lockfile;
      // retry without it instead of leaving the panel unable to start.
      console.warn(`Could not install ${label} dependencies with the frozen lockfile (${error?.message || error}); retrying without it...`);
      try {
        await installDependencies(dir, label, { frozen: false });
      } catch (retryError) {
        console.error(`Could not install ${label} dependencies: ${retryError?.message || retryError}`);
        process.exit(1);
      }
    }
  }

  // Link2symlink hardlinks are fixed once per dependency state, not on every
  // launch: walking all of node_modules is slow on proot guests.
  if (link2symlink && needsUnshare(dir)) {
    console.log(`Preparing ${label} dependencies for this environment...`);
    const fixed = unshareHardlinks(nodeModules);
    writeUnshareMarker(dir);
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

/** Starts the panel and resolves with its exit code once it stops. */
function startServer(port) {
  console.log("Starting server...");
  const env = {
    ...process.env,
    SMP_PORT: String(port),
    PORT: String(port),
    // This launcher owns the terminal: on a self-update the panel exits with
    // UPDATE_RESTART_EXIT so this process can start the new version.
    SMP_UPDATE_STATUS: UPDATE_STATUS_FILE,
  };
  const child = spawn(bunCommand(), ["run", "src/index.js"], { cwd: serverDir, stdio: "inherit", detached: false, env });
  currentServer = child;
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      currentServer = null;
      resolve(code);
    };
    child.once("error", (error) => {
      console.error(`[server] could not be started: ${error?.message || error}`);
      done(1);
    });
    child.once("exit", (code) => done(code ?? 0));
  });
}

/** Result written by the detached updater once the new tree is installed. */
function readUpdateStatus() {
  try { return JSON.parse(readFileSync(UPDATE_STATUS_FILE, "utf8")); } catch { return null; }
}

async function waitForUpdate() {
  const started = Date.now();
  while (Date.now() - started < UPDATE_WAIT_MS) {
    const status = readUpdateStatus();
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

/** True once the previous panel released the port and the new one can bind it. */
async function waitForPort(port) {
  for (let i = 0; i < 50 && !(await isPortFree(port)); i++) await new Promise((resolve) => setTimeout(resolve, 200));
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

  // A leftover status file from a previous run must not be mistaken for the
  // result of this update.
  try { rmSync(UPDATE_STATUS_FILE, { force: true }); } catch {}

  for (;;) {
    await ensureDependencies(serverDir, "server");
    await ensureDependencies(webDir, "web");

    if (process.env.SMP_SKIP_BUILD === "1") {
      console.log("Skipping web build (SMP_SKIP_BUILD=1).");
    } else {
      const build = await ensureWebBuild({ root, webDir, force: process.env.SMP_FORCE_BUILD === "1" });
      if (!build.ok) {
        console.error(build.error || "Web build failed; aborting.");
        process.exit(1);
      }
    }

    // Fail early with a clear message instead of serving "Panel build missing".
    if (!existsSync(path.join(serverDir, "src", "public", "index.html"))) {
      console.error("Panel build missing. Run `bun run build`, or start without SMP_SKIP_BUILD=1.");
      process.exit(1);
    }

    const code = await startServer(port);
    if (code !== UPDATE_RESTART_EXIT) process.exit(code);

    // The panel handed an update to the detached updater and exited: wait for
    // the swap, then start the new version in the foreground.
    console.log("Update installed; waiting for the new files to be swapped in...");
    const status = await waitForUpdate();
    if (!status) {
      console.error("The updater did not report back in time. Check update.log in the SMP data folder.");
      process.exit(1);
    }
    if (!status.ok) {
      console.error(`Update failed: ${status.error || "unknown error"}. Check update.log in the SMP data folder.`);
      process.exit(1);
    }
    try { rmSync(UPDATE_STATUS_FILE, { force: true }); } catch {}

    console.log("Restarting the panel with the updated version...");
    await waitForPort(port);
  }
})();
