import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

const DATA_DIR = process.env.SMP_DATA_DIR || path.join(homedir(), ".smp");
mkdirSync(DATA_DIR, { recursive: true });

let _db = null;

// Single entry point: the module-level `db` below is the only connection.
function openDb() {
  if (_db) return _db;
  _db = new Database(path.join(DATA_DIR, "smp.sqlite"));
  try { _db.exec("PRAGMA journal_mode = WAL"); } catch {}
  try { _db.exec("PRAGMA busy_timeout = 5000"); } catch {}
  try { _db.exec("PRAGMA foreign_keys = ON"); } catch {}
  // WAL + NORMAL keeps writes durable across app crashes without an fsync per commit.
  try { _db.exec("PRAGMA synchronous = NORMAL"); } catch {}
  try { _db.exec("PRAGMA temp_store = MEMORY"); } catch {}
  try { _db.exec("PRAGMA cache_size = -8000"); } catch {}
  initDb(_db);
  return _db;
}

const SCHEMA_VERSION = 5;

// Initialize immediately to avoid Proxy issues with Bun's Database
const db = openDb();

export function initDb(conn = db) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL,
      loader TEXT NOT NULL DEFAULT 'vanilla', loader_version TEXT, loader_build TEXT NOT NULL DEFAULT '', java_version TEXT,
      jar TEXT NOT NULL DEFAULT 'server.jar', memory_min TEXT DEFAULT '512M', memory_max TEXT DEFAULT '2G',
      motd TEXT DEFAULT 'A SMP Server', port INTEGER DEFAULT 25565,
      online INTEGER DEFAULT 0, auto_start INTEGER DEFAULT 0, pid INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS mods (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, source TEXT NOT NULL,
      project_id TEXT, version_id TEXT, version TEXT, filename TEXT,
      enabled INTEGER DEFAULT 1, download_url TEXT,
      installed_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS modpacks (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, source TEXT NOT NULL,
      project_id TEXT, version_id TEXT, version TEXT, title TEXT,
      icon_url TEXT, store_url TEXT, loader TEXT, loader_version TEXT,
      loader_build TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, cron TEXT NOT NULL,
      command TEXT NOT NULL, enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  try { conn.prepare("ALTER TABLE mods ADD COLUMN download_url TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN pid INTEGER").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN jvm_args TEXT NOT NULL DEFAULT ''").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN loader_channel TEXT NOT NULL DEFAULT ''").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN loader_build TEXT NOT NULL DEFAULT ''").run(); } catch {}
  try { conn.prepare("ALTER TABLE backups ADD COLUMN error TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE backups ADD COLUMN name TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE backups ADD COLUMN number INTEGER").run(); } catch {}
  try { conn.prepare("ALTER TABLE backups ADD COLUMN protected INTEGER NOT NULL DEFAULT 0").run(); } catch {}
  try { conn.prepare("ALTER TABLE backups ADD COLUMN format TEXT NOT NULL DEFAULT 'zip'").run(); } catch {}
  try { conn.prepare("ALTER TABLE backups ADD COLUMN reason TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_limit INTEGER NOT NULL DEFAULT 0").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_on_stop INTEGER NOT NULL DEFAULT 0").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_on_update INTEGER NOT NULL DEFAULT 1").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_on_loader INTEGER NOT NULL DEFAULT 1").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_auto_prune INTEGER NOT NULL DEFAULT 0").run(); } catch {}
  try { conn.prepare("ALTER TABLE servers ADD COLUMN exec TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN project_title TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN slug TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN icon_url TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN game_versions TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN loaders TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN sha1 TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN sha256 TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN sha512 TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN file_size INTEGER").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN channel TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN date_published INTEGER").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN changelog TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN dependencies TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN store_url TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN meta TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN project_type TEXT").run(); } catch {}
  try { conn.prepare("ALTER TABLE mods ADD COLUMN updated_at INTEGER").run(); } catch {}

  // ---- Backup metadata migration (v4) ----
  // Older rows had no name/number/format. Assign stable numbers and default
  // names once; files ending in .tar.zst are marked as the new format.
  try {
    conn.exec("UPDATE backups SET format = 'tar.zst' WHERE lower(path) LIKE '%.tar.zst'");
    const pending = conn.prepare("SELECT id, server_id FROM backups WHERE number IS NULL ORDER BY server_id ASC, created_at ASC").all();
    if (pending.length) {
      const counters = new Map();
      for (const row of conn.prepare("SELECT server_id, MAX(number) AS max FROM backups WHERE number IS NOT NULL GROUP BY server_id").all()) {
        counters.set(row.server_id, Number(row.max) || 0);
      }
      const update = conn.prepare("UPDATE backups SET number = ?, name = COALESCE(NULLIF(name, ''), ?) WHERE id = ?");
      for (const row of pending) {
        const next = (counters.get(row.server_id) || 0) + 1;
        counters.set(row.server_id, next);
        update.run(next, `Backup #${next}`, row.id);
      }
    }
  } catch { /* migration is best-effort */ }

  try { conn.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); } catch {}

  // Indexes for the hot query paths (server list, mods/backup listing, schedule loop).
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_servers_name ON servers(name)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_mods_server ON mods(server_id)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_backups_server_created ON backups(server_id, created_at DESC)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled)"); } catch {}
  try { conn.exec("CREATE INDEX IF NOT EXISTS idx_modpacks_server ON modpacks(server_id)"); } catch {}
}

export { db };

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
  // Reclaim the space the deleted rows used to occupy.
  try { db.exec("VACUUM"); } catch {}
}

export function getSetting(key, def) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : def;
}
export function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
export function genId() { return crypto.randomUUID(); }
