import { Elysia } from "elysia";
import { setSetting } from "../core/db.js";
import { getServerRow } from "../instances/servers.js";
import { getSftpInfo, setSftpPassword, startSftpServer, getSftpStatus, sftpEnabledKey } from "../runtime/sftp.js";

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
