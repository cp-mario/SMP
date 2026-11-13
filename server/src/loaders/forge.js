import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { BaseLoader, fetchJson, fetchText, downloadToFile } from "./BaseLoader.js";

const CATALOG_URL = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const METADATA_URL = `${FORGE_MAVEN}/maven-metadata.xml`;
const PROMO_TAIL = { latest: true, recommended: true };
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

class ForgeBuildCatalog {
  constructor(sourceUrl = CATALOG_URL) {
    this.sourceUrl = sourceUrl;
    this._cache = null;
  }

  async entries() {
    if (this._cache) return this._cache;
    const data = await fetchJson(this.sourceUrl);
    const raw = data && typeof data.promos === "object" ? data.promos : {};
    const map = new Map();
    for (const [key, build] of Object.entries(raw)) {
      const cut = key.lastIndexOf("-");
      if (cut <= 0) continue;
      const mc = key.slice(0, cut);
      const channel = key.slice(cut + 1);
      if (!PROMO_TAIL[channel] || !build) continue;
      const slot = map.get(mc) || { mc, latest: null, recommended: null };
      slot[channel] = String(build);
      map.set(mc, slot);
    }
    this._cache = [...map.values()]
      .filter((v) => minimumSupportedMc(v.mc))
      .sort((a, b) => rankMc(b.mc) - rankMc(a.mc));
    return this._cache;
  }

  async forMinecraft(mc) {
    const all = await this.entries();
    return all.find((v) => v.mc === mc) || null;
  }
}

function rankMc(v) {
  const p = String(v).split(/[._-]/);
  let n = 0;
  for (let i = 0; i < 4; i++) n = n * 10000 + (Number.parseInt(p[i], 10) || 0);
  return n;
}

function minimumSupportedMc(v) {
  const [a = 0, b = 0, c = 0] = String(v).split(/[._-]/).map((n) => Number.parseInt(n, 10) || 0);
  return a > 1 || (a === 1 && (b > 5 || (b === 5 && c >= 2)));
}

function assertToken(value, label) {
  const text = String(value ?? "").trim();
  if (!TOKEN_RE.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function quoteMeta(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pickMavenArtifactId(mc, build) {
  try {
    const xml = await fetchText(METADATA_URL);
    const exact = `${mc}-${build}`;
    if (xml.includes(`<version>${exact}</version>`)) return build;
    const pattern = new RegExp(`<version>${quoteMeta(mc)}-(${quoteMeta(build)}-[^<]+)</version>`);
    const hit = xml.match(pattern);
    return hit ? hit[1] : build;
  } catch {
    return build;
  }
}

async function listBuildsForMc(mc) {
  const out = [];
  try {
    const xml = await fetchText(METADATA_URL);
    const re = new RegExp(`<version>${quoteMeta(mc)}-([^<]+)</version>`, "g");
    for (const m of xml.matchAll(re)) {
      const build = String(m[1] || "").trim();
      if (build) out.push(build);
    }
  } catch {}
  // newest-first by rough numeric parts
  out.sort((a, b) => {
    const aa = a.split(/[._+-]/).map((n) => Number.parseInt(n, 10) || 0);
    const bb = b.split(/[._+-]/).map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) { const d = (bb[i] || 0) - (aa[i] || 0); if (d) return d; }
    return String(b).localeCompare(String(a));
  });
  return [...new Set(out)];
}

function javaBinary(javaCommand = null) {
  if (javaCommand && existsSync(javaCommand)) return javaCommand;
  if (javaCommand && !String(javaCommand).includes("/") && !String(javaCommand).includes("\\")) return javaCommand;
  const base = process.env.JAVA_HOME;
  if (base) {
    const exe = join(base, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (existsSync(exe)) return exe;
  }
  return "java";
}

function runForgeInstaller(installerJar, targetDir, javaCommand = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaBinary(javaCommand), ["-jar", installerJar, "--installServer", targetDir], {
      cwd: targetDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const keep = (chunk) => { output = (output + String(chunk)).slice(-24000); };
    const end = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      err ? reject(err) : resolve(value);
    };
    const limit = setTimeout(() => {
      try { proc.kill(); } catch {}
      end(new Error("Forge installer timed out"));
    }, 30 * 60 * 1000);
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("error", (e) => end(e));
    proc.on("close", (code) => end(null, { code: code ?? -1, output }));
  });
}

function findArgsLaunch(rootDir) {
  const base = join(rootDir, "libraries", "net", "minecraftforge", "forge");
  if (!existsSync(base)) return null;
  const order = process.platform === "win32"
    ? ["win_args.txt", "args.txt", "unix_args.txt"]
    : ["unix_args.txt", "args.txt", "win_args.txt"];
  let versions = [];
  try { versions = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  versions.sort((a, b) => b.localeCompare(a));
  for (const v of versions) {
    for (const name of order) {
      const rel = `libraries/net/minecraftforge/forge/${v}/${name}`;
      if (existsSync(join(rootDir, rel))) return { mode: "argsFile", value: rel, forgeVersion: v };
    }
  }
  return null;
}

function findJarLaunch(rootDir, mc = null, artifactId = null) {
  let names = [];
  try { names = readdirSync(rootDir); } catch { return null; }
  const candidates = names.filter((n) => n.toLowerCase().endsWith(".jar") && !/installer/i.test(n));
  const prefer = [];
  if (mc && artifactId) prefer.push(`forge-${mc}-${artifactId}.jar`, `forge-${mc}-${artifactId}-universal.jar`, `forge-${mc}-${artifactId}-server.jar`);
  if (mc) prefer.push(`forge-${mc}.jar`);
  for (const p of prefer) {
    const hit = candidates.find((n) => n.toLowerCase() === p.toLowerCase());
    if (hit) return { mode: "jar", value: hit };
  }
  const pick = candidates.find((n) => /^forge-.*\.jar$/i.test(n) && !/(shim|client)/i.test(n))
    || candidates.find((n) => /universal.*\.jar$/i.test(n))
    || candidates.find((n) => /^minecraft.*server.*\.jar$/i.test(n) && candidates.length === 1 ? null : null);
  return pick ? { mode: "jar", value: pick } : null;
}

function detectRuntime(rootDir, mc = null, artifactId = null) {
  return findArgsLaunch(rootDir) || findJarLaunch(rootDir, mc, artifactId);
}

function sizeOf(filePath) {
  try { return statSync(filePath).size; } catch { return 0; }
}

export class ForgeLoader extends BaseLoader {
  static id = "forge";
  static name = "Forge";
  static type = "java";
  static java = true;
  static eula = true;

  constructor() {
    super();
    this.catalog = new ForgeBuildCatalog();
  }

  async getVersions() {
    const entries = await this.catalog.entries();
    return entries.map((e) => ({
      id: e.mc,
      stable: true,
      channel: "stable",
      meta: { recommended: e.recommended, latest: e.latest, provider: "forge-promotions-slim" },
    }));
  }

  async getLoaderVersions(version) {
    const mc = assertToken(version, "mc_version");
    const entry = await this.catalog.forMinecraft(mc);
    const builds = await listBuildsForMc(mc);
    const rec = entry?.recommended ? String(entry.recommended) : null;
    const lat = entry?.latest ? String(entry.latest) : null;
    const tagged = [];
    if (rec) tagged.push({ id: rec, name: `Recommended ${rec}`, stable: true, channel: "stable", meta: { role: "recommended", mc } });
    if (lat && lat !== rec) tagged.push({ id: lat, name: `Latest ${lat}`, stable: false, channel: "experimental", meta: { role: "latest", mc } });
    for (const b of builds) {
      if (b === rec || b === lat) continue;
      tagged.push({ id: b, name: `Forge ${b}`, stable: false, channel: "experimental", meta: { mc } });
    }
    if (!tagged.length && entry) {
      const b = rec || lat;
      if (b) tagged.push({ id: b, name: `Forge ${b}`, stable: !!rec, channel: rec ? "stable" : "experimental", meta: { mc } });
    }
    return tagged;
  }

  async install({ version, dir, loaderVersion = null, javaCommand = null } = {}) {
    const mc = assertToken(version, "mc_version");
    mkdirSync(dir, { recursive: true });
    const entry = await this.catalog.forMinecraft(mc);

    let selected = loaderVersion ? assertToken(loaderVersion, "forge_build") : null;
    if (!selected) selected = entry ? assertToken(entry.recommended || entry.latest, "build") : null;
    if (!selected) throw new Error(`No Forge build is available for Minecraft ${mc}.`);

    const artifactId = assertToken(await pickMavenArtifactId(mc, selected), "artifact");
    const installerName = `forge-${mc}-${artifactId}-installer.jar`;
    const installerUrl = `${FORGE_MAVEN}/${mc}-${artifactId}/${installerName}`;
    const installerPath = join(dir, installerName);

    await downloadToFile(installerUrl, installerPath);
    try {
      const result = await runForgeInstaller(installerPath, dir, javaCommand);
      if (result.code !== 0) {
        const tail = String(result.output || "").trim().split(/\r?\n/).slice(-6).join(" | ");
        throw new Error(`Forge installer exited with code ${result.code}${tail ? `: ${tail}` : ""}`);
      }

      const runtime = detectRuntime(dir, mc, artifactId);
      if (!runtime) {
        const tail = String(result.output || "").trim().split(/\r?\n/).slice(-4).join(" | ");
        throw new Error(`Forge installation completed, but no runnable server artifact was detected for ${mc}-${artifactId}.${tail ? ` Output: ${tail}` : ""}`);
      }

      const exec = this.getExecution({ dir, row: null, _runtime: runtime });
      const file = runtime.mode === "jar" ? runtime.value : "server.jar";
      return {
        ok: true,
        file,
        jar: file,
        path: runtime.mode === "jar" ? join(dir, runtime.value) : dir,
        size: runtime.mode === "jar" ? sizeOf(join(dir, runtime.value)) : 0,
        sourceFile: installerName,
        exec,
        eula: this.eula,
        custom: this.custom,
        loader: this.id,
        version: mc,
        loaderVersion: artifactId,
        forgeBuild: artifactId,
        launchType: runtime.mode === "argsFile" ? "args_file" : "jar",
      };
    } finally {
      try { if (existsSync(installerPath)) rmSync(installerPath, { force: true }); } catch {}
      try { if (existsSync(`${installerPath}.log`)) rmSync(`${installerPath}.log`, { force: true }); } catch {}
    }
  }

  getExecution({ jar = "server.jar", row = null, dir = null, _runtime = null } = {}) {
    const runtime = _runtime || (dir && existsSync(dir) ? detectRuntime(dir) : null);
    const extra = typeof row?.jvm_args === "string" ? row.jvm_args.trim().split(/\s+/).filter(Boolean) : [];
    const memory = [`-Xmx${row?.memory_max || "2G"}`, `-Xms${row?.memory_min || "512M"}`, ...extra];
    if (runtime?.mode === "argsFile") {
      return { type: "java", command: "java", args: [...memory, `@${runtime.value}`, "nogui"], argsFile: runtime.value, jar };
    }
    if (runtime?.mode === "jar") {
      return { type: "java", command: "java", args: [...memory, "-jar", runtime.value, "nogui"], jar: runtime.value };
    }
    return { type: "java", command: "java", args: [...memory, "-jar", jar, "nogui"], jar };
  }
}
