/**
 * Formal migration system for the SMP SQLite database.
 *
 * Replaces ~30 `try { ALTER TABLE } catch {}` blocks with versioned, auditable
 * migrations stored in a `schema_migrations` table. Each migration runs once
 * and is tracked by version number. VACUUM runs only on major migrations
 * (when tables/indexes are dropped) instead of every schema change.
 *
 * Usage: add a new entry to the `migrations` array with a version number higher
 * than the current `SCHEMA_VERSION`. The `up` function receives the DB connection
 * and runs the migration SQL.
 */

import { db } from "./db.js";

const SCHEMA_VERSION = 6;

/**
 * Migration definitions, ordered by version.
 * Each migration runs exactly once when the schema version is below its number.
 */
const migrations = [
  {
    version: 1,
    up(conn) {
      // Initial migration: add download_url to mods
      try { conn.prepare("ALTER TABLE mods ADD COLUMN download_url TEXT").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN pid INTEGER").run(); } catch {}
    },
  },
  {
    version: 2,
    up(conn) {
      // Server columns: jvm_args, loader_channel, loader_build
      try { conn.prepare("ALTER TABLE servers ADD COLUMN jvm_args TEXT NOT NULL DEFAULT ''").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN loader_channel TEXT NOT NULL DEFAULT ''").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN loader_build TEXT NOT NULL DEFAULT ''").run(); } catch {}
    },
  },
  {
    version: 3,
    up(conn) {
      // Backup columns: error, name, number, protected, format, reason
      try { conn.prepare("ALTER TABLE backups ADD COLUMN error TEXT").run(); } catch {}
      try { conn.prepare("ALTER TABLE backups ADD COLUMN name TEXT").run(); } catch {}
      try { conn.prepare("ALTER TABLE backups ADD COLUMN number INTEGER").run(); } catch {}
      try { conn.prepare("ALTER TABLE backups ADD COLUMN protected INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      try { conn.prepare("ALTER TABLE backups ADD COLUMN format TEXT NOT NULL DEFAULT 'zip'").run(); } catch {}
      try { conn.prepare("ALTER TABLE backups ADD COLUMN reason TEXT").run(); } catch {}
      // Server backup settings
      try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_limit INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_on_stop INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_on_update INTEGER NOT NULL DEFAULT 1").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_on_loader INTEGER NOT NULL DEFAULT 1").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN backup_auto_prune INTEGER NOT NULL DEFAULT 0").run(); } catch {}
      try { conn.prepare("ALTER TABLE servers ADD COLUMN exec TEXT").run(); } catch {}
    },
  },
  {
    version: 4,
    up(conn) {
      // Mod metadata columns
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
      // Backup metadata migration: assign stable numbers and default names
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
    },
  },
  {
    version: 5,
    up(conn) {
      // Drop legacy tables and redundant indexes, then VACUUM (major migration)
      for (const legacy of ["schedule_runs", "server_stats"]) {
        try { conn.exec(`DROP TABLE IF EXISTS ${legacy}`); } catch {}
      }
      try {
        conn.exec(`
          DROP INDEX IF EXISTS idx_mods_server;
          DROP INDEX IF EXISTS idx_mods_source;
          DROP INDEX IF EXISTS idx_mods_enabled;
          DROP INDEX IF EXISTS idx_modpacks_server;
          DROP INDEX IF EXISTS idx_modpacks_source;
          DROP INDEX IF EXISTS idx_backups_server_created;
          DROP INDEX IF EXISTS idx_schedules_server_enabled;
        `);
      } catch {}
      // VACUUM only on major migrations that drop tables/indexes
      try { conn.exec("VACUUM"); } catch {}
      try { conn.exec("ANALYZE"); } catch {}
    },
  },
  {
    version: 6,
    up(conn) {
      // Add ON DELETE CASCADE to foreign key tables
      // SQLite requires recreating tables to add ON DELETE CASCADE.
      // We do this safely by renaming, recreating, copying, and dropping.
      addCascadeToMods(conn);
      addCascadeToModpacks(conn);
      addCascadeToBackups(conn);
      addCascadeToSchedules(conn);
      addCascadeToServerPorts(conn);
      addCascadeToServerExtraPorts(conn);
      try { conn.exec("VACUUM"); } catch {}
      try { conn.exec("ANALYZE"); } catch {}
    },
  },
];

/**
 * Recreate a table with ON DELETE CASCADE on server_id.
 * SQLite does not support ALTER TABLE to add foreign key constraints,
 * so we must recreate the table.
 */
function recreateTableWithCascade(conn, tableName, createSQL, columns) {
  const tempName = `${tableName}_tmp`;
  try {
    conn.exec(`DROP TABLE IF EXISTS ${tempName}`);
    conn.exec(createSQL.replace(`CREATE TABLE ${tableName}`, `CREATE TABLE ${tempName}`));
    // Copy data from old to new
    const colList = columns.join(", ");
    conn.exec(`INSERT INTO ${tempName}(${colList}) SELECT ${colList} FROM ${tableName}`);
    conn.exec(`DROP TABLE ${tableName}`);
    conn.exec(`ALTER TABLE ${tempName} RENAME TO ${tableName}`);
  } catch (e) {
    // If the table doesn't exist yet (fresh install), just create it
    try { conn.exec(createSQL); } catch {}
  }
}

function addCascadeToMods(conn) {
  recreateTableWithCascade(conn, "mods",
    `CREATE TABLE mods (
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
    )`,
    ["id", "server_id", "source", "project_id", "version_id", "version", "filename",
     "enabled", "download_url", "project_title", "slug", "icon_url",
     "game_versions", "loaders", "sha1", "sha256", "sha512", "file_size",
     "channel", "date_published", "changelog", "dependencies", "store_url",
     "meta", "project_type", "installed_at", "updated_at"]
  );
}

function addCascadeToModpacks(conn) {
  recreateTableWithCascade(conn, "modpacks",
    `CREATE TABLE modpacks (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, source TEXT NOT NULL,
      project_id TEXT, version_id TEXT, version TEXT, title TEXT,
      icon_url TEXT, store_url TEXT, loader TEXT, loader_version TEXT,
      loader_build TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    ["id", "server_id", "source", "project_id", "version_id", "version", "title",
     "icon_url", "store_url", "loader", "loader_version", "loader_build", "created_at"]
  );
}

function addCascadeToBackups(conn) {
  recreateTableWithCascade(conn, "backups",
    `CREATE TABLE backups (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0, error TEXT, name TEXT, number INTEGER,
      protected INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT 'zip',
      reason TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    ["id", "server_id", "path", "size", "error", "name", "number", "protected",
     "format", "reason", "created_at"]
  );
}

function addCascadeToSchedules(conn) {
  recreateTableWithCascade(conn, "schedules",
    `CREATE TABLE schedules (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, cron TEXT NOT NULL,
      command TEXT NOT NULL, enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    ["id", "server_id", "cron", "command", "enabled", "created_at"]
  );
}

function addCascadeToServerPorts(conn) {
  recreateTableWithCascade(conn, "server_ports",
    `CREATE TABLE server_ports (
      server_id TEXT NOT NULL, role TEXT NOT NULL, port INTEGER NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'tcp',
      PRIMARY KEY (server_id, role),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    ["server_id", "role", "port", "protocol"]
  );
}

function addCascadeToServerExtraPorts(conn) {
  recreateTableWithCascade(conn, "server_extra_ports",
    `CREATE TABLE server_extra_ports (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, label TEXT NOT NULL,
      port INTEGER NOT NULL, protocol TEXT NOT NULL DEFAULT 'tcp',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    ["id", "server_id", "label", "port", "protocol", "created_at"]
  );
}

/**
 * Run any pending migrations. Safe to call multiple times;
 * already-applied migrations are skipped.
 */
export function runMigrations(conn = db) {
  // Create the migrations tracking table
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  // Find the highest applied version
  let currentVersion = 0;
  try {
    const row = conn.prepare("SELECT MAX(version) AS max FROM schema_migrations").get();
    currentVersion = Number(row?.max) || 0;
  } catch {}

  // Also check user_version pragma for backward compatibility
  try {
    const uv = Number(conn.prepare("PRAGMA user_version").get()?.user_version) || 0;
    if (uv > currentVersion) currentVersion = uv;
  } catch {}

  // Run pending migrations in order
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    try {
      migration.up(conn);
      conn.prepare("INSERT OR REPLACE INTO schema_migrations(version) VALUES(?)").run(migration.version);
    } catch (e) {
      console.error(`[db] Migration v${migration.version} failed: ${e.message}`);
      // Continue with next migrations — best-effort
    }
  }

  // Sync user_version for backward compatibility
  const finalVersion = Math.max(currentVersion, ...migrations.map(m => m.version));
  try { conn.exec(`PRAGMA user_version = ${finalVersion}`); } catch {}
}

/** Return the current schema version. */
export function getCurrentSchemaVersion(conn = db) {
  try {
    const row = conn.prepare("SELECT MAX(version) AS max FROM schema_migrations").get();
    return Number(row?.max) || 0;
  } catch {
    return 0;
  }
}

export { SCHEMA_VERSION };
