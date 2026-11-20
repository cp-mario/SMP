import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { queryOne } from "../core/db.js";
import { serverFilesDir } from "../core/config.js";
import { getLoader } from "../loaders/index.js";
import { latestVersion } from "../mods/index.js";

function versionChannel(v) {
  const c = String(v?.channel || (v?.stable === false ? "experimental" : "stable")).toLowerCase();
  return c === "experimental" ? "experimental" : "stable";
}
function normalizeVersionList(list) {
  return (Array.isArray(list) ? list : []).map((v) => (typeof v === "string" ? { id: v, stable: true, channel: "stable" } : {
    id: v.id,
    stable: v.stable !== false && versionChannel(v) !== "experimental",
    channel: versionChannel(v),
    ...(v.meta ? { meta: v.meta } : {}),
  })).filter((v) => v.id);
}
function filterVersionsByChannel(list, channel = "all") {
  const want = String(channel || "all").toLowerCase();
  const items = normalizeVersionList(list);
  if (want === "stable" || want === "release" || want === "normal") return items.filter((v) => v.channel === "stable");
  if (want === "experimental" || want === "snapshot" || want === "beta") return items.filter((v) => v.channel === "experimental");
  return items;
}
function compareVersionLike(a, b) {
  const pa = String(a || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? -1, db = pb[i] ?? -1;
    if (da !== db) return da - db;
  }
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}
async function getLoaderVersions(loaderId, channel = "all") {
  const impl = getLoader(loaderId);
  if (!impl) return { impl: null, items: [], filtered: [] };
  const list = normalizeVersionList(await impl.getVersions());
  return { impl, items: list, filtered: filterVersionsByChannel(list, channel) };
}
function buildUpdateInfo(row, items) {
  const out = { loader: row?.loader || "", installed: row?.loader_version || "", channel: row?.loader_channel || null, latestStable: null, latestExperimental: null, recommended: null, recommendation: null };
  if (!out.installed || !Array.isArray(items) || !items.length) return out;
  const stable = items.filter((v) => v.channel === "stable");
  const experimental = items.filter((v) => v.channel === "experimental");
  out.latestStable = stable[0]?.id || null;
  out.latestExperimental = experimental[0]?.id || null;
  const installedItem = items.find((v) => String(v.id) === String(out.installed));
  const installedChannel = out.channel || installedItem?.channel || "stable";
  out.channel = installedChannel;
  const sameChannel = (installedChannel === "experimental" ? experimental : stable);
  const latestSame = sameChannel[0]?.id || null;
  if (latestSame && String(latestSame) !== String(out.installed)) {
    const newer = compareVersionLike(latestSame, out.installed) > 0 || sameChannel.findIndex((v) => String(v.id) === String(latestSame)) < sameChannel.findIndex((v) => String(v.id) === String(out.installed));
    if (newer) {
      out.recommended = latestSame;
      out.recommendation = installedChannel === "experimental"
        ? `New experimental version available: ${latestSame}`
        : `New stable version available: ${latestSame}`;
    }
  }
  return out;
}

const __buildCache = globalThis.__smp_buildCache || (globalThis.__smp_buildCache = new Map());

/** Installed Paper/Folia/Purpur build, read from version_history.json when the row has none. */
function installedPaperLikeBuild(row) {
  const stored = String(row?.loader_build || "").trim();
  if (stored) return stored;
  if (!["paper", "folia", "purpur"].includes(String(row?.loader || ""))) return "";
  for (const dir of [".paper", ".purpur"]) {
    try {
      const file = join(serverFilesDir(row.id), dir, "version_history.json");
      if (!existsSync(file)) continue;
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data?.lastBuild != null && String(data.lastBuild).trim()) return String(data.lastBuild).trim();
      const m = String(data?.currentVersion || "").match(/-(\d{2,})(?!\d)/);
      if (m) return m[1];
    } catch { /* try next candidate */ }
  }
  return "";
}

/**
 * Build-level update (Paper builds, Fabric loader versions, Forge/NeoForge builds...).
 * Returns null when the loader exposes no build list or the server is already current.
 */
async function getLoaderBuildUpdateInfo(row, { force = false } = {}) {
  const impl = getLoader(row?.loader);
  if (!impl || typeof impl.getLoaderVersions !== "function") return null;
  const version = String(row?.loader_version || "").trim();
  if (!version) return null;
  const installed = installedPaperLikeBuild(row);
  const channel = String(row?.loader_channel || "").toLowerCase() === "experimental" ? "experimental" : "stable";
  const key = `${row.loader}:${version}:${channel}`;
  const cached = __buildCache.get(key);
  const now = Date.now();
  let items = cached?.items;
  if (force || !cached || now - cached.at > 10 * 60 * 1000) {
    try {
      items = normalizeVersionList(await impl.getLoaderVersions(version));
      __buildCache.set(key, { at: now, items });
    } catch {
      items = cached?.items || [];
    }
  }
  const list = (Array.isArray(items) ? items : []).slice().sort((a, b) => {
    const an = Number(a.id), bn = Number(b.id);
    if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
    return compareVersionLike(b.id, a.id);
  });
  if (!list.length) return null;
  const sameChannel = list.filter((v) => v.channel === channel);
  const pool = sameChannel.length ? sameChannel : list;
  const latest = pool[0]?.id || null;
  if (!latest) return null;
  const currentNum = Number(installed);
  const latestNum = Number(latest);
  const newer = installed
    ? (Number.isFinite(currentNum) && Number.isFinite(latestNum) ? latestNum > currentNum : compareVersionLike(latest, installed) > 0)
    : true;
  if (!newer) return null;
  return {
    installed: installed || null,
    latest,
    recommended: latest,
    recommendation: installed
      ? `New build available: ${latest}`
      : `Installed build not registered; latest available: ${latest}`,
    channel,
  };
}
function modpackMeta(pack) {
  return {
    source: pack.source || "",
    project_id: pack.project_id || "",
    title: pack.title || "",
    version_id: pack.version_id || "",
    version: pack.version || pack.version_id || "",
    icon_url: pack.icon_url || "",
    store_url: pack.store_url || "",
    loader: pack.loader || "",
    loader_version: pack.loader_version || "",
    loader_build: pack.loader_build || "",
  };
}

function getModpackRow(serverId) {
  try {
    return queryOne("SELECT * FROM modpacks WHERE server_id = ? ORDER BY created_at DESC LIMIT 1", serverId) || null;
  } catch {
    return null;
  }
}

const __packUpdateCache = globalThis.__smp_pack_update_cache || (globalThis.__smp_pack_update_cache = new Map());
async function getModpackUpdateInfo(pack, { force = false } = {}) {
  const out = {
    ...modpackMeta(pack),
    installed_version: pack.version || pack.version_id || "",
    latest_version: "",
    latest_version_id: null,
    recommended: false,
    recommendation: null,
    error: null,
  };
  if (!pack.project_id || !pack.source || pack.source === "custom") return out;
  const key = `${pack.source}:${pack.project_id}`;
  const cached = __packUpdateCache.get(key);
  const now = Date.now();
  let latest = cached?.latest;
  if (force || !cached || now - cached.at > 10 * 60 * 1000) {
    try {
      latest = await latestVersion(pack.source, pack.project_id);
      __packUpdateCache.set(key, { at: now, latest });
    } catch (e) {
      latest = cached?.latest || null;
      out.error = e?.message || String(e);
    }
  }
  if (!latest?.id) return out;
  out.latest_version_id = String(latest.id);
  out.latest_version = latest.version_number || latest.name || latest.id;
  out.latest_game_versions = latest.game_versions || [];
  out.latest_loaders = latest.loaders || [];
  const installedId = String(pack.version_id || "");
  if (installedId && installedId === out.latest_version_id) {
    // Older modpack rows only stored the version id; use the project metadata now.
    out.version = out.latest_version;
    out.installed_version = out.latest_version;
    out.title = latest.project_title || out.title;
    out.icon_url = latest.icon_url || out.icon_url;
    out.store_url = latest.store_url || out.store_url;
  }
  if (installedId && installedId !== out.latest_version_id) {
    out.recommended = true;
    out.recommendation = `${pack.title || "Modpack"} ${out.latest_version} available`;
  }
  return out;
}

const __updateCache = globalThis.__smp_updateCache || (globalThis.__smp_updateCache = new Map());
async function getServerUpdateInfo(row, { force = false } = {}) {
  if (!row?.loader || !row?.loader_version) return null;
  const key = `${row.loader}`;
  // The loader already caches its version list for a few minutes; the dashboard
  // and the detail view ask for the same thing, so the result is kept too.
  const cached = __updateCache.get(key);
  const now = Date.now();
  let items = cached?.items;
  if (force || !cached || now - cached.at > 10 * 60 * 1000) {
    try { items = (await getLoaderVersions(row.loader, "all")).items; __updateCache.set(key, { at: now, items }); }
    catch { items = cached?.items || []; }
  }
  const info = buildUpdateInfo(row, items || []);
  info.build = await getLoaderBuildUpdateInfo(row, { force });
  return info;
}

async function fetchLoaderVersionsFor({ loader, version, channel = "all" } = {}) {
  const impl = getLoader(loader);
  if (!impl) return { items: [], error: "Loader not supported" };
  const gameVersion = String(version || "").trim();
  if (!gameVersion) return { items: [], error: "version is required" };
  try {
    if (typeof impl.getLoaderVersions !== "function") return { items: [], loader: impl.meta(), supported: false };
    const raw = await impl.getLoaderVersions(gameVersion);
    const list = Array.isArray(raw) ? raw : [];
    const filtered = filterVersionsByChannel(list, channel);
    const latestStable = list.find((v) => (v?.channel || (v?.stable !== false ? "stable" : "experimental")) === "stable")?.id || null;
    const latestExperimental = list.find((v) => (v?.channel || (v?.stable !== false ? "stable" : "experimental")) === "experimental")?.id || null;
    return { items: filtered, loader: impl.meta(), supported: true, version: gameVersion, channel, latest: { stable: latestStable, experimental: latestExperimental, default: latestStable || latestExperimental || list[0]?.id || null } };
  } catch (e) {
    return { items: [], error: e?.message || String(e), loader: impl.meta(), supported: true, version: gameVersion };
  }
}

export function invalidateServerUpdateCache(source) {
  try { __updateCache.delete(String(source || "")); } catch {}
}

export function invalidateBuildCache(loaderId) {
  const id = String(loaderId || "");
  for (const k of __buildCache.keys()) if (k.startsWith(`${id}:`)) __buildCache.delete(k);
}

export { versionChannel, normalizeVersionList, filterVersionsByChannel, compareVersionLike, getLoaderVersions, buildUpdateInfo, installedPaperLikeBuild, getLoaderBuildUpdateInfo, modpackMeta, getModpackRow, getModpackUpdateInfo, getServerUpdateInfo, fetchLoaderVersionsFor };
