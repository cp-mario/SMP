const PLUGIN_LOADERS = new Set([
  "paper", "purpur", "folia", "pumpkinmc", "spigot", "bukkit", "waterfall", "velocity", "bungeecord", "bungee",
]);

const MOD_LOADERS = new Set([
  "fabric", "quilt", "forge", "neoforge", "liteloader", "legacy-fabric", "risugami", "ornithe", "rift",
  "babric", "bta-babric", "nilloader", "modloader", "java-agent", "optifine",
]);

export const CF_CLASS_IDS = { mod: 6, modpack: 4471, plugin: 5, resourcepack: 4545, world: 17 };
export const CF_LOADER_TYPES = { forge: 1, cauldron: 2, liteloader: 3, fabric: 4, quilt: 5, neoforge: 6 };

export function normalizeLoader(loader) {
  const l = String(loader || "").toLowerCase().trim();
  if (!l) return "";
  if (l === "bungee") return "bungeecord";
  if (l === "pumpkin") return "pumpkinmc";
  return l;
}

export function isPluginLoader(loader) {
  return PLUGIN_LOADERS.has(normalizeLoader(loader));
}

export function isModLoader(loader) {
  return MOD_LOADERS.has(normalizeLoader(loader));
}

function modrinthLoadersForPlugin(loader) {
  switch (normalizeLoader(loader)) {
    case "paper": return ["paper", "bukkit", "spigot", "purpur"];
    case "purpur": return ["purpur", "paper", "bukkit", "spigot"];
    case "folia": return ["folia", "paper"];
    case "pumpkinmc": return ["paper"];
    case "spigot":
    case "bukkit": return ["spigot", "bukkit", "paper"];
    case "waterfall": return ["waterfall", "bungeecord"];
    case "velocity": return ["velocity"];
    case "bungeecord": return ["bungeecord", "waterfall"];
    default: return ["paper"];
  }
}

/** Hangar only exposes a fixed set of platforms; anything else must not be sent. */
export function hangarPlatformFor(loader) {
  switch (normalizeLoader(loader)) {
    case "velocity": return "VELOCITY";
    case "waterfall":
    case "bungeecord": return "WATERFALL";
    case "paper":
    case "purpur":
    case "folia":
    case "spigot":
    case "bukkit":
    case "pumpkinmc": return "PAPER";
    default: return null;
  }
}

const PLUGIN_COMPAT = {
  paper: ["paper", "bukkit", "spigot", "purpur", "folia", "pumpkinmc"],
  purpur: ["purpur", "paper", "bukkit", "spigot", "folia"],
  folia: ["folia", "paper"],
  pumpkinmc: ["pumpkinmc", "paper"],
  spigot: ["spigot", "bukkit", "paper"],
  bukkit: ["bukkit", "spigot", "paper"],
  waterfall: ["waterfall", "bungeecord"],
  bungeecord: ["bungeecord", "waterfall"],
  velocity: ["velocity"],
  vanilla: ["vanilla", "datapack", "minecraft"],
  datapack: ["datapack", "vanilla", "minecraft"],
  minecraft: ["minecraft", "datapack", "vanilla"],
  fabric: ["fabric", "quilt"],
  quilt: ["quilt", "fabric"],
};

export function loaderCompatible(versionLoader, wanted) {
  const a = normalizeLoader(versionLoader);
  const b = normalizeLoader(wanted);
  if (!b || !a || a === b) return true;
  if (a === "any") return true;
  return (PLUGIN_COMPAT[b] || []).includes(a);
}

/**
 * Describe where a loader stores add-ons and how to query stores for it.
 * `kind` decides the folder: plugins -> plugins/, mods -> mods/, vanilla -> world/datapacks.
 */
export function modsTarget(loader) {
  const l = normalizeLoader(loader);
  if (!l || l === "vanilla") {
    return { loader: l || "vanilla", kind: "mod", folder: "world/datapacks", loaders: ["datapack"], label: "Data packs", hangarPlatform: null, cfLoaderType: null };
  }
  if (isPluginLoader(l)) {
    return {
      loader: l,
      kind: "plugin",
      folder: "plugins",
      loaders: modrinthLoadersForPlugin(l),
      label: "Plugins",
      hangarPlatform: hangarPlatformFor(l),
      cfLoaderType: null,
    };
  }
  if (isModLoader(l)) {
    return {
      loader: l,
      kind: "mod",
      folder: "mods",
      loaders: [l],
      label: "Mods",
      hangarPlatform: null,
      cfLoaderType: CF_LOADER_TYPES[l] ?? null,
    };
  }
  return { loader: l, kind: "mod", folder: "mods", loaders: [], label: "Mods", hangarPlatform: null, cfLoaderType: null };
}

export function targetForLoaderKind(kind) {
  if (kind === "plugin") return { kind: "plugin", folder: "plugins", loaders: ["paper", "bukkit", "spigot", "purpur"], label: "Plugins" };
  if (kind === "datapack") return { kind: "mod", folder: "world/datapacks", loaders: ["datapack"], label: "Data packs" };
  return { kind: "mod", folder: "mods", loaders: [], label: "Mods" };
}

export function folderForTarget(target) {
  return target?.folder || "mods";
}