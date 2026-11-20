import { Elysia } from "elysia";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, dirname, resolve } from "path";
import { db } from "../core/db.js";
import { getServerRow, modFromRow, modsFolder, modsFolderFor } from "../instances/servers.js";
import { safeName } from "../core/util.js";
import { modsTarget } from "../mods/loaders.js";
import { downloadFile } from "../mods/packs.js";
import { sha1File, sha256File, fingerprintFile } from "../mods/http.js";
import { listSources, searchStore, getProject, getVersions, lookupHash, findModUpdates, latestVersion, resolveDownload, sourceConfigured } from "../mods/index.js";
import { invalidateServerUpdateCache } from "../instances/updates.js";

// ============ MODS (server) ============
export const modsRoute = new Elysia({ prefix: "/api/servers/:id/mods" })
  .get("/", ({ params }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const rows = db.prepare("SELECT * FROM mods WHERE server_id = ? ORDER BY installed_at DESC").all(params.id);
    return { mods: rows.map(modFromRow) };
  })
  .get("/updates", async ({ params, query }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const rows = db.prepare("SELECT * FROM mods WHERE server_id = ?").all(params.id);
    const updates = await findModUpdates(row, rows.map(modFromRow), { force: String(query?.force || "") === "1" });
    return { updates };
  })
  .post("/", async ({ params, body }) => {
    const server = getServerRow(params.id);
    if (!server) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const {
      source = "modrinth", project_id, version_id, version, filename, enabled = 1, download_url,
      project_title, slug, icon_url, game_versions, loaders, sha1, sha256, sha512, file_size, channel,
      date_published, changelog, dependencies, store_url, project_type, meta,
    } = body || {};
    const id = crypto.randomUUID();
    const file = safeName(filename) || null;
    const target = modsTarget(project_type === "datapack" ? "vanilla" : server.loader);
    const dir = modsFolderFor(params.id, server.loader, project_type);
    mkdirSync(dir, { recursive: true });
    db.prepare(`INSERT INTO mods(id,server_id,source,project_id,version_id,version,filename,enabled,download_url,
      project_title,slug,icon_url,game_versions,loaders,sha1,sha256,sha512,file_size,channel,date_published,changelog,dependencies,store_url,project_type,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, params.id, source, project_id || null, version_id || null, version || null, file, enabled ? 1 : 0, download_url || "",
      project_title || null, slug || null, icon_url || null,
      JSON.stringify(game_versions || []), JSON.stringify(loaders || []),
      sha1 || null, sha256 || null, sha512 || null, Number(file_size) || null, channel || null,
      Number(date_published) || null, changelog || "", JSON.stringify(dependencies || []),
      store_url || null, project_type || null, JSON.stringify(meta || null),
    );
    if (download_url && file && /^https?:\/\//i.test(download_url)) {
      try {
        await downloadFile(download_url, join(dir, file), { sha1, sha256, sha512 });
      } catch (e) {
        db.prepare("DELETE FROM mods WHERE id = ?").run(id);
        return new Response(JSON.stringify({ ok: false, error: `Download failed: ${e?.message || e}` }), { status: 502, headers: { "Content-Type": "application/json" } });
      }
    }
    return { id, ok: true, folder: target.folder };
  })
  .post("/scan", async ({ params }) => {
    const row = getServerRow(params.id);
    if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const dir = modsFolder(params.id, row.loader);
    if (!existsSync(dir)) return { scanned: 0, found: 0, unknown: [], mods: [] };
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".jar")).slice(0, 200);
    const existing = db.prepare("SELECT * FROM mods WHERE server_id = ?").all(params.id).map(modFromRow);
    const knownNames = new Set(existing.map((m) => m.filename).filter(Boolean));
    const knownHashes = new Set(existing.map((m) => m.sha1).filter(Boolean));
    const projectType = modsTarget(row.loader).kind;
    let found = 0;
    const unknown = [];
    for (const filename of files) {
      const path = join(dir, filename);
      let hash = "";
      let sha256 = "";
      let fingerprint = "";
      try { hash = await sha1File(path); } catch { hash = ""; }
      try { sha256 = await sha256File(path); } catch { sha256 = ""; }
      try { fingerprint = String(await fingerprintFile(path)); } catch { fingerprint = ""; }
      if (hash && knownHashes.has(hash)) continue;
      if (!hash && knownNames.has(filename)) continue;
      let hit = null;
      try {
        hit = await lookupHash({ sha1: hash, sha256, fingerprint, loader: row.loader, gameVersion: row.loader_version || "" });
      } catch { hit = null; }
      if (!hit?.version) { unknown.push({ filename, sha1: hash, sha256 }); continue; }
      const v = hit.version;
      const file = v.files?.[0];
      const source = hit.source || "modrinth";
      const existingRow = existing.find((m) => m.filename === filename);
      if (existingRow) {
        db.prepare(`UPDATE mods SET source=?,project_id=?,version_id=?,version=?,download_url=?,project_title=?,slug=?,icon_url=?,game_versions=?,loaders=?,sha1=?,sha256=?,sha512=?,file_size=?,channel=?,date_published=?,changelog=?,dependencies=?,store_url=?,project_type=?,updated_at=? WHERE id=? AND server_id=?`)
          .run(
            source, v.project_id, v.id, v.version_number, file?.url || "",
            v.project_title || existingRow.project_title || null, v.project_slug || existingRow.slug || null,
            v.icon_url || existingRow.icon_url || null,
            JSON.stringify(v.game_versions || []), JSON.stringify(v.loaders || []),
            hash || existingRow.sha1 || null, sha256 || file?.hashes?.sha256 || null, file?.hashes?.sha512 || null,
            Number(file?.size) || existingRow.file_size || null, v.channel || existingRow.channel || null,
            v.date_published || existingRow.date_published || null, v.changelog || existingRow.changelog || "",
            JSON.stringify(v.dependencies || []), v.store_url || existingRow.store_url || null,
            projectType, Date.now(), existingRow.id, params.id,
          );
      } else {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO mods(id,server_id,source,project_id,version_id,version,filename,enabled,download_url,
          project_title,slug,icon_url,game_versions,loaders,sha1,sha256,sha512,file_size,channel,date_published,changelog,dependencies,store_url,project_type,meta)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, params.id, source, v.project_id, v.id, v.version_number, filename, 1, file?.url || "",
          v.project_title || null, v.project_slug || null, v.icon_url || null,
          JSON.stringify(v.game_versions || []), JSON.stringify(v.loaders || []),
          hash || null, sha256 || file?.hashes?.sha256 || null, file?.hashes?.sha512 || null, Number(file?.size) || null, v.channel || null,
          v.date_published || null, v.changelog || "", JSON.stringify(v.dependencies || []),
          v.store_url || null, projectType, null,
        );
      }
      knownHashes.add(hash);
      knownNames.add(filename);
      found++;
    }
    const mods = db.prepare("SELECT * FROM mods WHERE server_id = ? ORDER BY installed_at DESC").all(params.id).map(modFromRow);
    return { scanned: files.length, found, unknown, mods };
  })
  .post("/:modId/update", async ({ params, set }) => {
    const server = getServerRow(params.id);
    if (!server) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const raw = db.prepare("SELECT * FROM mods WHERE id = ? AND server_id = ?").get(params.modId, params.id);
    if (!raw) return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const mod = modFromRow(raw);
    try {
      const latest = await latestVersion(mod.source, mod.project_id, { loader: mod.project_type === "datapack" ? "vanilla" : server.loader, gameVersion: server.loader_version || "" });
      if (!latest) return new Response(JSON.stringify({ ok: false, error: "No compatible version found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      const file = await resolveDownload(mod.source, latest);
      if (!file?.url) return new Response(JSON.stringify({ ok: false, error: "No download URL for the latest version" }), { status: 502, headers: { "Content-Type": "application/json" } });
      const dir = modsFolderFor(params.id, server.loader, mod.project_type);
      mkdirSync(dir, { recursive: true });
      const filename = safeName(file.filename) || mod.filename || "mod.jar";
      const dest = join(dir, filename);
      await downloadFile(file.url, dest, { sha1: file.hashes?.sha1, sha256: file.hashes?.sha256, sha512: file.hashes?.sha512 });
      if (mod.filename && mod.filename !== filename) {
        try { const old = join(dir, mod.filename); if (existsSync(old)) unlinkSync(old); } catch { /* ignore */ }
      }
      db.prepare(`UPDATE mods SET version_id=?,version=?,filename=?,sha1=?,sha256=?,sha512=?,file_size=?,channel=?,date_published=?,game_versions=?,loaders=?,store_url=?,changelog=?,dependencies=?,project_title=?,slug=?,icon_url=?,updated_at=? WHERE id=? AND server_id=?`)
        .run(
          latest.id, latest.version_number, filename, file.hashes?.sha1 || null, file.hashes?.sha256 || null, file.hashes?.sha512 || null,
          Number(file.size) || null, latest.channel || null, latest.date_published || null,
          JSON.stringify(latest.game_versions || []), JSON.stringify(latest.loaders || []),
          latest.store_url || null, latest.changelog || "", JSON.stringify(latest.dependencies || []),
          latest.project_title || mod.project_title || null, latest.project_slug || mod.slug || null,
          latest.icon_url || mod.icon_url || null, Date.now(), params.modId, params.id,
        );
      try { __updateCache.delete(mod.source); } catch { /* ignore */ }
      return { ok: true, version: latest.version_number, version_id: latest.id, filename };
    } catch (e) {
      const status = e?.status || 500;
      const res = new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), { status, headers: { "Content-Type": "application/json" } });
      return res;
    }
  })
  .patch("/:modId", ({ params, body, set }) => {
    if (!getServerRow(params.id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const row = db.prepare("SELECT * FROM mods WHERE id = ? AND server_id = ?").get(params.modId, params.id);
    if (!row) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    if (!body || typeof body !== "object" || Array.isArray(body)) { set.status = 400; return { ok: false, error: "Invalid body" }; }
    const allowed = ["enabled", "version", "filename", "version_id"];
    const fields = [], vals = [];
    for (const [k, v] of Object.entries(body)) {
      if (!allowed.includes(k)) continue;
      fields.push(`${k} = ?`);
      vals.push(k === "enabled" ? (v ? 1 : 0) : v);
    }
    if (!fields.length) return { ok: true };
    vals.push(params.modId);
    db.prepare(`UPDATE mods SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    return { ok: true };
  })
  .delete("/:modId", ({ params }) => {
    const server = getServerRow(params.id);
    if (!server) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const row = db.prepare("SELECT * FROM mods WHERE id = ? AND server_id = ?").get(params.modId, params.id);
    if (!row) return { ok: true };
    const modsDir = modsFolderFor(params.id, server.loader, row.project_type);
    if (row.filename && /^[\w .()+-]+\.(jar|zip)$/i.test(row.filename)) {
      try {
        const p = join(modsDir, row.filename);
        if (existsSync(p) && dirname(resolve(p)) === resolve(modsDir)) unlinkSync(p);
      } catch { /* ignore */ }
    }
    db.prepare("DELETE FROM mods WHERE id = ? AND server_id = ?").run(params.modId, params.id);
    return { ok: true };
  });

// ============ MODS SEARCH / VERSIONS (global) ============
export const modsSearchRoute = new Elysia({ prefix: "/api/mods" })
  .get("/sources", () => ({ sources: listSources() }))
  .get("/search", async ({ query }) => {
    const { q = "", source = "modrinth", type = "mod", loader = "", game_version, gameVersion, limit = 20, offset = 0, sort = "relevance" } = query;
    try {
      const data = await searchStore({
        q: String(q || ""), source: String(source || "modrinth"), type: String(type || "mod"),
        loader: String(loader || ""), gameVersion: String(game_version || gameVersion || ""),
        limit: Number(limit) || 20, offset: Number(offset) || 0, sort: String(sort || "relevance"),
      });
      return data;
    } catch (e) {
      return { results: [], total: 0, configured: sourceConfigured(String(source || "modrinth")), error: e?.message || String(e) };
    }
  })
  .get("/project", async ({ query }) => {
    const { source = "modrinth", project_id, loader = "", game_version, gameVersion } = query;
    if (!project_id) return { error: "project_id is required" };
    try {
      const project = await getProject(source, project_id, { loader });
      let versions = [];
      if (String(query?.include_versions || "") === "1") {
        versions = await getVersions(source, project_id, { loader, gameVersion: String(game_version || gameVersion || ""), limit: 50 });
      }
      return { project, versions };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  })
  .get("/versions", async ({ query }) => {
    const { source = "modrinth", project_id, loader = "", game_version, gameVersion, limit = 100 } = query;
    if (!project_id) return { versions: [], error: "project_id is required" };
    try {
      const versions = await getVersions(source, project_id, {
        loader: String(loader || ""),
        gameVersion: String(game_version || gameVersion || ""),
        limit: Number(limit) || 100,
      });
      return { versions, source };
    } catch (e) {
      return { versions: [], source, error: e?.message || String(e) };
    }
  })
  .get("/hash", async ({ query }) => {
    const { sha1 = "", sha512 = "", sha256 = "", fingerprint = "", loader = "", game_version, gameVersion } = query;
    if (!sha1 && !sha512 && !sha256 && !fingerprint) return { found: false, error: "sha1, sha512, sha256 or fingerprint is required" };
    try {
      const hit = await lookupHash({
        sha1: String(sha1 || ""), sha512: String(sha512 || ""),
        sha256: String(sha256 || ""), fingerprint: String(fingerprint || ""),
        loader: String(loader || ""), gameVersion: String(game_version || gameVersion || ""),
      });
      return hit ? { found: true, ...hit } : { found: false };
    } catch (e) {
      return { found: false, error: e?.message || String(e) };
    }
  });
