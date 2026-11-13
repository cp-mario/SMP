import { BaseLoader, fetchJson } from "./BaseLoader.js";
import AdmZip from "adm-zip";
import { chmodSync, existsSync, rmSync, statSync } from "fs";
import { join } from "path";

const DATA_REPO = "https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/v2";
const VERSIONS_URL = `${DATA_REPO}/versions.json`;

function platformBinary() {
  return process.platform === "win32" ? "windows" : "linux";
}

function binaryName() {
  return process.platform === "win32" ? "bedrock_server.exe" : "bedrock_server";
}

/**
 * Bedrock Dedicated Server (BDS).
 *
 * Mojang publishes no machine-readable version manifest, so the community-maintained
 * `bedrock-server-data` registry (download URLs + SHA-256 per build) is used.
 * The downloaded archive is extracted into the server directory.
 */
export class BedrockLoader extends BaseLoader {
  static id = "bedrock";
  static name = "Bedrock";
  static type = "bedrock";
  static java = false;
  static eula = false;

  constructor() {
    super();
    this._registryCache = null;
  }

  async _registry() {
    const now = Date.now();
    if (this._registryCache && now - this._registryCache.at < 30 * 60 * 1000) return this._registryCache.data;
    const data = await fetchJson(VERSIONS_URL);
    this._registryCache = { at: now, data };
    return data;
  }

  async getVersions() {
    const reg = await this._registry();
    const release = Array.isArray(reg?.release?.versions) ? reg.release.versions : [];
    const preview = Array.isArray(reg?.preview?.versions) ? reg.preview.versions : [];
    const out = release.map((id) => ({ id: String(id), stable: true, channel: "stable" }));
    for (const id of preview) out.push({ id: String(id), stable: false, channel: "experimental" });
    if (!out.length) return [{ id: "latest", stable: true, channel: "stable" }];
    return out;
  }

  async _metadata(version) {
    for (const channel of ["release", "preview"]) {
      try {
        const j = await fetchJson(`${DATA_REPO}/${channel}/${encodeURIComponent(version)}/metadata.json`);
        if (j?.binary) return { ...j, channel };
      } catch {}
    }
    return null;
  }

  async resolveDownload(version) {
    if (process.platform === "darwin") {
      throw new Error("Bedrock Dedicated Server is not published for macOS.");
    }
    const meta = await this._metadata(version);
    if (!meta) {
      throw new Error(`Bedrock Dedicated Server metadata not found for ${version}. Pick a version from the list.`);
    }
    const key = platformBinary();
    const bin = meta.binary?.[key];
    if (!bin?.url) {
      throw new Error(`Bedrock Dedicated Server has no ${key} build for ${version}.`);
    }

    return {
      url: bin.url,
      fileName: `bedrock-server-${version}.zip`,
      sha256: bin.sha256 || null,
      exec: this.getExecution({ jar: binaryName() }),
      postInstall: ({ dir, sourcePath }) => {
        try { if (sourcePath && existsSync(sourcePath)) new AdmZip(sourcePath).extractAllTo(dir, true); } catch {}
        if (process.platform !== "win32") {
          const exe = join(dir, "bedrock_server");
          try { if (existsSync(exe)) chmodSync(exe, 0o755); } catch {}
        }
        try { if (sourcePath && existsSync(sourcePath)) rmSync(sourcePath, { force: true }); } catch {}
      },
    };
  }

  async install(opts = {}) {
    const res = await super.install(opts);
    const exe = binaryName();
    const exePath = join(opts.dir || ".", exe);
    res.file = exe;
    res.path = exePath;
    res.size = existsSync(exePath) ? statSync(exePath).size : 0;
    res.exec = this.getExecution({ jar: exe });
    return res;
  }

  getExecution({ jar, row } = {}) {
    const exe = jar || binaryName();
    return { type: "bedrock", command: exe, args: [], jar: exe };
  }
}