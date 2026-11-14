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

  async _builds(version) {
    const info = await fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`);
    const builds = info?.builds;
    const all = Array.isArray(builds) ? builds : (Array.isArray(builds?.all) ? builds.all : []);
    return { latest: builds?.latest || all[all.length - 1] || null, all };
  }

  async getLoaderVersions(version) {
    const { all } = await this._builds(version);
    // The API lists builds oldest-first; the picker/update check expects newest-first.
    return [...all].reverse().map((id) => ({
      id: String(id),
      name: `Build ${id}`,
      stable: true,
      channel: "stable",
    }));
  }

  async resolveDownload(version, channel = "all", loaderVersion = null) {
    const { latest, all } = await this._builds(version);
    const wanted = String(loaderVersion || "").trim();
    const build = wanted || latest;
    if (!build || !all.some((x) => String(x) === String(build))) {
      throw new Error(`Purpur build ${wanted || "latest"} not found for ${version}`);
    }
    return {
      url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${encodeURIComponent(build)}/download`,
      fileName: "server.jar",
      loaderVersion: String(build),
    };
  }
}
