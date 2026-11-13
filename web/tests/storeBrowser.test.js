import { test, expect, describe } from "bun:test";
import {
  typeFromLoader,
  modFolderForLoader,
  formatDownloads,
  versionMatches,
  versionCompatibility,
  compatibilityFor,
  gameVersionMatches,
  primaryFile,
  shortHash,
  sourceName,
} from "../src/lib/storeBrowser.js";

describe("storeBrowser helpers", () => {
  test("maps loaders to add-on types", () => {
    expect(typeFromLoader("paper")).toBe("plugin");
    expect(typeFromLoader("purpur")).toBe("plugin");
    expect(typeFromLoader("fabric")).toBe("mod");
    expect(typeFromLoader("neoforge")).toBe("mod");
    expect(typeFromLoader("vanilla")).toBe("datapack");
  });

  test("maps loaders to server folders", () => {
    expect(modFolderForLoader("paper")).toBe("plugins");
    expect(modFolderForLoader("bukkit")).toBe("plugins");
    expect(modFolderForLoader("fabric")).toBe("mods");
    expect(modFolderForLoader("vanilla")).toBe("world/datapacks");
  });

  test("formats downloads", () => {
    expect(formatDownloads(999)).toBe("999");
    expect(formatDownloads(1500)).toBe("1.5K");
    expect(formatDownloads(2_500_000)).toBe("2.5M");
  });

  test("filters versions by loader and game version", () => {
    const version = { loaders: ["fabric", "quilt"], game_versions: ["1.20.1"] };
    expect(versionMatches(version, "fabric", "1.20.1")).toBe(true);
    expect(versionMatches(version, "forge", "1.20.1")).toBe(false);
    expect(versionMatches(version, "fabric", "1.21")).toBe(false);
    expect(versionMatches(version, "", "")).toBe(true);
    expect(versionMatches({ loaders: ["fabric"], game_versions: ["1.20.1"] }, "quilt", "1.20.1")).toBe(true);
    expect(versionMatches({ loaders: ["spigot", "bukkit"], game_versions: ["1.20.1"] }, "paper", "1.20.1")).toBe(true);
    expect(versionMatches({ loaders: ["PAPER"], game_versions: ["1.20.1"] }, "purpur", "1.20.1")).toBe(true);
  });

  test("keeps datapacks visible for vanilla servers", () => {
    const datapack = { loaders: ["datapack"], game_versions: ["1.21.1"] };
    expect(versionMatches(datapack, "vanilla", "1.21.1")).toBe(true);
    expect(versionMatches(datapack, "datapack", "1.21.1")).toBe(true);
    expect(versionMatches({ loaders: ["fabric"], game_versions: ["1.21.1"] }, "vanilla", "1.21.1")).toBe(false);
  });

  test("matches coarse store versions like Spigot", () => {
    expect(gameVersionMatches("1.21", "1.21.1")).toBe(true);
    expect(gameVersionMatches("1.21.1", "1.21")).toBe(true);
    expect(gameVersionMatches("1.20", "1.21.1")).toBe(false);
    expect(gameVersionMatches("1.20.1", "1.20.1")).toBe(true);
    expect(gameVersionMatches("1.21-R0.1-SNAPSHOT", "1.21.1")).toBe(true);
    expect(gameVersionMatches("1.20.1-1.20.4", "1.20.2")).toBe(true);
    expect(gameVersionMatches("1.20.1-1.20.4", "1.20")).toBe(true);
    expect(gameVersionMatches("1.20.1-1.20.4", "1.21")).toBe(false);
    const plugin = { loaders: ["spigot", "bukkit"], game_versions: ["1.20", "1.21", "26.1"] };
    expect(versionMatches(plugin, "paper", "1.21.1")).toBe(true);
    expect(versionMatches(plugin, "paper", "1.19.4")).toBe(false);
  });

  test("explains why a version is incompatible", () => {
    const version = { loaders: ["fabric"], game_versions: ["1.20.1"] };
    expect(versionCompatibility(version, "fabric", "1.20.1")).toEqual({ compatible: true, reasons: [] });
    const bad = versionCompatibility(version, "forge", "1.21");
    expect(bad.compatible).toBe(false);
    expect(bad.reasons.length).toBe(2);
    expect(bad.reasons.join(" ")).toContain("fabric");
    expect(bad.reasons.join(" ")).toMatch(/forge/i);
    expect(versionCompatibility(version, "", "").compatible).toBe(true);
  });

  test("checks project against a destination server", () => {
    const fabric = { loader: "fabric", loader_version: "1.20.1" };
    const paper = { loader: "paper", loader_version: "1.20.1" };
    const mod = { loaders: ["fabric"], gameVersions: ["1.20.1"], projectType: "mod" };
    const plugin = { loaders: ["paper", "bukkit"], gameVersions: ["1.20.1"], projectType: "plugin" };

    expect(compatibilityFor(fabric, mod).compatible).toBe(true);
    expect(compatibilityFor(paper, mod).compatible).toBe(false);
    expect(compatibilityFor(paper, plugin).compatible).toBe(true);
    expect(compatibilityFor(fabric, plugin).compatible).toBe(false);

    const other = compatibilityFor({ loader: "paper", loader_version: "1.19.4" }, plugin);
    expect(other.compatible).toBe(false);
    expect(other.reasons.join(" ")).toContain("1.19.4");

    const bedrock = compatibilityFor({ loader: "bedrock", loader_version: "1.21" }, mod);
    expect(bedrock.compatible).toBe(false);
    expect(bedrock.blocking).toBe(true);

    // Unknown metadata never blocks an install.
    expect(compatibilityFor(paper, {}).compatible).toBe(true);
    expect(compatibilityFor(null, mod).compatible).toBe(false);
  });

  test("picks the primary file", () => {
    const files = [{ filename: "a.jar", primary: false }, { filename: "b.jar", primary: true }];
    expect(primaryFile({ files }).filename).toBe("b.jar");
    expect(primaryFile({ files: [{ filename: "a.jar" }] }).filename).toBe("a.jar");
    expect(primaryFile(null)).toBe(null);
  });

  test("shortens hashes and labels sources", () => {
    expect(shortHash("abcdef1234567890", 4)).toBe("abcd…7890");
    expect(shortHash("")).toBe("");
    expect(sourceName("curseforge")).toBe("CurseForge");
  });
});