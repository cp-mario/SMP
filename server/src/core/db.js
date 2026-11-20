import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import { DATA_DIR } from "./paths.js";
mkdirSync(DATA_DIR, { recursive: true });

let _db = null;

// WAL + NORMAL keeps writes durable across app crashes without an fsync per commit.
// mmap_size serves read pages from the OS page cache instead of copying them
// through the pager; wal_autocheckpoint + journal_size_limit keep the -wal file
// bounded so a long-running panel does not accumulate gigabytes of write-ahead
// log. cache_size is negative (KiB): 16 MiB is ample for a panel-sized database.
const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -16000;
  PRAGMA mmap_size = 268435456;
  PRAGMA wal_autocheckpoint = 1000;
  PRAGMA journal_size_limit = 67108864;
`;

function openDb() {
  if (_db) return _db;
  _db = new Database(path.join(DATA_DIR, "smp.sqlite"));
  try { _db.exec(PRAGMAS); } catch {}
  initDbSync(_db);
  return _db;
}

/**
 * Prepared-statement helpers.
 *
 * `db` is the single connection, so every statement is synchronous and costs
 * microseconds. Handles are cached because `prepare()` re-parses the SQL and the
 * panel repeats a handful of queries on every 1-5 s poll. The cache is bounded:
 * dynamic `UPDATE ... SET ${fields}` builders stay on `db.prepare` so they can
 * never grow the cache without limit.
 */
const STMT_CACHE_MAX = 512;
const stmtCache = new Map();

function stmt(sql) {
  let prepared = stmtCache.get(sql);
  if (!prepared) {
    if (stmtCache.size >= STMT_CACHE_MAX) clearStatements();
    prepared = db.prepare(sql);
    stmtCache.set(sql, prepared);
  }
  return prepared;
}

/** Read every row for `sql`, with cached statement handles. */
function query(sql, ...args) {
  return stmt(sql).all(...args);
}

/** Read the first row for `sql`, or undefined. */
function queryOne(sql, ...args) {
  return stmt(sql).get(...args);
}

/** Run a write statement (`INSERT`/`UPDATE`/`DELETE`) with a cached handle. */
function run(sql, ...args) {
  return stmt(sql).run(...args);
}

function clearStatements() {
  for (const prepared of stmtCache.values()) { try { prepared.finalize(); } catch {} }
  stmtCache.clear();
}

// Initialize immediately to avoid Proxy issues with Bun's Database
const db = openDb();

export { db, query, queryOne, run, stmt };

/**
 * Create the base tables (idempotent) and run any pending migrations.
 * The base tables are created first so migrations have a schema to work on.
 * Synchronous version used at module load time.
 */
export function initDbSync(conn = db) {
  _createBaseTables(conn);
  _createIndexes(conn);
}

/**
 * Async version of initDb that also runs versioned migrations.
 */
export async function initDb(conn = db) {
  _createBaseTables(conn);
  try {
    const { runMigrations } = await import("./migrations.js");
    runMigrations(conn);
  } catch {
    // migrations.js may not exist on very old installs; fall through gracefully
  }
  _createIndexes(conn);
}

function _createBaseTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL,
      loader TEXT NOT NULL DEFAULT 'vanilla', loader_version TEXT, loader_build TEXT NOT NULL DEFAULT '', java_version TEXT,
      loader_channel TEXT NOT NULL DEFAULT '',
      jar TEXT NOT NULL DEFAULT 'server.jar', memory_min TEXT DEFAULT '512M', memory_max TEXT DEFAULT '2G',
      motd TEXT DEFAULT 'A SMP Server', port INTEGER DEFAULT 25565,
      online INTEGER DEFAULT 0, auto_start INTEGER DEFAULT 0, pid INTEGER,
      jvm_args TEXT NOT NULL DEFAULT '',
      backup_limit INTEGER NOT NULL DEFAULT 0, backup_on_stop INTEGER NOT NULL DEFAULT 0,
      backup_on_update INTEGER NOT NULL DEFAULT 1, backup_on_loader INTEGER NOT NULL DEFAULT 1,
      backup_auto_prune INTEGER NOT NULL DEFAULT 0,
      exec TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS mods (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, source TEXT NOT NULL,
      project_id TEXT, version_id TEXT, version TEXT, filename TEXT,
      enabled INTEGER DEFAULT 1, download_url TEXT,
      project_title TEXT, slug TEXT, icon_url TEXT,
      game_versions TEXT, loaders TEXT,
      sha1 TEXT, sha256 TEXT, sha512 TEXT,
      file_size INTEGER, channel TEXT, date_published INTEGER,
      changelog TEXT, dependencies TEXT, store_url TEXT, meta TEXT,
      project_type TEXT,
      installed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS modpacks (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, source TEXT NOT NULL,
      project_id TEXT, version_id TEXT, version TEXT, title TEXT,
      icon_url TEXT, store_url TEXT, loader TEXT, loader_version TEXT,
      loader_build TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0, error TEXT, name TEXT, number INTEGER,
      protected INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT 'zip',
      reason TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, cron TEXT NOT NULL,
      command TEXT NOT NULL, enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
}

function _createIndexes(conn) {
  // Indexes for the hot query paths. Composite indexes let the common
  // "filter by server_id, newest first" reads run as a single index scan
  // without a temp b-tree sort.
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_servers_name ON servers(name)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_mods_server_installed ON mods(server_id, installed_at DESC)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_modpacks_server_created ON modpacks(server_id, created_at DESC)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_backups_server_created ON backups(server_id, created_at DESC, number DESC)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_backups_server_unprotected ON backups(server_id, created_at ASC, number ASC) WHERE protected = 0"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_schedules_server ON schedules(server_id)"); } catch {}
}

/**
 * Wipes every table and recreates the schema, leaving the database as it looks
 * on a fresh install. The file itself is kept: Windows keeps SQLite files
 * mapped even after close(), so unlinking it while the panel runs fails.
 */
export function resetDatabase() {
  try { db.exec("PRAGMA foreign_keys = OFF"); } catch {}
  let tables = [];
  try {
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  } catch {}
  for (const row of tables) {
    const name = String(row?.name || "").replace(/"/g, '""');
    if (!name) continue;
    try { db.exec(`DROP TABLE IF EXISTS "${name}"`); } catch {}
  }
  try { db.exec("PRAGMA foreign_keys = ON"); } catch {}
  initDb(db);
  // The pooled readers have no statements to reuse after the tables are gone.
  clearStatements();
  invalidateSettings();
  // Reclaim the space the deleted rows used to occupy and rebuild planner stats.
  try { db.exec("VACUUM"); } catch {}
  try { db.exec("ANALYZE"); } catch {}
}

// ---------- Settings ----------
/**
 * Settings are read on nearly every request (CORS origins, port guard flags,
 * update channel, SFTP flags). A small write-through cache keeps those reads
 * off the hot path; `setSetting` updates it in the same tick, so readers never
 * observe a stale value.
 */
const settingCache = new Map();
const SETTING_CACHE_MAX = 512;
let settingCacheLoaded = false;

function loadSettingCache() {
  if (settingCacheLoaded) return;
  settingCacheLoaded = true;
  try {
    for (const row of query("SELECT key, value FROM settings")) {
      settingCache.set(row.key, row.value);
    }
  } catch { /* first boot: table is created by initDb */ }
}

export function getSetting(key, def) {
  if (!settingCacheLoaded) loadSettingCache();
  if (settingCache.has(key)) return settingCache.get(key);
  const row = queryOne("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return def;
  if (settingCache.size >= SETTING_CACHE_MAX) settingCache.clear();
  settingCache.set(key, row.value);
  return row.value;
}

export function setSetting(key, value) {
  run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  settingCache.set(key, value);
}

/** Removes one setting from the database and the cache. */
export function deleteSetting(key) {
  run("DELETE FROM settings WHERE key = ?", key);
  settingCache.delete(key);
}

/**
 * Removes settings matching a `LIKE` pattern and drops them from the cache.
 * `prefix%` is the only form used by the panel, so the simple prefix check
 * avoids emulating SQL LIKE.
 */
export function deleteSettingsLike(pattern) {
  const removed = run("DELETE FROM settings WHERE key LIKE ?", pattern);
  const text = String(pattern);
  const prefix = text.endsWith("%") ? text.slice(0, -1) : null;
  for (const key of [...settingCache.keys()]) {
    const hit = prefix !== null ? key.startsWith(prefix) : key === text;
    if (hit) settingCache.delete(key);
  }
  return removed;
}

/** Drops cached settings (used by resetDatabase and cross-process edits). */
export function invalidateSettings() {
  settingCache.clear();
  settingCacheLoaded = false;
}

export function genId() { return crypto.randomUUID(); }
