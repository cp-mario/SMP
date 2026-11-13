import { VanillaLoader } from "./vanilla.js";
import { PaperLoader, FoliaLoader, VelocityLoader } from "./paper.js";
import { PurpurLoader } from "./purpur.js";
import { FabricLoader } from "./fabric.js";
import { QuiltLoader } from "./quilt.js";
import { NeoForgeLoader } from "./neoforge.js";
import { ForgeLoader } from "./forge.js";
import { PumpkinMCLoader } from "./pumpkinmc.js";
import { EndstoneLoader } from "./endstone.js";
import { BedrockLoader } from "./bedrock.js";
import { CustomLoader } from "./custom.js";

export const loaderClasses = [
  VanillaLoader,
  PaperLoader,
  PurpurLoader,
  FoliaLoader,
  VelocityLoader,
  PumpkinMCLoader,
  EndstoneLoader,
  FabricLoader,
  QuiltLoader,
  NeoForgeLoader,
  ForgeLoader,
  BedrockLoader,
  CustomLoader,
];

export const loaders = Object.fromEntries(loaderClasses.map((C) => [C.id, new C()]));

export function getLoader(id) {
  return loaders[String(id || "").toLowerCase()] || null;
}

export function listLoaders() {
  return loaderClasses.map((C) => ({
    id: C.id,
    name: C.name,
    type: C.type,
    java: C.java,
    eula: C.eula,
    custom: C.custom,
  }));
}

export function loaderIds() {
  return loaderClasses.map((C) => C.id);
}

export function requiresEula(loaderId) {
  const l = getLoader(loaderId);
  return l ? l.requiresEula() : true;
}
