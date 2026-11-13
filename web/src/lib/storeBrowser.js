export const STORE_SOURCES = [
  { value: "modrinth", label: "Modrinth", store: "modrinth.com" },
  { value: "curseforge", label: "CurseForge", store: "curseforge.com" },
  { value: "hangar", label: "Hangar", store: "hangar.papermc.io" },
  { value: "spigot", label: "Spigot", store: "spigotmc.org" },
  { value: "ftb", label: "FTB", store: "feed-the-beast.com" },
];

export const STORE_TYPES = [
  { value: "mod", label: "Mods" },
  { value: "plugin", label: "Plugins" },
  { value: "modpack", label: "Modpacks" },
  { value: "datapack", label: "Data packs" },
];

export const FALLBACK_MINECRAFT_VERSIONS = [
  "1.21.4", "1.21.1", "1.20.6", "1.20.4", "1.20.1", "1.19.4", "1.19.2",
  "1.18.2", "1.17.1", "1.16.5", "1.15.2", "1.12.2", "1.8.9",
];

const PLUGIN_LOADERS = new Set(["paper", "purpur", "folia", "pumpkinmc", "spigot", "bukkit", "waterfall", "velocity", "bungeecord"]);

const PLUGIN_COMPAT = {
  paper: ["paper", "bukkit", "spigot", "purpur", "folia", "pumpkinmc"],
  purpur: ["purpur", "paper", "bukkit", "spigot", "folia"],
  folia: ["folia", "paper"],
  pumpkinmc: ["pumpkinmc", "paper"],
  spigot: ["spigot", "bukkit", "paper"],
  bukkit: ["bukkit", "spigot", "paper"],
  waterfall: ["waterfall", "bungeecord"],
  bungeecord: ["bungeecord", "waterfall"],
  vanilla: ["vanilla", "datapack", "minecraft"],
  datapack: ["datapack", "vanilla", "minecraft"],
  minecraft: ["minecraft", "datapack", "vanilla"],
  fabric: ["fabric", "quilt"],
  quilt: ["quilt", "fabric"],
};

function normalizeLoaderValue(value) {
  const l = String(value || "").toLowerCase().trim();
  if (l === "bungee") return "bungeecord";
  if (l === "pumpkin") return "pumpkinmc";
  return l;
}

function loaderCompatible(versionLoader, wanted) {
  const a = normalizeLoaderValue(versionLoader);
  const b = normalizeLoaderValue(wanted);
  if (!b || !a || a === b) return true;
  if (a === "any") return true;
  return (PLUGIN_COMPAT[b] || []).includes(a);
}

function versionParts(value) {
  const base = String(value || "").trim().toLowerCase().split(/[-+ ]/)[0];
  return base.split(/[^0-9]+/).filter(Boolean).map(Number);
}

function compareVersionParts(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const da = a[i] ?? -1;
    const db = b[i] ?? -1;
    if (da !== db) return da - db;
  }
  return 0;
}

function compareVersionPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Stores report Minecraft versions with different precision (1.21 vs 1.21.1). */
export function gameVersionMatches(value, wanted) {
  if (!wanted) return true;
  const have = String(value || "").trim().toLowerCase();
  const want = String(wanted || "").trim().toLowerCase();
  if (!have) return true;
  if (have === want) return true;

  const range = have.match(/^(\d+(?:\.\d+)*)\s*-\s*(\d+(?:\.\d+)*)$/);
  if (range) {
    return compareVersionPrefix(versionParts(want), versionParts(range[1])) >= 0
      && compareVersionPrefix(versionParts(want), versionParts(range[2])) <= 0;
  }

  const hp = versionParts(have);
  const wp = versionParts(want);
  if (!hp.length || !wp.length) return false;
  return compareVersionParts(hp.slice(0, Math.min(hp.length, wp.length)), wp.slice(0, Math.min(hp.length, wp.length))) === 0;
}

export function typeFromLoader(loader) {
  const l = normalizeLoaderValue(loader);
  if (PLUGIN_LOADERS.has(l)) return "plugin";
  if (l === "vanilla") return "datapack";
  return "mod";
}

export function labelForLoader(loader) {
  const l = normalizeLoaderValue(loader);
  if (!l || l === "vanilla") return "Vanilla";
  if (l === "neoforge") return "NeoForge";
  if (l === "pumpkinmc") return "PumpkinMC";
  return l.charAt(0).toUpperCase() + l.slice(1);
}

export function formatDownloads(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export function formatDate(ms) {
  if (!ms) return "—";
  try { return new Date(Number(ms)).toLocaleDateString(); } catch { return "—"; }
}

export function channelTone(channel) {
  const c = String(channel || "release").toLowerCase();
  if (c === "release" || c === "stable") return "success";
  if (c === "beta") return "warning";
  if (c === "alpha" || c === "snapshot") return "danger";
  return "neutral";
}

export function channelLabel(channel) {
  const c = String(channel || "release").toLowerCase();
  if (c === "release" || c === "stable") return "Release";
  return c.charAt(0).toUpperCase() + c.slice(1);
}

export function primaryFile(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  return files.find((f) => f.primary) || files[0] || null;
}

/**
 * Explain why a version does (not) match a loader / Minecraft version.
 * The install flow uses this to grey out incompatible builds while still allowing them.
 */
export function versionCompatibility(version, loader, gameVersion) {
  if (!version) return { compatible: false, reasons: ["No version"] };
  const loaders = (Array.isArray(version.loaders) ? version.loaders : []).map((l) => normalizeLoaderValue(l)).filter(Boolean);
  const games = (Array.isArray(version.game_versions) ? version.game_versions : []).map(String).filter(Boolean);
  const reasons = [];
  if (loader && loaders.length && !loaders.some((l) => loaderCompatible(l, loader))) {
    reasons.push(`Requires ${loaders.join(", ")} (target ${labelForLoader(loader)})`);
  }
  if (gameVersion && games.length && !games.some((v) => gameVersionMatches(v, gameVersion))) {
    reasons.push(`No build for ${gameVersion}`);
  }
  return { compatible: reasons.length === 0, reasons };
}

export function versionMatches(version, loader, gameVersion) {
  return versionCompatibility(version, loader, gameVersion).compatible;
}

/**
 * Can `candidate` (a project or a version) be installed into `server`?
 * `blocking` is reserved for targets that can never work (Bedrock), which the UI disables.
 */
export function compatibilityFor(server, candidate = {}) {
  if (!server) return { compatible: false, blocking: false, reasons: ["No server selected"] };
  const loader = normalizeLoaderValue(server.loader || "");
  const gameVersion = String(server.loader_version || "");
  if (loader === "bedrock" || loader === "endstone") {
    return {
      compatible: false,
      blocking: true,
      reasons: [loader === "endstone"
        ? "Endstone uses Python/C++ plugins, not Java mods or plugins"
        : "Bedrock servers cannot run mods or plugins"],
    };
  }

  const loaders = (candidate.loaders || []).map((l) => normalizeLoaderValue(l)).filter(Boolean);
  const games = (candidate.gameVersions || candidate.game_versions || []).map(String).filter(Boolean);
  const serverType = typeFromLoader(loader);
  const candidateType = candidate.projectType || candidate.project_type || "";
  const reasons = [];

  if (candidateType === "plugin" && serverType === "mod") {
    reasons.push(`Plugin, but the server runs ${labelForLoader(loader)}`);
  } else if (candidateType === "mod" && serverType === "plugin") {
    reasons.push(`Mod, but the server runs ${labelForLoader(loader)}`);
  }
  if (loaders.length && !loaders.some((l) => loaderCompatible(l, loader))) {
    reasons.push(`Requires ${loaders.join(", ")} (target ${labelForLoader(loader)})`);
  }
  if (gameVersion && games.length && !games.some((v) => gameVersionMatches(v, gameVersion))) {
    reasons.push(`No build for ${gameVersion}`);
  }

  return { compatible: reasons.length === 0, blocking: false, reasons };
}

export function versionLabel(version) {
  if (!version) return "";
  const name = version.version_number || version.name || version.id || "";
  const games = Array.isArray(version.game_versions) ? version.game_versions.join(", ") : "";
  return games ? `${name} · ${games}` : name;
}

export function shortHash(hash, size = 8) {
  const s = String(hash || "");
  if (!s) return "";
  return s.length > size * 2 ? `${s.slice(0, size)}…${s.slice(-size)}` : s;
}

export function projectStoreUrl(project) {
  return project?.store_url || "";
}

export function sourceName(source) {
  return STORE_SOURCES.find((s) => s.value === source)?.label || source || "Store";
}

export function sourceStore(source) {
  return STORE_SOURCES.find((s) => s.value === source)?.store || "";
}

export function isSearchableType(type) {
  return type !== "datapack";
}

export function modFolderForLoader(loader) {
  const l = normalizeLoaderValue(loader);
  if (PLUGIN_LOADERS.has(l)) return "plugins";
  if (l === "vanilla" || !l) return "world/datapacks";
  return "mods";
}