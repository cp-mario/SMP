import { getJson, toMs, toInt, asArray, unique } from "./http.js";

const API = "https://api.modrinth.com/v2";
const STORE = "https://modrinth.com";

const SORT_INDEX = {
  relevance: "relevance",
  downloads: "downloads",
  follows: "follows",
  newest: "newest",
  updated: "updated",
};

const MODRINTH_LOADERS = new Set([
  "babric", "bta-babric", "bukkit", "bungeecord", "canvas", "datapack", "fabric", "folia", "forge",
  "geyser", "iris", "java-agent", "legacy-fabric", "liteloader", "minecraft", "modloader", "neoforge",
  "nilloader", "optifine", "ornithe", "paper", "purpur", "quilt", "rift", "spigot", "sponge",
  "vanilla", "velocity", "waterfall", "pumpkinmc",
]);

function projectTypeFor(type) {
  if (type === "modpack") return "modpack";
  if (type === "plugin") return "plugin";
  if (type === "datapack") return "datapack";
  if (type === "resourcepack") return "resourcepack";
  return "mod";
}

function storePath(project) {
  const type = project?.project_type || "mod";
  const typeSlug = type === "modpack" ? "modpack" : type === "plugin" ? "plugin" : type === "datapack" ? "datapack" : type === "resourcepack" ? "resourcepack" : "mod";
  return `/${typeSlug}/${project?.slug || project?.id || ""}`;
}

export function normalizeModrinthProject(p) {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "");
  const slug = String(p.slug || "");
  const projectType = String(p.project_type || "mod");
  return {
    source: "modrinth",
    id,
    slug,
    title: p.title || slug || id,
    description: p.description || "",
    body: p.body || "",
    description_format: "markdown",
    icon_url: p.icon_url || "",
    downloads: toInt(p.downloads, 0),
    followers: toInt(p.followers, 0),
    project_type: projectType,
    author: p.author || p.team || "",
    categories: asArray(p.categories).map(String),
    loaders: asArray(p.loaders).map(String),
    game_versions: asArray(p.game_versions).map(String),
    latest_version: p.latest_version || null,
    published_at: toMs(p.published),
    updated_at: toMs(p.updated),
    queued_at: toMs(p.queued),
    approved_at: toMs(p.approved),
    license: p.license?.id || p.license?.name || null,
    source_url: p.source_url || "",
    issues_url: p.issues_url || "",
    wiki_url: p.wiki_url || "",
    discord_url: p.discord_url || "",
    donation_urls: p.donation_urls || null,
    gallery: asArray(p.gallery).map((g) => ({ url: g?.url || "", title: g?.title || "", description: g?.description || "" })),
    client_side: p.client_side || "unknown",
    server_side: p.server_side || "unknown",
    store_url: `${STORE}${storePath({ slug, id, project_type: projectType })}`,
  };
}

export function normalizeModrinthVersion(v, project = null) {
  if (!v || typeof v !== "object") return null;
  const files = asArray(v.files).map((f) => ({
    filename: f?.filename || "",
    url: f?.url || "",
    primary: !!f?.primary,
    size: toInt(f?.size, 0),
    hashes: {
      sha1: f?.hashes?.sha1 || "",
      sha256: "",
      sha512: f?.hashes?.sha512 || "",
    },
    file_type: f?.file_type || null,
  })).filter((f) => f.filename && f.url);
  const loaders = asArray(v.loaders).map(String);
  const gameVersions = asArray(v.game_versions).map(String);
  const projectId = String(v.project_id || project?.id || "");
  return {
    source: "modrinth",
    project_id: projectId,
    project_title: project?.title || null,
    project_slug: project?.slug || null,
    icon_url: project?.icon_url || null,
    id: String(v.id || ""),
    name: v.name || "",
    version_number: v.version_number || "",
    channel: v.version_type || "release",
    version_type: v.version_type || "release",
    game_versions: gameVersions,
    loaders,
    date_published: toMs(v.date_published),
    downloads: toInt(v.downloads, 0),
    files,
    dependencies: asArray(v.dependencies).map((d) => ({
      project_id: d?.project_id || null,
      version_id: d?.version_id || null,
      dependency_type: d?.dependency_type || "required",
    })),
    changelog: v.changelog || "",
    featured: !!v.featured,
    status: v.status || null,
    store_url: `${STORE}/mod/${projectId}${v.id ? `/version/${v.id}` : ""}`,
  };
}

function normalizeHit(h) {
  const id = String(h.project_id || h.id || "");
  const slug = String(h.slug || "");
  const projectType = String(h.project_type || "mod");
  return {
    source: "modrinth",
    id,
    slug,
    title: h.title || slug || id,
    description: h.description || "",
    icon_url: h.icon_url || "",
    downloads: toInt(h.downloads, 0),
    followers: toInt(h.follows, 0),
    project_type: projectType,
    author: h.author || "",
    categories: asArray(h.categories).map(String),
    display_categories: asArray(h.display_categories).map(String),
    loaders: asArray(h.categories).filter((c) => MODRINTH_LOADERS.has(c)),
    game_versions: asArray(h.versions).map(String),
    latest_version: h.latest_version || null,
    updated_at: toMs(h.date_modified),
    published_at: toMs(h.date_created),
    license: h.license || null,
    store_url: `${STORE}/${projectType === "modpack" ? "modpack" : projectType === "plugin" ? "plugin" : projectType === "datapack" ? "datapack" : "mod"}/${slug || id}`,
  };
}

export const modrinth = {
  id: "modrinth",
  name: "Modrinth",
  storeLabel: "modrinth.com",
  configured: () => true,

  async search({ q = "", limit = 20, offset = 0, type = "mod", loaders = [], gameVersion = "", sort = "relevance" } = {}) {
    const facets = [];
    // Modrinth stores plugins/datapacks as project versions, so their primary
    // project_type is often "mod". Filter by the version-level type instead.
    const typeFilter = projectTypeFor(type);
    facets.push(typeFilter === "plugin" ? ["all_project_types:plugin"] : [`project_type:${typeFilter}`]);
    const loaderList = unique(loaders.map(String));
    if (loaderList.length) facets.push(loaderList.map((l) => `categories:${l}`));
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    const url = new URL(`${API}/search`);
    if (q) url.searchParams.set("query", q);
    url.searchParams.set("limit", String(Math.max(1, Math.min(100, toInt(limit, 20)))));
    url.searchParams.set("offset", String(Math.max(0, toInt(offset, 0))));
    url.searchParams.set("index", SORT_INDEX[sort] || "relevance");
    url.searchParams.set("facets", JSON.stringify(facets));
    const data = await getJson(url);
    const hits = asArray(data.hits);
    return {
      source: "modrinth",
      results: hits.map(normalizeHit),
      total: toInt(data.total_hits, hits.length),
      offset: toInt(data.offset, 0),
      limit: toInt(data.limit, hits.length),
    };
  },

  async project(id) {
    const data = await getJson(`${API}/project/${encodeURIComponent(id)}`);
    return normalizeModrinthProject(data);
  },

  async versions(id, { loaders = [], gameVersion = "", limit = 100 } = {}) {
    const url = new URL(`${API}/project/${encodeURIComponent(id)}/version`);
    const loaderList = unique(loaders.map(String));
    if (loaderList.length) url.searchParams.set("loaders", JSON.stringify(loaderList));
    if (gameVersion) url.searchParams.set("game_versions", JSON.stringify([gameVersion]));
    let list = asArray(await getJson(url));
    let project = null;
    try { project = await this.project(id); } catch { project = null; }
    if (loaderList.length) list = list.filter((v) => !asArray(v.loaders).length || asArray(v.loaders).some((l) => loaderList.includes(l)));
    if (gameVersion) list = list.filter((v) => asArray(v.game_versions).includes(gameVersion));
    list.sort((a, b) => (toMs(b.date_published) || 0) - (toMs(a.date_published) || 0));
    const limited = list.slice(0, Math.max(1, toInt(limit, 100)));
    return limited.map((v) => normalizeModrinthVersion(v, project));
  },

  async versionByHash(hash, { loader = "", gameVersion = "" } = {}) {
    const clean = String(hash || "").trim();
    if (!clean) return null;
    const version = await getJson(`${API}/version_file/${encodeURIComponent(clean)}`);
    if (!version || version.__error) return null;
    let project = null;
    try { project = await this.project(version.project_id); } catch { project = null; }
    return normalizeModrinthVersion(version, project);
  },

  async updateFromHash(hash, { loader = "", gameVersion = "" } = {}) {
    const clean = String(hash || "").trim();
    if (!clean) return null;
    const params = new URLSearchParams();
    if (loader) params.set("loader", loader);
    if (gameVersion) params.set("version", gameVersion);
    const qs = params.toString();
    const version = await getJson(`${API}/version_file/${encodeURIComponent(clean)}/update${qs ? `?${qs}` : ""}`);
    if (!version || version.__error) return null;
    let project = null;
    try { project = await this.project(version.project_id); } catch { project = null; }
    return normalizeModrinthVersion(version, project);
  },

  async latestVersion(id, { loaders = [], gameVersion = "" } = {}) {
    const list = await this.versions(id, { loaders, gameVersion, limit: 200 });
    return list[0] || null;
  },
};