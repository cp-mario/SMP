import { Elysia } from "elysia";
import { db } from "../core/db.js";
import { serverFilesDir } from "../core/config.js";
import { getServerRow, serverDataFromRow, setProp } from "../instances/servers.js";
import { isRunning } from "../instances/process.js";
import { allocateServerPorts, saveServerPorts, applyPortsToConfig, invalidatePortCache, PortConflictError } from "../runtime/ports.js";

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
    if (data.name !== undefined) invalidatePortCache();

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
    if (fields.length) { vals.push(params.id); db.prepare(`UPDATE servers SET ${fields.join(", ")} WHERE id = ?`).run(...vals); if (data.name !== undefined) invalidatePortCache(); }
    if (data.motd !== undefined) setProp(params.id, "motd", data.motd);
    if (allocatedPorts) {
      saveServerPorts(params.id, allocatedPorts);
      applyPortsToConfig({ dir: serverFilesDir(params.id), loaderId: nextLoader, ports: allocatedPorts });
    }
    return { ok: true };
  });
