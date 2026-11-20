import { Elysia } from "elysia";
import { db, setSetting } from "../core/db.js";
import { jsonResponse } from "../core/http.js";
import { listLoaders } from "../loaders/index.js";
import { portProfile } from "../runtime/ports.js";

// ============ SETTINGS ============
export const settingsRoute = new Elysia({ prefix: "/api/settings" })
  .get("/", ({ request }) => {
    // Reads go through the pooled connection so they never queue behind a
    // concurrent write on the main handle.
    const rows = db.prepare("SELECT key, value FROM settings").all();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    return jsonResponse(request, { settings: s });
  })
  .post("/", ({ body, set }) => {
    const { key, value } = body || {};
    if (!key || typeof key !== "string") { set.status = 400; return { ok: false, error: "key is required" }; }
    setSetting(key, value == null ? "" : String(value));
    return { ok: true };
  });

// ============ LOADERS ============
export const loadersRoute = new Elysia({ prefix: "/api/loaders" })
  .get("/", () => ({ loaders: listLoaders().map((l) => ({ ...l, ports: portProfile(l.id) })) }));
