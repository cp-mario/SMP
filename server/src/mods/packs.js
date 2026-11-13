import AdmZip from "adm-zip";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import { fetchWithTimeout } from "../loaders/BaseLoader.js";
import { getLoader } from "../loaders/index.js";
import { curseforge, isConfigured as cfConfigured } from "./curseforge.js";
import { ftb } from "./ftb.js";
import { modrinth } from "./modrinth.js";
import { asArray } from "./http.js";

const DATA_DIR = process.env.SMP_DATA_DIR || join(homedir(), ".smp");
const TMP_DIR = join(DATA_DIR, "tmp");
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function log(onLog, message) {
  try { onLog?.(message); } catch { /* ignore */ }
}

function sanitizeRel(input) {
  const raw = String(input || "").replace(/\\/g, "/").trim();
  if (!raw) return null;
  const parts = raw.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;
  const rel = parts.join("/");
  return rel || null;
}

function safeJoin(base, rel) {
  const clean = sanitizeRel(rel);
  if (!clean) return null;
  const dst = resolve(base, clean);
  const root = resolve(base);
  if (dst !== root && !dst.startsWith(root + "/") && !dst.startsWith(root + "\\")) return null;
  return dst;
}

async function hashFile(path, algo) {
  return new Promise((resolveHash, reject) => {
    const h = createHash(algo);
    const s = createReadStream(path);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolveHash(h.digest("hex")));
  });
}

export async function downloadFile(url, dest, { sha1 = "", sha256 = "", sha512 = "", timeoutMs = 10 * 60 * 1000 } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetchWithTimeout(url, { timeoutMs, headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) throw new Error(`External download page (open the store): ${url}`);
  if (!res.body) throw new Error(`Empty response: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  if (sha1) {
    const actual = await hashFile(dest, "sha1");
    if (actual.toLowerCase() !== String(sha1).toLowerCase()) {
      try { unlinkSync(dest); } catch { /* ignore */ }
      throw new Error(`SHA-1 mismatch for ${url}`);
    }
  }
  if (sha256) {
    const actual = await hashFile(dest, "sha256");
    if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
      try { unlinkSync(dest); } catch { /* ignore */ }
      throw new Error(`SHA-256 mismatch for ${url}`);
    }
  }
  if (sha512) {
    const actual = await hashFile(dest, "sha512");
    if (actual.toLowerCase() !== String(sha512).toLowerCase()) {
      try { unlinkSync(dest); } catch { /* ignore */ }
      throw new Error(`SHA-512 mismatch for ${url}`);
    }
  }
  return { path: dest, size: statSync(dest).size };
}

function zipEntries(zip, prefix = "") {
  return zip.getEntries().filter((e) => !e.isDirectory && e.entryName.startsWith(prefix));
}

function extractEntries(zip, dest, { prefix = "", skip = null } = {}) {
  mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of zipEntries(zip, prefix)) {
    const rel = sanitizeRel(entry.entryName.slice(prefix.length));
    if (!rel) continue;
    if (skip && skip(rel)) continue;
    const out = safeJoin(dest, rel);
    if (!out) continue;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, entry.getData());
    count++;
  }
  return count;
}

function removeDir(path) {
  if (!existsSync(path)) return;
  try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ }
}

function loaderFromTargets(targets) {
  const mc = String(asArray(targets).find((t) => t?.type === "game")?.version || "").trim();
  const ml = asArray(targets).find((t) => t?.type === "modloader");
  if (!ml || !ml.name) return { loader: "vanilla", loaderVersion: mc, loaderBuild: null };
  const name = String(ml.name).toLowerCase();
  const build = String(ml.version || "").trim();
  if (name.includes("neoforge")) return { loader: "neoforge", loaderVersion: mc, loaderBuild: build || null };
  if (name.includes("forge")) return { loader: "forge", loaderVersion: mc, loaderBuild: build || null };
  if (name.includes("fabric")) return { loader: "fabric", loaderVersion: mc, loaderBuild: build || null };
  if (name.includes("quilt")) return { loader: "quilt", loaderVersion: mc, loaderBuild: build || null };
  return { loader: "vanilla", loaderVersion: mc, loaderBuild: null };
}

function cleanLoaderBuild(value, mc) {
  let build = String(value || "").trim();
  if (!build) return "";
  if (mc && build.startsWith(`${mc}-`)) build = build.slice(mc.length + 1);
  return build;
}

function parseCfLoaderId(id, mc) {
  const raw = String(id || "").trim();
  const m = raw.match(/^([a-z]+)-?(.*)$/i);
  if (!m) return { loader: "vanilla", loaderVersion: mc, loaderBuild: null };
  const name = m[1].toLowerCase();
  let build = m[2] || "";
  if (build.startsWith(`${mc}-`)) build = build.slice(mc.length + 1);
  if (name === "neoforge" || name === "forge" || name === "fabric" || name === "quilt") {
    return { loader: name, loaderVersion: mc, loaderBuild: build || null };
  }
  return { loader: "vanilla", loaderVersion: mc, loaderBuild: null };
}

async function installLoader(target, dir, javaCommand, onLog) {
  if (!target?.loader || target.loader === "vanilla") {
    return { loader: "vanilla", loader_version: target?.loaderVersion || "", loader_build: "", channel: "stable" };
  }
  const impl = getLoader(target.loader);
  if (!impl) throw new Error(`Unsupported loader for modpack: ${target.loader}`);
  log(onLog, `Installing ${target.loader} ${target.loaderVersion || ""}${target.loaderBuild ? ` build ${target.loaderBuild}` : ""}…`);
  const res = await impl.install({
    version: target.loaderVersion || "latest-stable",
    dir,
    channel: "all",
    loaderVersion: target.loaderBuild || null,
    javaCommand,
  });
  return {
    loader: target.loader,
    loader_version: res.version || target.loaderVersion || "",
    loader_build: res.loaderVersion || target.loaderBuild || "",
    channel: res.channel || "stable",
  };
}

async function installMrpack({ dir, archivePath, url, sha1, sha512, javaCommand, onLog }) {
  const tmp = join(TMP_DIR, `smp-mrpack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(TMP_DIR, { recursive: true });
  try {
    if (archivePath) {
      copyFile(archivePath, tmp);
    } else {
      await downloadFile(url, tmp, { sha1, sha512 });
    }
    const zip = new AdmZip(tmp);
    const indexEntry = zip.getEntry("modrinth.index.json");
    if (!indexEntry) throw new Error("Not a Modrinth modpack (modrinth.index.json missing).");
    const index = JSON.parse(zip.readAsText("modrinth.index.json"));
    const deps = index.dependencies || {};
    const mc = String(deps.minecraft || "").trim();
    let target = { loader: "vanilla", loaderVersion: mc, loaderBuild: null };
    if (deps["fabric-loader"]) target = { loader: "fabric", loaderVersion: mc, loaderBuild: cleanLoaderBuild(deps["fabric-loader"], mc) };
    else if (deps["quilt-loader"]) target = { loader: "quilt", loaderVersion: mc, loaderBuild: cleanLoaderBuild(deps["quilt-loader"], mc) };
    else if (deps["neoforge"]) target = { loader: "neoforge", loaderVersion: mc, loaderBuild: cleanLoaderBuild(deps["neoforge"], mc) };
    else if (deps["forge"]) target = { loader: "forge", loaderVersion: mc, loaderBuild: cleanLoaderBuild(deps["forge"], mc) };
    const loader = await installLoader(target, dir, javaCommand, onLog);
    const warnings = [];
    const files = asArray(index.files);
    log(onLog, `Downloading ${files.length} modpack file(s)…`);
    for (const f of files) {
      const env = f.env || {};
      if (env.client === "unsupported" || env.server === "unsupported") continue;
      const rel = sanitizeRel(f.path);
      const url = asArray(f.downloads)[0];
      if (!rel || !url) continue;
      const dest = safeJoin(dir, rel);
      if (!dest) { warnings.push(`Skipped unsafe path ${f.path}`); continue; }
      try {
        await downloadFile(url, dest, { sha1: f.hashes?.sha1 || "", sha512: f.hashes?.sha512 || "" });
      } catch (e) {
        warnings.push(`${f.path}: ${e.message}`);
      }
    }
    const serverOverrides = zipEntries(zip, "server-overrides/").length > 0;
    if (serverOverrides) {
      log(onLog, "Applying server overrides…");
      extractEntries(zip, dir, { prefix: "server-overrides/" });
    } else if (zipEntries(zip, "overrides/").length > 0) {
      log(onLog, "Applying overrides (client mods skipped)…");
      extractEntries(zip, dir, { prefix: "overrides/", skip: (rel) => /^(mods|resourcepacks|shaderpacks)\//.test(rel) });
    }
    return { ...loader, channel: loader.channel || "stable", warnings, pack_files: files.length };
  } finally {
    removeDir(tmp);
  }
}

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

async function installCfPack({ dir, archivePath, modId, fileId, javaCommand, onLog }) {
  if (!cfConfigured()) throw new Error("CurseForge requires an API key to download modpack files. Add one in Settings → CurseForge.");
  const tmp = join(TMP_DIR, `smp-cfpack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(TMP_DIR, { recursive: true });
  try {
    if (archivePath) copyFile(archivePath, tmp);
    else {
      const url = await curseforge.fileDownloadUrl(modId, fileId);
      if (!url) throw new Error("CurseForge did not return a download URL for this file.");
      await downloadFile(url, tmp);
    }
    const zip = new AdmZip(tmp);
    const manifestEntry = zip.getEntry("manifest.json");
    if (!manifestEntry) throw new Error("Not a CurseForge modpack (manifest.json missing).");
    const manifest = JSON.parse(zip.readAsText("manifest.json"));
    const mc = String(manifest.minecraft?.version || "").trim();
    const loaders = asArray(manifest.minecraft?.modLoaders);
    const primary = loaders.find((l) => l?.primary) || loaders[0] || null;
    const target = primary?.id ? parseCfLoaderId(primary.id, mc) : { loader: "vanilla", loaderVersion: mc, loaderBuild: null };
    const loader = await installLoader(target, dir, javaCommand, onLog);
    const warnings = [];
    const files = asArray(manifest.files).filter((f) => f?.projectID && f?.fileID);
    log(onLog, `Downloading ${files.length} modpack file(s) from CurseForge…`);
    const chunk = 4;
    for (let i = 0; i < files.length; i += chunk) {
      const batch = files.slice(i, i + chunk);
      await Promise.all(batch.map(async (f) => {
        try {
          const url = await curseforge.fileDownloadUrl(f.projectID, f.fileID);
          if (!url) { warnings.push(`No download URL for project ${f.projectID}`); return; }
          const name = decodeURIComponent(url.split("/").pop()?.split("?")[0] || "") || `cf-${f.projectID}-${f.fileID}.jar`;
          const dest = safeJoin(join(dir, "mods"), name);
          if (!dest) { warnings.push(`Skipped unsafe file name ${name}`); return; }
          await downloadFile(url, dest);
        } catch (e) {
          warnings.push(`Project ${f.projectID}: ${e.message}`);
        }
      }));
    }
    if (zipEntries(zip, "overrides/").length > 0) {
      log(onLog, "Applying overrides…");
      extractEntries(zip, dir, { prefix: "overrides/" });
    }
    return { ...loader, warnings, pack_files: files.length };
  } finally {
    removeDir(tmp);
  }
}

async function installFtbPack({ dir, id, versionId, javaCommand, onLog }) {
  const detail = await ftb.versionDetail(id, versionId);
  const target = loaderFromTargets(detail.targets);
  const loader = await installLoader(target, dir, javaCommand, onLog);
  const warnings = [];
  const files = asArray(detail.files).filter((f) => f.url && !f.clientonly);
  log(onLog, `Downloading ${files.length} FTB modpack file(s)…`);
  const chunk = 4;
  for (let i = 0; i < files.length; i += chunk) {
    const batch = files.slice(i, i + chunk);
    await Promise.all(batch.map(async (f) => {
      const rel = sanitizeRel(`${f.path || ""}${f.name || ""}`.replace(/^\.\//, ""));
      if (!rel) { warnings.push(`Skipped unsafe path ${f.name}`); return; }
      const dest = safeJoin(dir, rel);
      if (!dest) { warnings.push(`Skipped unsafe path ${f.name}`); return; }
      try {
        await downloadFile(f.url, dest, { sha1: f.sha1, sha512: f.sha512 });
      } catch (e) {
        warnings.push(`${f.name}: ${e.message}`);
      }
    }));
  }
  return { ...loader, warnings, pack_files: files.length };
}

async function installCustomArchive({ dir, archivePath, javaCommand, onLog }) {
  if (!archivePath || !existsSync(archivePath)) {
    return { loader: "vanilla", loader_version: "", loader_build: "", channel: "stable", warnings: ["No archive uploaded."] };
  }
  const zip = new AdmZip(archivePath);
  if (zip.getEntry("modrinth.index.json")) return await installMrpack({ dir, archivePath, javaCommand, onLog });
  if (zip.getEntry("manifest.json")) return await installCfPack({ dir, archivePath, javaCommand, onLog });
  log(onLog, "Extracting archive…");
  const count = extractEntries(zip, dir);
  return { loader: "vanilla", loader_version: "", loader_build: "", channel: "stable", warnings: [], pack_files: count };
}

/**
 * Install a modpack into an existing server directory.
 * Returns the resolved loader/version so the caller can update the server row.
 */
export async function installModpack({ dir, source = "modrinth", projectId, versionId, archivePath = null, javaCommand = null, onLog = null }) {
  mkdirSync(dir, { recursive: true });
  const warnings = [];
  let result;
  if (source === "modrinth") {
    const versions = await modrinth.versions(projectId, { limit: 200 });
    const picked = versions.find((v) => String(v.id) === String(versionId)) || versions[0];
    const file = picked?.files?.[0];
    if (!file?.url) throw new Error("No downloadable file for this Modrinth modpack version.");
    result = await installMrpack({ dir, url: file.url, sha1: file.hashes?.sha1, sha512: file.hashes?.sha512, javaCommand, onLog });
  } else if (source === "curseforge") {
    result = await installCfPack({ dir, modId: projectId, fileId: versionId, javaCommand, onLog });
  } else if (source === "ftb") {
    result = await installFtbPack({ dir, id: projectId, versionId, javaCommand, onLog });
  } else if (source === "custom") {
    result = await installCustomArchive({ dir, archivePath, javaCommand, onLog });
  } else {
    throw new Error(`Unsupported modpack source: ${source}`);
  }
  return {
    ok: true,
    source,
    ...result,
    loader: result.loader || "vanilla",
    loader_version: result.loader_version || "",
    loader_build: result.loader_build || "",
    channel: result.channel || "stable",
    warnings: result.warnings || warnings,
  };
}