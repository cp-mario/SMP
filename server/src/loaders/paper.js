import { BaseLoader, fetchJson } from "./BaseLoader.js";

/**
 * PaperMC Fill v3 API (https://fill.papermc.io/v3). Legacy api.papermc.io/v2 is 410 Gone.
 * Reference only (not copied): Paper/Folia share the same API; differ by project slug.
 */
const FILL_API = "https://fill.papermc.io/v3/projects";

function isStableVersion(v) {
  return !/(pre|rc|snapshot|alpha|beta)/i.test(String(v || ""));
}

function flattenVersionsMap(families) {
  // { family: [full_version,...] }, newest family first, newest version first within.
  const out = [];
  const seen = new Set();
  if (families && typeof families === "object" && !Array.isArray(families)) {
    for (const list of Object.values(families)) {
      for (const v of Array.isArray(list) ? list : []) {
        const id = typeof v === "string" ? v : (v?.id || v?.version || "");
        if (id && !seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
  }
  return out;
}

class PaperMCFillLoader extends BaseLoader {
  static type = "java";
  static java = true;
  static eula = true;
  static project = "";

  async getVersions() {
    const payload = await fetchJson(`${FILL_API}/${this.constructor.project}`);
    const versions = flattenVersionsMap(payload?.versions);
    return versions.map((id) => {
      const stable = isStableVersion(id);
      return { id, stable, channel: stable ? "stable" : "experimental" };
    });
  }

  _selectBuild(builds, channel = "all") {
    if (!Array.isArray(builds) || !builds.length) return null;
    const wantExperimental = ["experimental", "beta", "snapshot", "alpha"].includes(String(channel || "").toLowerCase());
    const matching = builds.filter((b) => {
      const ch = String(b?.channel || "").toLowerCase();
      return wantExperimental ? ch !== "stable" : ch === "stable";
    });
    const pool = matching.length ? matching : builds;
    return pool.reduce((a, b) => ((Number(b?.id) || 0) > (Number(a?.id) || 0) ? b : a), pool[0]);
  }

  async getLoaderVersions(version) {
    const project = this.constructor.project;
    const builds = await fetchJson(`${FILL_API}/${project}/versions/${encodeURIComponent(version)}/builds`);
    return (Array.isArray(builds) ? builds : []).map((b) => {
      const stable = String(b?.channel || "").toUpperCase() === "STABLE";
      return {
        id: String(b?.id ?? ""),
        name: `Build ${b?.id ?? ""}`,
        stable,
        channel: stable ? "stable" : "experimental",
        meta: { version, build: b?.id, channel: b?.channel },
      };
    }).filter((b) => b.id);
  }

  async resolveDownload(version, channel = "all", loaderVersion = null) {
    const project = this.constructor.project;
    const builds = await fetchJson(`${FILL_API}/${project}/versions/${encodeURIComponent(version)}/builds`);
    const wanted = String(loaderVersion || "").trim();
    const build = wanted
      ? builds.find((b) => String(b?.id) === wanted)
      : this._selectBuild(builds, channel);
    if (!build) {
      throw new Error(wanted
        ? `${this.constructor.name} build ${wanted} not found for ${version}`
        : `${this.constructor.name} build not found for ${version}`);
    }
    const buildId = build?.id;
    const dl = build?.downloads?.["server:default"] || build?.downloads?.application || null;
    const url = dl?.url;
    if (!url) throw new Error(`${this.constructor.name} download not found for ${version} build ${buildId}`);
    const fileName = dl?.name || "server.jar";
    const sha256 = dl?.checksums?.sha256 || null;
    return { url, fileName, sha256, loaderVersion: String(buildId), meta: { project, version, build: buildId, channel: build?.channel } };
  }
}

export class PaperLoader extends PaperMCFillLoader {
  static id = "paper";
  static name = "Paper";
  static project = "paper";
}

export class FoliaLoader extends PaperMCFillLoader {
  static id = "folia";
  static name = "Folia";
  static project = "folia";
}

export class VelocityLoader extends PaperMCFillLoader {
  static id = "velocity";
  static name = "Velocity";
  static project = "velocity";
  static eula = false;
}
