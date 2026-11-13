import { createHash } from "crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { pipeline } from "stream";
import { Readable } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);
const FETCH_TIMEOUT = 45000;
const UA = "SMP-Panel/1.0 (+https://github.com/SMP-Panel)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function mergeHeaders(options = {}) {
  const h = { "User-Agent": UA, Accept: "application/json,text/*,*/*", ...(options.headers || {}) };
  return { ...options, headers: h };
}

export async function fetchJson(url, options = {}) {
  const res = await fetchWithTimeout(url, mergeHeaders(options));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchText(url, options = {}) {
  const res = await fetchWithTimeout(url, mergeHeaders(options));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options?.timeoutMs || FETCH_TIMEOUT);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...mergeHeaders(options), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export async function downloadToFile(url, outPath, { sha256, timeoutMs = 10 * 60 * 1000 } = {}) {
  // Some CDNs (e.g. minecraft.net) reset connections for non-browser User-Agents.
  const res = await fetchWithTimeout(url, { timeoutMs, headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  if (!res.body) throw new Error(`Empty response: ${url}`);
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
  if (sha256) {
    const actual = await sha256File(outPath);
    if (String(actual).toLowerCase() !== String(sha256).toLowerCase()) {
      try { unlinkSync(outPath); } catch {}
      throw new Error(`SHA-256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
    }
  }
  return { path: outPath, size: statSync(outPath).size, sha256: sha256 || null };
}

export function normalizeChannel(v) {
  const c = String(v || "").toLowerCase();
  if (c === "stable" || c === "release" || c === "normal") return "stable";
  if (c === "experimental" || c === "snapshot" || c === "beta" || c === "alpha" || c === "rc" || c === "pre") return "experimental";
  return "stable";
}

export function normalizeVersionItem(v) {
  if (typeof v === "string") return { id: v, stable: true, channel: "stable" };
  const stable = v?.stable !== false && String(v?.channel || "").toLowerCase() !== "experimental";
  const channel = normalizeChannel(v?.channel || (stable ? "stable" : "experimental"));
  return { ...(v || {}), id: String(v?.id || ""), stable: channel === "stable", channel };
}

export function filterVersionItems(items, channel = "all") {
  const want = String(channel || "all").toLowerCase();
  const list = (Array.isArray(items) ? items : []).map(normalizeVersionItem).filter((v) => v.id);
  if (want === "stable" || want === "release" || want === "normal") return list.filter((v) => v.channel === "stable");
  if (want === "experimental" || want === "snapshot" || want === "beta") return list.filter((v) => v.channel === "experimental");
  return list;
}

export function pickLatestVersion(items, channel = "stable") {
  const list = filterVersionItems(items, channel);
  return list[0] || null;
}

export async function ensureJavaServerJar({ dir, sourcePath, sourceFile, exec }) {
  const jarPath = join(dir, "server.jar");
  const usesArgsFile = !!(exec && exec.argsFile);
  const isDirectJar = !usesArgsFile && String(sourceFile || sourcePath || "").toLowerCase().endsWith(".jar");
  if (isDirectJar) {
    if (sourcePath && sourcePath !== jarPath && existsSync(sourcePath)) {
      try { if (existsSync(jarPath) && jarPath !== sourcePath) renameSync(jarPath, join(dir, `server.jar.bak-${Date.now()}`)); } catch {}
      try { renameSync(sourcePath, jarPath); } catch {}
    }
    if (!existsSync(jarPath) && sourcePath && existsSync(sourcePath)) {
      try { renameSync(sourcePath, jarPath); } catch {}
    }
  }
  if (exec && typeof exec === "object" && !usesArgsFile) {
    if (exec.jar && String(exec.jar).toLowerCase().endsWith(".jar")) exec.jar = "server.jar";
    if (Array.isArray(exec.args)) exec.args = exec.args.map((a, i, arr) => {
      if (arr[i - 1] === "-jar" && String(a).toLowerCase().endsWith(".jar")) return "server.jar";
      if (String(a) === sourceFile && String(a).toLowerCase().endsWith(".jar")) return "server.jar";
      return a;
    });
  }
  const finalFile = existsSync(jarPath) ? "server.jar" : (sourceFile || "server.jar");
  return { jarPath: existsSync(jarPath) ? jarPath : (sourcePath || jarPath), file: finalFile };
}

/**
 * Base contract for server loaders.
 *
 * Each loader returns/install the server artifact as `server.jar` in the server files dir
 * (callers may pass a custom output name; the loader resolves/renames as needed).
 *
 * Version entries: { id: string, stable: boolean, channel?: "stable"|"experimental" }
 */
export class BaseLoader {
  /** @type {string} loader id (e.g. "paper") */
  static id = "";
  /** @type {string} display name */
  static name = "";
  /** @type {"java"|"bedrock"|"native"|"custom"} runtime type */
  static type = "java";
  /** @type {boolean} uses managed Java/JVM settings (RAM, JVM args) */
  static java = true;
  /** @type {boolean} requires Minecraft EULA acceptance */
  static eula = true;
  /** @type {boolean} custom/user-managed loader */
  static custom = false;

  constructor() {
    if (new.target === BaseLoader) throw new Error("BaseLoader is abstract");
  }

  get id() { return this.constructor.id; }
  get name() { return this.constructor.name; }
  get type() { return this.constructor.type; }
  get java() { return this.constructor.java; }
  get eula() { return this.constructor.eula; }
  get custom() { return this.constructor.custom; }

  /** Metadata exposed to API clients. */
  meta() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      java: this.java,
      eula: this.eula,
      custom: this.custom,
    };
  }

  /**
   * List available versions.
   * @returns {Promise<Array<{id:string,stable:boolean,channel?:"stable"|"experimental",meta?:object}>>}
   */
  async getVersions() {
    throw new Error(`${this.id}: getVersions() not implemented`);
  }

  /**
   * Resolve download info for a version.
   * @param {string} version
   * @returns {Promise<{url:string,fileName:string,exec?:object,postInstall?:Function|null,manual?:boolean,custom?:boolean}>}
   */
  async resolveDownload(version) {
    throw new Error(`${this.id}: resolveDownload() not implemented`);
  }

  /**
   * Resolve a concrete version. Supports `latest`, `latest-stable`, `latest-experimental`.
   */
  async resolveVersion(version, channel = "all") {
    const raw = String(version || "").trim();
    const m = raw.match(/^latest(?:[-_:](stable|experimental|release|snapshot|normal|beta))?$/i);
    if (!m) return { id: raw, channel: normalizeChannel(channel || "all") === "experimental" ? "experimental" : "stable", requested: raw };
    const want = normalizeChannel(m[1] || channel || "stable");
    const versions = await this.getVersions();
    const picked = pickLatestVersion(versions, want) || pickLatestVersion(versions, "all");
    if (!picked) throw new Error(`${this.id}: no ${want} version available`);
    return { id: picked.id, channel: picked.channel, stable: picked.stable, requested: raw, resolved: true };
  }

  /**
   * List loader-specific build versions for a game version (e.g. Fabric/Quilt loader builds).
   * Optional; loaders that have no secondary loader version return null/empty.
   * @param {string} version - game/MC version
   * @returns {Promise<Array<{id:string,name?:string,stable?:boolean,channel?:string,meta?:object}>|null>}
   */
  async getLoaderVersions(version) {
    return null;
  }

  /**
   * Download/install the loader into `dir`. Java loaders produce `server.jar` when the launch model is a direct jar.
   * @param {{version:string, dir:string, channel?:string, loaderVersion?:string}} opts
   */
  async install({ version, dir, channel = "all", loaderVersion = null, javaCommand = null } = {}) {
    const vinfo = await this.resolveVersion(version, channel);
    version = vinfo.id;
    const resolved = await this.resolveDownload(version, channel, loaderVersion);
    if (resolved.custom || resolved.manual) {
      const exec = resolved.exec || this.getExecution({ jar: resolved.fileName || "server.jar", dir });
      return {
        ok: true,
        file: resolved.fileName || "server.jar",
        path: join(dir, resolved.fileName || "server.jar"),
        size: existsSync(join(dir, resolved.fileName || "server.jar")) ? statSync(join(dir, resolved.fileName || "server.jar")).size : 0,
        sourceFile: resolved.fileName || null,
        exec,
        eula: this.eula,
        custom: this.custom,
        loader: this.id,
        version,
        channel: vinfo.channel,
        loaderVersion: loaderVersion ?? resolved.loaderVersion ?? null,
        resolvedVersion: vinfo.resolved ? vinfo : undefined,
        manual: true,
        javaCommand,
      };
    }
    if (!resolved.url) throw new Error(`${this.id}: no download URL resolved for ${version}`);

    const sourceFile = resolved.fileName || `${this.id}-${version}.jar`;
    const sourcePath = join(dir, sourceFile);
    await downloadToFile(resolved.url, sourcePath, { sha256: resolved.sha256 });

    if (typeof resolved.postInstall === "function") {
      await resolved.postInstall({ version, dir, sourcePath, sourceFile, loader: this, resolved, javaCommand, loaderVersion });
    }

    let file = sourceFile;
    let outPath = sourcePath;
    let exec = resolved.exec || this.getExecution({ jar: sourceFile, dir });
    const isInstaller = /installer/i.test(sourceFile);
    const wantsServerJar = resolved.renameToServerJar !== false && !isInstaller && !resolved.keepSourceName && !(exec && exec.argsFile);
    if (this.java && wantsServerJar && String(sourceFile).toLowerCase().endsWith(".jar")) {
      const norm = await ensureJavaServerJar({ dir, sourcePath, sourceFile, exec });
      file = norm.file;
      outPath = norm.jarPath;
      if (!exec || !Array.isArray(exec.args)) exec = this.getExecution({ jar: file, dir });
    }

    return {
      ok: true,
      file,
      path: outPath,
      size: existsSync(outPath) ? statSync(outPath).size : 0,
      sourceFile,
      sha256: resolved.sha256 || null,
      exec,
      eula: this.eula,
      custom: this.custom,
      loader: this.id,
      version,
      channel: vinfo.channel,
      loaderVersion: loaderVersion ?? resolved.loaderVersion ?? null,
      resolvedVersion: vinfo.resolved ? vinfo : undefined,
      javaCommand,
    };
  }

  /**
   * Describe how the server process should be launched.
   * @param {{jar?:string,dir?:string,row?:object}} opts
   * @returns {{command:string|null,args:string[],cwd?:string,stdio?:string,type:string,manual?:boolean}}
   */
  getExecution({ jar = "server.jar", row = null } = {}) {
    if (this.type === "bedrock") {
      const exe = process.platform === "win32" ? "bedrock_server.exe" : "./bedrock_server";
      return { type: "bedrock", command: exe, args: [], jar, stdio: "pipe" };
    }
    if (this.custom) {
      return { type: "custom", command: null, args: [], jar, manual: true };
    }
    if (!this.java) {
      return { type: "java", command: "java", args: ["-jar", jar, "nogui"], jar, managedJvm: false };
    }
    const memoryMax = row?.memory_max || "2G";
    const memoryMin = row?.memory_min || "512M";
    const extra = typeof row?.jvm_args === "string" ? row.jvm_args.trim().split(/\s+/).filter(Boolean) : [];
    return { type: "java", command: "java", args: [`-Xmx${memoryMax}`, `-Xms${memoryMin}`, ...extra, "-jar", jar, "nogui"], jar };
  }

  /**
   * Whether EULA acceptance is required before start.
   */
  requiresEula() {
    return !!this.eula;
  }
}
