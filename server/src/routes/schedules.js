import { Elysia } from "elysia";
import { query, run } from "../core/db.js";
import { getServerRow } from "../instances/servers.js";
import { parseCron } from "../instances/schedules.js";

export const schedulesRoute = new Elysia({ prefix: "/api/servers/:id/schedules" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return { schedules: query("SELECT * FROM schedules WHERE server_id = ?", params.id) };
  })
  .post("/", async ({ params, body }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const cron = String(body?.cron || "").trim();
    const command = String(body?.command || "").trim();
    if (!parseCron(cron)) return new Response(JSON.stringify({ error: "Invalid cron expression (use: min hour day month weekday)" }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (!command) return new Response(JSON.stringify({ error: "command is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const id = crypto.randomUUID();
    run("INSERT INTO schedules(id,server_id,cron,command) VALUES(?,?,?,?)", id, params.id, cron, command);
    return { id, ok: true };
  })
  .delete("/:scheduleId", ({ params }) => {
    run("DELETE FROM schedules WHERE id = ? AND server_id = ?", params.scheduleId, params.id);
    return { ok: true };
  });
