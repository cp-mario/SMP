// Builds the Svelte panel into server/src/public, but only when its inputs
// changed. A hash of the web sources is stored in <root>/.smp-build.json; when
// it matches, start.js can boot the panel without running Vite again.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bunCommand } from "./bun-bin.js";
import { run } from "./run.js";

const INPUT_FILES = [
  "index.html",
  "package.json",
  "bun.lock",
  "bun.lockb",
  "vite.config.js",
  "svelte.config.js",
  "jsconfig.json",
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];
const INPUT_DIRS = ["src", "public"];
const MARKER = ".smp-build.json";
const LOCK = ".smp-build.lock";
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_WAIT_MS = 10 * 60 * 1000;

function collectFiles(dir, root, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, root, out);
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

/** Deterministic hash of everything the Vite build reads. */
export function webInputHash(webDir) {
  const files = [];
  for (const name of INPUT_FILES) if (existsSync(path.join(webDir, name))) files.push(name);
  for (const name of INPUT_DIRS) collectFiles(path.join(webDir, name), webDir, files);
  files.sort();
  const hash = createHash("sha256");
  hash.update("smp-web-v1\0");
  for (const rel of files) {
    const file = path.join(webDir, rel);
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    let buf;
    try { buf = readFileSync(file); } catch { continue; }
    hash.update(rel);
    hash.update("\0");
    hash.update(String(buf.length));
    hash.update("\0");
    hash.update(buf);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function markerPath(root) {
  return path.join(root, MARKER);
}

function readMarker(root) {
  try { return JSON.parse(readFileSync(markerPath(root), "utf8")); } catch { return null; }
}

function appVersion(root) {
  try {
    return String(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version || "");
  } catch {
    return "";
  }
}

function isBuilt(root, hash) {
  if (!existsSync(path.join(root, "server", "src", "public", "index.html"))) return false;
  const marker = readMarker(root);
  return Boolean(marker && marker.hash === hash);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockAge(lock) {
  try { return Date.now() - statSync(lock).mtimeMs; } catch { return 0; }
}

function lockOwnerAlive(lock) {
  let pid = 0;
  try { pid = Number(readFileSync(path.join(lock, "pid"), "utf8").trim()); } catch {}
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Serializes builds so two launchers cannot write server/src/public at once. */
async function withBuildLock(root, fn) {
  const lock = path.join(root, LOCK);
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = lockAge(lock);
      if (age > LOCK_STALE_MS || (!lockOwnerAlive(lock) && age > 5000)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("Timed out waiting for another web build.");
      await sleep(200);
    }
  }
  try {
    writeFileSync(path.join(lock, "pid"), String(process.pid));
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Builds the web panel when needed.
 * Returns { ok, built, hash, reason?, error? }.
 */
export async function ensureWebBuild({ root, webDir, force = false } = {}) {
  const hash = webInputHash(webDir);

  if (!force && isBuilt(root, hash)) {
    console.log("Web panel is up to date (skipping build).");
    return { ok: true, built: false, hash, reason: "up-to-date" };
  }

  const viteBin = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    const error = `Vite not found at ${viteBin}. Install the web dependencies first.`;
    console.error(error);
    return { ok: false, built: false, hash, reason: "missing-vite", error };
  }

  let built = false;
  let failure = null;
  try {
    await withBuildLock(root, async () => {
      // Another launcher may have built the same inputs while we waited.
      if (!force && isBuilt(root, hash)) {
        built = false;
        return;
      }
      console.log("Building web panel...");
      const code = await run(bunCommand(), [viteBin, "build"], webDir, "web-build");
      if (code !== 0) {
        failure = `Web build failed (vite exited with code ${code}).`;
        return;
      }
      writeFileSync(markerPath(root), JSON.stringify({
        hash,
        builtAt: Date.now(),
        bun: String(process.versions?.bun || ""),
        version: appVersion(root),
      }, null, 2));
      built = true;
    });
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`Web build failed: ${message}`);
    return { ok: false, built: false, hash, error: message };
  }

  if (failure) {
    console.error(failure);
    return { ok: false, built: false, hash, error: failure };
  }
  if (!built) console.log("Web panel is up to date (built by another process).");
  return { ok: true, built, hash, reason: built ? "built" : "up-to-date" };
}

if (import.meta.main) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await ensureWebBuild({
    root,
    webDir: path.join(root, "web"),
    force: process.env.SMP_FORCE_BUILD === "1",
  });
  if (!result.ok) process.exit(1);
}