import { Elysia } from "elysia";
import { existsSync, statSync, mkdirSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { db } from "../core/db.js";
import { isValidBackupId, serverPath, serverFilesDir } from "../core/config.js";
import { attachmentName } from "../core/util.js";
import { getServerRow } from "../instances/servers.js";
import { backupJson, backupFormat, backupName, backupNumberLabel, backupDownloadName, normalizeBackupName, backupLimitFor, peekBackupNumber, createBackupRecord, deleteBackupRecord, overLimitBackups, withBackupLock, ensureStoredTarZst } from "../instances/backupOps.js";
import { logLine } from "../core/logs.js";
import { isRunning, stopServerProcess } from "../instances/process.js";
import { extractBackupArchive, tarZstToZip } from "../instances/backups.js";

// ============ BACKUPS ============
const backupJsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });


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
