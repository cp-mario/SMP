import { Elysia } from "elysia";
import { db } from "../core/db.js";
import { parseMemoryMb } from "../core/util.js";
import { jsonResponse } from "../core/http.js";
import { getServerRow, setServerPid, ensureServerDir, writeServerEula, readServerEula } from "../instances/servers.js";
import { runningServers, isRunning, startServerById, stopServerProcess, forceStopServerProcess, readProcessUsage, procUsageSamples } from "../instances/process.js";
import { createBackupRecord } from "../instances/backupOps.js";
import { logLine, getLogs, clearLogs, logStreams, logEncoder } from "../core/logs.js";

// ============ CONTROL ============
/**
 * Usage for every running server in one round trip.
 *
 * `GET /api/servers/:id/stats` per server costs a request (and a process read)
 * each; the resource panel on the server detail view and any future overview
 * widget need the same numbers, so the client polls once here.
 */
export const statsRoute = new Elysia({ prefix: "/api/stats" })
  .get("/", async ({ request }) => {
    const rows = db.prepare("SELECT * FROM servers ORDER BY name ASC").all();
    const now = Date.now();
    const out = [];
    for (const row of rows) {
      const online = isRunning(row.id);
      const memoryMaxBytes = parseMemoryMb(row.memory_max, 2048) * 1024 * 1024;
      const pid = online ? (runningServers.get(row.id)?.proc?.pid || row.pid || null) : null;
      if (!online || !pid) {
        procUsageSamples.delete(row.pid);
        out.push({ id: row.id, online: false, pid: null, cpuPercent: 0, memoryBytes: 0, memoryMaxBytes });
        continue;
      }
      const sample = await readProcessUsage(pid);
      if (!sample) {
        out.push({ id: row.id, online: true, pid, cpuPercent: 0, memoryBytes: 0, memoryMaxBytes, error: "Process stats unavailable" });
        continue;
      }
      const prev = procUsageSamples.get(pid);
      let cpuPercent = 0;
      if (prev && now > prev.t && sample.cpuSeconds >= prev.cpuSeconds) {
        cpuPercent = ((sample.cpuSeconds - prev.cpuSeconds) / ((now - prev.t) / 1000)) * 100;
      }
      procUsageSamples.set(pid, { cpuSeconds: sample.cpuSeconds, t: now });
      out.push({
        id: row.id,
        online: true,
        pid,
        cpuPercent: Math.max(0, Math.round(cpuPercent * 10) / 10),
        memoryBytes: sample.memoryBytes,
        memoryMaxBytes,
      });
    }
    return jsonResponse(request, { stats: out, timestamp: now });
  });

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
.get("/:id/stats", async ({ request, params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404 });
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
        c.enqueue(logEncoder().encode(`data: ${JSON.stringify({ init: init.lines, next: init.next, running: isRunning(id) })}\n\n`));
        const hb = setInterval(() => {
          try { c.enqueue(logEncoder().encode(`: ping\n\n`)); } catch { try { clearInterval(hb); } catch {} }
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
