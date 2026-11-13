import { BaseLoader, fetchJson } from "./BaseLoader.js";

export class VanillaLoader extends BaseLoader {
  static id = "vanilla";
  static name = "Vanilla";
  static type = "java";
  static java = true;
  static eula = true;

  async getVersions() {
    const man = await fetchJson("https://launchermeta.mojang.com/mc/game/version_manifest.json");
    return (man.versions || []).map((v) => ({
      id: v.id,
      stable: v.type === "release",
      channel: v.type === "release" ? "stable" : "experimental",
      meta: { type: v.type, url: v.url, releaseTime: v.releaseTime },
    }));
  }

  async resolveDownload(version) {
    const man = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    const v = (man.versions || []).find((x) => x.id === version);
    if (!v) throw new Error(`Vanilla version not found: ${version}`);
    const vman = await fetchJson(v.url);
    const srv = vman?.downloads?.server;
    const url = srv?.url;
    if (!url) throw new Error(`Vanilla server download not found for ${version}`);
    return { url, fileName: "server.jar", sha1: srv?.sha1 || null };
  }
}
