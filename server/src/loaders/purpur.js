import { BaseLoader, fetchJson } from "./BaseLoader.js";

export class PurpurLoader extends BaseLoader {
  static id = "purpur";
  static name = "Purpur";
  static type = "java";
  static java = true;
  static eula = true;

  async getVersions() {
    const data = await fetchJson("https://api.purpurmc.org/v2/purpur");
    const versions = Array.isArray(data?.versions) ? [...data.versions].reverse() : [];
    return versions.map((v) => {
      const stable = !/(pre|rc|snapshot|alpha|beta)/i.test(v);
      return { id: v, stable, channel: stable ? "stable" : "experimental" };
    });
  }

  async resolveDownload(version) {
    const info = await fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`);
    const builds = info?.builds;
    const all = Array.isArray(builds) ? builds : (Array.isArray(builds?.all) ? builds.all : []);
    const build = builds?.latest || all[all.length - 1];
    if (!build) throw new Error(`Purpur build not found for ${version}`);
    return {
      url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${encodeURIComponent(build)}/download`,
      fileName: "server.jar",
    };
  }
}
