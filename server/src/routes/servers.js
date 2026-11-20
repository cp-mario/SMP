import { Elysia } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { db, query, run, setSetting, deleteSetting, deleteSettingsLike, getSetting } from "../core/db.js";
import { isValidServerId, serverPath, serverFilesDir, hasServerIcon, serverIconVersion } from "../core/config.js";
import { rmdirRecursive, formatMemoryMb, clampMemoryMb, parseMemoryMb, normalizeJvmArgs, parseExec, flagValue } from "../core/util.js";
import { jsonResponse } from "../core/http.js";
import { getServerRow, setServerPid, createServerRecord, modFromRow, setProp, invalidateServerRowCache } from "../instances/servers.js";
import { isRunning, runningServers } from "../instances/process.js";
import { createBackupRecord, enforceBackupLimit } from "../instances/backupOps.js";
import { getServerUpdateInfo, getModpackUpdateInfo, modpackMeta, getModpackRow } from "../instances/updates.js";
import { getLoader } from "../loaders/index.js";
import { sftpEnabledKey, sftpPasswordKey } from "../runtime/sftp.js";
import { portProfile, serverPortsStatus, allocateServerPorts, saveServerPorts, applyPortsToConfig, isPortNumber, findPortOwner, insertServerExtraPort, updateServerExtraPort, deleteServerExtraPort, getServerExtraPorts, deleteServerPorts, usedPorts, invalidatePortCache, PortConflictError } from "../runtime/ports.js";

// ============ SERVERS ============
export const serversRoute = new Elysia({ prefix: "/api/servers" })
  .get("/", async ({ request, query: queryParams }) => {
    // One snapshot for the whole list: per-server lookups would run two
    // queries each (loader ports + plugin ports) plus one reservation scan.
    const rows = query("SELECT id, name, dir, loader, loader_version, loader_build, loader_channel, java_version, jar, memory_min, memory_max, motd, port, online, auto_start, pid, jvm_args, backup_limit, backup_on_stop, backup_on_update, backup_on_loader, backup_auto_prune, exec, created_at FROM servers ORDER BY name ASC");
    const sharedPorts = usedPorts();
    const modsByServer = new Map();
    for (const m of query("SELECT id, server_id, source, project_id, version_id, version, filename, enabled, download_url, project_title, slug, icon_url, game_versions, loaders, sha1, sha256, sha512, file_size, channel, date_published, changelog, dependencies, store_url, meta, project_type, installed_at, updated_at FROM mods")) {
      if (!modsByServer.has(m.server_id)) modsByServer.set(m.server_id, []);
      modsByServer.get(m.server_id).push(modFromRow(m));
    }
    const withUpdates = String(queryParams?.updates || "") === "1";
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
      out.push({ ...r, online: online ? 1 : 0, ports: serverPortsStatus(r, sharedPorts), mods, java: !!lm.java, eula_required: !!lm.eula, loader_custom: !!lm.custom, has_icon: hasServerIcon(r.id), icon_version: serverIconVersion(r.id), update, modpack: pack ? modpackMeta(pack) : null });
    }
    return jsonResponse(request, { servers: out });
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
  .get("/:id", async ({ request, params, query: queryParams }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response("Not found", { status: 404 });
    const mods = query("SELECT id, server_id, source, project_id, version_id, version, filename, enabled, download_url, project_title, slug, icon_url, game_versions, loaders, sha1, sha256, sha512, file_size, channel, date_published, changelog, dependencies, store_url, meta, project_type, installed_at, updated_at FROM mods WHERE server_id = ?", row.id).map(modFromRow);
    const online = isRunning(row.id);
    if (!online && row.pid) setServerPid(row.id, null);
    const lm = (getLoader(row.loader) || { meta: () => ({}) }).meta?.() || {};
    const withUpdates = String(queryParams?.updates || "1") !== "0";
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
    return jsonResponse(request, { server: { ...row, online: online ? 1 : 0, ports: serverPortsStatus(row), strict_ports: getSetting(`ports_strict_${row.id}`, "0") === "1", port_profile: portProfile(row.loader), mods, java: !!lm.java, eula_required: !!lm.eula, loader_custom: !!lm.custom, has_icon: hasServerIcon(row.id), icon_version: serverIconVersion(row.id), update, modpack } });
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
    const backups = query("SELECT path FROM backups WHERE server_id = ?", params.id);
    for (const b of backups) { try { if (b?.path && existsSync(b.path)) unlinkSync(b.path); } catch {} }
    try { run("DELETE FROM mods WHERE server_id = ?", params.id); } catch {}
    try { run("DELETE FROM backups WHERE server_id = ?", params.id); } catch {}
    try { run("DELETE FROM schedules WHERE server_id = ?", params.id); } catch {}
    try { deleteServerPorts(params.id); } catch {}
    try { run("DELETE FROM servers WHERE id = ?", params.id); } catch {}
    try { deleteSettingsLike(`sftp_%_${params.id}`); } catch {}
    try { deleteSetting(sftpEnabledKey(params.id)); } catch {}
    try { deleteSetting(sftpPasswordKey(params.id)); } catch {}
    try { deleteSetting(`backup_seq_${params.id}`); } catch {}
    try { deleteSetting(`ports_strict_${params.id}`); } catch {}
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
      // `usedPorts` caches the server name join for conflict labels.
      if (body.name !== undefined) invalidatePortCache();
    }
    if (body.motd !== undefined) await setProp(params.id, "motd", body.motd);
    if (allocatedPorts) {
      saveServerPorts(params.id, allocatedPorts);
      applyPortsToConfig({ dir: serverFilesDir(params.id), loaderId: effectiveLoader, ports: allocatedPorts });
    }
    if (body.backup_limit !== undefined || body.backup_auto_prune !== undefined) {
      // Existing backups are only pruned when the server explicitly opts into
      // automatic cleanup. Otherwise the UI offers a manual "delete over limit".
      if (getServerRow(params.id)?.backup_auto_prune) enforceBackupLimit(params.id);
    }
    // Invalidate the cached server row so the next read sees the new values.
    invalidateServerRowCache(params.id);
    return { ok: true };
  });
