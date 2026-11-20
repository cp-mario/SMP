import { Elysia } from "elysia";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { join, resolve, parse, sep } from "path";
import { tmpdir } from "os";
import { db, resetDatabase } from "../core/db.js";
import { DATA_DIR, SERVERS_DIR, JAVA_DIR, ROOT_DIR } from "../core/config.js";
import { stopAllServers } from "../instances/process.js";
import { flushAllLogs } from "../core/logs.js";
import { stopSftpServer } from "../runtime/sftp.js";
import { migrateServerPorts } from "../runtime/ports.js";

// ============ PANEL MAINTENANCE (destructive) ============
// Actions requested from Settings -> Danger zone. Every scope needs the exact
// phrase the UI collects in the second confirmation step, so a stray API call
// cannot remove anything by itself. The actual removal runs in a detached
// helper that waits for this process to exit: the panel keeps the database and
// the installation directory open while it runs, and Windows locks both.
const WIPE_SCOPES = {
  // `closes: false` scopes empty their folders in-process and keep the panel up.
  servers: { phrase: "DELETE SERVERS", summary: "all servers and the panel database", closes: false },
  java: { phrase: "DELETE JAVA", summary: "the managed Java runtimes", closes: false },
  panel: { phrase: "DELETE PANEL", summary: "the panel installation", closes: true },
  all: { phrase: "DELETE EVERYTHING", summary: "all servers, the managed Java runtimes and the installation", closes: true },
};

const WIPE_HELPER = `
import { appendFileSync, existsSync, rmSync, unlinkSync } from "fs";

const [, , pidArg, ...targets] = process.argv;
const pid = Number(pidArg);
const logPath = process.env.SMP_WIPE_LOG || "";
const log = (msg) => { try { if (logPath) appendFileSync(logPath, "[" + new Date().toISOString() + "] " + msg + String.fromCharCode(10)); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitExit(p, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(p, 0); } catch { return true; }
    await sleep(200);
  }
  return false;
}

if (!pid || !targets.length) process.exit(1);
log("wipe started for pid " + pid + ": " + targets.join(", "));
const exited = await waitExit(pid, 120000);
log(exited ? "panel exited" : "panel still alive after 120s, deleting anyway");
await sleep(700);
for (const target of targets) {
  try {
    if (!existsSync(target)) { log("missing " + target); continue; }
    rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
    log("removed " + target);
  } catch (e) {
    log("could not remove " + target + ": " + (e && e.message ? e.message : e));
  }
}
try { unlinkSync(process.argv[1]); } catch {}
process.exit(0);
`;

function spawnWipe({ targets, pid, logPath }) {
  const helperPath = join(tmpdir(), `smp-wipe-${pid}-${Date.now()}.mjs`);
  writeFileSync(helperPath, WIPE_HELPER);
  const child = spawn(process.execPath, [helperPath, String(pid), ...targets], {
    detached: true,
    stdio: "ignore",
    cwd: tmpdir(),
    env: { ...process.env, SMP_WIPE_LOG: logPath },
  });
  child.unref();
}

/** Refuses filesystem roots and shallow paths before anything is removed. */
function isSafeWipeTarget(p) {
  try {
    const resolved = resolve(String(p || ""));
    const parsed = parse(resolved);
    if (!parsed.root || parsed.root === resolved) return false;
    const depth = resolved.slice(parsed.root.length).split(sep).filter(Boolean).length;
    return depth >= 2;
  } catch {
    return false;
  }
}

function wipeTargets(scope) {
  const targets = [];
  if (scope === "servers" || scope === "all") targets.push({ id: "data", path: resolve(DATA_DIR) });
  if (scope === "panel" || scope === "all") targets.push({ id: "panel", path: resolve(ROOT_DIR) });
  return targets;
}

/** Empties a folder but keeps the folder itself, like a fresh install. */
function emptyDir(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
  mkdirSync(dir, { recursive: true });
}

export const panelRoute = new Elysia({ prefix: "/api/panel" })
  .get("/paths", () => ({
    dataDir: DATA_DIR,
    serversDir: SERVERS_DIR,
    javaDir: JAVA_DIR,
    installDir: ROOT_DIR,
    dataDirExists: existsSync(DATA_DIR),
    installDirExists: existsSync(ROOT_DIR),
  }))
  .post("/wipe", async ({ body, set }) => {
    const scope = String(body?.scope || "").trim().toLowerCase();
    const spec = WIPE_SCOPES[scope];
    if (!spec) { set.status = 400; return { ok: false, error: "Unknown scope" }; }
    const typed = String(body?.confirm || "").trim().replace(/\s+/g, " ").toUpperCase();
    if (typed !== spec.phrase) { set.status = 400; return { ok: false, error: `Type "${spec.phrase}" to confirm.` }; }

    const closes = spec.closes !== false;
    const targets = closes
      ? wipeTargets(scope)
      : (scope === "servers"
        ? [{ id: "data", path: resolve(DATA_DIR) }, { id: "servers", path: SERVERS_DIR }]
        : [{ id: "java", path: JAVA_DIR }]);
    for (const target of targets) {
      if (!isSafeWipeTarget(target.path)) {
        set.status = 409;
        return { ok: false, error: `Refusing to delete ${target.path}: this path is not a safe target.` };
      }
    }
    const panelTarget = targets.find((t) => t.id === "panel");
    if (panelTarget && !existsSync(join(panelTarget.path, "package.json"))) {
      set.status = 409;
      return { ok: false, error: `Refusing to delete ${panelTarget.path}: it does not look like the SMP installation.` };
    }

    // Servers must stop before their folders or their Java runtime disappear.
    let stopResult = { ids: [], stopped: [] };
    try { stopResult = await stopAllServers({ timeoutMs: 8000 }); } catch {}
    try { flushAllLogs(); } catch {}

    // Server/Java-only wipes keep the panel alive: empty the folders, recreate
    // them and forget the servers whose files were just removed.
    if (!closes) {
      try {
        if (scope === "servers") {
          // Fresh install state: keep only the managed Java runtimes. Every other
          // entry (server folders, uploads, logs) is removed, then the servers
          // folder and an empty database are recreated. The SQLite file stays:
          // Windows keeps it mapped even after close(), so it is emptied by
          // dropping all tables instead of unlinking it.
          for (const entry of readdirSync(DATA_DIR)) {
            if (entry === "java" || entry.startsWith("smp.sqlite")) continue;
            rmSync(join(DATA_DIR, entry), { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
          }
          mkdirSync(SERVERS_DIR, { recursive: true });
          mkdirSync(JAVA_DIR, { recursive: true });
          resetDatabase();
          migrateServerPorts();
        } else {
          emptyDir(JAVA_DIR);
        }
      } catch (e) {
        set.status = 500;
        return { ok: false, error: `Could not delete: ${e?.message || e}`, targets: targets.map((t) => t.path) };
      }
      try {
        appendFileSync(join(DATA_DIR, "wipe.log"), `[${new Date().toISOString()}] wiped ${scope}: ${targets.map((t) => t.path).join(", ")}\n`);
      } catch {}
      return {
        ok: true,
        closing: false,
        scope,
        targets: targets.map((t) => t.path),
        servers: { total: stopResult.ids.length, stopped: stopResult.stopped.length },
        message: scope === "servers"
          ? "All servers were deleted and the panel database was reset. The panel is still running, the Java runtimes were kept and the servers folder was recreated."
          : "All managed Java runtimes were deleted. The panel is still running and the java folder was recreated.",
      };
    }

    // Closing scopes: the detached helper waits for this process to exit.
    try { stopSftpServer(); } catch {}
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}

    const logPath = join(DATA_DIR, "wipe.log");
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(logPath, `[${new Date().toISOString()}] wipe requested: ${scope} -> ${targets.map((t) => t.path).join(", ")}\n`);
    } catch {}

    try {
      spawnWipe({ targets: targets.map((t) => t.path), pid: process.pid, logPath });
    } catch (e) {
      set.status = 500;
      return { ok: false, error: `Could not start the delete helper: ${e?.message || e}` };
    }

    // Answer first, then exit so the detached helper can remove the folders.
    setTimeout(() => { try { process.exit(0); } catch {} }, 900);
    set.status = 202;
    return {
      ok: true,
      closing: true,
      scope,
      targets: targets.map((t) => t.path),
      servers: { total: stopResult.ids.length, stopped: stopResult.stopped.length },
      message: `Deleting ${spec.summary}. The panel is closing.`,
    };
  });
