import { BaseLoader, fetchJson, fetchText } from "./BaseLoader.js";
import { chmodSync, existsSync, statSync } from "fs";
import { join } from "path";

const RELEASES_API = "https://api.github.com/repos/Pumpkin-MC/Pumpkin/releases";
const RELEASES_PAGE = `${RELEASES_API}?per_page=20`;

function isArm() {
  return process.arch === "arm64" || process.arch === "aarch64";
}

/**
 * PumpkinMC ships as a self-contained native binary per platform/architecture,
 * attached to GitHub releases. No Java runtime is involved.
 */
export class PumpkinMCLoader extends BaseLoader {
  static id = "pumpkinmc";
  static name = "PumpkinMC";
  static type = "native";
  static java = false;
  static eula = false;

  constructor() {
    super();
    this._releasesCache = null;
  }

  async _releases() {
    const now = Date.now();
    if (this._releasesCache && now - this._releasesCache.at < 10 * 60 * 1000) return this._releasesCache.list;
    const payload = await fetchJson(RELEASES_PAGE);
    const list = (Array.isArray(payload) ? payload : []).filter((r) => r && !r.draft && r.tag_name);
    this._releasesCache = { at: now, list };
    return list;
  }

  async getVersions() {
    const releases = await this._releases();
    return releases.map((r) => {
      const stable = !r.prerelease;
      return {
        id: String(r.tag_name),
        stable,
        channel: stable ? "stable" : "experimental",
        meta: {
          name: r.name || r.tag_name,
          mc: this._mcFromTag(r.tag_name),
          publishedAt: r.published_at || null,
          prerelease: !!r.prerelease,
        },
      };
    });
  }

  _mcFromTag(tag) {
    const m = String(tag || "").match(/\+(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  }

  _assetFor(assets, name) {
    return (assets || []).find((a) => String(a?.name || "").toLowerCase() === name.toLowerCase()) || null;
  }

  _binaryName() {
    const arm = isArm();
    if (process.platform === "win32") return arm ? "pumpkin-ARM64-Windows.exe" : "pumpkin-X64-Windows.exe";
    if (process.platform === "darwin") return "pumpkin-ARM64-macOS";
    if (process.platform === "android") return "pumpkin-aarch64-android";
    return arm ? "pumpkin-ARM64-Linux" : "pumpkin-X64-Linux";
  }

  async _checksums(release) {
    const asset = this._assetFor(release.assets, "checksums.sha256");
    if (!asset?.browser_download_url) return null;
    try {
      const text = await fetchText(asset.browser_download_url);
      const map = new Map();
      for (const line of String(text).split(/\r?\n/)) {
        const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
        if (m) map.set(m[2].trim().toLowerCase(), m[1].toLowerCase());
      }
      return map;
    } catch {
      return null;
    }
  }

  async resolveDownload(version) {
    const releases = await this._releases();
    const release = releases.find((r) => String(r.tag_name) === String(version));
    if (!release) throw new Error(`PumpkinMC release not found: ${version}`);

    const binary = this._binaryName();
    let asset = this._assetFor(release.assets, binary);
    if (!asset) {
      // Fallback: any non-checksum asset (e.g. macOS Intel builds are not published).
      asset = (release.assets || []).find((a) => a?.name && a.name !== "checksums.sha256" && !/\.(txt|json|sha256)$/i.test(a.name));
    }
    if (!asset?.browser_download_url) throw new Error(`PumpkinMC has no downloadable binary for ${process.platform}/${process.arch} in ${version}`);

    const checksums = await this._checksums(release);
    const sha256 = checksums?.get(String(asset.name).toLowerCase()) || null;

    return {
      url: asset.browser_download_url,
      fileName: asset.name,
      sha256,
      exec: this.getExecution({ jar: asset.name }),
      postInstall: ({ sourcePath }) => {
        if (process.platform !== "win32") {
          try { if (existsSync(sourcePath)) chmodSync(sourcePath, 0o755); } catch {}
        }
      },
    };
  }

  getExecution({ jar = this._binaryName(), row = null } = {}) {
    const file = jar || this._binaryName();
    return { type: "native", command: `./${file}`, args: [], jar: file, managedJvm: false };
  }
}