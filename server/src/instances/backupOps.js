import { existsSync, statSync, mkdirSync, unlinkSync, rmdirSync, renameSync } from "fs";
import { join } from "path";
import { db, getSetting, setSetting } from "../core/db.js";
import { serverBackupsDir, serverFilesDir } from "../core/config.js";
import { logLine } from "../core/logs.js";
import { getServerRow } from "./servers.js";
import { formatBytes } from "../core/util.js";
import { createBackupArchive, convertZipToTarZst, BACKUP_FORMAT } from "./backups.js";

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

export { normalizeBackupName, backupNumberLabel, backupName, backupFormat, backupReasonLabel, backupJson, backupDateStamp, backupDownloadName, withBackupLock, backupLimitFor, peekBackupNumber, allocateBackupNumber, unprotectedBackups, overLimitBackups, deleteBackupRecord, createBackupRecord, enforceBackupLimit, ensureStoredTarZst };
