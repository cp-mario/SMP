import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";

import { getSetting, setSetting, db, resetDatabase } from "./db.js";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, createWriteStream,
  unlinkSync, rmdirSync, rmSync, appendFileSync, renameSync } from "fs";
import { readdir, stat } from "fs/promises";
import { join, dirname, resolve, basename, parse, sep, posix as pathPosix } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir, totalmem } from "os";
import { spawn, execFile } from "child_process";
import { pipeline, Readable } from "stream";
import { promisify } from "util";
import { getSftpInfo, setSftpPassword, startSftpServer, stopSftpServer, getSftpStatus, autoStartSftp, sftpEnabledKey, sftpPasswordKey } from "./sftp.js";
import { createBackupArchive, extractBackupArchive, convertZipToTarZst, tarZstToZip, BACKUP_FORMAT } from "./backups.js";
import { AVAILABLE_JAVA_VERSIONS, detectJava, listInstalledJava, installJava, uninstallJava, resolveJavaCommand, getInstalledJavaHome } from "./java.js";
import { getLoader, listLoaders, loaderIds, requiresEula } from "./loaders/index.js";
import { listSources, searchStore, getProject, getVersions, lookupHash, findModUpdates, findModUpdate, latestVersion, resolveDownload, sourceConfigured, getSource } from "./mods/index.js";
import { installModpack, downloadFile } from "./mods/packs.js";
import { sha1File, sha256File, fingerprintFile } from "./mods/http.js";
import { modsTarget, folderForTarget } from "./mods/loaders.js";
import { portProfile, isPortNumber, isPortBindable, allocateServerPorts, saveServerPorts, applyPortsToConfig, checkServerStartupPorts, serverPortsStatus, formatPortConflict, migrateServerPorts, PortConflictError, findPortOwner, insertServerExtraPort, updateServerExtraPort, deleteServerExtraPort, getServerExtraPorts } from "./ports.js";
import { startPortGuard, stopPortGuard } from "./portGuard.js";
import { appVersion, getUpdateState, applyUpdate, normalizeChannel, defaultChannel } from "./version.js";

const streamPipeline = promisify(pipeline);
const execFileAsync = promisify(execFile);

function rmdirRecursive(p) {
  if (!existsSync(p)) return;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const cp = join(p, e.name);
    if (e.isDirectory()) rmdirRecursive(cp); else unlinkSync(cp);
  }
  rmdirSync(p, { recursive: true });
}

function safeName(name) {
  const n = String(name || "").replace(/[\/\\]/g, "").replace(/\.\.+/g, "").trim();
  if (!n || n === "." || n === "..") return null;
  return n;
}

// Content-Disposition filename: keep only a safe basename, RFC 5987-encode the rest.
function attachmentName(name, fallback = "download") {
  const raw = String(name || "").split(/[\\/]/).pop() || fallback;
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(raw);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function zipDirectory(srcDir, outPath) {
  const Archiver = (await import("archiver")).default;
  await new Promise((resolveZip, rejectZip) => {
    const output = createWriteStream(outPath);
    const archive = Archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolveZip(outPath));
    output.on("error", rejectZip);
    archive.on("error", rejectZip);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize().catch(rejectZip);
  });
  return outPath;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "../..");

const DATA_DIR = process.env.SMP_DATA_DIR || join(homedir(), ".smp");
const SERVERS_DIR = join(DATA_DIR, "servers");
const JAVA_DIR = join(DATA_DIR, "java");
mkdirSync(SERVERS_DIR, { recursive: true });
migrateServerPorts();

// Clean up artifacts left behind by a crash in the middle of a backup/restore.
// This runs before the HTTP server starts, so no backup operation can be active.
function recoverBackupStaging() {
  let servers;
  try { servers = readdirSync(SERVERS_DIR, { withFileTypes: true }); } catch { return; }
  for (const entry of servers) {
    if (!entry.isDirectory() || !isValidServerId(entry.name)) continue;
    const dir = serverPath(entry.name);
    const files = serverFilesDir(entry.name);
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    // If a restore swapped the old folder away but crashed before installing
    // the extracted one, put the previous files back.
    const previous = items
      .filter((item) => item.isDirectory() && item.name.startsWith(".pre-restore-"))
      .map((item) => item.name)
      .sort();
    if (!existsSync(files) && previous.length) {
      try { renameSync(join(dir, previous[previous.length - 1]), files); } catch {}
    }
    for (const item of items) {
      if (item.isDirectory() && (item.name.startsWith(".restore-") || item.name.startsWith(".pre-restore-"))) {
        try { rmSync(join(dir, item.name), { recursive: true, force: true }); } catch {}
      } else if (item.isDirectory() && item.name === "backups") {
        let backupItems;
        try { backupItems = readdirSync(join(dir, "backups"), { withFileTypes: true }); } catch { continue; }
        for (const backupItem of backupItems) {
          if (backupItem.isFile() && backupItem.name.endsWith(".part")) {
            try { unlinkSync(join(dir, "backups", backupItem.name)); } catch {}
          } else if (backupItem.isDirectory() && backupItem.name === ".convert") {
            try { rmSync(join(dir, "backups", backupItem.name), { recursive: true, force: true }); } catch {}
          }
        }
      }
    }
  }
}
recoverBackupStaging();
mkdirSync(JAVA_DIR, { recursive: true });

const DEFAULT_CORS_ORIGINS = ["http://localhost:3001", "http://127.0.0.1:3001"];

function getCorsOrigins() {
  const setting = String(getSetting("cors_origins", "") || "").trim();
  if (!setting) return DEFAULT_CORS_ORIGINS;
  if (setting === "*") return ["*"];
  try {
    const parsed = JSON.parse(setting);
    return Array.isArray(parsed) && parsed.length ? parsed.map(String) : DEFAULT_CORS_ORIGINS;
  } catch {
    return DEFAULT_CORS_ORIGINS;
  }
}

// The CORS origin callback runs on every cross-origin request; avoid a DB read each time.
let corsOriginsCache = { at: 0, origins: DEFAULT_CORS_ORIGINS };
function corsAllowedOrigins() {
  const now = Date.now();
  if (now - corsOriginsCache.at > 5000) corsOriginsCache = { at: now, origins: getCorsOrigins() };
  return corsOriginsCache.origins;
}

const OUTPUT_DIR = process.execPath.endsWith(".exe") && process.execPath.includes("dist")
  ? join(dirname(process.execPath), "public")
  : join(ROOT_DIR, "server/src/public");

const MAX_TEXT_EDIT_BYTES = 10 * 1024 * 1024;
const STREAM_THRESHOLD_BYTES = 5 * 1024 * 1024;
const TEXT_EXTS = new Set(["txt","log","json","yml","yaml","toml","ini","cfg","conf","properties","md","js","ts","jsx","tsx","svelte","html","css","xml","csv","sh","bat","ps1","mcfunction","mcmeta","lang","env","gitignore","lock","java","kt","kts","gradle","rs","py","rb","go","c","h","cpp","hpp"]);

const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  zip: "application/zip",
  jar: "application/java-archive",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

// Vite hashes asset filenames, so they never change content under the same URL.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const ASSET_CACHE = "public, max-age=86400";

function parseMemoryMb(v, fallback = 2048) {
  if (v == null || v === "") return fallback;
  const s = String(v).trim().toUpperCase();
  const m = s.match(/^(\d+)\s*(MB|M|GB|G)?$/);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const u = m[2] || "M";
  return (u === "G" || u === "GB") ? n * 1024 : n;
}
function formatMemoryMb(mb) {
  const n = Math.max(256, Math.floor(Number(mb) || 256));
  return n % 1024 === 0 ? `${n / 1024}G` : `${n}M`;
}
function clampMemoryMb(mb) {
  const max = Math.max(256, Math.floor(totalmem() / (1024 * 1024)));
  return Math.min(max, Math.max(256, Math.floor(Number(mb) || 256)));
}
function normalizeJvmArgs(v) {
  if (v == null) return "";
  return String(v).replace(/[\r\n]+/g, " ").trim();
}
function validateServerInput(body) {
  const errors = [];
  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    errors.push("name is required");
  }
  if (body.name && body.name.length > 100) {
    errors.push("name too long (max 100 chars)");
  }
  const valid = loaderIds();
  if (body.loader && !valid.includes(body.loader)) {
    errors.push("invalid loader");
  }
  if (body.port !== undefined && (typeof body.port !== "number" || body.port < 1 || body.port > 65535)) {
    errors.push("invalid port");
  }
  const mem = body.memory_max ?? body.memoryMin ?? body.memory ?? body.ram;
  if (mem !== undefined && mem !== "" && !/^\d+\s*(MB|M|GB|G)?$/i.test(String(mem))) {
    errors.push("invalid memory format");
  }
  if (body.jvm_args !== undefined && typeof body.jvm_args !== "string") {
    errors.push("invalid jvm_args");
  }
  return errors;
}

function sanitizePath(base, userPath) {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(base, userPath);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + "/") && !resolvedPath.startsWith(resolvedBase + "\\")) {
    return null;
  }
  return resolvedPath;
}

function serverPath(id) { return join(SERVERS_DIR, id); }
function isValidServerId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
function isValidBackupId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
function serverFilesDir(id) { return join(serverPath(id), "server-files"); }
function serverIconPath(id) { return join(serverFilesDir(id), "server-icon.png"); }
function hasServerIcon(id) {
  try { return existsSync(serverIconPath(id)); } catch { return false; }
}
function serverIconVersion(id) {
  try { return Math.floor(statSync(serverIconPath(id)).mtimeMs); } catch { return 0; }
}
function isEndstoneServer(id) {
  try { return String(db.prepare("SELECT loader FROM servers WHERE id = ?").get(id)?.loader || "").toLowerCase() === "endstone"; } catch { return false; }
}
function serverPropPath(id) {
  return isEndstoneServer(id)
    ? join(serverFilesDir(id), "bedrock_server", "server.properties")
    : join(serverFilesDir(id), "server.properties");
}
function serverBackupsDir(id) { return join(serverPath(id), "backups"); }
function serverLogPath(id) { return join(serverPath(id), "logs.txt"); }
function serverEulaPath(id) { return join(serverFilesDir(id), "eula.txt"); }

// ---------- Backup helpers ----------
function flagValue(value) {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}
function normalizeBackupName(name) {
  const raw = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return raw.slice(0, 120);
}
function backupNumberLabel(row) {
  return row?.number ? `Backup #${row.number}` : "Backup";
}
function backupName(row) {
  return normalizeBackupName(row?.name) || backupNumberLabel(row);
}
function backupFormat(row) {
  const path = String(row?.path || "").toLowerCase();
  if (path.endsWith(".tar.zst")) return "tar.zst";
  if (path.endsWith(".zip")) return "zip";
  const fmt = String(row?.format || "").toLowerCase();
  return fmt === "zip" ? "zip" : "tar.zst";
}
function backupReasonLabel(reason) {
  switch (String(reason || "").toLowerCase()) {
    case "shutdown": return "On stop";
    case "update": return "Before update";
    case "loader": return "Before loader change";
    case "modpack": return "Before modpack update";
    default: return null;
  }
}
function backupJson(row) {
  if (!row) return null;
  const format = backupFormat(row);
  return {
    id: row.id,
    server_id: row.server_id,
    name: backupName(row),
    number: row.number ?? null,
    size: Number(row.size) || 0,
    created_at: Number(row.created_at) || 0,
    protected: !!row.protected,
    format,
    reason: row.reason || "manual",
    reason_label: backupReasonLabel(row.reason),
    error: row.error || null,
  };
}
function backupDateStamp(createdAtSeconds) {
  const d = new Date((Number(createdAtSeconds) || Math.floor(Date.now() / 1000)) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function backupDownloadName(row, ext) {
  const base = normalizeBackupName(backupName(row)) || "backup";
  return `${base}_${backupDateStamp(row.created_at)}.${ext}`;
}

const backupLocks = globalThis.__smp_backup_locks || (globalThis.__smp_backup_locks = new Map());
function withBackupLock(serverId, fn) {
  const previous = backupLocks.get(serverId) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  backupLocks.set(serverId, run);
  run.finally(() => { if (backupLocks.get(serverId) === run) backupLocks.delete(serverId); }).catch(() => {});
  return run;
}

function backupLimitFor(server) {
  return Math.max(0, Math.floor(Number(server?.backup_limit) || 0));
}

function peekBackupNumber(serverId) {
  let max = Number(getSetting(`backup_seq_${serverId}`, "0")) || 0;
  try {
    const row = db.prepare("SELECT MAX(number) AS max FROM backups WHERE server_id = ?").get(serverId);
    max = Math.max(max, Number(row?.max) || 0);
  } catch {}
  return max + 1;
}

function allocateBackupNumber(serverId) {
  const next = peekBackupNumber(serverId);
  setSetting(`backup_seq_${serverId}`, String(next));
  return next;
}

function unprotectedBackups(serverId) {
  try {
    return db.prepare("SELECT * FROM backups WHERE server_id = ? AND protected = 0 ORDER BY created_at ASC, number ASC").all(serverId);
  } catch {
    return [];
  }
}

/** Oldest unprotected backups that are above the retention limit. */
function overLimitBackups(serverId) {
  const limit = backupLimitFor(getServerRow(serverId));
  if (!limit) return [];
  const rows = unprotectedBackups(serverId);
  return rows.length > limit ? rows.slice(0, rows.length - limit) : [];
}

function deleteBackupRecord(row, { force = false } = {}) {
  if (!row) return false;
  if (row.protected && !force) {
    const err = new Error("This backup is protected. Unprotect it before deleting.");
    err.status = 409;
    throw err;
  }
  if (row.path && existsSync(row.path)) {
    try {
      unlinkSync(row.path);
    } catch (e) {
      const err = new Error(`Could not delete the backup file: ${e?.message || String(e)}`);
      err.status = 409;
      throw err;
    }
  }
  db.prepare("DELETE FROM backups WHERE id = ? AND server_id = ?").run(row.id, row.server_id);
  return true;
}

async function createBackupRecord(serverId, { name = "", protect = false, reason = "manual" } = {}) {
  const row = getServerRow(serverId);
  if (!row) {
    const err = new Error("Server not found");
    err.status = 404;
    throw err;
  }
  return await withBackupLock(serverId, async () => {
    const dir = serverBackupsDir(serverId);
    mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    const path = join(dir, `${id}.${BACKUP_FORMAT}`);
    const discardArchive = () => { try { if (existsSync(path)) unlinkSync(path); } catch {} };
    let size;
    try {
      size = await createBackupArchive(serverFilesDir(serverId), path);
    } catch (e) {
      discardArchive();
      throw e;
    }
    const number = allocateBackupNumber(serverId);
    const cleanName = normalizeBackupName(name) || `Backup #${number}`;
    const protectedFlag = protect ? 1 : 0;
    try {
      db.prepare("INSERT INTO backups(id,server_id,path,size,name,number,protected,format,reason) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, serverId, path, size, cleanName, number, protectedFlag, BACKUP_FORMAT, String(reason || "manual"));
    } catch (e) {
      discardArchive();
      throw e;
    }
    if (getServerRow(serverId)?.backup_auto_prune) {
      enforceBackupLimit(serverId, { keepId: id });
    }
    const created = db.prepare("SELECT * FROM backups WHERE id = ?").get(id);
    logLine(serverId, `[backup] Created ${cleanName} (${formatBytes(size)})`);
    return backupJson(created);
  });
}

function enforceBackupLimit(serverId, { keepId = null } = {}) {
  const limit = backupLimitFor(getServerRow(serverId));
  if (!limit) return { deleted: 0, kept: 0 };
  const rows = unprotectedBackups(serverId);
  let excess = rows.length - limit;
  let deleted = 0;
  for (const row of rows) {
    if (excess <= 0) break;
    // Never prune the snapshot that was just created. It becomes the oldest
    // unprotected backup on a later run and can be pruned then.
    if (keepId && row.id === keepId) continue;
    try {
      deleteBackupRecord(row);
      deleted++;
      excess--;
    } catch {}
  }
  if (deleted) logLine(serverId, `[backup] Retention limit ${limit}: removed ${deleted} backup(s) over the limit`);
  return { deleted, kept: rows.length - deleted };
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseExec(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function parseJsonField(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function modFromRow(row) {
  return {
    ...row,
    game_versions: parseJsonField(row.game_versions, []),
    loaders: parseJsonField(row.loaders, []),
    dependencies: parseJsonField(row.dependencies, []),
    meta: parseJsonField(row.meta, null),
    enabled: !!row.enabled,
  };
}

function modsFolder(serverId, loader) {
  return join(serverFilesDir(serverId), folderForTarget(modsTarget(loader)));
}

function modsFolderFor(serverId, loader, projectType) {
  return modsFolder(serverId, projectType === "datapack" ? "vanilla" : loader);
}

function createServerRecordSync(body) {
  const errors = validateServerInput(body);
  if (errors.length > 0) {
    const err = new Error(errors.join(", "));
    err.status = 400;
    err.errors = errors;
    throw err;
  }
  const loader = body.loader || "vanilla";
  const loaderMeta = (getLoader(loader) || { meta: () => ({}) }).meta?.() || {};
  const jvmManaged = !!loaderMeta.java;
  const defaultPort = portProfile(loader).find((p) => p.role === "game")?.defaultPort ?? 25565;
  const { name, loader_version, loader_build, java_version, memory_min = "512M", port = defaultPort, motd = "A SMP Server", jar = "server.jar", auto_start = 0 } = body;
  const safePort = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535 ? Number(port) : defaultPort;
  const memory_max = jvmManaged ? formatMemoryMb(clampMemoryMb(parseMemoryMb(body.memory_max ?? body.memory ?? body.ram ?? "2G", 2048))) : "2G";
  const jvm_args = jvmManaged ? normalizeJvmArgs(body.jvm_args) : "";
  const id = crypto.randomUUID();
  ensureServerDir(id);
  writeServerEula(id, false);
  db.prepare("INSERT INTO servers(id,name,dir,loader,loader_version,loader_build,java_version,jar,memory_max,memory_min,port,motd,auto_start,jvm_args) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, name, serverPath(id), loader, loader_version || "", loader_build || "", java_version || "", jar, memory_max, memory_min, safePort, motd, auto_start ? 1 : 0, jvm_args);
  const propPath = serverPropPath(id);
  mkdirSync(dirname(propPath), { recursive: true });
  writeFileSync(propPath, loader === "endstone"
    ? `server-name=${motd}\nserver-port=${safePort}\n`
    : `motd=${motd}\nserver-port=${safePort}\nenable-query=true\n`);
  return { id, loader: loaderMeta, loaderId: loader };
}

function uploadDir() {
  const dir = join(DATA_DIR, "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveUpload(uploadId) {
  if (typeof uploadId !== "string" || !/^[0-9a-f-]{36}$/i.test(uploadId)) return null;
  const path = join(uploadDir(), `${uploadId}.zip`);
  return existsSync(path) ? path : null;
}

function serverDataFromRow(row) {
  const lm = (getLoader(row.loader) || { meta: () => ({}) }).meta?.() || {};
  return {
    name: row.name,
    loader: row.loader,
    loader_version: row.loader_version,
    loader_build: row.loader_build,
    loader_channel: row.loader_channel,
    java_version: row.java_version,
    memory_min: row.memory_min,
    memory_max: row.memory_max,
    jvm_args: row.jvm_args,
    port: row.port,
    motd: row.motd,
    online: !!row.online,
    created_at: row.created_at,
    eula_required: !!lm.eula,
    custom: !!lm.custom,
    java: !!lm.java,
    exec: parseExec(row.exec),
  };
}
function readServerEula(id) {
  try {
    const p = serverEulaPath(id);
    if (!existsSync(p)) return { accepted: false, value: "false", exists: false };
    const txt = readFileSync(p, "utf8");
    const m = txt.match(/^\s*eula\s*=\s*(true|false)\s*$/im);
    const value = m ? m[1].toLowerCase() : "false";
    return { accepted: value === "true", value, exists: true };
  } catch { return { accepted: false, value: "false", exists: false }; }
}
function writeServerEula(id, accepted) {
  ensureServerDir(id);
  writeFileSync(serverEulaPath(id), `eula=${accepted ? "true" : "false"}\n`, "utf8");
}

function ensureServerDir(id) {
  const p = serverPath(id);
  mkdirSync(p, { recursive: true });
  mkdirSync(serverFilesDir(id), { recursive: true });
  mkdirSync(serverBackupsDir(id), { recursive: true });

  const eulaPath = serverEulaPath(id);
  if (!existsSync(eulaPath)) writeFileSync(eulaPath, "eula=false\n", "utf8");

  return serverFilesDir(id);
}

function getProp(id, key, def) {
  try {
    const lookup = key === "motd" && isEndstoneServer(id) ? "server-name" : key;
    const txt = readFileSync(serverPropPath(id), "utf8");
    const line = txt.split(/\r?\n/).find(l => l.startsWith(lookup + "="));
    return line ? line.split("=").slice(1).join("=") : def;
  } catch (e) { return def; }
}

function setProp(id, key, value) {
  const p = serverPropPath(id);
  const actualKey = key === "motd" && isEndstoneServer(id) ? "server-name" : key;
  let txt = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = txt.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ""));
  const idx = lines.findIndex(l => l.startsWith(actualKey + "="));
  if (idx >= 0) lines[idx] = `${actualKey}=${value}`;
  else lines.push(`${actualKey}=${value}`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
}

const LOG_FLUSH_MS = 250;
const LOG_MAX_BYTES = 10 * 1024 * 1024;

function getLogState(id) {
  const arr = globalThis.__smp_logs || (globalThis.__smp_logs = new Map());
  let st = arr.get(id);
  if (!st) { st = { lines: [], next: 0, loaded: false, pending: [], flushTimer: null }; arr.set(id, st); }
  if (!st.pending) st.pending = [];
  return st;
}
function flushLogs(id) {
  const st = getLogState(id);
  if (st.flushTimer) { clearTimeout(st.flushTimer); st.flushTimer = null; }
  if (!st.pending || st.pending.length === 0) return;
  const text = st.pending.join("\n") + "\n";
  st.pending.length = 0;
  try {
    const logPath = serverLogPath(id);
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
      try { renameSync(logPath, logPath + ".1"); } catch {}
    }
    appendFileSync(logPath, text);
  } catch {}
}
function flushAllLogs() {
  const arr = globalThis.__smp_logs;
  if (!arr) return;
  for (const id of arr.keys()) { try { flushLogs(id); } catch {} }
}
function loadLogsFromDisk(id) {
  const st = getLogState(id);
  if (st.loaded) return st;
  st.loaded = true;
  try {
    const logPath = serverLogPath(id);
    if (existsSync(logPath)) {
      const txt = readFileSync(logPath, "utf8");
      const lines = txt.split(/\r?\n/).filter(l => l.trim());
      const start = Math.max(0, lines.length - 4000);
      st.lines = lines.slice(start).map((t, i) => ({ n: start + i, t }));
      st.next = start + st.lines.length;
    }
  } catch {}
  return st;
}
function clearLogs(id) {
  const arr = globalThis.__smp_logs || (globalThis.__smp_logs = new Map());
  const old = arr.get(id);
  if (old?.flushTimer) clearTimeout(old.flushTimer);
  arr.set(id, { lines: [], next: 0, loaded: true, pending: [], flushTimer: null });
  try { writeFileSync(serverLogPath(id), ""); } catch {}
  pushLogEvent(id, { clear: true, next: 0 });
}
function pushLogEvent(id, payload) {
  const set = logStreams.get(id);
  if (!set || !set.size) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  let bytes;
  for (const c of [...set]) {
    try { c.enqueue(bytes || (bytes = new TextEncoder().encode(msg))); } catch { set.delete(c); }
  }
}
function logLine(id, text) {
  const st = getLogState(id);
  const raw = String(text ?? "").replace(/\r?\n$/, "");
  if (raw === "") return;
  const entry = { n: st.next++, t: `[${new Date().toISOString()}] ${raw}` };
  st.lines.push(entry);
  if (st.lines.length > 4000) st.lines.splice(0, st.lines.length - 4000);
  st.pending.push(entry.t);
  if (st.pending.length >= 500) flushLogs(id);
  else if (!st.flushTimer) st.flushTimer = setTimeout(() => { st.flushTimer = null; flushLogs(id); }, LOG_FLUSH_MS);
  pushLogEvent(id, { line: entry.t, n: entry.n });
}
process.on("exit", flushAllLogs);
function getLogs(id, after, limit) {
  const st = loadLogsFromDisk(id);
  const a = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : null;
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  if (a != null) {
    const firstN = st.lines.length ? st.lines[0].n : st.next;
    if (a > st.next) return { lines: [], next: st.next, full: false };
    const from = a <= firstN ? 0 : a - firstN;
    let list = st.lines.slice(from).map(x => x.t);
    if (lim) list = list.slice(-lim);
    return { lines: list, next: st.next, full: false };
  }
  let list = st.lines.map(x => x.t);
  if (lim) list = list.slice(-lim);
  return { lines: list, next: st.next, full: true };
}

const runningServers = new Map();
const logStreams = new Map(); // id -> Set<ReadableStreamDefaultController>

function setServerPid(id, pid) {
  try { db.prepare("UPDATE servers SET pid = ?, online = ? WHERE id = ?").run(pid ?? null, pid ? 1 : 0, id); } catch {}
}
function getServerRow(id) {
  if (!isValidServerId(id)) return null;
  return db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
}
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

// Loader implementations live in ./loaders/* (class per loader, versions with stability, eula/custom/exec metadata).

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
    command = await resolveJavaCommand(JAVA_DIR, r.java_version, "java");
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

/**
 * Create a server with a fully allocated, collision-free port set.
 * The game port comes from `body.port` when provided; otherwise the loader
 * default is used and moved to the next free port if it is already taken.
 */
async function createServerRecord(body = {}) {
  const loaderId = String(body.loader || "vanilla");
  const profile = portProfile(loaderId);
  const defaultPort = profile.find((p) => p.role === "game")?.defaultPort ?? 25565;
  const requestedPorts = body.ports && typeof body.ports === "object" && !Array.isArray(body.ports) ? { ...body.ports } : {};
  if (body.port !== undefined && body.port !== null && body.port !== "") requestedPorts.game = Number(body.port);
  delete body.ports;
  let allocation;
  try {
    allocation = await allocateServerPorts({
      serverId: null,
      loaderId,
      requested: Object.keys(requestedPorts).length ? requestedPorts : null,
      checkOs: true,
    });
  } catch (e) {
    if (e instanceof PortConflictError) { e.status = 409; e.errors = [e.message]; }
    throw e;
  }
  const gamePort = allocation.ports.find((p) => p.role === "game")?.port ?? defaultPort;
  const created = createServerRecordSync({ ...body, port: gamePort });
  saveServerPorts(created.id, allocation.ports);
  applyPortsToConfig({ dir: serverFilesDir(created.id), loaderId, ports: allocation.ports });
  return { ...created, ports: allocation.ports };
}

// ============ SERVERS ============
export const serversRoute = new Elysia({ prefix: "/api/servers" })
  .get("/", async ({ query }) => {
    const rows = db.prepare("SELECT * FROM servers ORDER BY name ASC").all();
    const modsByServer = new Map();
    for (const m of db.prepare("SELECT * FROM mods").all()) {
      if (!modsByServer.has(m.server_id)) modsByServer.set(m.server_id, []);
      modsByServer.get(m.server_id).push(modFromRow(m));
    }
    const withUpdates = String(query?.updates || "") === "1";
    const out = [];
    for (const r of rows) {
      const mods = modsByServer.get(r.id) || [];
      const online = isRunning(r.id);
      if (!online && r.pid) setServerPid(r.id, null);
      const lm = (getLoader(r.loader) || { meta: () => ({}) }).meta?.() || {};
      const pack = getModpackRow(r.id);
      let update = null;
      // A modpack is updated through its own project version, not through the loader.
      if (withUpdates && !online && !pack) {
        try { update = await getServerUpdateInfo(r); } catch { update = null; }
      }
      out.push({ ...r, online: online ? 1 : 0, ports: serverPortsStatus(r), mods, java: !!lm.java, eula_required: !!lm.eula, loader_custom: !!lm.custom, has_icon: hasServerIcon(r.id), icon_version: serverIconVersion(r.id), update, modpack: pack ? modpackMeta(pack) : null });
    }
    return { servers: out };
  })
  .post("/", async ({ body }) => {
    try {
      const created = await createServerRecord(body);
      return { id: created.id, ok: true, loader: created.loader };
    } catch (e) {
      const status = e?.status || 500;
      return new Response(JSON.stringify({ errors: e?.errors || [e?.message || "Invalid server"] }), { status, headers: { "Content-Type": "application/json" } });
    }
  })
  .get("/:id", async ({ params, query }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response("Not found", { status: 404 });
    const mods = db.prepare("SELECT * FROM mods WHERE server_id = ?").all(row.id).map(modFromRow);
    const online = isRunning(row.id);
    if (!online && row.pid) setServerPid(row.id, null);
    const lm = (getLoader(row.loader) || { meta: () => ({}) }).meta?.() || {};
    const withUpdates = String(query?.updates || "1") !== "0";
    const packRow = getModpackRow(row.id);
    let modpack = packRow ? { ...modpackMeta(packRow), update: null } : null;
    let update = null;
    if (withUpdates && !online) {
      if (packRow) {
        try {
          const info = await getModpackUpdateInfo(packRow);
          modpack = { ...modpack, ...info, update: info };
        } catch { modpack.update = null; }
      } else {
        try { update = await getServerUpdateInfo(row); } catch { update = null; }
      }
    }
    return { server: { ...row, online: online ? 1 : 0, ports: serverPortsStatus(row), strict_ports: getSetting(`ports_strict_${row.id}`, "0") === "1", port_profile: portProfile(row.loader), mods, java: !!lm.java, eula_required: !!lm.eula, loader_custom: !!lm.custom, has_icon: hasServerIcon(row.id), icon_version: serverIconVersion(row.id), update, modpack } };
  })
  .post("/:id/ports", ({ params, body, set }) => {
    if (!isValidServerId(params.id) || !getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const label = String(body?.label || "").trim().slice(0, 60);
    const port = Number(body?.port);
    const protocol = String(body?.protocol || "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
    if (!label) { set.status = 400; return { ok: false, error: "A name is required" }; }
    if (!isPortNumber(port)) { set.status = 400; return { ok: false, error: "Port must be between 1 and 65535" }; }
    const owner = findPortOwner(port, protocol);
    if (owner) {
      set.status = 409;
      const who = owner.serverName ? ` (used by "${owner.serverName}")` : "";
      return { ok: false, error: `Port ${port}/${protocol.toUpperCase()} is already in use${who}.`, conflict: owner };
    }
    return { ok: true, port: { ...insertServerExtraPort({ serverId: params.id, label, port, protocol }), custom: true } };
  })
  .post("/:id/ports/autofix", async ({ params, set }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (isRunning(params.id)) { set.status = 409; return { ok: false, error: "Stop the server before auto-assigning ports." }; }
    try {
      const before = serverPortsStatus(row).filter((p) => !p.custom);
      const allocation = await allocateServerPorts({ serverId: params.id, loaderId: row.loader, requested: null, checkOs: true });
      saveServerPorts(params.id, allocation.ports);
      applyPortsToConfig({ dir: serverFilesDir(params.id), loaderId: row.loader, ports: allocation.ports });
      const after = serverPortsStatus(getServerRow(params.id)).filter((p) => !p.custom);
      const moved = after.map((p) => {
        const old = before.find((b) => b.role === p.role);
        return old && old.port !== p.port ? { role: p.role, label: p.label, from: old.port, to: p.port, protocol: p.protocol } : null;
      }).filter(Boolean);
      return { ok: true, ports: after, moved };
    } catch (e) {
      set.status = e?.status || 500;
      return { ok: false, error: e?.message || String(e), conflicts: e?.conflicts || [] };
    }
  })
  .patch("/:id/ports/:portId", ({ params, body, set }) => {
    if (!isValidServerId(params.id) || !getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const extra = getServerExtraPorts(params.id).find((e) => e.id === String(params.portId));
    if (!extra) { set.status = 404; return { ok: false, error: "Port reservation not found" }; }
    const port = Number(body?.port);
    if (!isPortNumber(port)) { set.status = 400; return { ok: false, error: "Port must be between 1 and 65535" }; }
    const owner = findPortOwner(port, extra.protocol, { excludeExtraId: extra.id });
    if (owner) {
      set.status = 409;
      const who = owner.serverName ? ` (used by "${owner.serverName}")` : "";
      return { ok: false, error: `Port ${port}/${extra.protocol.toUpperCase()} is already in use${who}.`, conflict: owner };
    }
    updateServerExtraPort(params.id, extra.id, { port });
    return { ok: true };
  })
  .delete("/:id/ports/:portId", ({ params }) => {
    if (!isValidServerId(params.id) || !getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    deleteServerExtraPort(params.id, String(params.portId));
    return { ok: true };
  })
  .delete("/:id", ({ params }) => {
    if (!isValidServerId(params.id)) return new Response("Not found", { status: 404 });
    const r = runningServers.get(params.id);
    try { if (r?.proc && r.proc.exitCode == null) r.proc.kill("SIGTERM"); } catch {}
    runningServers.delete(params.id);
    const backups = db.prepare("SELECT path FROM backups WHERE server_id = ?").all(params.id);
    for (const b of backups) { try { if (b?.path && existsSync(b.path)) unlinkSync(b.path); } catch {} }
    try { db.prepare("DELETE FROM mods WHERE server_id = ?").run(params.id); } catch {}
    try { db.prepare("DELETE FROM backups WHERE server_id = ?").run(params.id); } catch {}
    try { db.prepare("DELETE FROM schedules WHERE server_id = ?").run(params.id); } catch {}
    try { db.prepare("DELETE FROM server_extra_ports WHERE server_id = ?").run(params.id); } catch {}
    try { db.prepare("DELETE FROM servers WHERE id = ?").run(params.id); } catch {}
    try { db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`sftp_%_${params.id}`); } catch {}
    try { db.prepare("DELETE FROM settings WHERE key = ?").run(sftpEnabledKey(params.id)); } catch {}
    try { db.prepare("DELETE FROM settings WHERE key = ?").run(sftpPasswordKey(params.id)); } catch {}
    try { db.prepare("DELETE FROM settings WHERE key = ?").run(`backup_seq_${params.id}`); } catch {}
    try { db.prepare("DELETE FROM settings WHERE key = ?").run(`ports_strict_${params.id}`); } catch {}
    try { const dir = serverPath(params.id); if (existsSync(dir)) rmdirRecursive(dir); } catch {}
    return { ok: true };
  })
  .patch("/:id", async ({ params, body }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response("Not found", { status: 404 });
    if (!body || typeof body !== "object") return new Response(JSON.stringify({ error: "Invalid body" }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (body.strict_ports !== undefined) {
      setSetting(`ports_strict_${params.id}`, body.strict_ports ? "1" : "0");
      delete body.strict_ports;
    }
    if (isRunning(params.id) && (body.loader !== undefined || body.loader_version !== undefined || body.loader_build !== undefined || body.jar !== undefined)) {
      return new Response(JSON.stringify({ error: "Stop the server before changing loader, version, or jar." }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    const effectiveLoader = body.loader !== undefined ? body.loader : row.loader;
    // Re-allocate the whole port set when the primary port or the loader changes.
    // This also migrates Java <-> Bedrock defaults and drops roles the new loader lacks.
    const loaderChanging = body.loader !== undefined && String(body.loader) !== String(row.loader || "");
    // Role-specific edits (e.g. Bedrock's IPv6 port) arrive as body.ports.
    const extraPorts = body.ports && typeof body.ports === "object" && !Array.isArray(body.ports) ? body.ports : null;
    delete body.ports;
    const touchesPrimary = body.port !== undefined || extraPorts?.game !== undefined || loaderChanging;
    let allocatedPorts = null;
    if (touchesPrimary || extraPorts) {
      const requested = { ...(extraPorts || {}) };
      if (body.port !== undefined) requested.game = body.port;
      try {
        const allocation = await allocateServerPorts({
          serverId: params.id,
          loaderId: effectiveLoader,
          requested: Object.keys(requested).length ? requested : null,
          // Editing only a secondary role must not silently move the primary port.
          checkOs: !isRunning(params.id) && touchesPrimary,
        });
        allocatedPorts = allocation.ports;
        body.port = allocatedPorts.find((p) => p.role === "game")?.port ?? body.port;
      } catch (e) {
        if (e instanceof PortConflictError) {
          return new Response(JSON.stringify({ ok: false, error: e.message, conflicts: e.conflicts }), { status: 409, headers: { "Content-Type": "application/json" } });
        }
        throw e;
      }
    }
    const loaderMeta = (getLoader(effectiveLoader) || { meta: () => ({ java: true }) }).meta?.() || {};
    const jvmManaged = !!loaderMeta.java;
    if (!jvmManaged) {
      delete body.memory_max; delete body.memory_min; delete body.jvm_args; delete body.memory; delete body.ram;
    } else {
      if (body.memory_max !== undefined || body.memory !== undefined || body.ram !== undefined) {
        body.memory_max = formatMemoryMb(clampMemoryMb(parseMemoryMb(body.memory_max ?? body.memory ?? body.ram, parseMemoryMb(row.memory_max, 2048))));
      }
      if (body.jvm_args !== undefined) body.jvm_args = normalizeJvmArgs(body.jvm_args);
    }

    // Automatic pre-change backups. They happen before any DB column or jar
    // is touched, so the snapshot represents the server exactly as it was.
    const loaderChanged = body.loader !== undefined && String(body.loader) !== String(row.loader || "");
    const versionChanged = (body.loader_version !== undefined && String(body.loader_version) !== String(row.loader_version || ""))
      || (body.loader_build !== undefined && String(body.loader_build) !== String(row.loader_build || ""))
      || (body.jar !== undefined && String(body.jar) !== String(row.jar || ""));
    const shouldBackupUpdate = versionChanged && !!row.backup_on_update;
    const shouldBackupLoader = loaderChanged && !!row.backup_on_loader;
    if (shouldBackupUpdate || shouldBackupLoader) {
      try {
        await createBackupRecord(params.id, { reason: loaderChanged && shouldBackupLoader ? "loader" : "update" });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: `Automatic backup failed: ${e?.message || String(e)}` }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    if (body.backup_limit !== undefined) {
      const n = Number(body.backup_limit);
      body.backup_limit = Number.isFinite(n) ? Math.max(0, Math.min(9999, Math.floor(n))) : 0;
    }
    for (const key of ["backup_on_stop", "backup_on_update", "backup_on_loader", "backup_auto_prune"]) {
      if (body[key] !== undefined) body[key] = flagValue(body[key]);
    }
    if (body.exec !== undefined) {
      // Custom start command: store the executable + args the launcher spawns.
      const execLoader = String(body.loader !== undefined ? body.loader : row.loader || "");
      const execMeta = (getLoader(execLoader) || { meta: () => ({}) }).meta?.() || {};
      if (!execMeta.custom) {
        return new Response(JSON.stringify({ error: "Start command is only available for custom loaders" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const rawExec = typeof body.exec === "string" ? body.exec : JSON.stringify(body.exec);
      const parsedExec = parseExec(rawExec);
      if (!parsedExec || typeof parsedExec.command !== "string" || !parsedExec.command.trim()) {
        return new Response(JSON.stringify({ error: "Invalid start command" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      body.exec = JSON.stringify({
        ...parsedExec,
        type: ["java", "bedrock", "custom"].includes(parsedExec.type) ? parsedExec.type : "custom",
        command: parsedExec.command.trim(),
        args: Array.isArray(parsedExec.args) ? parsedExec.args.map((a) => String(a)) : [],
      });
    }
    const allowedFields = ["name", "loader", "loader_version", "loader_build", "loader_channel", "java_version", "jar", "memory_min", "memory_max", "jvm_args", "port", "motd", "auto_start", "backup_limit", "backup_on_stop", "backup_on_update", "backup_on_loader", "backup_auto_prune", "exec"];
    const fields = [], vals = [];
    for (const [k, v] of Object.entries(body)) {
      if (!allowedFields.includes(k)) continue;
      let value = v;
      if (k === "port") {
        value = Number(v);
        if (!Number.isInteger(value) || value < 1 || value > 65535) continue;
      }
      if (k === "name") {
        if (typeof value !== "string" || !value.trim() || value.length > 100) continue;
      }
      if (k === "auto_start" || k === "backup_on_stop" || k === "backup_on_update" || k === "backup_on_loader" || k === "backup_auto_prune") value = flagValue(value);
      fields.push(`${k} = ?`);
      vals.push(value);
    }
    if (fields.length > 0) {
      vals.push(params.id);
      db.prepare(`UPDATE servers SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    }
    if (body.motd !== undefined) setProp(params.id, "motd", body.motd);
    if (allocatedPorts) {
      saveServerPorts(params.id, allocatedPorts);
      applyPortsToConfig({ dir: serverFilesDir(params.id), loaderId: effectiveLoader, ports: allocatedPorts });
    }
    if (body.backup_limit !== undefined || body.backup_auto_prune !== undefined) {
      // Existing backups are only pruned when the server explicitly opts into
      // automatic cleanup. Otherwise the UI offers a manual "delete over limit".
      if (getServerRow(params.id)?.backup_auto_prune) enforceBackupLimit(params.id);
    }
    return { ok: true };
  });

// ============ CONTROL ============
export const controlRoute = new Elysia({ prefix: "/api/servers" })
  .post("/:id/eula", ({ params, body }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const accepted = !!(body && (body.accepted === true || body.accepted === "true"));
    ensureServerDir(params.id);
    writeServerEula(params.id, accepted);
    return { ok: true, ...readServerEula(params.id), serverId: params.id, url: "https://www.minecraft.net/eula" };
  })
  .post("/:id/start", async ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const r = await startServerById(params.id, row);
    if (r instanceof Response) return r;
    return r;
  })
  .post("/:id/stop", async ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const stopped = await stopServerProcess(params.id);
    if (!stopped) {
      setServerPid(params.id, null);
      return { ok: true, stopped: false, message: "Server not running in this panel session" };
    }
    let backup = null;
    let backupError = null;
    if (row.backup_on_stop) {
      try {
        backup = await createBackupRecord(params.id, { reason: "shutdown" });
      } catch (e) {
        backupError = e?.message || String(e);
        logLine(params.id, `[backup] On-stop backup failed: ${backupError}`);
      }
    }
    return { ok: true, stopped: true, backup, backupError };
  })
  .post("/:id/force-stop", async ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const stopped = await forceStopServerProcess(params.id);
    if (!stopped) {
      setServerPid(params.id, null);
      return { ok: true, stopped: false, message: "The server process is not running in this panel session." };
    }
    return { ok: true, stopped: true };
  })
  .post("/:id/restart", async ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const r = runningServers.get(params.id);
    if (r?.proc && r.proc.exitCode == null) {
      logLine(params.id, "Restarting...");
      await stopServerProcess(params.id);
      await new Promise(r2 => setTimeout(r2, 800));
    }
    const res = await startServerById(params.id, row);
    if (res instanceof Response) return res;
    return res;
  })
  .post("/:id/command", ({ params, body }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const r = runningServers.get(params.id);
    const proc = r?.proc;
    if (!proc || proc.exitCode != null || !proc.stdin?.writable) {
      return new Response(JSON.stringify({ ok: false, error: "Server not running in this panel session. Start it from this panel to send commands." }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    const command = (body?.command ?? "").toString();
    if (!command.trim()) return new Response(JSON.stringify({ ok: false, error: "Empty command" }), { status: 400, headers: { "Content-Type": "application/json" } });
    try {
      proc.stdin.write(command.replace(/\r?\n$/, "") + "\n");
      logLine(params.id, `> ${command}`);
      return { ok: true };
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  })
  .get("/:id/logs", ({ params, query }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const after = query?.after != null && query.after !== "" ? Number(query.after) : null;
    const limit = query?.limit != null && query.limit !== "" ? Number(query.limit) : null;
    const res = getLogs(params.id, Number.isFinite(after) ? after : null, Number.isFinite(limit) ? limit : null);
    return { ok: true, lines: res.lines, next: res.next, running: isRunning(params.id) };
  })
  .get("/:id/stats", async ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const memoryMaxBytes = parseMemoryMb(row.memory_max, 2048) * 1024 * 1024;
    const online = isRunning(params.id);
    const pid = online ? (runningServers.get(params.id)?.proc?.pid || row.pid || null) : null;
    if (!online || !pid) {
      procUsageSamples.delete(row.pid);
      return { ok: true, online: false, pid: null, cpuPercent: 0, memoryBytes: 0, memoryMaxBytes, timestamp: Date.now() };
    }
    const sample = await readProcessUsage(pid);
    if (!sample) {
      return { ok: true, online: true, pid, cpuPercent: 0, memoryBytes: 0, memoryMaxBytes, error: "Process stats unavailable", timestamp: Date.now() };
    }
    const now = Date.now();
    const prev = procUsageSamples.get(pid);
    let cpuPercent = 0;
    if (prev && now > prev.t && sample.cpuSeconds >= prev.cpuSeconds) {
      cpuPercent = ((sample.cpuSeconds - prev.cpuSeconds) / ((now - prev.t) / 1000)) * 100;
    }
    procUsageSamples.set(pid, { cpuSeconds: sample.cpuSeconds, t: now });
    return {
      ok: true,
      online: true,
      pid,
      cpuPercent: Math.max(0, Math.round(cpuPercent * 10) / 10),
      memoryBytes: sample.memoryBytes,
      memoryMaxBytes,
      timestamp: now,
    };
  })
  .get("/:id/logs/stream", ({ params, request }) => {
    if (!getServerRow(params.id)) return new Response("Not found", { status: 404 });
    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const id = params.id;
    let ctrl;
    const stream = new ReadableStream({
      start(c) {
        ctrl = c;
        let set = logStreams.get(id);
        if (!set) { set = new Set(); logStreams.set(id, set); }
        set.add(c);
        const init = getLogs(id, after != null && after !== "" ? Number(after) : null);
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ init: init.lines, next: init.next, running: isRunning(id) })}\n\n`));
        const hb = setInterval(() => {
          try { c.enqueue(new TextEncoder().encode(`: ping\n\n`)); } catch { try { clearInterval(hb); } catch {} }
        }, 15000);
        c._hb = hb;
      },
      cancel() {
        try { clearInterval(ctrl?._hb); } catch {}
        const set = logStreams.get(id);
        if (set) { set.delete(ctrl); if (!set.size) logStreams.delete(id); }
      }
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
  })
  .delete("/:id/logs", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    clearLogs(params.id); return { ok: true };
  });


// ============ JAR DOWNLOAD ============
function versionChannel(v) {
  const c = String(v?.channel || (v?.stable === false ? "experimental" : "stable")).toLowerCase();
  return c === "experimental" ? "experimental" : "stable";
}
function normalizeVersionList(list) {
  return (Array.isArray(list) ? list : []).map((v) => (typeof v === "string" ? { id: v, stable: true, channel: "stable" } : {
    id: v.id,
    stable: v.stable !== false && versionChannel(v) !== "experimental",
    channel: versionChannel(v),
    ...(v.meta ? { meta: v.meta } : {}),
  })).filter((v) => v.id);
}
function filterVersionsByChannel(list, channel = "all") {
  const want = String(channel || "all").toLowerCase();
  const items = normalizeVersionList(list);
  if (want === "stable" || want === "release" || want === "normal") return items.filter((v) => v.channel === "stable");
  if (want === "experimental" || want === "snapshot" || want === "beta") return items.filter((v) => v.channel === "experimental");
  return items;
}
function compareVersionLike(a, b) {
  const pa = String(a || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? -1, db = pb[i] ?? -1;
    if (da !== db) return da - db;
  }
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}
async function getLoaderVersions(loaderId, channel = "all") {
  const impl = getLoader(loaderId);
  if (!impl) return { impl: null, items: [], filtered: [] };
  const list = normalizeVersionList(await impl.getVersions());
  return { impl, items: list, filtered: filterVersionsByChannel(list, channel) };
}
function buildUpdateInfo(row, items) {
  const out = { loader: row?.loader || "", installed: row?.loader_version || "", channel: row?.loader_channel || null, latestStable: null, latestExperimental: null, recommended: null, recommendation: null };
  if (!out.installed || !Array.isArray(items) || !items.length) return out;
  const stable = items.filter((v) => v.channel === "stable");
  const experimental = items.filter((v) => v.channel === "experimental");
  out.latestStable = stable[0]?.id || null;
  out.latestExperimental = experimental[0]?.id || null;
  const installedItem = items.find((v) => String(v.id) === String(out.installed));
  const installedChannel = out.channel || installedItem?.channel || "stable";
  out.channel = installedChannel;
  const sameChannel = (installedChannel === "experimental" ? experimental : stable);
  const latestSame = sameChannel[0]?.id || null;
  if (latestSame && String(latestSame) !== String(out.installed)) {
    const newer = compareVersionLike(latestSame, out.installed) > 0 || sameChannel.findIndex((v) => String(v.id) === String(latestSame)) < sameChannel.findIndex((v) => String(v.id) === String(out.installed));
    if (newer) {
      out.recommended = latestSame;
      out.recommendation = installedChannel === "experimental"
        ? `Nueva versión experimental disponible: ${latestSame}`
        : `Nueva versión estable disponible: ${latestSame}`;
    }
  }
  return out;
}
function modpackMeta(pack) {
  return {
    source: pack.source || "",
    project_id: pack.project_id || "",
    title: pack.title || "",
    version_id: pack.version_id || "",
    version: pack.version || pack.version_id || "",
    icon_url: pack.icon_url || "",
    store_url: pack.store_url || "",
    loader: pack.loader || "",
    loader_version: pack.loader_version || "",
    loader_build: pack.loader_build || "",
  };
}

function getModpackRow(serverId) {
  try {
    return db.prepare("SELECT * FROM modpacks WHERE server_id = ? ORDER BY created_at DESC LIMIT 1").get(serverId) || null;
  } catch {
    return null;
  }
}

const __packUpdateCache = globalThis.__smp_pack_update_cache || (globalThis.__smp_pack_update_cache = new Map());
async function getModpackUpdateInfo(pack, { force = false } = {}) {
  const out = {
    ...modpackMeta(pack),
    installed_version: pack.version || pack.version_id || "",
    latest_version: "",
    latest_version_id: null,
    recommended: false,
    recommendation: null,
    error: null,
  };
  if (!pack.project_id || !pack.source || pack.source === "custom") return out;
  const key = `${pack.source}:${pack.project_id}`;
  const cached = __packUpdateCache.get(key);
  const now = Date.now();
  let latest = cached?.latest;
  if (force || !cached || now - cached.at > 10 * 60 * 1000) {
    try {
      latest = await latestVersion(pack.source, pack.project_id);
      __packUpdateCache.set(key, { at: now, latest });
    } catch (e) {
      latest = cached?.latest || null;
      out.error = e?.message || String(e);
    }
  }
  if (!latest?.id) return out;
  out.latest_version_id = String(latest.id);
  out.latest_version = latest.version_number || latest.name || latest.id;
  out.latest_game_versions = latest.game_versions || [];
  out.latest_loaders = latest.loaders || [];
  const installedId = String(pack.version_id || "");
  if (installedId && installedId === out.latest_version_id) {
    // Older modpack rows only stored the version id; use the project metadata now.
    out.version = out.latest_version;
    out.installed_version = out.latest_version;
    out.title = latest.project_title || out.title;
    out.icon_url = latest.icon_url || out.icon_url;
    out.store_url = latest.store_url || out.store_url;
  }
  if (installedId && installedId !== out.latest_version_id) {
    out.recommended = true;
    out.recommendation = `${pack.title || "Modpack"} ${out.latest_version} available`;
  }
  return out;
}

const __updateCache = globalThis.__smp_updateCache || (globalThis.__smp_updateCache = new Map());
async function getServerUpdateInfo(row, { force = false } = {}) {
  if (!row?.loader || !row?.loader_version) return null;
  const key = `${row.loader}`;
  const cached = __updateCache.get(key);
  const now = Date.now();
  let items = cached?.items;
  if (force || !cached || now - cached.at > 10 * 60 * 1000) {
    try { items = (await getLoaderVersions(row.loader, "all")).items; __updateCache.set(key, { at: now, items }); }
    catch { items = cached?.items || []; }
  }
  return buildUpdateInfo(row, items || []);
}

async function fetchLoaderVersionsFor({ loader, version, channel = "all" } = {}) {
  const impl = getLoader(loader);
  if (!impl) return { items: [], error: "Loader not supported" };
  const gameVersion = String(version || "").trim();
  if (!gameVersion) return { items: [], error: "version is required" };
  try {
    if (typeof impl.getLoaderVersions !== "function") return { items: [], loader: impl.meta(), supported: false };
    const raw = await impl.getLoaderVersions(gameVersion);
    const list = Array.isArray(raw) ? raw : [];
    const filtered = filterVersionsByChannel(list, channel);
    const latestStable = list.find((v) => (v?.channel || (v?.stable !== false ? "stable" : "experimental")) === "stable")?.id || null;
    const latestExperimental = list.find((v) => (v?.channel || (v?.stable !== false ? "stable" : "experimental")) === "experimental")?.id || null;
    return { items: filtered, loader: impl.meta(), supported: true, version: gameVersion, channel, latest: { stable: latestStable, experimental: latestExperimental, default: latestStable || latestExperimental || list[0]?.id || null } };
  } catch (e) {
    return { items: [], error: e?.message || String(e), loader: impl.meta(), supported: true, version: gameVersion };
  }
}

export const jarRoute = new Elysia({ prefix: "/api/jar" })
  .get("/download", async ({ query }) => {
    const { loader, version, serverId, channel = "all", loaderVersion, loader_build, loaderBuild } = query;
    if (serverId && !isValidServerId(serverId)) return new Response("Server not found", { status: 404 });
    const row = serverId ? db.prepare("SELECT * FROM servers WHERE id = ?").get(serverId) : null;
    const dir = serverId ? ensureServerDir(serverId) : join(DATA_DIR, "tmp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!row && serverId) return new Response("Server not found", { status: 404 });
    const loaderId = loader || row?.loader || "vanilla";
    const reqVer = version || query.latest || (row && row.loader_version) || "latest-stable";
    const reqLoaderBuild = String(loaderVersion ?? loader_build ?? loaderBuild ?? row?.loader_build ?? "").trim() || null;
    const impl = getLoader(loaderId);
    if (!impl) return new Response("Loader not supported", { status: 501 });

    try {
      const javaCommand = impl?.java ? await resolveJavaCommand(JAVA_DIR, row?.java_version, "java") : null;
      const result = await impl.install({ version: reqVer, dir, channel, loaderVersion: reqLoaderBuild, javaCommand, serverId });
      const fileName = result.file || result.jar || "server.jar";
      const resolvedVersion = result.version || reqVer;
      const resolvedLoaderBuild = String(result.loaderVersion ?? reqLoaderBuild ?? "").trim();
      if (serverId) {
        db.prepare("UPDATE servers SET jar = ?, loader_version = ?, loader_channel = ?, loader_build = ? WHERE id = ?").run(fileName, resolvedVersion, result.channel || channel || "", resolvedLoaderBuild, serverId);
        if (result.exec !== undefined) db.prepare("UPDATE servers SET exec = ? WHERE id = ?").run(result.exec ? JSON.stringify(result.exec) : null, serverId);
        try { __updateCache.delete(loaderId); } catch {}
      }
      return { ...result, file: fileName, version: resolvedVersion, loader_build: resolvedLoaderBuild, loaderVersion: resolvedLoaderBuild || null };
    } catch (e) {
      if (e.name === "AbortError") return new Response("Download timeout", { status: 504 });
      return new Response(`Download error: ${e.message}`, { status: 500 });
    }
  })
  .get("/versions", async ({ query }) => {
    const { loader, channel = "all", version } = query;
    if (version) {
      // `/jar/versions?version=<mc>` is an alias for the loader-build endpoint.
      return await fetchLoaderVersionsFor({ loader, version, channel });
    }
    const impl = getLoader(loader);
    if (!impl) return { versions: [], error: "Loader not supported" };
    try {
      const all = normalizeVersionList(await impl.getVersions());
      const items = filterVersionsByChannel(all, channel);
      const latestStable = all.find((v) => v.channel === "stable")?.id || null;
      const latestExperimental = all.find((v) => v.channel === "experimental")?.id || null;
      // Backward-compatible `versions: string[]` plus rich `items`/channels.
      return { versions: items.map((v) => v.id), items, loader: impl.meta(), channel, latest: { stable: latestStable, experimental: latestExperimental } };
    } catch (e) { return { versions: [], items: [], error: e.message }; }
  })
  .get("/loader-versions", async ({ query }) => {
    const { loader, version, mc, channel = "all" } = query;
    return await fetchLoaderVersionsFor({ loader, version: version || mc, channel });
  })
  .get("/latest", async ({ query }) => {
    const { loader, channel = "stable" } = query;
    const impl = getLoader(loader);
    if (!impl) return new Response(JSON.stringify({ error: "Loader not supported" }), { status: 501, headers: { "Content-Type": "application/json" } });
    try {
      const v = await impl.resolveVersion(`latest-${String(channel).includes("exp") ? "experimental" : "stable"}`, channel);
      return { ok: true, loader, ...v };
    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } }); }
  });

// ============ MODS (server) ============
export const modsRoute = new Elysia({ prefix: "/api/servers/:id/mods" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const rows = db.prepare("SELECT * FROM mods WHERE server_id = ? ORDER BY installed_at DESC").all(params.id);
    return { mods: rows.map(modFromRow) };
  })
  .get("/updates", async ({ params, query }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const rows = db.prepare("SELECT * FROM mods WHERE server_id = ?").all(params.id);
    const updates = await findModUpdates(row, rows.map(modFromRow), { force: String(query?.force || "") === "1" });
    return { updates };
  })
  .post("/", async ({ params, body }) => {
    const server = getServerRow(params.id);
    if (!server) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const {
      source = "modrinth", project_id, version_id, version, filename, enabled = 1, download_url,
      project_title, slug, icon_url, game_versions, loaders, sha1, sha256, sha512, file_size, channel,
      date_published, changelog, dependencies, store_url, project_type, meta,
    } = body || {};
    const id = crypto.randomUUID();
    const file = safeName(filename) || null;
    const target = modsTarget(project_type === "datapack" ? "vanilla" : server.loader);
    const dir = modsFolderFor(params.id, server.loader, project_type);
    mkdirSync(dir, { recursive: true });
    db.prepare(`INSERT INTO mods(id,server_id,source,project_id,version_id,version,filename,enabled,download_url,
      project_title,slug,icon_url,game_versions,loaders,sha1,sha256,sha512,file_size,channel,date_published,changelog,dependencies,store_url,project_type,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, params.id, source, project_id || null, version_id || null, version || null, file, enabled ? 1 : 0, download_url || "",
      project_title || null, slug || null, icon_url || null,
      JSON.stringify(game_versions || []), JSON.stringify(loaders || []),
      sha1 || null, sha256 || null, sha512 || null, Number(file_size) || null, channel || null,
      Number(date_published) || null, changelog || "", JSON.stringify(dependencies || []),
      store_url || null, project_type || null, JSON.stringify(meta || null),
    );
    if (download_url && file && /^https?:\/\//i.test(download_url)) {
      try {
        await downloadFile(download_url, join(dir, file), { sha1, sha256, sha512 });
      } catch (e) {
        db.prepare("DELETE FROM mods WHERE id = ?").run(id);
        return new Response(JSON.stringify({ ok: false, error: `Download failed: ${e?.message || e}` }), { status: 502, headers: { "Content-Type": "application/json" } });
      }
    }
    return { id, ok: true, folder: target.folder };
  })
  .post("/scan", async ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const dir = modsFolder(params.id, row.loader);
    if (!existsSync(dir)) return { scanned: 0, found: 0, unknown: [], mods: [] };
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".jar")).slice(0, 200);
    const existing = db.prepare("SELECT * FROM mods WHERE server_id = ?").all(params.id).map(modFromRow);
    const knownNames = new Set(existing.map((m) => m.filename).filter(Boolean));
    const knownHashes = new Set(existing.map((m) => m.sha1).filter(Boolean));
    const projectType = modsTarget(row.loader).kind;
    let found = 0;
    const unknown = [];
    for (const filename of files) {
      const path = join(dir, filename);
      let hash = "";
      let sha256 = "";
      let fingerprint = "";
      try { hash = await sha1File(path); } catch { hash = ""; }
      try { sha256 = await sha256File(path); } catch { sha256 = ""; }
      try { fingerprint = String(await fingerprintFile(path)); } catch { fingerprint = ""; }
      if (hash && knownHashes.has(hash)) continue;
      if (!hash && knownNames.has(filename)) continue;
      let hit = null;
      try {
        hit = await lookupHash({ sha1: hash, sha256, fingerprint, loader: row.loader, gameVersion: row.loader_version || "" });
      } catch { hit = null; }
      if (!hit?.version) { unknown.push({ filename, sha1: hash, sha256 }); continue; }
      const v = hit.version;
      const file = v.files?.[0];
      const source = hit.source || "modrinth";
      const existingRow = existing.find((m) => m.filename === filename);
      if (existingRow) {
        db.prepare(`UPDATE mods SET source=?,project_id=?,version_id=?,version=?,download_url=?,project_title=?,slug=?,icon_url=?,game_versions=?,loaders=?,sha1=?,sha256=?,sha512=?,file_size=?,channel=?,date_published=?,changelog=?,dependencies=?,store_url=?,project_type=?,updated_at=? WHERE id=? AND server_id=?`)
          .run(
            source, v.project_id, v.id, v.version_number, file?.url || "",
            v.project_title || existingRow.project_title || null, v.project_slug || existingRow.slug || null,
            v.icon_url || existingRow.icon_url || null,
            JSON.stringify(v.game_versions || []), JSON.stringify(v.loaders || []),
            hash || existingRow.sha1 || null, sha256 || file?.hashes?.sha256 || null, file?.hashes?.sha512 || null,
            Number(file?.size) || existingRow.file_size || null, v.channel || existingRow.channel || null,
            v.date_published || existingRow.date_published || null, v.changelog || existingRow.changelog || "",
            JSON.stringify(v.dependencies || []), v.store_url || existingRow.store_url || null,
            projectType, Date.now(), existingRow.id, params.id,
          );
      } else {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO mods(id,server_id,source,project_id,version_id,version,filename,enabled,download_url,
          project_title,slug,icon_url,game_versions,loaders,sha1,sha256,sha512,file_size,channel,date_published,changelog,dependencies,store_url,project_type,meta)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, params.id, source, v.project_id, v.id, v.version_number, filename, 1, file?.url || "",
          v.project_title || null, v.project_slug || null, v.icon_url || null,
          JSON.stringify(v.game_versions || []), JSON.stringify(v.loaders || []),
          hash || null, sha256 || file?.hashes?.sha256 || null, file?.hashes?.sha512 || null, Number(file?.size) || null, v.channel || null,
          v.date_published || null, v.changelog || "", JSON.stringify(v.dependencies || []),
          v.store_url || null, projectType, null,
        );
      }
      knownHashes.add(hash);
      knownNames.add(filename);
      found++;
    }
    const mods = db.prepare("SELECT * FROM mods WHERE server_id = ? ORDER BY installed_at DESC").all(params.id).map(modFromRow);
    return { scanned: files.length, found, unknown, mods };
  })
  .post("/:modId/update", async ({ params, set }) => {
    const server = getServerRow(params.id);
    if (!server) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const raw = db.prepare("SELECT * FROM mods WHERE id = ? AND server_id = ?").get(params.modId, params.id);
    if (!raw) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const mod = modFromRow(raw);
    try {
      const latest = await latestVersion(mod.source, mod.project_id, { loader: mod.project_type === "datapack" ? "vanilla" : server.loader, gameVersion: server.loader_version || "" });
      if (!latest) return new Response(JSON.stringify({ ok: false, error: "No compatible version found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      const file = await resolveDownload(mod.source, latest);
      if (!file?.url) return new Response(JSON.stringify({ ok: false, error: "No download URL for the latest version" }), { status: 502, headers: { "Content-Type": "application/json" } });
      const dir = modsFolderFor(params.id, server.loader, mod.project_type);
      mkdirSync(dir, { recursive: true });
      const filename = safeName(file.filename) || mod.filename || "mod.jar";
      const dest = join(dir, filename);
      await downloadFile(file.url, dest, { sha1: file.hashes?.sha1, sha256: file.hashes?.sha256, sha512: file.hashes?.sha512 });
      if (mod.filename && mod.filename !== filename) {
        try { const old = join(dir, mod.filename); if (existsSync(old)) unlinkSync(old); } catch { /* ignore */ }
      }
      db.prepare(`UPDATE mods SET version_id=?,version=?,filename=?,sha1=?,sha256=?,sha512=?,file_size=?,channel=?,date_published=?,game_versions=?,loaders=?,store_url=?,changelog=?,dependencies=?,project_title=?,slug=?,icon_url=?,updated_at=? WHERE id=? AND server_id=?`)
        .run(
          latest.id, latest.version_number, filename, file.hashes?.sha1 || null, file.hashes?.sha256 || null, file.hashes?.sha512 || null,
          Number(file.size) || null, latest.channel || null, latest.date_published || null,
          JSON.stringify(latest.game_versions || []), JSON.stringify(latest.loaders || []),
          latest.store_url || null, latest.changelog || "", JSON.stringify(latest.dependencies || []),
          latest.project_title || mod.project_title || null, latest.project_slug || mod.slug || null,
          latest.icon_url || mod.icon_url || null, Date.now(), params.modId, params.id,
        );
      try { __updateCache.delete(mod.source); } catch { /* ignore */ }
      return { ok: true, version: latest.version_number, version_id: latest.id, filename };
    } catch (e) {
      const status = e?.status || 500;
      const res = new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), { status, headers: { "Content-Type": "application/json" } });
      return res;
    }
  })
  .patch("/:modId", ({ params, body, set }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const row = db.prepare("SELECT * FROM mods WHERE id = ? AND server_id = ?").get(params.modId, params.id);
    if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (!body || typeof body !== "object" || Array.isArray(body)) { set.status = 400; return { ok: false, error: "Invalid body" }; }
    const allowed = ["enabled", "version", "filename", "version_id"];
    const fields = [], vals = [];
    for (const [k, v] of Object.entries(body)) {
      if (!allowed.includes(k)) continue;
      fields.push(`${k} = ?`);
      vals.push(k === "enabled" ? (v ? 1 : 0) : v);
    }
    if (!fields.length) return { ok: true };
    vals.push(params.modId);
    db.prepare(`UPDATE mods SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    return { ok: true };
  })
  .delete("/:modId", ({ params }) => {
    const server = getServerRow(params.id);
    if (!server) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const row = db.prepare("SELECT * FROM mods WHERE id = ? AND server_id = ?").get(params.modId, params.id);
    if (!row) return { ok: true };
    const modsDir = modsFolderFor(params.id, server.loader, row.project_type);
    if (row.filename && /^[\w .()+-]+\.(jar|zip)$/i.test(row.filename)) {
      try {
        const p = join(modsDir, row.filename);
        if (existsSync(p) && dirname(resolve(p)) === resolve(modsDir)) unlinkSync(p);
      } catch { /* ignore */ }
    }
    db.prepare("DELETE FROM mods WHERE id = ? AND server_id = ?").run(params.modId, params.id);
    return { ok: true };
  });

// ============ MODS SEARCH / VERSIONS (global) ============
export const modsSearchRoute = new Elysia({ prefix: "/api/mods" })
  .get("/sources", () => ({ sources: listSources() }))
  .get("/search", async ({ query }) => {
    const { q = "", source = "modrinth", type = "mod", loader = "", game_version, gameVersion, limit = 20, offset = 0, sort = "relevance" } = query;
    try {
      const data = await searchStore({
        q: String(q || ""), source: String(source || "modrinth"), type: String(type || "mod"),
        loader: String(loader || ""), gameVersion: String(game_version || gameVersion || ""),
        limit: Number(limit) || 20, offset: Number(offset) || 0, sort: String(sort || "relevance"),
      });
      return data;
    } catch (e) {
      return { results: [], total: 0, configured: sourceConfigured(String(source || "modrinth")), error: e?.message || String(e) };
    }
  })
  .get("/project", async ({ query }) => {
    const { source = "modrinth", project_id, loader = "", game_version, gameVersion } = query;
    if (!project_id) return { error: "project_id is required" };
    try {
      const project = await getProject(source, project_id, { loader });
      let versions = [];
      if (String(query?.include_versions || "") === "1") {
        versions = await getVersions(source, project_id, { loader, gameVersion: String(game_version || gameVersion || ""), limit: 50 });
      }
      return { project, versions };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  })
  .get("/versions", async ({ query }) => {
    const { source = "modrinth", project_id, loader = "", game_version, gameVersion, limit = 100 } = query;
    if (!project_id) return { versions: [], error: "project_id is required" };
    try {
      const versions = await getVersions(source, project_id, {
        loader: String(loader || ""),
        gameVersion: String(game_version || gameVersion || ""),
        limit: Number(limit) || 100,
      });
      return { versions, source };
    } catch (e) {
      return { versions: [], source, error: e?.message || String(e) };
    }
  })
  .get("/hash", async ({ query }) => {
    const { sha1 = "", sha512 = "", sha256 = "", fingerprint = "", loader = "", game_version, gameVersion } = query;
    if (!sha1 && !sha512 && !sha256 && !fingerprint) return { found: false, error: "sha1, sha512, sha256 or fingerprint is required" };
    try {
      const hit = await lookupHash({
        sha1: String(sha1 || ""), sha512: String(sha512 || ""),
        sha256: String(sha256 || ""), fingerprint: String(fingerprint || ""),
        loader: String(loader || ""), gameVersion: String(game_version || gameVersion || ""),
      });
      return hit ? { found: true, ...hit } : { found: false };
    } catch (e) {
      return { found: false, error: e?.message || String(e) };
    }
  });

// ============ MODPACKS ============
export const modpackRoute = new Elysia({ prefix: "/api/servers" })
  .post("/from-modpack", async ({ body }) => {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
    const {
      name, source = "modrinth", project_id, version_id,
      loader: requestedLoader = "", loader_version = "", loader_build = "",
      java_version = "", memory_max = "2G", memory_min = "512M", jvm_args = "",
      port = requestedLoader === "bedrock" ? 19132 : 25565, motd = "A SMP Server", auto_start = 0, upload_id = "",
    } = body || {};
    if (!name || !String(name).trim()) return json({ ok: false, error: "name is required" }, 400);
    if (source === "curseforge" && !sourceConfigured("curseforge")) {
      return json({ ok: false, error: "CurseForge requires an API key. Add it in Settings → CurseForge." }, 400);
    }
    const uploadPath = source === "custom" ? resolveUpload(upload_id) : null;
    if (source === "custom" && !uploadPath && !requestedLoader) {
      return json({ ok: false, error: "Upload a modpack archive or choose a loader." }, 400);
    }
    let created;
    try {
      created = await createServerRecord({ name, loader: requestedLoader || "vanilla", loader_version, loader_build, java_version, memory_max, memory_min, jvm_args, port, motd, auto_start: 0 });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, e?.status || 400);
    }
    const id = created.id;
    const dir = serverFilesDir(id);
    ensureServerDir(id);
    try {
      const result = await installModpack({
        dir, source, projectId: project_id, versionId: version_id,
        archivePath: uploadPath, javaCommand: null,
        onLog: (m) => logLine(id, `[modpack] ${m}`),
      });
      let finalLoader = result.loader || requestedLoader || "vanilla";
      let finalVersion = result.loader_version || loader_version || "";
      let finalBuild = result.loader_build || loader_build || "";
      let channel = result.channel || "stable";
      if (source === "custom" && requestedLoader && requestedLoader !== "vanilla" && (!result.loader || result.loader === "vanilla")) {
        const impl = getLoader(requestedLoader);
        if (impl) {
          logLine(id, `[modpack] Installing ${requestedLoader}…`);
          const inst = await impl.install({ version: loader_version || "latest-stable", dir, channel: "all", loaderVersion: loader_build || null });
          finalLoader = requestedLoader;
          finalVersion = inst.version || loader_version || "";
          finalBuild = inst.loaderVersion || loader_build || "";
          channel = inst.channel || channel;
        }
      }
      if (finalLoader === "vanilla" && !existsSync(join(dir, "server.jar"))) {
        const vanilla = getLoader("vanilla");
        if (vanilla) {
          logLine(id, `[modpack] Installing vanilla server ${finalVersion || "latest-stable"}…`);
          const inst = await vanilla.install({ version: finalVersion || "latest-stable", dir, channel: "all" });
          finalVersion = inst.version || finalVersion;
        }
      }
      db.prepare("UPDATE servers SET loader=?, loader_version=?, loader_build=?, loader_channel=?, auto_start=? WHERE id=?")
        .run(finalLoader, finalVersion, finalBuild, channel, auto_start ? 1 : 0, id);
      // The pack may have installed a different runtime than the one used at creation
      // (for example a Bedrock pack): re-reserve ports for the final loader.
      if (String(finalLoader) !== String(requestedLoader || "vanilla")) {
        try {
          const allocation = await allocateServerPorts({ serverId: id, loaderId: finalLoader, requested: null, checkOs: true });
          saveServerPorts(id, allocation.ports);
          applyPortsToConfig({ dir, loaderId: finalLoader, ports: allocation.ports });
        } catch (e) {
          logLine(id, `[ports] Could not reallocate ports for ${finalLoader}: ${e?.message || String(e)}`);
        }
      }
      const finalMeta = (getLoader(finalLoader) || { meta: () => ({}) }).meta?.() || {};
      if (finalMeta.java) {
        const mem = clampMemoryMb(parseMemoryMb(body.memory_max ?? body.memory ?? "2G", 2048));
        db.prepare("UPDATE servers SET memory_max=?, jvm_args=? WHERE id=?").run(formatMemoryMb(mem), normalizeJvmArgs(body.jvm_args), id);
      }
      let packVersion = version_id || "";
      let packTitle = name;
      let packIcon = null;
      let packStore = null;
      if (source !== "custom" && project_id) {
        try {
          const versions = await getVersions(source, project_id, { limit: 200 });
          const picked = versions.find((v) => String(v.id) === String(version_id)) || versions[0];
          if (picked) {
            packVersion = picked.version_number || picked.name || packVersion;
            packTitle = picked.project_title || packTitle;
            packIcon = picked.icon_url || null;
            packStore = picked.store_url || null;
          }
        } catch { /* non-fatal: keep the id */ }
      }
      try {
        db.prepare("INSERT INTO modpacks(id,server_id,source,project_id,version_id,version,title,icon_url,store_url,loader,loader_version,loader_build) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(crypto.randomUUID(), id, source, project_id || null, version_id || null, packVersion, packTitle, packIcon, packStore, finalLoader, finalVersion, finalBuild);
      } catch { /* non-fatal */ }
      return { id, ok: true, loader: finalLoader, loader_version: finalVersion, loader_build: finalBuild, channel, warnings: result.warnings || [] };
    } catch (e) {
      logLine(id, `[modpack] Error: ${e?.message || e}`);
      return json({ ok: false, id, error: e?.message || String(e) }, 500);
    }
  })
  .post("/:id/update-modpack", async ({ params }) => {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
    const row = getServerRow(params.id);
    if (!row) return json({ ok: false, error: "Server not found" }, 404);
    if (isRunning(row.id)) return json({ ok: false, error: "Stop the server before updating the modpack." }, 400);
    const pack = getModpackRow(row.id);
    if (!pack?.project_id) return json({ ok: false, error: "This server is not a modpack." }, 400);
    let latest;
    try {
      latest = await latestVersion(pack.source, pack.project_id);
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 502);
    }
    if (!latest?.id) return json({ ok: false, error: "No modpack version found." }, 502);
    const latestId = String(latest.id);
    if (pack.version_id && String(pack.version_id) === latestId) {
      return { ok: true, unchanged: true, version: latest.version_number || latest.name || pack.version || pack.version_id || latestId };
    }
    if (row.backup_on_update || row.backup_on_loader) {
      try {
        await createBackupRecord(row.id, { reason: "modpack" });
      } catch (e) {
        return json({ ok: false, error: `Automatic backup failed: ${e?.message || String(e)}` }, 500);
      }
    }
    const dir = serverFilesDir(row.id);
    ensureServerDir(row.id);
    try {
      const result = await installModpack({
        dir, source: pack.source, projectId: pack.project_id, versionId: latest.id,
        javaCommand: null,
        onLog: (m) => logLine(row.id, `[modpack] ${m}`),
      });
      const finalLoader = result.loader || pack.loader || row.loader || "vanilla";
      const finalVersion = result.loader_version || pack.loader_version || row.loader_version || "";
      const finalBuild = result.loader_build || pack.loader_build || row.loader_build || "";
      const channel = result.channel || "stable";
      db.prepare("UPDATE servers SET loader=?, loader_version=?, loader_build=?, loader_channel=? WHERE id=?")
        .run(finalLoader, finalVersion, finalBuild, channel, row.id);
      const versionLabel = latest.version_number || latest.name || latestId;
      db.prepare("UPDATE modpacks SET version_id=?, version=?, title=?, icon_url=?, store_url=?, loader=?, loader_version=?, loader_build=? WHERE server_id=?")
        .run(latestId, versionLabel, latest.project_title || pack.title || row.name, latest.icon_url || pack.icon_url || null, latest.store_url || pack.store_url || null, finalLoader, finalVersion, finalBuild, row.id);
      logLine(row.id, `[modpack] Updated to ${versionLabel}`);
      return { ok: true, version: versionLabel, version_id: latestId, loader: finalLoader, loader_version: finalVersion, loader_build: finalBuild, warnings: result.warnings || [] };
    } catch (e) {
      logLine(row.id, `[modpack] Update error: ${e?.message || e}`);
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

export const modpackUploadRoute = new Elysia({ prefix: "/api/modpacks" })
  .post("/upload", async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return new Response(JSON.stringify({ ok: false, error: "No file" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const original = safeName(file.name) || "modpack.zip";
    if (!/\.(zip|mrpack)$/i.test(original)) {
      return new Response(JSON.stringify({ ok: false, error: "Upload a .zip or .mrpack archive" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const uploadId = crypto.randomUUID();
    const path = join(uploadDir(), `${uploadId}.zip`);
    try {
      await streamPipeline(Readable.fromWeb(file.stream()), createWriteStream(path));
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: `Upload failed: ${e?.message || e}` }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return { ok: true, uploadId, name: original, size: statSync(path).size };
  });

// ============ BACKUPS ============
const backupJsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

async function ensureStoredTarZst(serverId, row) {
  if (backupFormat(row) === "tar.zst" && String(row.path).toLowerCase().endsWith(".tar.zst") && existsSync(row.path)) return row;
  if (!row.path || !existsSync(row.path)) throw new Error("Backup file not found");
  const dir = serverBackupsDir(serverId);
  const tempRoot = join(dir, ".convert");
  mkdirSync(tempRoot, { recursive: true });
  const base = row.path.replace(/\.(zip|tar\.zst)$/i, "");
  const nextPath = `${base}.tar.zst`;
  if (nextPath !== row.path && existsSync(nextPath)) {
    // A previous conversion finished but the DB was not updated.
  } else if (nextPath !== row.path) {
    await convertZipToTarZst(row.path, nextPath, tempRoot);
  }
  const size = statSync(nextPath).size;
  db.prepare("UPDATE backups SET path = ?, size = ?, format = ? WHERE id = ? AND server_id = ?")
    .run(nextPath, size, BACKUP_FORMAT, row.id, serverId);
  if (row.path !== nextPath) {
    try { unlinkSync(row.path); } catch {}
  }
  try { rmdirSync(tempRoot); } catch {}
  return db.prepare("SELECT * FROM backups WHERE id = ? AND server_id = ?").get(row.id, serverId);
}

export const backupsRoute = new Elysia({ prefix: "/api/servers/:id/backups" })
  .get("/", ({ params }) => {
    const server = getServerRow(params.id);
    if (!server) return backupJsonResponse({ error: "Not found" }, 404);
    const rows = db.prepare("SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC, number DESC").all(params.id);
    const limit = backupLimitFor(server);
    const unprotected = rows.filter((row) => !row.protected).length;
    return {
      backups: rows.map(backupJson),
      next_number: peekBackupNumber(params.id),
      limit,
      unprotected_count: unprotected,
      protected_count: rows.length - unprotected,
      over_limit: limit ? Math.max(0, unprotected - limit) : 0,
      auto_prune: !!server.backup_auto_prune,
    };
  })
  .post("/", async ({ params, body }) => {
    if (!getServerRow(params.id)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    const name = normalizeBackupName(body?.name);
    const protect = !!(body?.protected ?? body?.protect);
    try {
      const backup = await createBackupRecord(params.id, { name, protect, reason: "manual" });
      return { ok: true, backup };
    } catch (e) {
      return backupJsonResponse({ ok: false, error: e?.message || String(e) }, e?.status || 500);
    }
  })
  .delete("/", async ({ params, body }) => {
    if (!getServerRow(params.id)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    const selectedIds = Array.isArray(body?.ids)
      ? [...new Set(body.ids.filter((id) => isValidBackupId(id)))]
      : null;
    try {
      const result = await withBackupLock(params.id, async () => {
        let deleted = 0;
        let kept = 0;
        if (selectedIds) {
          for (const id of selectedIds) {
            const row = db.prepare("SELECT * FROM backups WHERE id = ? AND server_id = ?").get(id, params.id);
            if (!row) continue;
            if (row.protected) { kept++; continue; }
            try { if (deleteBackupRecord(row)) deleted++; } catch {}
          }
        } else {
          const rows = db.prepare("SELECT * FROM backups WHERE server_id = ?").all(params.id);
          for (const row of rows) {
            if (row.protected) { kept++; continue; }
            try { if (deleteBackupRecord(row)) deleted++; } catch {}
          }
        }
        return { deleted, kept };
      });
      logLine(params.id, selectedIds
        ? `[backup] Deleted ${result.deleted} selected backup(s)`
        : `[backup] Deleted all unprotected backups (${result.deleted})`);
      return { ok: true, ...result };
    } catch (e) {
      return backupJsonResponse({ ok: false, error: e?.message || String(e) }, 500);
    }
  })
  .post("/prune", async ({ params }) => {
    if (!getServerRow(params.id)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    try {
      const result = await withBackupLock(params.id, async () => {
        const rows = overLimitBackups(params.id);
        let deleted = 0;
        let failed = 0;
        for (const row of rows) {
          try { deleteBackupRecord(row); deleted++; } catch { failed++; }
        }
        return { deleted, failed, over_limit: overLimitBackups(params.id).length };
      });
      logLine(params.id, `[backup] Deleted ${result.deleted} backup(s) over the retention limit`);
      return { ok: true, ...result };
    } catch (e) {
      return backupJsonResponse({ ok: false, error: e?.message || String(e) }, 500);
    }
  })
  .patch("/:backupId", ({ params, body }) => {
    if (!isValidBackupId(params.backupId)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    const row = db.prepare("SELECT * FROM backups WHERE id = ? AND server_id = ?").get(params.backupId, params.id);
    if (!row) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    const updates = [];
    const values = [];
    if (body?.name !== undefined) {
      const name = normalizeBackupName(body.name) || backupNumberLabel(row);
      updates.push("name = ?");
      values.push(name);
    }
    if (body?.protected !== undefined || body?.protect !== undefined) {
      updates.push("protected = ?");
      values.push((body?.protected ?? body?.protect) ? 1 : 0);
    }
    if (updates.length) {
      values.push(row.id, params.id);
      db.prepare(`UPDATE backups SET ${updates.join(", ")} WHERE id = ? AND server_id = ?`).run(...values);
    }
    const updated = db.prepare("SELECT * FROM backups WHERE id = ? AND server_id = ?").get(params.backupId, params.id);
    return { ok: true, backup: backupJson(updated) };
  })
  .get("/:backupId/download", async ({ params, query, request }) => {
    if (!isValidBackupId(params.backupId)) return backupJsonResponse({ error: "Not found" }, 404);
    let row = db.prepare("SELECT * FROM backups WHERE id = ? AND server_id = ?").get(params.backupId, params.id);
    if (!row || !row.path || !existsSync(row.path)) return backupJsonResponse({ error: "Not found" }, 404);
    const format = String(query?.format || "tar.zst").toLowerCase() === "zip" ? "zip" : "tar.zst";
    try {
      if (format === "zip") {
        if (backupFormat(row) === "zip") {
          return new Response(Bun.file(row.path), {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": attachmentName(backupDownloadName(row, "zip")),
              "Content-Length": String(statSync(row.path).size),
              "Cache-Control": "no-store",
            },
          });
        }
        const stream = tarZstToZip(row.path, { signal: request.signal });
        return new Response(Readable.toWeb(stream), {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": attachmentName(backupDownloadName(row, "zip")),
            "Cache-Control": "no-store",
          },
        });
      }
      if (backupFormat(row) !== "tar.zst" || !String(row.path).toLowerCase().endsWith(".tar.zst")) {
        row = await withBackupLock(params.id, () => ensureStoredTarZst(params.id, row));
      }
      if (!row || !existsSync(row.path)) return backupJsonResponse({ error: "Not found" }, 404);
      return new Response(Bun.file(row.path), {
        headers: {
          "Content-Type": "application/zstd",
          "Content-Disposition": attachmentName(backupDownloadName(row, "tar.zst")),
          "Content-Length": String(statSync(row.path).size),
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return backupJsonResponse({ ok: false, error: e?.message || String(e) }, 500);
    }
  })
  .post("/:backupId/restore", async ({ params }) => {
    if (!isValidBackupId(params.backupId)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    const row = db.prepare("SELECT * FROM backups WHERE id = ? AND server_id = ?").get(params.backupId, params.id);
    if (!row || !row.path || !existsSync(row.path)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    if (!getServerRow(params.id)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    const serverDir = serverPath(params.id);
    const filesDir = serverFilesDir(params.id);
    const staging = join(serverDir, `.restore-${params.backupId}`);
    const previous = join(serverDir, `.pre-restore-${params.backupId}`);
    try {
      const result = await withBackupLock(params.id, async () => {
        const wasRunning = isRunning(params.id);
        if (wasRunning) await stopServerProcess(params.id);
        let archiveRow = row;
        if (backupFormat(archiveRow) !== "tar.zst" || !String(archiveRow.path).toLowerCase().endsWith(".tar.zst")) {
          archiveRow = await ensureStoredTarZst(params.id, archiveRow);
        }
        rmSync(staging, { recursive: true, force: true });
        rmSync(previous, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true });
        try {
          await extractBackupArchive(archiveRow.path, staging);
        } catch (e) {
          rmSync(staging, { recursive: true, force: true });
          throw new Error(`Could not extract the backup: ${e?.message || String(e)}`);
        }
        let movedPrevious = false;
        if (existsSync(filesDir)) {
          renameSync(filesDir, previous);
          movedPrevious = true;
        }
        try {
          renameSync(staging, filesDir);
        } catch (e) {
          if (movedPrevious) {
            try { renameSync(previous, filesDir); } catch {}
          }
          throw e;
        }
        if (movedPrevious) {
          try { rmSync(previous, { recursive: true, force: true }); } catch {}
        }
        logLine(params.id, `[backup] Restored ${backupName(row)}`);
        return { wasRunning };
      });
      return { ok: true, stopped: result.wasRunning, backup: backupJson(row) };
    } catch (e) {
      try { rmSync(staging, { recursive: true, force: true }); } catch {}
      if (!existsSync(filesDir) && existsSync(previous)) {
        try { renameSync(previous, filesDir); } catch {}
      }
      return backupJsonResponse({ ok: false, error: e?.message || String(e) }, e?.status || 500);
    }
  })
  .delete("/:backupId", async ({ params }) => {
    if (!isValidBackupId(params.backupId)) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    const row = db.prepare("SELECT * FROM backups WHERE id = ? AND server_id = ?").get(params.backupId, params.id);
    if (!row) return backupJsonResponse({ ok: false, error: "Not found" }, 404);
    try {
      await withBackupLock(params.id, async () => { deleteBackupRecord(row); });
      return { ok: true };
    } catch (e) {
      return backupJsonResponse({ ok: false, error: e?.message || String(e) }, e?.status || 500);
    }
  });

// ============ SETTINGS ============
export const settingsRoute = new Elysia({ prefix: "/api/settings" })
  .get("/", () => {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    return { settings: s };
  })
  .post("/", ({ body, set }) => {
    const { key, value } = body || {};
    if (!key || typeof key !== "string") { set.status = 400; return { ok: false, error: "key is required" }; }
    setSetting(key, value == null ? "" : String(value));
    return { ok: true };
  });

// ============ LOADERS ============
export const loadersRoute = new Elysia({ prefix: "/api/loaders" })
  .get("/", () => ({ loaders: listLoaders().map((l) => ({ ...l, ports: portProfile(l.id) })) }));

// ============ JAVA ============
export const javaRoute = new Elysia({ prefix: "/api/java" })
  .get("/installed", () => ({ installed: listInstalledJava(JAVA_DIR), javaDir: JAVA_DIR }))
  .get("/", async () => {
    const [detected, installed] = await Promise.all([
      detectJava(JAVA_DIR).catch(() => []),
      Promise.resolve(listInstalledJava(JAVA_DIR)),
    ]);
    const installedIds = new Set(installed.map(i => String(i.id)));
    const available = AVAILABLE_JAVA_VERSIONS.map(v => ({ ...v, installed: installedIds.has(String(v.id)), managed: true }));
    const runtimes = [
      { id: "system", name: "Java del sistema (PATH/JAVA_HOME)", source: "system", installed: detected.some(d => d.source === "path" || d.source === "JAVA_HOME") },
      ...installed.map(i => ({ id: i.id, name: "Java " + i.id + " (instalado en carpeta java)", source: "managed", installed: true, path: i.path, home: i.home })),
      ...detected.filter(d => !d.managed).map(d => ({ id: d.path, name: d.name + (d.version ? " — " + d.version : ""), source: d.source, installed: true, path: d.path, version: d.version, detected: true })),
    ];
    const seen = new Set();
    const rt = runtimes.filter(r => { const k = String(r.id); if (seen.has(k)) return false; seen.add(k); return true; });
    return { available, installed, detected, runtimes: rt, javaDir: JAVA_DIR };
  })
  .get("/runtimes", async () => {
    const [detected, installed] = await Promise.all([detectJava(JAVA_DIR).catch(() => []), Promise.resolve(listInstalledJava(JAVA_DIR))]);
    const runtimes = [
      { id: "system", name: "Java del sistema (PATH/JAVA_HOME)", source: "system" },
      ...installed.map(i => ({ id: i.id, name: "Java " + i.id + " (instalado en carpeta java)", source: "managed", path: i.path })),
      ...detected.filter(d => !d.managed).map(d => ({ id: d.path, name: d.name + (d.version ? " — " + d.version : ""), source: d.source, path: d.path, version: d.version })),
    ];
    const seen = new Set();
    return { runtimes: runtimes.filter(r => { const k = String(r.id); if (seen.has(k)) return false; seen.add(k); return true; }) };
  })
  .get("/detect", async () => {
    const java = await detectJava(JAVA_DIR).catch(() => []);
    return { java, detected: java };
  })
  .post("/install", async ({ body, set }) => {
    const version = String(body?.version || body?.id || "").trim();
    if (!/^\d+$/.test(version)) { set.status = 400; return { ok: false, error: "Especifica una versión mayor válida (ej. 21)" }; }
    try {
      const res = await installJava(JAVA_DIR, version);
      const [detected, installed] = await Promise.all([detectJava(JAVA_DIR).catch(() => []), Promise.resolve(listInstalledJava(JAVA_DIR))]);
      return { ...res, installed, detected };
    } catch (e) {
      set.status = 500;
      return { ok: false, error: e?.message || String(e) };
    }
  })
  .delete("/:version", async ({ params, set }) => {
    const res = uninstallJava(JAVA_DIR, params.version);
    if (!res.ok) { set.status = 404; return res; }
    return { ...res, installed: listInstalledJava(JAVA_DIR) };
  });
export const systemRoute = new Elysia({ prefix: "/api/system" })
  .get("/", () => {
    const total = totalmem();
    const totalMb = Math.max(256, Math.floor(total / (1024 * 1024)));
    return {
      totalRam: total,
      totalRamMb: totalMb,
      memory: { minMb: 256, maxMb: totalMb, sliderStepMb: 512, inputStepMb: 1 },
    };
  });

// ============ FILES / UPLOAD (path-parsed; Elysia 1.4 wildcard-in-prefix is unreliable) ============
async function handleServerFiles(req, serverId, rest, query) {
  if (!getServerRow(serverId)) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  const base = serverFilesDir(serverId);
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  const method = req.method;
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const rel = rest.replace(/^\/+/, "").split("/").map(decode).join("/");
  const actionMatch = rel.match(/^(.*?)(?:\/(content|mkdir|rename|move|compress|extract|download))$/);
  const action = actionMatch ? actionMatch[2] : null;
  const targetRel = actionMatch ? actionMatch[1] : rel;
  const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const err = (msg, status = 400) => new Response(typeof msg === "string" ? msg : JSON.stringify(msg), { status, headers: { "Content-Type": typeof msg === "string" ? "text/plain; charset=utf-8" : "application/json" } });
  // Reject traversal or drive/root segments (the root listing is an empty relative path).
  if (targetRel && targetRel.split("/").some((seg) => seg === ".." || seg === "" || /^[A-Za-z]:/.test(seg))) return err("Forbidden", 403);

  if (method === "GET" && !action) {
    const dir = targetRel ? sanitizePath(base, targetRel) : base;
    if (!dir) return err("Forbidden", 403);
    if (!existsSync(dir)) return j({ files: [] });
    if (!statSync(dir).isDirectory()) return err("Not found", 404);
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = [];
    const chunkSize = 100;
    for (let i = 0; i < dirents.length; i += chunkSize) {
      const batch = dirents.slice(i, i + chunkSize);
      const stats = await Promise.all(batch.map(async (e) => {
        try {
          const s = await stat(join(dir, e.name));
          return { name: e.name, isDirectory: e.isDirectory(), size: e.isDirectory() ? 0 : s.size, mtime: s.mtimeMs };
        } catch {
          return { name: e.name, isDirectory: e.isDirectory(), size: 0, mtime: 0 };
        }
      }));
      entries.push(...stats);
    }
    entries.sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
    return j({ files: entries, path: targetRel || "" });
  }

  const file = targetRel ? sanitizePath(base, targetRel) : base;
  if (!file) return err("Forbidden", 403);

  if (method === "GET" && action === "content") {
    if (!existsSync(file) || statSync(file).isDirectory()) return err("Not found", 404);
    const st = statSync(file);
    const ext = (file.split(".").pop() || "").toLowerCase();
    const isInlineImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(ext);
    const type = isInlineImage ? `image/${ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext}` : (MIME[ext] || "application/octet-stream");
    const headers = { "Content-Type": type, "Cache-Control": "no-store" };
    if (query?.download || !isInlineImage) headers["Content-Disposition"] = attachmentName(file);
    if (!query?.download && TEXT_EXTS.has(ext) && st.size > MAX_TEXT_EDIT_BYTES) {
      return new Response(JSON.stringify({ error: "File is too large to open in the editor (max 10 MB)." }), { status: 413, headers: { "Content-Type": "application/json" } });
    }
    if (st.size > STREAM_THRESHOLD_BYTES) return new Response(Bun.file(file), { headers });
    return new Response(readFileSync(file), { headers });
  }
  if (method === "POST" && action === "content") {
    mkdirSync(dirname(file), { recursive: true });
    const body = await req.text();
    writeFileSync(file, body);
    return j({ ok: true });
  }
  if (method === "POST" && action === "mkdir") {
    mkdirSync(file, { recursive: true }); return j({ ok: true });
  }
  if (method === "POST" && action === "rename") {
    if (!existsSync(file)) return err("Not found", 404);
    const body = await req.json().catch(() => ({}));
    const name = safeName(body?.name);
    if (!name) return err("Invalid name", 400);
    const dst = sanitizePath(base, pathPosix.join(dirname(targetRel), name));
    if (!dst) return err("Forbidden", 403);
    if (existsSync(dst)) return err("Target exists", 409);
    renameSync(file, dst);
    return j({ ok: true, name });
  }
  if (method === "POST" && action === "move") {
    if (!existsSync(file)) return err("Not found", 404);
    const body = await req.json().catch(() => ({}));
    const to = String(body?.to || "").replace(/^\/+/, "");
    const dstDir = sanitizePath(base, to);
    if (!dstDir) return err("Forbidden", 403);
    mkdirSync(dstDir, { recursive: true });
    const dst = sanitizePath(base, pathPosix.join(to, basename(file)));
    if (!dst) return err("Forbidden", 403);
    if (resolve(dst) !== resolve(file)) {
      if (existsSync(dst)) return err("Target exists", 409);
      renameSync(file, dst);
    }
    return j({ ok: true });
  }
  if (method === "POST" && action === "compress") {
    if (!existsSync(file)) return err("Not found", 404);
    const body = await req.json().catch(() => ({}));
    const isDir = statSync(file).isDirectory();
    const outName = safeName(body?.name) || (basename(file) + ".zip");
    if (!outName.toLowerCase().endsWith(".zip")) return err("Archive name must end with .zip", 400);
    const out = sanitizePath(base, pathPosix.join(dirname(targetRel), outName));
    if (!out) return err("Forbidden", 403);
    if (existsSync(out)) return err("Target exists", 409);
    if (isDir) {
      await zipDirectory(file, out);
    } else {
      const Archiver = (await import("archiver")).default;
      await new Promise((res, rej) => {
        const output = createWriteStream(out);
        const archive = Archiver("zip", { zlib: { level: 9 } });
        output.on("close", res); output.on("error", rej); archive.on("error", rej);
        archive.pipe(output); archive.file(file, { name: basename(file) }); archive.finalize();
      });
    }
    return j({ ok: true, file: outName });
  }
  if (method === "POST" && action === "extract") {
    if (!existsSync(file) || statSync(file).isDirectory()) return err("Archive not found", 404);
    if (!file.toLowerCase().endsWith(".zip")) return err("Only .zip extraction is supported", 400);
    const body = await req.json().catch(() => ({}));
    const toRel = body?.to != null ? String(body.to).replace(/^\/+/, "") : dirname(targetRel);
    const dst = sanitizePath(base, toRel);
    if (!dst) return err("Forbidden", 403);
    mkdirSync(dst, { recursive: true });
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip(file);
    for (const e of zip.getEntries()) { if (!sanitizePath(dst, e.entryName)) return err("Archive contains unsafe paths", 400); }
    zip.extractAllTo(dst, true);
    return j({ ok: true });
  }
  if (method === "GET" && action === "download") {
    if (!existsSync(file)) return err("Not found", 404);
    const headers = { "Content-Disposition": attachmentName(file) };
    if (statSync(file).isDirectory()) {
      const tmp = join(serverPath(serverId), `_dl_${Date.now()}.zip`);
      await zipDirectory(file, tmp);
      const buf = readFileSync(tmp); try { unlinkSync(tmp); } catch {}
      return new Response(buf, { headers: { "Content-Type": "application/zip", "Content-Disposition": attachmentName(basename(file) + ".zip") } });
    }
    const ext = (file.split(".").pop() || "").toLowerCase();
    headers["Content-Type"] = MIME[ext] || "application/octet-stream";
    if (statSync(file).size > STREAM_THRESHOLD_BYTES) return new Response(Bun.file(file), { headers });
    return new Response(readFileSync(file), { headers });
  }
  if (method === "DELETE" && !action) {
    if (!existsSync(file)) return err("Not found", 404);
    if (statSync(file).isDirectory()) rmdirRecursive(file); else unlinkSync(file);
    return j({ ok: true });
  }
  return err("Not found", 404);
}

async function handleServerUpload(req, serverId, query) {
  if (!getServerRow(serverId)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const base = serverFilesDir(serverId);
  const targetDir = query?.path ? sanitizePath(base, query.path) : base;
  if (!targetDir) return new Response("Forbidden", { status: 403 });
  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return new Response("No file", { status: 400 });
  const name = safeName(file.name);
  if (!name) return new Response("Invalid file name", { status: 400 });
  mkdirSync(targetDir, { recursive: true });
  const filePath = sanitizePath(targetDir, name);
  if (!filePath) return new Response("Forbidden", { status: 403 });
  const out = createWriteStream(filePath);
  await streamPipeline(Readable.fromWeb(file.stream()), out);
  return new Response(JSON.stringify({ ok: true, name }), { headers: { "Content-Type": "application/json" } });
}
// ============ SERVER DATA ============
// Raw row editor: exposes the servers table as JSON so advanced users can fix or
// tweak values the normal forms do not expose. `id` is the only immutable column.
const RAW_SERVER_FIELDS = [
  "name", "dir", "loader", "loader_version", "loader_build", "loader_channel", "java_version",
  "jar", "memory_min", "memory_max", "motd", "port", "online", "auto_start", "pid", "created_at",
  "jvm_args", "exec",
];
const RAW_INT_FIELDS = new Set(["port", "online", "auto_start", "pid", "created_at"]);

function rawServerError(set, message) {
  set.status = 400;
  return { ok: false, error: message };
}

export const serverDataRoute = new Elysia({ prefix: "/api/servers/:id/data" })
  .get("/", ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response("Not found", { status: 404 });
    return serverDataFromRow(row);
  })
  .get("/raw", ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return { row: { ...row } };
  })
  .post("/raw", async ({ params, body, set }) => {
    const current = getServerRow(params.id);
    if (!current) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

    let data = body;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { return rawServerError(set, "Invalid JSON"); }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return rawServerError(set, "Expected a JSON object");

    const nextLoader = data.loader !== undefined ? String(data.loader) : current.loader;
    const changingLoader = data.loader !== undefined && String(data.loader) !== String(current.loader || "");
    let allocatedPorts = null;
    if (data.port !== undefined || changingLoader) {
      const hasPort = data.port !== undefined && data.port !== null && data.port !== "";
      try {
        const allocation = await allocateServerPorts({
          serverId: params.id,
          loaderId: nextLoader,
          requested: hasPort ? { game: Number(data.port) } : null,
          checkOs: !isRunning(params.id),
        });
        allocatedPorts = allocation.ports;
        data.port = allocatedPorts.find((p) => p.role === "game")?.port ?? data.port;
      } catch (e) {
        if (e instanceof PortConflictError) return new Response(JSON.stringify({ ok: false, error: e.message, conflicts: e.conflicts }), { status: 409, headers: { "Content-Type": "application/json" } });
        throw e;
      }
    }

    const fields = [], vals = [];
    for (const [k, v] of Object.entries(data)) {
      if (k === "id") continue; // the row key is immutable; the UI also rejects changes
      if (!RAW_SERVER_FIELDS.includes(k)) return rawServerError(set, `Unknown or read-only column: ${k}`);
      let value = v;
      if (RAW_INT_FIELDS.has(k)) {
        if (v === null || v === "") value = null;
        else {
          value = Number(v);
          if (!Number.isInteger(value)) return rawServerError(set, `${k} must be an integer`);
        }
      } else if (k === "exec") {
        if (v === null) value = null;
        else if (typeof v === "object") value = JSON.stringify(v);
        else value = String(v);
      } else {
        value = v === null ? null : String(v);
      }
      fields.push(`${k} = ?`);
      vals.push(value);
    }
    if (!fields.length) return { ok: true, row: { ...current } };

    vals.push(params.id);
    db.prepare(`UPDATE servers SET ${fields.join(", ")} WHERE id = ?`).run(...vals);

    // Keep the on-disk properties in sync for the two fields the panel mirrors.
    if (data.motd !== undefined) setProp(params.id, "motd", data.motd);
    if (allocatedPorts) {
      saveServerPorts(params.id, allocatedPorts);
      applyPortsToConfig({ dir: serverFilesDir(params.id), loaderId: nextLoader, ports: allocatedPorts });
    }

    return { ok: true, row: { ...getServerRow(params.id) } };
  })
  .post("/", async ({ params, body, set }) => {
    const current = getServerRow(params.id);
    if (!current) return new Response("Not found", { status: 404 });
    let data = typeof body === "string" ? body : JSON.stringify(body);
    try { data = JSON.parse(data); } catch { set.status = 400; return { ok: false, error: "Invalid JSON" }; }
    if (!data || typeof data !== "object" || Array.isArray(data)) { set.status = 400; return { ok: false, error: "Expected a JSON object" }; }
    const nextLoader = data.loader !== undefined ? String(data.loader) : current.loader;
    const changingLoader = data.loader !== undefined && String(data.loader) !== String(current.loader || "");
    let allocatedPorts = null;
    if (data.port !== undefined || changingLoader) {
      const hasPort = data.port !== undefined && data.port !== null && data.port !== "";
      try {
        const allocation = await allocateServerPorts({
          serverId: params.id,
          loaderId: nextLoader,
          requested: hasPort ? { game: Number(data.port) } : null,
          checkOs: !isRunning(params.id),
        });
        allocatedPorts = allocation.ports;
        data.port = allocatedPorts.find((p) => p.role === "game")?.port ?? data.port;
      } catch (e) {
        if (e instanceof PortConflictError) return new Response(JSON.stringify({ ok: false, error: e.message, conflicts: e.conflicts }), { status: 409, headers: { "Content-Type": "application/json" } });
        throw e;
      }
    }
    const fields = [], vals = [];
    for (const k of ["name", "loader", "loader_version", "loader_build", "java_version", "memory_min", "memory_max", "jvm_args", "port", "motd"]) {
      if (data[k] === undefined) continue;
      let value = data[k];
      if (k === "port") {
        value = Number(value);
        if (!Number.isInteger(value) || value < 1 || value > 65535) continue;
      }
      if (k === "name" && (typeof value !== "string" || !value.trim() || value.length > 100)) continue;
      fields.push(`${k} = ?`); vals.push(value);
    }
    if (data.exec !== undefined) {
      if (data.exec === null) { fields.push("exec = ?"); vals.push(null); }
      else if (typeof data.exec === "object" && !Array.isArray(data.exec)) { fields.push("exec = ?"); vals.push(JSON.stringify(data.exec)); }
      else { set.status = 400; return { ok: false, error: "exec must be an object or null" }; }
    }
    if (fields.length) { vals.push(params.id); db.prepare(`UPDATE servers SET ${fields.join(", ")} WHERE id = ?`).run(...vals); }
    if (data.motd !== undefined) setProp(params.id, "motd", data.motd);
    if (allocatedPorts) {
      saveServerPorts(params.id, allocatedPorts);
      applyPortsToConfig({ dir: serverFilesDir(params.id), loaderId: nextLoader, ports: allocatedPorts });
    }
    return { ok: true };
  });

// ============ MOTD ============
export const motdRoute = new Elysia({ prefix: "/api/servers/:id/motd" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return { motd: getProp(params.id, "motd", "A SMP Server") };
  })
  .post("/", ({ params, body, set }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (!body || typeof body.motd !== "string") { set.status = 400; return { ok: false, error: "motd is required" }; }
    setProp(params.id, "motd", body.motd.replace(/[\r\n]+/g, " ").slice(0, 256));
    return { ok: true };
  });

// ============ TUNNEL ============
export const tunnelRoute = new Elysia({ prefix: "/api/tunnel" })
  .get("/status", () => ({ provider: "playit.gg", connected: false, url: null }))
  .post("/connect", () => ({ ok: true }));

// ============ SCHEDULES ============
function parseCron(cronStr) {
  const parts = String(cronStr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const field = /^(\*|\d+|\*\/\d+|\d+-\d+|\d+(,\d+)+)$/;
  if (![minute, hour, dayOfMonth, month, dayOfWeek].every((f) => field.test(f))) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export const schedulesRoute = new Elysia({ prefix: "/api/servers/:id/schedules" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return { schedules: db.prepare("SELECT * FROM schedules WHERE server_id = ?").all(params.id) };
  })
  .post("/", async ({ params, body }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const cron = String(body?.cron || "").trim();
    const command = String(body?.command || "").trim();
    if (!parseCron(cron)) return new Response(JSON.stringify({ error: "Invalid cron expression (use: min hour day month weekday)" }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (!command) return new Response(JSON.stringify({ error: "command is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO schedules(id,server_id,cron,command) VALUES(?,?,?,?)").run(id, params.id, cron, command);
    return { id, ok: true };
  })
  .delete("/:scheduleId", ({ params }) => {
    db.prepare("DELETE FROM schedules WHERE id = ? AND server_id = ?").run(params.scheduleId, params.id);
    return { ok: true };
  });

// ============ SFTP ============
export const sftpRoute = new Elysia({ prefix: "/api/servers/:id/sftp" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return { ok: true, ...getSftpInfo(params.id), status: getSftpStatus() };
  })
  .post("/enable", ({ params, body }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const enable = body?.enabled !== false && body?.enabled !== 0 && body?.enabled !== "0";
    if (enable && !getSftpInfo(params.id).hasPassword && !body?.password) {
      return new Response(JSON.stringify({ ok: false, error: "Set an SFTP password first" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    setSetting(sftpEnabledKey(params.id), enable ? "1" : "0");
    if (enable && body?.password) setSftpPassword(params.id, body.password);
    const st = getSftpStatus();
    if (enable && !st.running) startSftpServer();
    return { ok: true, ...getSftpInfo(params.id), status: getSftpStatus() };
  })
  .post("/password", ({ params, body }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (!body?.password) return new Response(JSON.stringify({ error: "Password required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    try { setSftpPassword(params.id, body.password); }
    catch (e) { return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 400, headers: { "Content-Type": "application/json" } }); }
    return { ok: true, ...getSftpInfo(params.id), status: getSftpStatus() };
  });

// ============ SERVER ICON ============
// pica/pngjs/jpeg-js are only needed when an icon is uploaded. Loading them lazily
// keeps the panel's cold start (and memory footprint) small.
let iconImageLibsPromise = null;
function loadIconImageLibs() {
  if (!iconImageLibsPromise) {
    iconImageLibsPromise = Promise.all([import("pica"), import("pngjs"), import("jpeg-js")])
      .then(([picaMod, pngMod, jpegMod]) => ({
        pica: new picaMod.default({ features: ["js"] }),
        PNG: pngMod.PNG,
        jpeg: jpegMod.default,
      }))
      .catch((e) => { iconImageLibsPromise = null; throw e; });
  }
  return iconImageLibsPromise;
}

function decodeImageToRgba(buf, { PNG, jpeg }) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const { width, height, data } = PNG.sync.read(b);
    return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) {
    const { width, height, data } = jpeg.decode(b, { useTArray: true });
    return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  }
  // BMP (24/32bpp, uncompressed) or reject
  if (b.length >= 54 && b[0] === 0x42 && b[1] === 0x4d) {
    const dataOffset = b.readUInt32LE(10);
    const dib = b.readUInt32LE(14);
    let width = 0, height = 0, bpp = 0;
    if (dib >= 40) { width = b.readInt32LE(18); height = b.readInt32LE(22); bpp = b.readUInt16LE(28); }
    else { throw new Error("Unsupported BMP header"); }
    const topDown = height < 0; height = Math.abs(height);
    if (![24, 32].includes(bpp) || b.readUInt32LE(30) !== 0) throw new Error("Unsupported BMP format (need uncompressed 24/32bpp)");
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcRow = topDown ? y : (height - 1 - y);
      const rowOff = dataOffset + srcRow * rowSize;
      for (let x = 0; x < width; x++) {
        const si = rowOff + x * (bpp / 8);
        const di = (y * width + x) * 4;
        rgba[di] = b[si + 2]; rgba[di + 1] = b[si + 1]; rgba[di + 2] = b[si]; rgba[di + 3] = bpp === 32 ? b[si + 3] : 255;
      }
    }
    return { width, height, data: rgba };
  }
  throw new Error("Unsupported image format (need PNG, JPEG, or BMP)");
}

async function resizeServerIcon(buf) {
  try {
    const { pica, PNG, jpeg } = await loadIconImageLibs();
    const src = decodeImageToRgba(buf, { PNG, jpeg });
    const destArr = new Uint8Array(64 * 64 * 4);
    await pica.resizeBuffer({
      src: new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength),
      width: src.width,
      height: src.height,
      toWidth: 64,
      toHeight: 64,
      dest: destArr,
    });
    const png = PNG.sync.write({ width: 64, height: 64, data: Buffer.from(destArr.buffer, destArr.byteOffset, destArr.byteLength) });
    return Buffer.from(png);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not process image: ${msg}. Supported input: PNG, JPEG, BMP (auto-resized to 64x64 PNG).`);
  }
}

export const serverIconRoute = new Elysia({ prefix: "/api/servers/:id/icon" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response("Not found", { status: 404 });
    const file = serverIconPath(params.id);
    if (!existsSync(file)) return new Response("Not found", { status: 404 });
    // The UI requests /icon?t=<mtime>, so the response is safe to cache forever.
    return new Response(Bun.file(file), { headers: { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_CACHE } });
  })
  .post("/", async ({ params, request }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const dir = serverFilesDir(params.id); mkdirSync(dir, { recursive: true });
    let buf;
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const f = form.get("file") || form.get("icon");
      if (!f || typeof f === "string") return new Response(JSON.stringify({ ok: false, error: "No file received (multipart field 'file'/'icon')." }), { status: 400, headers: { "Content-Type": "application/json" } });
      buf = Buffer.from(await f.arrayBuffer());
    } else {
      buf = Buffer.from(await request.arrayBuffer());
    }
    if (!buf || !buf.length) return new Response(JSON.stringify({ ok: false, error: "Empty file." }), { status: 400, headers: { "Content-Type": "application/json" } });
    let out;
    try {
      out = await resizeServerIcon(buf);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: msg, bytes: buf.length, bun: typeof Bun !== "undefined" ? Bun.version : null, hasBunImage: typeof Bun !== "undefined" ? !!Bun.Image : false }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    writeFileSync(join(dir, "server-icon.png"), out);
    return { ok: true };
  })
  .delete("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const file = join(serverFilesDir(params.id), "server-icon.png");
    if (existsSync(file)) unlinkSync(file);
    return { ok: true };
  });

// ============ PORTS ============
export const portsRoute = new Elysia({ prefix: "/api/ports" })
  .get("/", () => {
    const rows = db.prepare("SELECT * FROM servers ORDER BY name ASC").all();
    return {
      servers: rows.map((r) => ({
        id: r.id, name: r.name, loader: r.loader,
        ports: serverPortsStatus(r),
        profile: portProfile(r.loader),
      })),
    };
  })
  .post("/check", async ({ body }) => {
    const port = Number(body?.port);
    const protocol = String(body?.protocol || "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
    if (!isPortNumber(port)) {
      return new Response(JSON.stringify({ ok: false, available: false, error: "Port must be between 1 and 65535" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const serverId = typeof body?.serverId === "string" ? body.serverId : null;
    const owner = findPortOwner(port, protocol, { excludeServerId: serverId });
    const bindable = await isPortBindable(port, protocol, body?.family === 6 ? 6 : 4);
    return {
      ok: true, port, protocol,
      available: !owner && bindable,
      reason: owner ? "server" : bindable ? null : "system",
      server: owner ? { id: owner.serverId, name: owner.serverName } : null,
    };
  })
  .post("/allocate", async ({ body, set }) => {
    try {
      const { ports } = await allocateServerPorts({
        loaderId: String(body?.loader || "vanilla"),
        requested: body?.requested ?? null,
        checkOs: true,
      });
      return { ok: true, ports };
    } catch (e) {
      set.status = e?.status || 400;
      return { ok: false, error: e?.message || String(e), conflicts: e?.conflicts || [] };
    }
  });

// ============ UPDATES ============
// The panel compares the GitHub releases feed with the version in the root
// package.json. Applying an update stops every running server first, so no world
// is left mid-write while the files are replaced.
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

// The channel chosen in Settings wins, then the stored preference, then the one
// implied by the running version (pre-release builds start on experimental).
function resolveUpdateChannel(explicit) {
  if (explicit) return normalizeChannel(explicit);
  const stored = getSetting("update_channel", "");
  return normalizeChannel(stored || defaultChannel());
}

// Progress page served while a self-update runs. It shows nothing but a
// loading bar: the panel closes, swaps the files and restarts, so the only
// thing the user needs to know is when to go back to the panel and reload.
// It polls /api/updates/log (written by the detached updater and the relaunched
// panel) to tell when the new panel is answering.
const UPDATE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMP update</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #0d1117; color: #e6edf3; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { width: 100%; max-width: 460px; padding: 22px; background: #161b22; border: 1px solid #30363d; border-radius: 14px; }
  h1 { margin: 0 0 6px; font-size: 1rem; font-weight: 700; }
  .track { position: relative; height: 8px; margin: 18px 0 14px; background: #010409; border: 1px solid #30363d; border-radius: 999px; overflow: hidden; }
  .bar { position: absolute; top: 0; bottom: 0; width: 35%; border-radius: 999px; background: linear-gradient(90deg, #1f6feb, #58a6ff); animation: slide 1.4s ease-in-out infinite; transition: width 0.35s ease; }
  .track.done .bar { left: 0; width: 100%; animation: none; background: #3fb950; }
  .track.failed .bar { left: 0; width: 100%; animation: none; background: #f85149; }
  @keyframes slide { 0% { left: -35%; } 100% { left: 100%; } }
  .status { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 600; }
  .status.done { color: #3fb950; }
  .status.failed { color: #f85149; }
  .hint { margin: 8px 0 0; color: #8b949e; font-size: 0.82rem; line-height: 1.5; }
  .hint[hidden] { display: none; }
</style>
</head>
<body>
  <div class="card">
    <h1 id="title">Updating SMP</h1>
    <div class="track" id="track" role="progressbar" aria-label="Update progress"><div class="bar"></div></div>
    <div class="status" id="status">Loading…</div>
    <p class="hint" id="hint" hidden></p>
  </div>
<script>
  const title = document.getElementById("title");
  const track = document.getElementById("track");
  const status = document.getElementById("status");
  const hint = document.getElementById("hint");
  // Only lines written after this page opened belong to this update; older
  // updates left "panel relaunched" entries in the same log file.
  const pageStart = Date.now() - 10000;
  let finished = false;

  function finish(kind) {
    if (finished) return;
    finished = true;
    track.className = "track " + kind;
    if (kind === "done") {
      title.textContent = "Update complete";
      status.className = "status done";
      status.textContent = "Done";
      hint.hidden = false;
      hint.textContent = "Go back to the panel tab and reload the page.";
    } else {
      title.textContent = "Update failed";
      status.className = "status failed";
      status.textContent = "The panel did not come back up";
      hint.hidden = false;
      hint.textContent = "Start the panel again from the terminal. The updater log is update.log in your SMP data folder.";
    }
  }

  function outcome(text) {
    const lines = text.split("\\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const at = Date.parse((line.match(/^\\[([^\\]]+)\\]/) || [])[1] || "");
      if (!Number.isFinite(at) || at < pageStart) continue;
      if (/updater: panel relaunched/.test(line)) return "done";
      if (/updater: (relaunch FAILED|the panel did not exit)/.test(line)) return "failed";
    }
    return null;
  }

  async function poll() {
    if (finished) return;
    try {
      const res = await fetch("/api/updates/log", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const kind = outcome(await res.text());
      if (kind) return finish(kind);
      status.textContent = "Loading…";
    } catch {
      // The panel is closed while the files are swapped.
      status.textContent = "Loading…";
    }
    setTimeout(poll, 1000);
  }
  poll();
</script>
</body>
</html>`;

export const updatesRoute = new Elysia({ prefix: "/api/updates" })
  .get("/", async ({ query }) => getUpdateState({ channel: resolveUpdateChannel(query?.channel) }))
  .post("/check", async ({ body }) => getUpdateState({ channel: resolveUpdateChannel(body?.channel), force: true }))

  // Tail of the updater log (written by the detached updater and the relaunched
  // panel), consumed by the /update console page.
  .get("/log", () => {
    const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
    try {
      const buf = readFileSync(join(process.env.SMP_DATA_DIR || join(homedir(), ".smp"), "update.log"));
      return new Response(buf.subarray(Math.max(0, buf.length - 65536)).toString("utf8"), { headers });
    } catch {
      return new Response("", { headers });
    }
  })

  .post("/apply", async ({ body }) => {
    const target = String(body?.version || "").trim();
    const channel = resolveUpdateChannel(body?.channel);
    const state = await getUpdateState({ channel, force: true });
    const { ids, stopped } = await stopAllServers();
    const result = await applyUpdate({ target, current: state.current, channel });
    // The detached updater replaces the installation once this process exits.
    if (result.ok && result.restarting) {
      setTimeout(() => { try { process.exit(0); } catch {} }, 1500);
    }
    return { ok: result.ok, code: result.code || null, message: result.message || null, target, channel, version: state.current, servers: { total: ids.length, stopped }, applying: true };
  })
  .post("/shutdown", async ({ body, set }) => {
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "Panel shutdown requested";
    const { ids, stopped } = await stopAllServers();
    try { stopSftpServer(); } catch {}
    console.log(`[panel] ${reason} (stopped ${stopped.length}/${ids.length} servers)`);
    // Answer the request first; the process exits a moment later.
    setTimeout(() => {
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
      process.exit(0);
    }, 600);
    set.status = 202;
    return { ok: true, stopping: true, reason, stopped, etaMs: 600 };
  });

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

const app = new Elysia()
  .use(cors({
    // Reflect only configured origins. Returning `true` for any origin would let
    // every website call the panel with the user's credentials.
    origin: (origin) => {
      if (!origin) return true;
      const allowed = corsAllowedOrigins();
      return allowed.includes("*") || allowed.includes(origin);
    },
    credentials: true,
  }))
  .onRequest(async ({ request }) => {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/servers\/([^/]+)\/(files|upload)(\/.*)?$/);
    if (m) {
      try {
        const [, serverId, kind, restRaw] = m;
        const query = Object.fromEntries(url.searchParams.entries());
        if (kind === "upload") return await handleServerUpload(request, serverId, query);
        return await handleServerFiles(request, serverId, restRaw || "", query);
      } catch (e) {
        return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
  })
  .use(serversRoute)
  .use(portsRoute)
  .use(controlRoute)
  .use(jarRoute)
  .use(modsRoute)
  .use(modsSearchRoute)
  .use(modpackRoute)
  .use(modpackUploadRoute)
  .use(backupsRoute)
  .use(settingsRoute)
  .use(loadersRoute)
  .use(javaRoute)
  .use(systemRoute)
  .use(serverDataRoute)
  .use(motdRoute)
  .use(tunnelRoute)
  .use(schedulesRoute)
  .use(sftpRoute)
  .use(serverIconRoute)
  .use(updatesRoute)
  .use(panelRoute)
  .get("/update", () => new Response(UPDATE_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }))
  .get("/api/health", () => ({ ok: true, service: "smp", port: Number(process.env.SMP_PORT || process.env.PORT || 3001), pid: process.pid }))
  .get("/api/panel/info", () => ({ ok: true, service: "smp", version: appVersion(), port: Number(process.env.SMP_PORT || process.env.PORT || 3001), pid: process.pid, startedAt: globalThis.__smp_startedAt || (globalThis.__smp_startedAt = Date.now()) }))
  .get("/*", ({ request }) => {
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Not found", { status: 404 }); }
    if (pathname.startsWith("/api")) return new Response("Not found", { status: 404 });
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(OUTPUT_DIR, rel);
    const root = resolve(OUTPUT_DIR) + (process.platform === "win32" ? "\\" : "/");
    if (filePath !== resolve(OUTPUT_DIR) && !filePath.startsWith(root)) return new Response("Not found", { status: 404 });
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // Only unknown extension-less routes fall back to the SPA shell.
      if (pathname.startsWith("/assets/")) return new Response("Not found", { status: 404 });
      const indexFile = join(OUTPUT_DIR, "index.html");
      if (!existsSync(indexFile)) return new Response("Panel build missing. Run the web build.", { status: 500 });
      return new Response(Bun.file(indexFile), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    const ext = filePath.split(".").pop().toLowerCase();
    const cache = pathname.startsWith("/assets/")
      ? IMMUTABLE_CACHE
      : (rel === "index.html" ? "no-cache" : ASSET_CACHE);
    return new Response(Bun.file(filePath), {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache },
    });
  })
  .listen(Number(process.env.SMP_PORT || process.env.PORT || 3001));


function matchesCron(cron, date) {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay(); // 0 = Sunday

  function match(field, value) {
    if (field === "*") return true;
    if (field.includes(",")) return field.split(",").map(Number).includes(value);
    if (field.includes("/")) {
      const [range, stepRaw] = field.split("/");
      const step = parseInt(stepRaw, 10);
      if (!Number.isFinite(step) || step <= 0) return false;
      const [fromRaw, toRaw] = range.split("-");
      const from = fromRaw === "*" ? 0 : Number(fromRaw);
      const to = toRaw == null ? value : Number(toRaw);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
      if (fromRaw === "*") return value % step === 0;
      return value >= from && value <= to && (value - from) % step === 0;
    }
    if (field.includes("-")) {
      const [from, to] = field.split("-").map(Number);
      return Number.isFinite(from) && Number.isFinite(to) && value >= from && value <= to;
    }
    const n = parseInt(field, 10);
    return Number.isFinite(n) && n === value;
  }

  return match(cron.minute, minute) &&
         match(cron.hour, hour) &&
         match(cron.dayOfMonth, dayOfMonth) &&
         match(cron.month, month) &&
         match(cron.dayOfWeek, dayOfWeek);
}

async function runSchedules() {
  const now = new Date();
  let schedules = [];
  try { schedules = db.prepare("SELECT * FROM schedules WHERE enabled = 1").all(); } catch { return; }

  for (const sched of schedules) {
    const cron = parseCron(sched.cron);
    if (!cron || !matchesCron(cron, now)) continue;
    const r = runningServers.get(sched.server_id);
    const proc = r?.proc;
    if (!proc || proc.exitCode != null || !proc.stdin?.writable) continue;
    try {
      proc.stdin.write(sched.command + "\n");
      logLine(sched.server_id, `[SCHEDULE] ${sched.command}`);
    } catch (e) {
      logLine(sched.server_id, `[SCHEDULE ERROR] ${e.message}`);
    }
  }
}

// Run schedule check every minute
setInterval(runSchedules, 60 * 1000);
// Run once on startup
runSchedules();
try { autoStartSftp(); } catch {}

const __SMP_PORT = Number(process.env.SMP_PORT || process.env.PORT || 3001);
console.log(`SMP server running at http://localhost:${app.server?.port ?? __SMP_PORT}`);
export default app;

