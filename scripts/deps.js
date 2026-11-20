// Dependency state for a package directory (server/ or web/).
//
// `bun install` is skipped when package.json and the lockfile have not changed
// since the last install. A small marker inside node_modules records the
// signature, so launching the panel does not hit the registry again.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bunCommand } from "./bun-bin.js";
import { run } from "./run.js";

const LOCK_FILES = ["bun.lock", "bun.lockb"];
const DEPS_MARKER = ".smp-deps.json";
const UNSHARE_MARKER = ".smp-unshared.json";

// Termux/PRoot (proot-distro) cannot create real hardlinks, so it emulates them
// with symlinks into a hidden store. The kernel still hands the store path back
// through /proc, so Bun resolves an installed file to something like
// /.l2s/.l2s.bin.js0003.0002 and then fails to load its relative imports.
// Installing with the copy backend and de-sharing existing hardlinks keeps
// module resolution intact inside those guests.
export function usesProotLink2Symlink() {
  if (process.platform !== "linux") return false;
  return existsSync(process.env.PROOT_L2S_DIR || "/.l2s");
}

/** Arguments for `bun install` in `dir` (frozen lockfile, copy backend on proot). */
export function installArgs(dir, { frozen = true } = {}) {
  const args = ["install"];
  if (frozen && LOCK_FILES.some((name) => existsSync(path.join(dir, name)))) args.push("--frozen-lockfile");
  if (usesProotLink2Symlink()) args.push("--backend=copyfile");
  return args;
}

function bunVersion() {
  return String(process.versions?.bun || "").trim();
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Hash of the files that decide whether dependencies must be reinstalled. */
export function depsSignature(dir) {
  const hash = createHash("sha256");
  hash.update(`smp-deps-v1\0${process.platform}\0${process.arch}\0${bunVersion()}\0`);
  for (const name of ["package.json", ...LOCK_FILES]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    let buf;
    try { buf = readFileSync(file); } catch { continue; }
    hash.update(name);
    hash.update("\0");
    hash.update(String(buf.length));
    hash.update("\0");
    hash.update(buf);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** True when the package files changed since the last install in `dir`. */
export function depsChanged(dir) {
  const marker = readJson(path.join(dir, "node_modules", DEPS_MARKER));
  return !marker || marker.signature !== depsSignature(dir);
}

export function writeDepsMarker(dir) {
  writeJson(path.join(dir, "node_modules", DEPS_MARKER), {
    signature: depsSignature(dir),
    bun: bunVersion(),
    installedAt: Date.now(),
  });
}

/** True when a proot tree still has link2symlink hardlinks to de-share. */
export function needsUnshare(dir) {
  if (!usesProotLink2Symlink()) return false;
  const nodeModules = path.join(dir, "node_modules");
  if (!existsSync(nodeModules)) return false;
  const marker = readJson(path.join(nodeModules, UNSHARE_MARKER));
  return !marker || marker.signature !== depsSignature(dir);
}

export function writeUnshareMarker(dir) {
  writeJson(path.join(dir, "node_modules", UNSHARE_MARKER), {
    signature: depsSignature(dir),
    at: Date.now(),
  });
}

/** Replaces link2symlink hardlinks with real copies so Bun can resolve them. */
export function unshareHardlinks(dir) {
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

/** Installs dependencies in `dir` and records the new signature. */
export async function installDependencies(dir, label, { bun = bunCommand(), frozen = true } = {}) {
  console.log(`Installing ${label} dependencies...`);
  const code = await run(bun, installArgs(dir, { frozen }), dir, `${label}-install`);
  if (code !== 0) throw new Error(`Could not install ${label} dependencies (exit code ${code}).`);
  if (!existsSync(path.join(dir, "node_modules"))) {
    throw new Error(`${label} installation did not create node_modules.`);
  }
  writeDepsMarker(dir);
}