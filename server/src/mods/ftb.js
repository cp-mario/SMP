import { getJson, toMs, toInt, asArray, unique, gameVersionMatches } from "./http.js";
import { loaderCompatible } from "./loaders.js";

const API = "https://api.feed-the-beast.com/v1/modpacks/public";
const STORE = "https://www.feed-the-beast.com";

function artUrl(pack) {
  const art = asArray(pack?.art);
  return (art.find((a) => a?.type === "square" || a?.title === "Logo") || art[0])?.url || "";
}

function targetsOf(pack) {
  return asArray(pack?.targets || pack?.versions?.[0]?.targets);
}

function gameVersions(pack) {
  return unique(targetsOf(pack).filter((t) => t?.type === "game").map((t) => String(t.version || "")).filter(Boolean));
}

function loaderTargets(pack) {
  return unique(targetsOf(pack).filter((t) => t?.type === "modloader").map((t) => `${t.name}:${t.version}`));
}

function normalizeProject(p) {
  if (!p || typeof p !== "object") return null;
  return {
    source: "ftb",
    id: String(p.id || ""),
    slug: String(p.slug || ""),
    title: p.name || p.slug || "",
    description: p.synopsis || "",
    body: p.description || "",
    description_format: "text",
    icon_url: artUrl(p),
    downloads: toInt(p.installs, 0),
    followers: toInt(p.plays, 0),
    project_type: "modpack",
    author: "",
    categories: asArray(p.tags).map((t) => t?.name || "").filter(Boolean),
    loaders: loaderTargets(p).map((t) => t.split(":")[0]),
    game_versions: gameVersions(p),
    latest_version: asArray(p.versions).slice(-1)[0]?.name || null,
    updated_at: toMs(p.updated),
    published_at: toMs(p.released),
    license: null,
    source_url: "",
    issues_url: "",
    wiki_url: asArray(p.links).find((l) => /wiki/i.test(l?.name || ""))?.link || "",
    donation_urls: null,
    gallery: asArray(p.art).map((a) => ({ url: a?.url || "", title: a?.title || "", description: "" })),
    client_side: "unknown",
    server_side: "required",
    tags: asArray(p.tags).map((t) => t?.name || "").filter(Boolean),
    store_url: `${STORE}/modpacks/${p.id}-${p.slug || ""}`,
  };
}

function versionGameVersions(v) {
  return unique(asArray(v?.targets).filter((t) => t?.type === "game").map((t) => String(t.version || "")).filter(Boolean));
}

function versionLoaders(v) {
  return unique(asArray(v?.targets).filter((t) => t?.type === "modloader").map((t) => String(t.name || "")));
}

function normalizeVersion(v, project = null) {
  if (!v || typeof v !== "object") return null;
  return {
    source: "ftb",
    project_id: String(project?.id || v.parent || ""),
    project_title: project?.title || null,
    project_slug: project?.slug || null,
    icon_url: project?.icon_url || null,
    id: String(v.id || ""),
    name: v.name || "",
    version_number: v.name || "",
    channel: String(v.type || "release").toLowerCase(),
    version_type: String(v.type || "release").toLowerCase(),
    game_versions: versionGameVersions(v),
    loaders: versionLoaders(v),
    date_published: toMs(v.released) || toMs(v.updated),
    downloads: toInt(v.installs, 0),
    files: [],
    dependencies: [],
    changelog: v.changelog || "",
    featured: false,
    status: null,
    store_url: `${STORE}/modpacks/${project?.id || v.parent || ""}-${project?.slug || ""}`,
  };
}

async function hydrate(ids, existing = new Map()) {
  const out = [];
  const missing = [];
  for (const id of ids) {
    const key = String(id);
    if (existing.has(key)) { out.push(existing.get(key)); continue; }
    missing.push(key);
  }
  const chunk = 6;
  for (let i = 0; i < missing.length; i += chunk) {
    const batch = missing.slice(i, i + chunk);
    const packs = await Promise.all(batch.map(async (id) => {
      try {
        const data = await getJson(`${API}/modpack/${encodeURIComponent(id)}`);
        return normalizeProject(data);
      } catch { return null; }
    }));
    out.push(...packs.filter(Boolean));
  }
  return out;
}

export const ftb = {
  id: "ftb",
  name: "FTB",
  storeLabel: "feed-the-beast.com",
  configured: () => true,

  async search({ q = "", limit = 20, offset = 0, gameVersion = "", loader = "", sort = "downloads" } = {}) {
    const size = Math.max(1, Math.min(50, toInt(limit, 20)));
    const page = Math.floor(Math.max(0, toInt(offset, 0)) / size) + 1;
    // FTB search ignores paging, so request a wider pool when filters are active.
    const poolSize = (gameVersion || loader) ? 50 : size;
    let ids = [];
    if (q) {
      const data = await getJson(`${API}/modpack/search/${poolSize}?term=${encodeURIComponent(q)}`);
      ids = asArray(data.packs).map(String);
    } else {
      const data = await getJson(`${API}/modpack/popular/plays/${poolSize}`);
      ids = asArray(data.packs).map(String);
    }
    let all = await hydrate(ids);
    const wantedLoader = String(loader || "").toLowerCase();
    if (wantedLoader) all = all.filter((p) => !p.loaders?.length || p.loaders.some((l) => loaderCompatible(l, wantedLoader)));
    if (gameVersion) all = all.filter((p) => !p.game_versions?.length || p.game_versions.some((v) => gameVersionMatches(v, gameVersion)));
    all.sort((a, b) => {
      if (sort === "updated") return (b.updated_at || 0) - (a.updated_at || 0);
      if (sort === "newest") return (b.published_at || 0) - (a.published_at || 0);
      return (b.downloads || 0) - (a.downloads || 0);
    });
    const start = (page - 1) * size;
    return {
      source: "ftb",
      results: all.slice(start, start + size),
      total: all.length,
      offset: start,
      limit: size,
    };
  },

  async project(id) {
    const data = await getJson(`${API}/modpack/${encodeURIComponent(id)}`);
    return normalizeProject(data);
  },

  async versionDetail(id, versionId) {
    const data = await getJson(`${API}/modpack/${encodeURIComponent(id)}/${encodeURIComponent(versionId)}`);
    return {
      id: String(data.id || versionId),
      name: data.name || "",
      type: data.type || "release",
      targets: asArray(data.targets),
      files: asArray(data.files).map((f) => ({
        name: f.name || "",
        path: f.path || "./",
        url: f.url || f.mirrors?.[0] || "",
        sha1: f.sha1 || f.hashes?.sha1 || "",
        sha512: f.hashes?.sha512 || "",
        size: toInt(f.size, 0),
        clientonly: !!f.clientonly,
        serveronly: !!f.serveronly,
        type: f.type || "mod",
        curseforge: f.curseforge || null,
      })),
      changelog: data.changelog || "",
    };
  },
};

ftb.project = async function projectWithVersions(id) {
  const data = await getJson(`${API}/modpack/${encodeURIComponent(id)}`);
  const project = normalizeProject(data);
  if (project) {
    project.versions = asArray(data.versions)
      .map((v) => normalizeVersion(v, project))
      .sort((a, b) => (b.date_published || 0) - (a.date_published || 0))
      .slice(0, 200);
  }
  return project;
};

ftb.versions = async function versionsWithProject(id) {
  const project = await ftb.project(id);
  return project?.versions || [];
};

ftb.latestVersion = async function latestVersion(id) {
  const list = await ftb.versions(id);
  return list[0] || null;
};