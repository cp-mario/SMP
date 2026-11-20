import { getSetting } from "../core/db.js";
import { getJson, postJson, StoreError, toInt, asArray, unique, htmlToText, toMs, gameVersionMatches } from "./http.js";
import { CF_CLASS_IDS, CF_LOADER_TYPES, loaderCompatible } from "./loaders.js";

const API = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID = 432;
const STORE = "https://www.curseforge.com/minecraft";

export function curseforgeApiKey() {
  return String(getSetting("curseforge_api_key", "") || "").trim();
}

export function isConfigured() {
  return !!curseforgeApiKey();
}

function ensureKey() {
  if (!isConfigured()) {
    throw new StoreError("CurseForge requires an API key. Add one in Settings → CurseForge (console.curseforge.com).", { code: "missing_key" });
  }
}

async function cf(path, params = {}) {
  ensureKey();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  try {
    return await getJson(url, { headers: { "x-api-key": curseforgeApiKey() } });
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      throw new StoreError("CurseForge rejected the API key. Check Settings → CurseForge.", { status: e.status, code: "invalid_key" });
    }
    throw e;
  }
}

function classIdFor(type) {
  if (type === "modpack") return CF_CLASS_IDS.modpack;
  if (type === "plugin") return CF_CLASS_IDS.plugin;
  if (type === "resourcepack") return CF_CLASS_IDS.resourcepack;
  return CF_CLASS_IDS.mod;
}

function releaseTypeChannel(releaseType) {
  const n = toInt(releaseType, 1);
  if (n === 2) return "beta";
  if (n === 3) return "alpha";
  return "release";
}

function hashesFrom(list) {
  const out = { sha1: "", sha512: "" };
  for (const h of asArray(list)) {
    const algo = toInt(h?.algo, 0);
    const value = String(h?.value || "");
    if (!value) continue;
    if (algo === 1) out.sha1 = value;
    else if (algo === 2) out.sha512 = value;
    else if (value.length === 40) out.sha1 = out.sha1 || value;
    else if (value.length === 128) out.sha512 = out.sha512 || value;
  }
  return out;
}

function latestIndexes(p) {
  return asArray(p.latestFilesIndexes);
}

function projectStoreUrl(p) {
  const classSlug = p.classId === CF_CLASS_IDS.modpack ? "modpacks" : p.classId === CF_CLASS_IDS.plugin ? "bukkit-plugins" : "mc-mods";
  if (p.links?.websiteUrl) return p.links.websiteUrl;
  return `${STORE}/${classSlug}/${p.slug || p.id || ""}`;
}

function normalizeProject(p) {
  if (!p || typeof p !== "object") return null;
  const idx = latestIndexes(p);
  const gameVersions = unique(idx.map((i) => i?.gameVersion).filter(Boolean));
  const loaders = unique(idx.map((i) => i?.modLoader).filter((l) => l && String(l).toLowerCase() !== "any"));
  const projectType = p.classId === CF_CLASS_IDS.modpack ? "modpack" : p.classId === CF_CLASS_IDS.plugin ? "plugin" : p.classId === CF_CLASS_IDS.resourcepack ? "resourcepack" : "mod";
  return {
    source: "curseforge",
    id: String(p.id || ""),
    slug: String(p.slug || ""),
    title: p.name || "",
    description: htmlToText(p.summary || ""),
    body: "",
    description_format: "html",
    icon_url: p.logo?.thumbnailUrl || p.logo?.url || "",
    downloads: toInt(p.downloadCount, 0),
    followers: toInt(p.downloadCount, 0),
    project_type: projectType,
    author: asArray(p.authors)[0]?.name || "",
    categories: asArray(p.categories).map((c) => c?.name || "").filter(Boolean),
    loaders,
    game_versions: gameVersions,
    latest_version: idx[0]?.filename || null,
    updated_at: toMs(p.dateModified) || toMs(p.dateReleased) || toMs(p.dateCreated),
    published_at: toMs(p.dateCreated),
    license: null,
    source_url: "",
    issues_url: "",
    wiki_url: p.links?.wikiUrl || "",
    store_url: projectStoreUrl(p),
  };
}

function normalizeFile(f, modId, project = null) {
  const rawVersions = asArray(f.gameVersions).map(String);
  const gameVersions = unique(rawVersions.filter((v) => /^\d/.test(v)));
  const fileLoaders = unique(rawVersions.filter((v) => v && !/^\d/.test(v)).map((v) => v.toLowerCase()));
  const loaders = fileLoaders.length ? fileLoaders : unique(asArray(project?.loaders).map((v) => String(v).toLowerCase()));
  const hashes = hashesFrom(f.hashes);
  return {
    source: "curseforge",
    project_id: String(modId),
    project_title: project?.title || null,
    project_slug: project?.slug || null,
    icon_url: project?.icon_url || null,
    id: String(f.id || ""),
    name: f.displayName || f.fileName || "",
    version_number: f.displayName || f.fileName || "",
    channel: releaseTypeChannel(f.releaseType),
    version_type: releaseTypeChannel(f.releaseType),
    game_versions: gameVersions,
    loaders,
    date_published: toMs(f.fileDate),
    downloads: 0,
    files: [{
      filename: f.fileName || "",
      url: f.downloadUrl || "",
      primary: true,
      size: toInt(f.fileLength, 0),
      hashes,
      file_type: null,
      file_id: String(f.id || ""),
      mod_id: String(modId),
    }],
    dependencies: asArray(f.dependencies).map((d) => ({
      project_id: String(d?.modId || ""),
      version_id: d?.fileId ? String(d.fileId) : null,
      dependency_type: toInt(d?.relationType, 3) === 1 ? "required" : toInt(d?.relationType, 3) === 2 ? "optional" : "embedded",
    })),
    changelog: "",
    store_url: project ? `${project.store_url}/files/${f.id}` : `${STORE}/mods/${modId}/files/${f.id}`,
  };
}

export const curseforge = {
  id: "curseforge",
  name: "CurseForge",
  storeLabel: "curseforge.com",
  configured: isConfigured,

  async search({ q = "", limit = 20, offset = 0, type = "mod", loaders = [], gameVersion = "", sort = "relevance" } = {}) {
    ensureKey();
    const sortField = sort === "updated" ? 3
      : sort === "newest" ? 11
        : sort === "downloads" ? 6
          : 2;
    const loaderType = toInt(CF_LOADER_TYPES[String(loaders?.[0] || "").toLowerCase()], 0);
    const wantedLoader = String(loaders?.[0] || "").toLowerCase();
    const base = {
      gameId: MINECRAFT_GAME_ID,
      classId: classIdFor(type),
      searchFilter: q || undefined,
      sortField,
      sortOrder: "desc",
      index: Math.max(0, toInt(offset, 0)),
      pageSize: Math.max(1, Math.min(50, toInt(limit, 20))),
    };
    let data = await cf("/mods/search", {
      ...base,
      gameVersion: gameVersion || undefined,
      // The CurseForge API requires a game version when a mod loader is supplied.
      modLoaderType: loaderType && gameVersion ? loaderType : undefined,
    });
    let items = asArray(data.data);
    let fallbackUsed = false;
    // CurseForge's version filter is exact, so a mod that only lists "1.21"
    // would vanish on a "1.21.1" server. Retry without it and match coarsely.
    if (gameVersion && !items.length) {
      fallbackUsed = true;
      data = await cf("/mods/search", base);
      items = asArray(data.data).filter((p) => {
        const indexes = asArray(p.latestFilesIndexes);
        const versionsOk = !indexes.length || indexes.some((i) => gameVersionMatches(i?.gameVersion, gameVersion));
        if (!versionsOk) return false;
        if (!wantedLoader) return true;
        const fileLoaders = indexes.map((i) => String(i?.modLoader || "").toLowerCase()).filter(Boolean);
        if (!fileLoaders.length) return true;
        return fileLoaders.some((l) => loaderCompatible(l, wantedLoader));
      });
    }
    const pagination = data.pagination || {};
    return {
      source: "curseforge",
      results: items.map(normalizeProject).filter(Boolean),
      total: fallbackUsed ? items.length : toInt(pagination.totalCount, items.length),
      offset: toInt(pagination.index, 0),
      limit: toInt(pagination.pageSize, items.length),
    };
  },

  async project(id) {
    const data = await cf(`/mods/${encodeURIComponent(id)}`);
    const p = data.data;
    const project = normalizeProject(p);
    if (!project) return null;
    try {
      const desc = await cf(`/mods/${id}/description`);
      project.body = String(desc.data || "");
      project.description_format = "html";
    } catch { project.body = project.description; }
    return project;
  },

  async versions(id, { loaders = [], gameVersion = "", limit = 100 } = {}) {
    const data = await cf(`/mods/${encodeURIComponent(id)}/files`, {
      // Filter game version and loader locally so coarse matches (1.21 for 1.21.1)
      // and files without loader metadata are not hidden.
      pageSize: Math.max(1, Math.min(50, toInt(limit, 50))),
    });
    let project = null;
    try { project = await this.project(id); } catch { project = null; }
    const wantedLoaders = unique(loaders.map((l) => String(l).toLowerCase()));
    const files = asArray(data.data)
      .filter((f) => {
        if (!gameVersion) return true;
        const versions = asArray(f.gameVersions);
        return !versions.length || versions.some((v) => gameVersionMatches(v, gameVersion));
      })
      .filter((f) => {
        if (!wantedLoaders.length) return true;
        const fileLoaders = unique(asArray(f.gameVersions).filter((v) => v && !/^\d/.test(String(v))).map((v) => String(v).toLowerCase()));
        const candidates = fileLoaders.length ? fileLoaders : asArray(project?.loaders).map((v) => String(v).toLowerCase());
        if (!candidates.length) return true;
        return candidates.some((l) => wantedLoaders.some((w) => loaderCompatible(l, w)));
      })
      .sort((a, b) => (toMs(b.fileDate) || 0) - (toMs(a.fileDate) || 0))
      .slice(0, Math.max(1, toInt(limit, 100)));
    const versions = files.map((f) => normalizeFile(f, id, project));
    await Promise.all(versions.slice(0, 50).map(async (v) => {
      const file = v.files?.[0];
      if (file && !file.url && file.mod_id && file.file_id) {
        try { file.url = await this.fileDownloadUrl(file.mod_id, file.file_id); } catch { /* leave empty */ }
      }
    }));
    return versions;
  },

  async fileDownloadUrl(modId, fileId) {
    const data = await cf(`/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/download-url`);
    return data.data || "";
  },

  async versionByFingerprint(fingerprint, { gameId = 432 } = {}) {
    if (!this.configured()) throw new StoreError("CurseForge API key is not configured");
    const fp = toInt(fingerprint, 0);
    if (!fp) return null;
    const body = await postJson(`${API}/fingerprints/${gameId}`, { fingerprints: [fp] }, { headers: { "x-api-key": curseforgeApiKey() } });
    const match = body?.data?.exactMatches?.[0];
    if (!match?.file?.modId) return null;
    const modId = toInt(match.file.modId, 0);
    const fileId = toInt(match.file.id, 0);
    if (!modId || !fileId) return null;
    const project = await this.project(modId);
    const url = await this.fileDownloadUrl(modId, fileId);
    const displayName = match.file.display_name || match.file.displayName || match.file.file_name || match.file.fileName || "";
    const fileName = match.file.file_name || match.file.fileName || displayName;
    const releaseType = match.file.release_type ?? match.file.releaseType;
    const fileDate = match.file.file_date || match.file.fileDate;
    const fileLength = match.file.file_length ?? match.file.fileLength;
    return {
      source: "curseforge",
      project_id: String(modId),
      project_title: project.title,
      project_slug: project.slug,
      icon_url: project.icon_url,
      id: String(fileId),
      name: displayName,
      version_number: displayName,
      channel: releaseType === 1 ? "release" : releaseType === 2 ? "beta" : "alpha",
      version_type: releaseType === 1 ? "release" : releaseType === 2 ? "beta" : "alpha",
      game_versions: project.game_versions || [],
      loaders: project.loaders || [],
      date_published: toMs(fileDate),
      downloads: 0,
      files: [{
        filename: fileName,
        url,
        primary: true,
        size: toInt(fileLength, 0),
        hashes: {
          sha1: asArray(match.file.hashes).find((h) => h.algo === 1)?.value || "",
          sha512: "",
        },
        file_type: null,
      }],
      dependencies: [],
      changelog: "",
      featured: false,
      status: null,
      store_url: project.store_url,
    };
  },

  async updateFromFingerprint(fingerprint, { loader = "", gameVersion = "", gameId = 432 } = {}) {
    const current = await this.versionByFingerprint(fingerprint, { gameId });
    if (!current) return null;
    const latest = await this.latestVersion(current.project_id, { loader, gameVersion });
    if (!latest || String(latest.id) === String(current.id)) return null;
    return latest;
  },

  async resolveDownload(version) {
    if (!version) return null;
    const file = version.files?.[0];
    if (file?.url) return file;
    if (!file?.mod_id || !file?.file_id) return file || null;
    const url = await this.fileDownloadUrl(file.mod_id, file.file_id);
    return { ...file, url };
  },

  async latestVersion(id, { loaders = [], gameVersion = "" } = {}) {
    const list = await this.versions(id, { loaders, gameVersion, limit: 10 });
    return list[0] || null;
  },
};