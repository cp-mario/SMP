import * as tar from "tar";
import { createZstdCompress, createZstdDecompress, constants as zlibConstants } from "node:zlib";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve, sep } from "node:path";
import Archiver from "archiver";
import AdmZip from "adm-zip";

/**
 * Backup archives are stored as a streamed tar + zstd file.
 *
 * - Nothing is buffered: tar entries are compressed as they are read.
 * - Zstd level 3 is the speed/ratio sweet spot for Minecraft worlds (already
 *   mostly incompressible region files) and mods/jars.
 * - Only the compressed archive is written. The old ZIP path is kept for
 *   legacy backups and for on-demand ZIP downloads.
 */
export const BACKUP_FORMAT = "tar.zst";
export const BACKUP_ZSTD_LEVEL = Math.max(1, Math.min(19, Number(process.env.SMP_BACKUP_ZSTD_LEVEL) || 3));
const TEMP_SUFFIX = ".part";

function zstdCompressor() {
  return createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: BACKUP_ZSTD_LEVEL } });
}

function zstdDecompressor() {
  return createZstdDecompress();
}

function removeQuietly(path) {
  try { if (path) unlinkSync(path); } catch {}
}

/** Streams `srcDir` into `outPath` as a .tar.zst, atomically via a .part file. */
export async function createBackupArchive(srcDir, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}${TEMP_SUFFIX}`;
  try {
    await pipeline(
      tar.create({
        cwd: srcDir,
        portable: true, // no pax headers: smaller archive and faster creation
        follow: false,  // never follow symlinks outside the server folder
        dot: true,      // include dotfiles
      }, ["."]),
      zstdCompressor(),
      createWriteStream(tmp),
    );
    renameSync(tmp, outPath);
    return statSync(outPath).size;
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
}

/** Streams a .tar.zst archive into `destDir`. */
export async function extractBackupArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  await pipeline(
    createReadStream(archivePath),
    zstdDecompressor(),
    tar.x({ cwd: destDir, preservePaths: false, strict: false }),
  );
}

function isSafeEntryPath(name) {
  const normalized = String(name || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === ".." || part === "");
}

/** Extracts a legacy .zip backup with traversal protection. */
export function extractLegacyZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  const root = resolve(destDir);
  for (const entry of zip.getEntries()) {
    const name = String(entry.entryName || "").replace(/\\/g, "/");
    if (!isSafeEntryPath(name)) throw new Error(`Unsafe path in backup: ${name}`);
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`Unsafe path in backup: ${name}`);
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.getData());
  }
}

/**
 * Converts a legacy ZIP to .tar.zst through a temporary folder.
 * Used lazily only when a legacy backup is downloaded/restored as tar.zst.
 */
export async function convertZipToTarZst(zipPath, outPath, tempRoot) {
  const tmpDir = join(tempRoot, `.convert-${crypto.randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    extractLegacyZip(zipPath, tmpDir);
    return await createBackupArchive(tmpDir, outPath);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function normalizeTarEntryPath(name) {
  return String(name || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Returns a Node readable that converts a stored .tar.zst into a ZIP on the fly.
 * The archive never touches disk: it is decompressed, parsed, re-zipped and
 * streamed straight to the HTTP response.
 */
export function tarZstToZip(archivePath, { signal } = {}) {
  const archive = Archiver("zip", { zlib: { level: 6 } });
  const input = createReadStream(archivePath).pipe(zstdDecompressor()).pipe(tar.t());
  let finished = false;

  const abort = (err) => {
    if (finished) return;
    finished = true;
    try { input.destroy(); } catch {}
    try { archive.destroy(err); } catch {}
  };

  signal?.addEventListener("abort", () => abort(new Error("Download aborted")), { once: true });
  archive.on("warning", (err) => { if (err?.code !== "ENOENT") abort(err); });
  archive.on("error", abort);
  input.on("error", abort);

  input.on("entry", (entry) => {
    if (finished) return entry.resume();
    const name = normalizeTarEntryPath(entry.path);
    if (!name) return entry.resume();

    if (entry.type === "Directory") {
      archive.append(Buffer.alloc(0), {
        name: `${name}/`,
        type: "directory",
        date: entry.mtime,
        mode: entry.mode,
      });
      entry.resume();
      return;
    }

    if (entry.type === "SymbolicLink") {
      try {
        archive.symlink(name, entry.linkpath, entry.mode);
      } catch {
        // A ZIP without the symlink is better than a failed download.
      }
      entry.resume();
      return;
    }

    if (entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile") {
      archive.append(entry, {
        name,
        date: entry.mtime,
        mode: entry.mode,
        size: entry.size,
      });
      return;
    }

    // Hard links, devices, etc. cannot be represented in a portable ZIP.
    entry.resume();
  });

  input.on("end", () => {
    if (finished) return;
    archive.finalize().catch(abort);
  });

  return archive;
}

/** Removes everything inside `dir` but keeps the directory itself. */
export function clearDirectory(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const target = join(dir, entry.name);
    try {
      if (entry.isDirectory()) rmSync(target, { recursive: true, force: true });
      else unlinkSync(target);
    } catch {}
  }
}
