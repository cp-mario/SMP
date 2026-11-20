import { Elysia } from "elysia";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { queryOne, run } from "../core/db.js";
import { JAVA_DIR, isValidServerId } from "../core/config.js";
import { DATA_DIR } from "../core/paths.js";
import { jsonResponse } from "../core/http.js";
import { ensureServerDir } from "../instances/servers.js";
import { getLoader } from "../loaders/index.js";
import { invalidateLoaderCache } from "../loaders/BaseLoader.js";
import { resolveJavaCommand } from "../runtime/java.js";
import { normalizeVersionList, filterVersionsByChannel, fetchLoaderVersionsFor, invalidateServerUpdateCache, invalidateBuildCache } from "../instances/updates.js";

export const jarRoute = new Elysia({ prefix: "/api/jar" })
  .get("/download", async ({ query }) => {
    const { loader, version, serverId, channel = "all", loaderVersion, loader_build, loaderBuild } = query;
    if (serverId && !isValidServerId(serverId)) return new Response("Server not found", { status: 404 });
    const row = serverId ? queryOne("SELECT * FROM servers WHERE id = ?", serverId) : null;
    const dir = serverId ? ensureServerDir(serverId) : join(DATA_DIR, "tmp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!row && serverId) return new Response("Server not found", { status: 404 });
    const loaderId = loader || row?.loader || "vanilla";
    const reqVer = version || query.latest || (row && row.loader_version) || "latest-stable";
    const reqLoaderBuild = String(loaderVersion ?? loader_build ?? loaderBuild ?? row?.loader_build ?? "").trim() || null;
    const impl = getLoader(loaderId);
    if (!impl) return new Response("Loader not supported", { status: 501 });

    try {
      const javaCommand = impl?.java ? await resolveJavaCommand(JAVA_DIR, row?.java_version, "java") : null;
      const result = await impl.install({ version: reqVer, dir, channel, loaderVersion: reqLoaderBuild, javaCommand, serverId });
      const fileName = result.file || result.jar || "server.jar";
      const resolvedVersion = result.version || reqVer;
      const resolvedLoaderBuild = String(result.loaderVersion ?? reqLoaderBuild ?? "").trim();
      if (serverId) {
        run("UPDATE servers SET jar = ?, loader_version = ?, loader_channel = ?, loader_build = ? WHERE id = ?", fileName, resolvedVersion, result.channel || channel || "", resolvedLoaderBuild, serverId);
        if (result.exec !== undefined) run("UPDATE servers SET exec = ? WHERE id = ?", result.exec ? JSON.stringify(result.exec) : null, serverId);
        try { __updateCache.delete(loaderId); } catch {}
        for (const k of __buildCache.keys()) if (k.startsWith(`${loaderId}:`)) __buildCache.delete(k);
        invalidateLoaderCache(loaderId);
      }
      return { ...result, file: fileName, version: resolvedVersion, loader_build: resolvedLoaderBuild, loaderVersion: resolvedLoaderBuild || null };
    } catch (e) {
      if (e.name === "AbortError") return new Response("Download timeout", { status: 504 });
      return new Response(`Download error: ${e.message}`, { status: 500 });
    }
  })
  .get("/versions", async ({ request, query }) => {
    const { loader, channel = "all", version } = query;
    if (version) {
      // `/jar/versions?version=<mc>` is an alias for the loader-build endpoint.
      return jsonResponse(request, await fetchLoaderVersionsFor({ loader, version, channel }));
    }
    const impl = getLoader(loader);
    if (!impl) return jsonResponse(request, { versions: [], error: "Loader not supported" });
    try {
      const all = normalizeVersionList(await impl.getVersions());
      const items = filterVersionsByChannel(all, channel);
      const latestStable = all.find((v) => v.channel === "stable")?.id || null;
      const latestExperimental = all.find((v) => v.channel === "experimental")?.id || null;
      // Backward-compatible `versions: string[]` plus rich `items`/channels.
      return jsonResponse(request, { versions: items.map((v) => v.id), items, loader: impl.meta(), channel, latest: { stable: latestStable, experimental: latestExperimental } });
    } catch (e) { return jsonResponse(request, { versions: [], items: [], error: e.message }); }
  })
  .get("/loader-versions", async ({ request, query }) => {
    const { loader, version, mc, channel = "all" } = query;
    return jsonResponse(request, await fetchLoaderVersionsFor({ loader, version: version || mc, channel }));
  })
  .get("/latest", async ({ request, query }) => {
    const { loader, channel = "stable" } = query;
    const impl = getLoader(loader);
    if (!impl) return jsonResponse(request, { error: "Loader not supported" }, { status: 501 });
    try {
      const v = await impl.resolveVersion(`latest-${String(channel).includes("exp") ? "experimental" : "stable"}`, channel);
      return jsonResponse(request, { ok: true, loader, ...v });
    } catch (e) { return jsonResponse(request, { error: e.message }, { status: 500 }); }
  });
