import { modrinth } from "./modrinth.js";
import { curseforge, isConfigured as cfConfigured } from "./curseforge.js";
import { hangar } from "./hangar.js";
import { spigot } from "./spiget.js";
import { ftb } from "./ftb.js";
import { modsTarget, normalizeLoader, hangarPlatformFor } from "./loaders.js";
import { toInt } from "./http.js";

export const sources = [modrinth, curseforge, hangar, spigot, ftb];

export const SOURCE_MAP = Object.fromEntries(sources.map((s) => [s.id, s]));

export function getSource(id) {
  return SOURCE_MAP[String(id || "").toLowerCase()] || null;
}

export function listSources() {
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    storeLabel: s.storeLabel,
    configured: !!s.configured?.(),
    types: s.id === "ftb" ? ["modpack"]
      : s.id === "hangar" || s.id === "spigot" ? ["plugin"]
        : s.id === "curseforge" ? ["mod", "plugin", "modpack"]
          : ["mod", "plugin", "modpack", "datapack"],
    needsKey: s.id === "curseforge",
  }));
}

export function sourceConfigured(id) {
  const s = getSource(id);
  return s ? !!s.configured?.() : false;
}

function normalizeType(type) {
  const t = String(type || "mod").toLowerCase();
  if (t === "plugins") return "plugin";
  if (t === "mods") return "mod";
  if (t === "modpacks" || t === "pack") return "modpack";
  if (t === "datapacks") return "datapack";
  return t;
}

function platformList(platform) {
  return platform ? [platform] : [];
}

function deriveLoaders(loader, type) {
  const t = normalizeType(type);
  if (t === "modpack" || !loader) return [];
  const target = modsTarget(loader);
  if (t === "plugin") return target.kind === "plugin" ? target.loaders : ["paper", "bukkit", "spigot"];
  return target.loaders;
}

export async function searchStore({ source = "modrinth", q = "", type = "mod", loader = "", gameVersion = "", limit = 20, offset = 0, sort = "relevance" } = {}) {
  const src = getSource(source);
  if (!src) return { source, results: [], total: 0, error: `Unknown source: ${source}` };
  if (!src.configured()) {
    return { source, results: [], total: 0, configured: false, error: `${src.name} is not configured.` };
  }
  const normalizedType = normalizeType(type);
  const loaders = src.id === "hangar" ? platformList(hangarPlatformFor(loader)) : deriveLoaders(loader, normalizedType);
  const opts = {
    q: String(q || "").trim(),
    type: normalizedType,
    loader: String(loader || "").trim(),
    loaders,
    gameVersion: String(gameVersion || "").trim(),
    limit: Math.max(1, Math.min(50, toInt(limit, 20))),
    offset: Math.max(0, toInt(offset, 0)),
    sort,
  };
  if (src.id === "ftb") {
    const data = await src.search({ ...opts });
    return { ...data, configured: true };
  }
  const data = await src.search(opts);
  return { ...data, configured: true };
}

export async function getProject(source, id, { loader = "" } = {}) {
  const src = getSource(source);
  if (!src) throw new Error(`Unknown source: ${source}`);
  if (!src.configured()) throw new Error(`${src.name} is not configured.`);
  return await src.project(id, { flavor: "spigot", loader });
}

export async function getVersions(source, id, { loader = "", gameVersion = "", limit = 100 } = {}) {
  const src = getSource(source);
  if (!src) throw new Error(`Unknown source: ${source}`);
  if (!src.configured()) throw new Error(`${src.name} is not configured.`);
  const target = modsTarget(loader);
  const loaders = src.id === "hangar" ? platformList(hangarPlatformFor(loader)) : (loader ? target.loaders : []);
  const opts = { loaders, gameVersion: String(gameVersion || "").trim(), limit: Math.max(1, Math.min(200, toInt(limit, 100))) };
  if (src.id === "ftb") return await src.versions(id, opts);
  return await src.versions(id, opts);
}

export async function latestVersion(source, id, { loader = "", gameVersion = "" } = {}) {
  const src = getSource(source);
  if (!src) throw new Error(`Unknown source: ${source}`);
  if (!src.configured()) throw new Error(`${src.name} is not configured.`);
  const target = modsTarget(loader);
  const opts = { loaders: src.id === "hangar" ? platformList(hangarPlatformFor(loader)) : (loader ? target.loaders : []), gameVersion: String(gameVersion || "").trim(), limit: 50 };
  if (src.id === "ftb") return await src.latestVersion(id, opts);
  if (src.id === "spigot" || src.id === "bukkit") return await src.latestVersion(id, { gameVersion: opts.gameVersion });
  return await src.latestVersion(id, opts);
}

export async function resolveDownload(source, version) {
  const src = getSource(source);
  if (!src) throw new Error(`Unknown source: ${source}`);
  if (src.id === "curseforge") return await src.resolveDownload(version);
  return version?.files?.[0] || null;
}

const __updateCache = globalThis.__smp_mod_update_cache || (globalThis.__smp_mod_update_cache = new Map());

function updateCacheKey(mod, server) {
  const loader = mod?.project_type === "datapack" ? "vanilla" : server.loader;
  return `${mod.source}:${mod.project_id}:${loader}:${server.loader_version || ""}`;
}

/**
 * Find the newest version of an installed mod for the server's loader and Minecraft version.
 * Returns null when the installed version is already the newest or the source cannot tell.
 */
export async function findModUpdate(mod, server, { force = false } = {}) {
  if (!mod?.source || !mod?.project_id || !server?.loader) return null;
  if (mod.source === "ftb") return null;
  const key = updateCacheKey(mod, server);
  const now = Date.now();
  const cached = __updateCache.get(key);
  if (!force && cached && now - cached.at < 10 * 60 * 1000) return cached.value;
  let value = null;
  try {
    const latest = await latestVersion(mod.source, mod.project_id, { loader: mod.project_type === "datapack" ? "vanilla" : server.loader, gameVersion: server.loader_version || "" });
    if (latest && String(latest.id) !== String(mod.version_id || "")) {
      value = {
        mod_id: mod.id,
        source: mod.source,
        project_id: mod.project_id,
        current: mod.version || mod.version_id || "",
        current_version_id: mod.version_id || "",
        latest,
        project_title: mod.project_title || latest.project_title || null,
      };
    }
  } catch {
    value = null;
  }
  __updateCache.set(key, { at: now, value });
  return value;
}

export async function findModUpdates(server, mods, { force = false } = {}) {
  const out = [];
  const list = Array.isArray(mods) ? mods : [];
  const chunk = 4;
  for (let i = 0; i < list.length; i += chunk) {
    const batch = list.slice(i, i + chunk);
    const results = await Promise.all(batch.map(async (mod) => {
      try { return await findModUpdate(mod, server, { force }); } catch { return null; }
    }));
    out.push(...results.filter(Boolean));
  }
  return out;
}

/** Resolve a local jar hash to a store project/version (Modrinth exposes a hash index). */
export async function lookupHash({ sha1 = "", sha512 = "", sha256 = "", fingerprint = "", loader = "", gameVersion = "" } = {}) {
  for (const hash of [sha1, sha512].filter(Boolean)) {
    try {
      const version = await modrinth.versionByHash(hash, { loader, gameVersion });
      if (version) {
        let update = null;
        try { update = await modrinth.updateFromHash(hash, { loader, gameVersion }); } catch { update = null; }
        return { source: "modrinth", hash, version, update };
      }
    } catch { /* try next hash */ }
  }
  if (fingerprint) {
    try {
      const version = await curseforge.versionByFingerprint(fingerprint);
      if (version) {
        let update = null;
        try { update = await curseforge.updateFromFingerprint(fingerprint, { loader, gameVersion }); } catch { update = null; }
        return { source: "curseforge", hash: String(fingerprint), version, update };
      }
    } catch { /* try Hangar */ }
  }
  if (sha256) {
    try {
      const version = await hangar.versionByHash(sha256);
      if (version) {
        let update = null;
        try { update = await hangar.updateFromHash(sha256, { loader, gameVersion }); } catch { update = null; }
        return { source: "hangar", hash: sha256, version, update };
      }
    } catch { /* no match */ }
  }
  return null;
}

export { modsTarget, normalizeLoader };