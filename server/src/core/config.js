import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync, rmSync, renameSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { getSetting } from "./db.js";
import { migrateServerPorts } from "../runtime/ports.js";
import { DATA_DIR } from "./paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "../../..");

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

function serverBackupsDir(id) { return join(serverPath(id), "backups"); }
function serverLogPath(id) { return join(serverPath(id), "logs.txt"); }
function serverEulaPath(id) { return join(serverFilesDir(id), "eula.txt"); }

export { DATA_DIR, SERVERS_DIR, JAVA_DIR, ROOT_DIR, OUTPUT_DIR, DEFAULT_CORS_ORIGINS, corsAllowedOrigins, MAX_TEXT_EDIT_BYTES, STREAM_THRESHOLD_BYTES, TEXT_EXTS, MIME, IMMUTABLE_CACHE, ASSET_CACHE, serverPath, isValidServerId, isValidBackupId, serverFilesDir, serverIconPath, hasServerIcon, serverIconVersion, serverBackupsDir, serverLogPath, serverEulaPath };
