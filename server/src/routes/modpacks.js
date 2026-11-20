import { Elysia } from "elysia";
import { existsSync, mkdirSync, statSync, createWriteStream } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { db } from "../core/db.js";
import { serverFilesDir } from "../core/config.js";
import { safeName, streamPipeline, clampMemoryMb, parseMemoryMb, formatMemoryMb, normalizeJvmArgs } from "../core/util.js";
import { getServerRow, createServerRecord, ensureServerDir, resolveUpload, uploadDir } from "../instances/servers.js";
import { getLoader } from "../loaders/index.js";
import { installModpack } from "../mods/packs.js";
import { getVersions, latestVersion, sourceConfigured } from "../mods/index.js";
import { allocateServerPorts, saveServerPorts, applyPortsToConfig } from "../runtime/ports.js";
import { getModpackRow } from "../instances/updates.js";
import { createBackupRecord } from "../instances/backupOps.js";
import { isRunning } from "../instances/process.js";
import { logLine } from "../core/logs.js";

// ============ MODPACKS ============
export const modpackRoute = new Elysia({ prefix: "/api/servers" })
  .post("/from-modpack", async ({ body }) => {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
    const {
      name, source = "modrinth", project_id, version_id,
      loader: requestedLoader = "", loader_version = "", loader_build = "",
      java_version = "", memory_max = "2G", memory_min = "512M", jvm_args = "",
      port = requestedLoader === "bedrock" ? 19132 : 25565, motd = "A SMP Server", auto_start = 0, upload_id = "",
    } = body || {};
    if (!name || !String(name).trim()) return json({ ok: false, error: "name is required" }, 400);
    if (source === "curseforge" && !sourceConfigured("curseforge")) {
      return json({ ok: false, error: "CurseForge requires an API key. Add it in Settings → CurseForge." }, 400);
    }
    const uploadPath = source === "custom" ? resolveUpload(upload_id) : null;
    if (source === "custom" && !uploadPath && !requestedLoader) {
      return json({ ok: false, error: "Upload a modpack archive or choose a loader." }, 400);
    }
    let created;
    try {
      created = await createServerRecord({ name, loader: requestedLoader || "vanilla", loader_version, loader_build, java_version, memory_max, memory_min, jvm_args, port, motd, auto_start: 0 });
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, e?.status || 400);
    }
    const id = created.id;
    const dir = serverFilesDir(id);
    ensureServerDir(id);
    try {
      const result = await installModpack({
        dir, source, projectId: project_id, versionId: version_id,
        archivePath: uploadPath, javaCommand: null,
        onLog: (m) => logLine(id, `[modpack] ${m}`),
      });
      let finalLoader = result.loader || requestedLoader || "vanilla";
      let finalVersion = result.loader_version || loader_version || "";
      let finalBuild = result.loader_build || loader_build || "";
      let channel = result.channel || "stable";
      if (source === "custom" && requestedLoader && requestedLoader !== "vanilla" && (!result.loader || result.loader === "vanilla")) {
        const impl = getLoader(requestedLoader);
        if (impl) {
          logLine(id, `[modpack] Installing ${requestedLoader}…`);
          const inst = await impl.install({ version: loader_version || "latest-stable", dir, channel: "all", loaderVersion: loader_build || null });
          finalLoader = requestedLoader;
          finalVersion = inst.version || loader_version || "";
          finalBuild = inst.loaderVersion || loader_build || "";
          channel = inst.channel || channel;
        }
      }
      if (finalLoader === "vanilla" && !existsSync(join(dir, "server.jar"))) {
        const vanilla = getLoader("vanilla");
        if (vanilla) {
          logLine(id, `[modpack] Installing vanilla server ${finalVersion || "latest-stable"}…`);
          const inst = await vanilla.install({ version: finalVersion || "latest-stable", dir, channel: "all" });
          finalVersion = inst.version || finalVersion;
        }
      }
      db.prepare("UPDATE servers SET loader=?, loader_version=?, loader_build=?, loader_channel=?, auto_start=? WHERE id=?")
        .run(finalLoader, finalVersion, finalBuild, channel, auto_start ? 1 : 0, id);
      // The pack may have installed a different runtime than the one used at creation
      // (for example a Bedrock pack): re-reserve ports for the final loader.
      if (String(finalLoader) !== String(requestedLoader || "vanilla")) {
        try {
          const allocation = await allocateServerPorts({ serverId: id, loaderId: finalLoader, requested: null, checkOs: true });
          saveServerPorts(id, allocation.ports);
          applyPortsToConfig({ dir, loaderId: finalLoader, ports: allocation.ports });
        } catch (e) {
          logLine(id, `[ports] Could not reallocate ports for ${finalLoader}: ${e?.message || String(e)}`);
        }
      }
      const finalMeta = (getLoader(finalLoader) || { meta: () => ({}) }).meta?.() || {};
      if (finalMeta.java) {
        const mem = clampMemoryMb(parseMemoryMb(body.memory_max ?? body.memory ?? "2G", 2048));
        db.prepare("UPDATE servers SET memory_max=?, jvm_args=? WHERE id=?").run(formatMemoryMb(mem), normalizeJvmArgs(body.jvm_args), id);
      }
      let packVersion = version_id || "";
      let packTitle = name;
      let packIcon = null;
      let packStore = null;
      if (source !== "custom" && project_id) {
        try {
          const versions = await getVersions(source, project_id, { limit: 200 });
          const picked = versions.find((v) => String(v.id) === String(version_id)) || versions[0];
          if (picked) {
            packVersion = picked.version_number || picked.name || packVersion;
            packTitle = picked.project_title || packTitle;
            packIcon = picked.icon_url || null;
            packStore = picked.store_url || null;
          }
        } catch { /* non-fatal: keep the id */ }
      }
      try {
        db.prepare("INSERT INTO modpacks(id,server_id,source,project_id,version_id,version,title,icon_url,store_url,loader,loader_version,loader_build) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(crypto.randomUUID(), id, source, project_id || null, version_id || null, packVersion, packTitle, packIcon, packStore, finalLoader, finalVersion, finalBuild);
      } catch { /* non-fatal */ }
      return { id, ok: true, loader: finalLoader, loader_version: finalVersion, loader_build: finalBuild, channel, warnings: result.warnings || [] };
    } catch (e) {
      logLine(id, `[modpack] Error: ${e?.message || e}`);
      return json({ ok: false, id, error: e?.message || String(e) }, 500);
    }
  })
  .post("/:id/update-modpack", async ({ params }) => {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
    const row = getServerRow(params.id);
    if (!row) return json({ ok: false, error: "Server not found" }, 404);
    if (isRunning(row.id)) return json({ ok: false, error: "Stop the server before updating the modpack." }, 400);
    const pack = getModpackRow(row.id);
    if (!pack?.project_id) return json({ ok: false, error: "This server is not a modpack." }, 400);
    let latest;
    try {
      latest = await latestVersion(pack.source, pack.project_id);
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 502);
    }
    if (!latest?.id) return json({ ok: false, error: "No modpack version found." }, 502);
    const latestId = String(latest.id);
    if (pack.version_id && String(pack.version_id) === latestId) {
      return { ok: true, unchanged: true, version: latest.version_number || latest.name || pack.version || pack.version_id || latestId };
    }
    if (row.backup_on_update || row.backup_on_loader) {
      try {
        await createBackupRecord(row.id, { reason: "modpack" });
      } catch (e) {
        return json({ ok: false, error: `Automatic backup failed: ${e?.message || String(e)}` }, 500);
      }
    }
    const dir = serverFilesDir(row.id);
    ensureServerDir(row.id);
    try {
      const result = await installModpack({
        dir, source: pack.source, projectId: pack.project_id, versionId: latest.id,
        javaCommand: null,
        onLog: (m) => logLine(row.id, `[modpack] ${m}`),
      });
      const finalLoader = result.loader || pack.loader || row.loader || "vanilla";
      const finalVersion = result.loader_version || pack.loader_version || row.loader_version || "";
      const finalBuild = result.loader_build || pack.loader_build || row.loader_build || "";
      const channel = result.channel || "stable";
      db.prepare("UPDATE servers SET loader=?, loader_version=?, loader_build=?, loader_channel=? WHERE id=?")
        .run(finalLoader, finalVersion, finalBuild, channel, row.id);
      const versionLabel = latest.version_number || latest.name || latestId;
      db.prepare("UPDATE modpacks SET version_id=?, version=?, title=?, icon_url=?, store_url=?, loader=?, loader_version=?, loader_build=? WHERE server_id=?")
        .run(latestId, versionLabel, latest.project_title || pack.title || row.name, latest.icon_url || pack.icon_url || null, latest.store_url || pack.store_url || null, finalLoader, finalVersion, finalBuild, row.id);
      logLine(row.id, `[modpack] Updated to ${versionLabel}`);
      return { ok: true, version: versionLabel, version_id: latestId, loader: finalLoader, loader_version: finalVersion, loader_build: finalBuild, warnings: result.warnings || [] };
    } catch (e) {
      logLine(row.id, `[modpack] Update error: ${e?.message || e}`);
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

export const modpackUploadRoute = new Elysia({ prefix: "/api/modpacks" })
  .post("/upload", async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return new Response(JSON.stringify({ ok: false, error: "No file" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const original = safeName(file.name) || "modpack.zip";
    if (!/\.(zip|mrpack)$/i.test(original)) {
      return new Response(JSON.stringify({ ok: false, error: "Upload a .zip or .mrpack archive" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const uploadId = crypto.randomUUID();
    const path = join(uploadDir(), `${uploadId}.zip`);
    try {
      await streamPipeline(Readable.fromWeb(file.stream()), createWriteStream(path));
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: `Upload failed: ${e?.message || e}` }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return { ok: true, uploadId, name: original, size: statSync(path).size };
  });
