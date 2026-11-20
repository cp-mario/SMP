import { Elysia } from "elysia";
import { db } from "../core/db.js";
import { serverPortsStatus, portProfile, isPortNumber, findPortOwner, isPortBindable, allocateServerPorts } from "../runtime/ports.js";

// ============ PORTS ============
export const portsRoute = new Elysia({ prefix: "/api/ports" })
  .get("/", () => {
    const rows = db.prepare("SELECT * FROM servers ORDER BY name ASC").all();
    return {
      servers: rows.map((r) => ({
        id: r.id, name: r.name, loader: r.loader,
        ports: serverPortsStatus(r),
        profile: portProfile(r.loader),
      })),
    };
  })
  .post("/check", async ({ body }) => {
    const port = Number(body?.port);
    const protocol = String(body?.protocol || "tcp").toLowerCase() === "udp" ? "udp" : "tcp";
    if (!isPortNumber(port)) {
      return new Response(JSON.stringify({ ok: false, available: false, error: "Port must be between 1 and 65535" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const serverId = typeof body?.serverId === "string" ? body.serverId : null;
    const owner = findPortOwner(port, protocol, { excludeServerId: serverId });
    const bindable = await isPortBindable(port, protocol, body?.family === 6 ? 6 : 4);
    return {
      ok: true, port, protocol,
      available: !owner && bindable,
      reason: owner ? "server" : bindable ? null : "system",
      server: owner ? { id: owner.serverId, name: owner.serverName } : null,
    };
  })
  .post("/allocate", async ({ body, set }) => {
    try {
      const { ports } = await allocateServerPorts({
        loaderId: String(body?.loader || "vanilla"),
        requested: body?.requested ?? null,
        checkOs: true,
      });
      return { ok: true, ports };
    } catch (e) {
      set.status = e?.status || 400;
      return { ok: false, error: e?.message || String(e), conflicts: e?.conflicts || [] };
    }
  });
