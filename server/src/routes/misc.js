import { Elysia } from "elysia";
import { getServerRow, getProp, setProp } from "../instances/servers.js";

// ============ MOTD ============
export const motdRoute = new Elysia({ prefix: "/api/servers/:id/motd" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return { motd: getProp(params.id, "motd", "A SMP Server") };
  })
  .post("/", async ({ params, body, set }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (!body || typeof body.motd !== "string") { set.status = 400; return { ok: false, error: "motd is required" }; }
    await setProp(params.id, "motd", body.motd.replace(/[\r\n]+/g, " ").slice(0, 256));
    return { ok: true };
  });

// ============ TUNNEL ============
export const tunnelRoute = new Elysia({ prefix: "/api/tunnel" })
  .get("/status", () => ({ provider: "playit.gg", connected: false, url: null }))
  .post("/connect", () => ({ ok: true }));
