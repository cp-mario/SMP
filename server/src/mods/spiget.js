import { getJson, getJsonWithMeta, toMs, toInt, asArray, slugify, gameVersionMatches } from "./http.js";

const API = "https://api.spiget.org/v2";
const STORE = "https://www.spigotmc.org";
let categoryMap = null;

async function loadCategoryMap() {
  if (categoryMap) return categoryMap;
  try {
    const list = asArray(await getJson(`${API}/categories`));
    categoryMap = new Map(list.map((c) => [String(c.id), c.name || String(c.id)]));
  } catch {
    categoryMap = new Map();
  }
  return categoryMap;
}

function iconUrl(icon) {
  if (!icon?.url) return "";
  return `${API}/${String(icon.url).replace(/^\/+/, "")}`;
}

function resourceStoreUrl(r) {
  const slug = slugify(r.name);
  return `${STORE}/resources/${slug}.${r.id}/`;
}

function normalizeResource(r, flavor = "spigot") {
  if (!r || typeof r !== "object") return null;
  const file = r.file || {};
  const fileUrl = file.url || "";
  return {
    source: flavor === "bukkit" ? "bukkit" : "spigot",
    id: String(r.id || ""),
    slug: slugify(r.name),
    title: r.name || "",
    description: r.tag || "",
    body: "",
    description_format: "text",
    contributors: r.contributors || "",
    icon_url: iconUrl(r.icon),
    downloads: toInt(r.downloads, 0),
    followers: toInt(r.likes, 0),
    project_type: "plugin",
    author: r.author?.name || (r.author?.id ? `Author ${r.author.id}` : ""),
    author_id: r.author?.id || null,
    author_url: r.author?.url || "",
    categories: r.category?.name ? [r.category.name] : (r.category?.id ? [String(r.category.id)] : []),
    category_id: r.category?.id || null,
    tags: asArray(r.tags).map((t) => (typeof t === "string" ? t : t?.name || "")).filter(Boolean),
    loaders: ["spigot", "bukkit"],
    game_versions: asArray(r.testedVersions).map(String),
    tested_versions: asArray(r.testedVersions).map(String),
    latest_version: r.version?.id ? String(r.version.id) : null,
    updated_at: toMs(r.updateDate) || toMs(r.releaseDate),
    published_at: toMs(r.releaseDate),
    license: null,
    source_url: r.sourceCodeLink || "",
    issues_url: "",
    wiki_url: r.links?.documentation || "",
    donation_urls: r.donationLink ? [{ platform: "custom", url: r.donationLink }] : null,
    gallery: [],
    client_side: "unknown",
    server_side: "required",
    external: !!r.external,
    premium: !!r.premium,
    rating: r.rating?.average || null,
    rating_count: toInt(r.rating?.count, 0),
    file: {
      url: fileUrl ? `${API}/${String(fileUrl).replace(/^\/+/, "")}` : "",
      external_url: file.externalUrl || "",
      size: toInt(file.size, 0),
      type: file.type || "",
    },
    store_url: resourceStoreUrl(r),
    ...(flavor === "bukkit" ? { bukkit_store_url: `${STORE.replace("www.spigotmc.org", "dev.bukkit.org")}/search?search=${encodeURIComponent(r.name || "")}` } : {}),
  };
}

function normalizeVersion(v, resourceId, project = null) {
  if (!v || typeof v !== "object") return null;
  const file = v.file || {};
  const download = v.downloadUrl || file.externalUrl || file.url || "";
  const rawUrl = download
    ? (String(download).startsWith("http") ? download : `${API}/${String(download).replace(/^\/+/, "")}`)
    : `${API}/resources/${resourceId}/versions/${v.id}/download/proxy`;
  // Specific-version URLs redirect to spigotmc.org (Cloudflare 403); use Spiget's proxy.
  const url = rawUrl.includes(`/versions/${v.id}/download`) ? rawUrl.replace(/\/download$/, "/download/proxy") : rawUrl;
  return {
    source: project?.source || "spigot",
    project_id: String(resourceId),
    project_title: project?.title || null,
    project_slug: project?.slug || null,
    icon_url: project?.icon_url || null,
    id: String(v.id || ""),
    name: v.name || "",
    version_number: v.name || "",
    channel: v.channel || "release",
    version_type: v.channel || "release",
    game_versions: asArray(project?.game_versions).map(String),
    loaders: project?.loaders || ["spigot", "bukkit"],
    date_published: toMs(v.releaseDate),
    downloads: toInt(v.downloads, 0),
    files: [{
      filename: project?.title ? `${slugify(project.title)}-${v.name || "latest"}.jar` : `${resourceId}.jar`,
      url,
      primary: true,
      size: toInt(file.size, 0),
      hashes: { sha1: "", sha512: "" },
      file_type: file.type || null,
    }],
    dependencies: [],
    changelog: v.changelog || "",
    featured: false,
    status: null,
    store_url: project?.store_url || `${STORE}/resources/${resourceId}/`,
  };
}

export const spigot = {
  id: "spigot",
  name: "Spigot",
  storeLabel: "spigotmc.org",
  configured: () => true,

  async search({ q = "", limit = 20, offset = 0, gameVersion = "", sort = "downloads", flavor = "spigot" } = {}) {
    const size = Math.max(1, Math.min(50, toInt(limit, 20)));
    const start = Math.max(0, toInt(offset, 0));
    const page = Math.floor(start / size) + 1;
    const localStart = start - (page - 1) * size;
    const sortParam = sort === "updated" ? "-updateDate" : sort === "newest" ? "-releaseDate" : sort === "follows" ? "-likes" : "-downloads";
    const fetchPage = async (p) => {
      const params = new URLSearchParams({ size: String(size), page: String(p), sort: sortParam });
      if (q) params.set("field", "name");
      const url = q
        ? `${API}/search/resources/${encodeURIComponent(q)}?${params.toString()}`
        : `${API}/resources?${params.toString()}`;
      const { data, headers } = await getJsonWithMeta(url);
      return { items: asArray(data), total: toInt(headers.get("x-total"), 0) };
    };

    let items = [];
    let total = 0;
    const itemStart = gameVersion ? start : localStart;
    let p = gameVersion ? 1 : page;
    // A game-version filter runs client side, so walk a few pages to fill the page.
    const maxPages = 8;
    while (items.length < itemStart + size && p < (gameVersion ? 1 : page) + maxPages) {
      const res = await fetchPage(p);
      total = res.total || total;
      if (!res.items.length) break;
      const pageItems = gameVersion
        ? res.items.filter((r) => {
          const tested = asArray(r.testedVersions);
          return !tested.length || tested.some((v) => gameVersionMatches(v, gameVersion));
        })
        : res.items;
      items.push(...pageItems);
      p++;
    }

    const map = await loadCategoryMap();
    const results = items.slice(itemStart, itemStart + size).map((r) => normalizeResource(r, flavor)).filter(Boolean);
    for (const r of results) {
      if (r.category_id && map.has(String(r.category_id))) r.categories = [map.get(String(r.category_id))];
    }
    return {
      source: flavor === "bukkit" ? "bukkit" : "spigot",
      results,
      total: gameVersion ? Math.max(items.length, itemStart + size) : (total || items.length),
      offset: start,
      limit: size,
    };
  },

  async project(id, { flavor = "spigot" } = {}) {
    const r = await getJson(`${API}/resources/${encodeURIComponent(id)}`);
    const project = normalizeResource(r, flavor);
    if (project?.category_id) {
      const map = await loadCategoryMap();
      if (map.has(String(project.category_id))) project.categories = [map.get(String(project.category_id))];
    }
    return project;
  },

  async versions(id, { gameVersion = "", limit = 100 } = {}) {
    let project = null;
    try { project = await this.project(id); } catch { project = null; }
    const list = asArray(await getJson(`${API}/resources/${encodeURIComponent(id)}/versions?size=${Math.max(1, Math.min(50, toInt(limit, 50)))}&sort=-releaseDate`));
    const normalized = list
      .map((v) => normalizeVersion(v, id, project))
      .filter((v) => v && (!gameVersion || !v.game_versions?.length || asArray(v.game_versions).some((gv) => gameVersionMatches(gv, gameVersion))))
      .sort((a, b) => (b.date_published || 0) - (a.date_published || 0))
      .slice(0, Math.max(1, toInt(limit, 100)));
    // Spiget caches only the latest jar on its CDN; older versions must go through the proxy.
    const firstFile = normalized[0]?.files?.[0];
    if (firstFile && firstFile.url.includes(`/resources/${id}/versions/`) && firstFile.url.includes("/download")) {
      firstFile.url = `${API}/resources/${encodeURIComponent(id)}/download`;
    }
    return normalized;
  },

  async latestVersion(id, { gameVersion = "" } = {}) {
    if (gameVersion) {
      const list = await this.versions(id, { gameVersion, limit: 100 });
      return list[0] || null;
    }
    let project = null;
    try { project = await this.project(id); } catch { project = null; }
    const latest = await getJson(`${API}/resources/${encodeURIComponent(id)}/versions/latest`);
    const download = project?.file?.external_url || `${API}/resources/${encodeURIComponent(id)}/download`;
    return normalizeVersion({ ...latest, downloadUrl: download }, id, project);
  },

  async resolveDownload(version) {
    return version?.files?.[0] || null;
  },
};

export const bukkit = {
  ...spigot,
  id: "bukkit",
  name: "Bukkit",
  storeLabel: "dev.bukkit.org",
  configured: () => true,
  async search(opts = {}) { return spigot.search({ ...opts, flavor: "bukkit" }); },
  async project(id, opts = {}) { return spigot.project(id, { ...opts, flavor: "bukkit" }); },
  async versions(id, opts = {}) { return spigot.versions(id, opts); },
  async latestVersion(id, opts = {}) { return spigot.latestVersion(id, opts); },
};