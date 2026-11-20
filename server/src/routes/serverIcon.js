import { Elysia } from "elysia";
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { serverFilesDir, serverIconPath, IMMUTABLE_CACHE } from "../core/config.js";
import { getServerRow } from "../instances/servers.js";
import { resizeServerIcon } from "../instances/icon.js";

export const serverIconRoute = new Elysia({ prefix: "/api/servers/:id/icon" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response("Not found", { status: 404 });
    const file = serverIconPath(params.id);
    if (!existsSync(file)) return new Response("Not found", { status: 404 });
    // The UI requests /icon?t=<mtime>, so the response is safe to cache forever.
    return new Response(Bun.file(file), { headers: { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_CACHE } });
  })
  .post("/", async ({ params, request }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const dir = serverFilesDir(params.id); mkdirSync(dir, { recursive: true });
    let buf;
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const f = form.get("file") || form.get("icon");
      if (!f || typeof f === "string") return new Response(JSON.stringify({ ok: false, error: "No file received (multipart field 'file'/'icon')." }), { status: 400, headers: { "Content-Type": "application/json" } });
      buf = Buffer.from(await f.arrayBuffer());
    } else {
      buf = Buffer.from(await request.arrayBuffer());
    }
    if (!buf || !buf.length) return new Response(JSON.stringify({ ok: false, error: "Empty file." }), { status: 400, headers: { "Content-Type": "application/json" } });
    let out;
    try {
      out = await resizeServerIcon(buf);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ ok: false, error: msg, bytes: buf.length, bun: typeof Bun !== "undefined" ? Bun.version : null, hasBunImage: typeof Bun !== "undefined" ? !!Bun.Image : false }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    writeFileSync(join(dir, "server-icon.png"), out);
    return { ok: true };
  })
  .delete("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const file = join(serverFilesDir(params.id), "server-icon.png");
    if (existsSync(file)) unlinkSync(file);
    return { ok: true };
  });
