import { getJson, toMs, toInt, asArray, unique, gameVersionMatches } from "./http.js";

const API = "https://hangar.papermc.io/api/v1";
const STORE = "https://hangar.papermc.io";

function projectStoreUrl(p) {
  const owner = p?.namespace?.owner || p?.owner || "";
  const slug = p?.namespace?.slug || p?.slug || "";
  return owner && slug ? `${STORE}/${owner}/${slug}` : `${STORE}/`;
}

function projectSlug(p) {
  return String(p?.namespace?.slug || p?.slug || p?.name || "");
}

function platformList(p) {
  return Object.keys(p?.supportedPlatforms || {});
}

function pageContent(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return String(value.content || value.markdown || value.html || "");
}

function normalizeProject(p) {
  if (!p || typeof p !== "object") return null;
  const slug = projectSlug(p);
  const platforms = platformList(p);
  return {
    source: "hangar",
    id: slug,
    slug,
    title: p.name || slug,
    description: p.description || "",
    body: pageContent(p.mainPageContent) || p.description || "",
    description_format: "markdown",
    icon_url: p.avatarUrl || "",
    downloads: toInt(p.stats?.downloads, 0),
    followers: toInt(p.stats?.stars, 0),
    project_type: "plugin",
    author: p.namespace?.owner || "",
    categories: p.category ? [String(p.category)] : [],
    loaders: platforms,
    game_versions: unique(platforms.flatMap((pl) => asArray(p.supportedPlatforms?.[pl]).map(String))),
    latest_version: null,
    updated_at: toMs(p.lastUpdated) || toMs(p.publishedAt),
    published_at: toMs(p.publishedAt),
    license: p.settings?.license?.name || null,
    source_url: p.settings?.links?.find((l) => l?.name === "Source")?.url || "",
    issues_url: p.settings?.links?.find((l) => l?.name === "Issues")?.url || "",
    wiki_url: p.settings?.links?.find((l) => l?.name === "Wiki")?.url || "",
    donation_urls: null,
    gallery: [],
    client_side: "unknown",
    server_side: "required",
    tags: asArray(p.settings?.tags).map(String),
    store_url: projectStoreUrl(p),
    supportedPlatforms: p.supportedPlatforms || {},
  };
}

function pickPlatform(version, preferred) {
  const downloads = version?.downloads || {};
  if (preferred && downloads[preferred]) return preferred;
  if (downloads.PAPER) return "PAPER";
  const first = Object.keys(downloads)[0];
  return first || null;
}

function normalizeVersion(v, project = null, preferredPlatform = "PAPER") {
  if (!v || typeof v !== "object") return null;
  const downloads = v.downloads || {};
  const platform = pickPlatform(v, preferredPlatform);
  const files = [];
  for (const [pl, entry] of Object.entries(downloads)) {
    const fileInfo = entry?.fileInfo || {};
    const url = entry?.downloadUrl || entry?.externalUrl || "";
    if (!fileInfo.name || !url) continue;
    files.push({
      filename: fileInfo.name,
      url,
      primary: pl === platform,
      size: toInt(fileInfo.sizeBytes, 0),
      hashes: { sha1: "", sha256: fileInfo.sha256Hash || "", sha512: "" },
      file_type: null,
      platform: pl,
    });
  }
  const channel = String(v.channel?.name || "release").toLowerCase();
  const slug = project?.slug || "";
  return {
    source: "hangar",
    project_id: slug,
    project_title: project?.title || null,
    project_slug: slug,
    icon_url: project?.icon_url || null,
    id: String(v.name || ""),
    name: v.name || "",
    version_number: v.name || "",
    channel,
    version_type: channel,
    game_versions: asArray(v.platformDependencies?.[platform]).map(String),
    loaders: platform ? [platform] : [],
    date_published: toMs(v.createdAt),
    downloads: toInt(v.stats?.totalDownloads, 0),
    files,
    dependencies: asArray(v.pluginDependencies?.[platform]).map((d) => ({
      project_id: d?.name || null,
      version_id: null,
      dependency_type: d?.type || "required",
    })),
    changelog: v.description || "",
    featured: false,
    status: v.reviewState || null,
    store_url: `${STORE}/${project?.author || ""}/${slug}/versions/${encodeURIComponent(v.name || "")}`,
  };
}

export const hangar = {
  id: "hangar",
  name: "Hangar",
  storeLabel: "hangar.papermc.io",
  configured: () => true,

  async search({ q = "", limit = 20, offset = 0, type = "plugin", loaders = [], gameVersion = "", sort = "downloads" } = {}) {
    const platform = loaders?.[0] ? loaders[0].toUpperCase() : "";
    const wanted = Math.max(1, Math.min(50, toInt(limit, 20)));
    const start = Math.max(0, toInt(offset, 0));
    const pageSize = Math.min(25, wanted);
    const sortParam = sort === "updated" ? "-updated" : sort === "newest" ? "-newest" : sort === "follows" ? "-stars" : "-downloads";

    let items = [];
    let total = 0;
    for (let fetched = 0; fetched < wanted; fetched += pageSize) {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("limit", String(pageSize));
      params.set("offset", String(start + fetched));
      if (platform) params.set("platform", platform);
      params.set("sort", sortParam);
      const data = await getJson(`${API}/projects?${params.toString()}`);
      const pageItems = asArray(data.result);
      total = toInt(data.pagination?.count, total);
      items.push(...pageItems);
      if (pageItems.length < pageSize) break;
    }

    const normalized = items.map(normalizeProject).filter(Boolean);
    const results = gameVersion
      ? normalized.filter((p) => !p.game_versions?.length || p.game_versions.some((v) => gameVersionMatches(v, gameVersion)))
      : normalized;
    return {
      source: "hangar",
      results: results.slice(0, wanted),
      total: total || items.length,
      offset: start,
      limit: wanted,
    };
  },

  async project(id) {
    const data = await getJson(`${API}/projects/${encodeURIComponent(id)}`);
    return normalizeProject(data.result || data);
  },

  async versions(id, { loaders = [], gameVersion = "", limit = 100 } = {}) {
    const platform = loaders?.[0] ? loaders[0].toUpperCase() : "";
    const params = new URLSearchParams();
    if (platform) params.set("platform", platform);
    params.set("limit", String(Math.max(1, Math.min(25, toInt(limit, 25)))));
    params.set("offset", "0");
    let project = null;
    try { project = await this.project(id); } catch { project = null; }
    const data = await getJson(`${API}/projects/${encodeURIComponent(id)}/versions?${params.toString()}`);
    let list = asArray(data.result)
      .map((v) => normalizeVersion(v, project, platform || "PAPER"))
      .filter((v) => v && (!gameVersion || !v.game_versions?.length || asArray(v.game_versions).some((gv) => gameVersionMatches(gv, gameVersion))));
    list.sort((a, b) => (b.date_published || 0) - (a.date_published || 0));
    return list.slice(0, Math.max(1, toInt(limit, 100)));
  },

  async versionByHash(hash) {
    const wanted = String(hash || "").toLowerCase();
    if (!wanted) return null;
    const data = await getJson(`${API}/versions/hash/${encodeURIComponent(wanted)}`);
    const project = data?.result || data;
    const slug = projectSlug(project);
    if (!slug) return null;
    const versions = await this.versions(slug, { limit: 25 });
    return versions.find((v) => (v.files || []).some((f) => String(f.hashes?.sha256 || "").toLowerCase() === wanted)) || null;
  },

  async updateFromHash(hash, { loader = "", gameVersion = "" } = {}) {
    const current = await this.versionByHash(hash);
    if (!current) return null;
    const latest = await this.latestVersion(current.project_id, { loaders: current.loaders, gameVersion });
    if (!latest || String(latest.id) === String(current.id)) return null;
    return latest;
  },

  async latestVersion(id, { loaders = [], gameVersion = "" } = {}) {
    const list = await this.versions(id, { loaders, gameVersion, limit: 25 });
    return list[0] || null;
  },
};