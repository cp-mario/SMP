import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { OUTPUT_DIR, MIME, IMMUTABLE_CACHE, ASSET_CACHE, corsAllowedOrigins } from "./core/config.js";
import { compressResponse, fileResponse } from "./core/http.js";
import { handleServerFiles, handleServerUpload } from "./instances/files.js";
import { appVersion } from "./core/version.js";
import { UPDATE_PAGE_HTML } from "./core/updatePage.js";
import { serversRoute } from "./routes/servers.js";
import { statsRoute, controlRoute } from "./routes/control.js";
import { portsRoute } from "./routes/ports.js";
import { jarRoute } from "./routes/jar.js";
import { modsRoute, modsSearchRoute } from "./routes/mods.js";
import { modpackRoute, modpackUploadRoute } from "./routes/modpacks.js";
import { backupsRoute } from "./routes/backups.js";
import { settingsRoute, loadersRoute } from "./routes/settings.js";
import { javaRoute, systemRoute } from "./routes/system.js";
import { serverDataRoute } from "./routes/serverData.js";
import { motdRoute, tunnelRoute } from "./routes/misc.js";
import { schedulesRoute } from "./routes/schedules.js";
import { sftpRoute } from "./routes/sftp.js";
import { serverIconRoute } from "./routes/serverIcon.js";
import { updatesRoute } from "./routes/updates.js";
import { panelRoute } from "./routes/panel.js";

const app = new Elysia()
  .use(cors({
    // Reflect only configured origins. Returning `true` for any origin would let
    // every website call the panel with the user's credentials.
    origin: (origin) => {
      if (!origin) return true;
      const allowed = corsAllowedOrigins();
      return allowed.includes("*") || allowed.includes(origin);
    },
    credentials: true,
  }))
  // Compress JSON API responses. The panel polls every 1-5 s, and its payloads
  // are repetitive JSON that gzips by ~80%.
  .onAfterHandle(async ({ request, response }) => compressResponse(request, response))
  .onRequest(async ({ request }) => {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/servers\/([^/]+)\/(files|upload)(\/.*)?$/);
    if (m) {
      try {
        const [, serverId, kind, restRaw] = m;
        const query = Object.fromEntries(url.searchParams.entries());
        if (kind === "upload") return await handleServerUpload(request, serverId, query);
        return await handleServerFiles(request, serverId, restRaw || "", query);
      } catch (e) {
        return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
  })
  .use(serversRoute)
  .use(statsRoute)
  .use(portsRoute)
  .use(controlRoute)
  .use(jarRoute)
  .use(modsRoute)
  .use(modsSearchRoute)
  .use(modpackRoute)
  .use(modpackUploadRoute)
  .use(backupsRoute)
  .use(settingsRoute)
  .use(loadersRoute)
  .use(javaRoute)
  .use(systemRoute)
  .use(serverDataRoute)
  .use(motdRoute)
  .use(tunnelRoute)
  .use(schedulesRoute)
  .use(sftpRoute)
  .use(serverIconRoute)
  .use(updatesRoute)
  .use(panelRoute)
  .get("/update", () => new Response(UPDATE_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }))
  .get("/api/health", () => ({ ok: true, service: "smp", port: Number(process.env.SMP_PORT || process.env.PORT || 3001), pid: process.pid }))
  .get("/api/panel/info", () => ({ ok: true, service: "smp", version: appVersion(), port: Number(process.env.SMP_PORT || process.env.PORT || 3001), pid: process.pid, startedAt: globalThis.__smp_startedAt || (globalThis.__smp_startedAt = Date.now()) }))
  .get("/*", ({ request }) => {
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Not found", { status: 404 }); }
    if (pathname.startsWith("/api")) return new Response("Not found", { status: 404 });
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(OUTPUT_DIR, rel);
    const root = resolve(OUTPUT_DIR) + (process.platform === "win32" ? "\\" : "/");
    if (filePath !== resolve(OUTPUT_DIR) && !filePath.startsWith(root)) return new Response("Not found", { status: 404 });
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // Only unknown extension-less routes fall back to the SPA shell.
      if (pathname.startsWith("/assets/")) return new Response("Not found", { status: 404 });
      const indexFile = join(OUTPUT_DIR, "index.html");
      if (!existsSync(indexFile)) return new Response("Panel build missing. Run the web build.", { status: 500 });
      return fileResponse(request, indexFile, "text/html; charset=utf-8", "no-cache");
    }
    const ext = filePath.split(".").pop().toLowerCase();
    const cache = pathname.startsWith("/assets/")
      ? IMMUTABLE_CACHE
      : (rel === "index.html" ? "no-cache" : ASSET_CACHE);
    return fileResponse(request, filePath, MIME[ext] || "application/octet-stream", cache);
  })
  .listen(Number(process.env.SMP_PORT || process.env.PORT || 3001));

export default app;
