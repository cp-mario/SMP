import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync } from "fs";
import { join } from "path";
import { BaseLoader, fetchJson, fetchText, downloadToFile } from "./BaseLoader.js";

const MAVEN_BASE = "https://maven.neoforged.net/releases";
const MAVEN_API = `${MAVEN_BASE}/net/neoforged/neoforge/maven-metadata.xml`;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const JAVA_COMPAT = [
  { minMc: [1, 20, 5], java: 21 },
  { minMc: [1, 18, 0], java: 17 },
  { minMc: [1, 17, 0], java: 16 },
  { minMc: [0, 0, 0], java: 8 },
];

function assertToken(value, label) {
  const text = String(value ?? "").trim();
  if (!TOKEN_RE.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function mcTuple(v) {
  const p = String(v || "").split(/[._-]/).map((n) => Number.parseInt(n, 10) || 0);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

function recommendedJava(mc) {
  const t = mcTuple(mc);
  for (const rule of JAVA_COMPAT) {
    const r = rule.minMc;
    if (t[0] > r[0] || (t[0] === r[0] && (t[1] > r[1] || (t[1] === r[1] && t[2] >= r[2])))) return rule.java;
  }
  return 17;
}

function parseNeoVersions(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<version>([^<]+)<\/version>/g)) {
    const v = String(m[1] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

function deriveMc(version) {
  // NeoForge 20.2+ uses <mc_minor>.<patch>.* (e.g. 21.1.209 -> 1.21.1, 20.4.237 -> 1.20.4)
  const m = String(version).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 20) return `1.${major}.${minor}`;
  return null;
}

function rankVer(v) {
  return String(v).split(/[._+-]/).map((n) => Number.parseInt(n, 10) || 0);
}

function cmpVerDesc(a, b) {
  const aa = rankVer(a), bb = rankVer(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const d = (bb[i] || 0) - (aa[i] || 0);
    if (d) return d;
  }
  return String(b).localeCompare(String(a));
}

function cmpMcDesc(a, b) {
  const aa = rankVer(a), bb = rankVer(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const d = (bb[i] || 0) - (aa[i] || 0);
    if (d) return d;
  }
  return String(b).localeCompare(String(a));
}

async function fetchNeoVersions() {
  try {
    const xml = await fetchText(MAVEN_API);
    const versions = parseNeoVersions(xml);
    if (versions.length) return versions;
  } catch {}
  // Fallback: maven-metadata may be behind different path in some setups; try JSON API style if present.
  try {
    const j = await fetchJson(`${MAVEN_BASE}/api/maven/versions/releases/net/neoforged/neoforge`);
    if (Array.isArray(j?.versions)) return j.versions.map(String);
  } catch {}
  return [];
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

function runInstaller(installerJar, targetDir, javaCommand = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaBinary(javaCommand), ["-jar", installerJar, "--installServer"], {
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
      end(new Error("NeoForge installer timed out"));
    }, 30 * 60 * 1000);
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("error", (e) => end(e));
    proc.on("close", (code) => end(null, { code: code ?? -1, output }));
  });
}

function findArgsLaunch(rootDir) {
  const base = join(rootDir, "libraries", "net", "neoforged", "neoforge");
  if (!existsSync(base)) return null;
  const order = process.platform === "win32"
    ? ["win_args.txt", "args.txt", "unix_args.txt"]
    : ["unix_args.txt", "args.txt", "win_args.txt"];
  let versions = [];
  try { versions = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  versions.sort(cmpVerDesc);
  for (const v of versions) {
    for (const name of order) {
      const rel = `libraries/net/neoforged/neoforge/${v}/${name}`;
      if (existsSync(join(rootDir, rel))) return { mode: "argsFile", value: rel, neoforgeVersion: v };
    }
  }
  // Fallback: root-level run scripts may reference args file
  for (const script of ["run.bat", "run.sh", "run.command"]) {
    const p = join(rootDir, script);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, "utf8");
      const m = txt.match(/@(?:libraries\/net\/neoforged\/neoforge\/[^@\s"']+\/(?:unix|win)_args\.txt|user_jvm_args\.txt)/);
      if (m) {
        const hit = m[0].replace(/^@/, "").trim();
        if (existsSync(join(rootDir, hit))) return { mode: "argsFile", value: hit };
      }
    } catch {}
  }
  return null;
}

function findJarLaunch(rootDir) {
  let names = [];
  try { names = readdirSync(rootDir); } catch { return null; }
  const candidates = names.filter((n) => n.toLowerCase().endsWith(".jar") && !/installer/i.test(n));
  const pick = candidates.find((n) => /^neoforge-.*\.jar$/i.test(n))
    || candidates.find((n) => /server.*\.jar$/i.test(n) && !/^minecraft/i.test(n))
    || candidates.find((n) => /universal.*\.jar$/i.test(n));
  return pick ? { mode: "jar", value: pick } : null;
}

function detectRuntime(rootDir) {
  return findArgsLaunch(rootDir) || findJarLaunch(rootDir);
}

export class NeoForgeLoader extends BaseLoader {
  static id = "neoforge";
  static name = "NeoForge";
  static type = "java";
  static java = true;
  static eula = true;

  async _catalog() {
    const all = await fetchNeoVersions();
    const byMc = new Map();
    for (const v of all) {
      const mc = deriveMc(v);
      if (!mc) continue;
      const list = byMc.get(mc) || [];
      list.push(v);
      byMc.set(mc, list);
    }
    for (const list of byMc.values()) list.sort(cmpVerDesc);
    return { all, byMc };
  }

  async getVersions() {
    const { byMc } = await this._catalog();
    const items = [...byMc.entries()]
      .sort((a, b) => cmpMcDesc(a[0], b[0]))
      .map(([mc, builds]) => ({
        id: mc,
        stable: true,
        channel: "stable",
        meta: { latest: builds[0], provider: "neoforged-maven", java: recommendedJava(mc) },
      }));
    if (items.length) return items;
    // Graceful fallback when maven metadata is unreachable
    return ["1.21.1", "1.21", "1.20.6", "1.20.4"].map((id) => ({ id, stable: false, channel: "experimental" }));
  }

  async getLoaderVersions(version) {
    const mc = assertToken(version, "mc_version");
    const { byMc } = await this._catalog();
    const builds = byMc.get(mc) || [];
    return builds.map((v, i) => ({
      id: v,
      name: `NeoForge ${v}`,
      stable: i === 0, // newest build surfaced as default/stable pick in UI
      channel: i === 0 ? "stable" : "experimental",
      meta: { mc, java: recommendedJava(mc) },
    }));
  }

  async install({ version, dir, loaderVersion = null, javaCommand = null } = {}) {
    const mc = assertToken(version, "mc_version");
    mkdirSync(dir, { recursive: true });
    const { byMc } = await this._catalog();
    const builds = byMc.get(mc) || [];
    let selected = loaderVersion ? assertToken(loaderVersion, "neoforge_version") : (builds[0] || null);
    if (!selected) throw new Error(`No NeoForge build found for Minecraft ${mc}.`);
    if (deriveMc(selected) && deriveMc(selected) !== mc) {
      throw new Error(`NeoForge build ${selected} does not match Minecraft ${mc}.`);
    }

    const installerName = `neoforge-${selected}-installer.jar`;
    const installerUrl = `${MAVEN_BASE}/net/neoforged/neoforge/${selected}/${installerName}`;
    const installerPath = join(dir, installerName);
    await downloadToFile(installerUrl, installerPath);

    try {
      const result = await runInstaller(installerPath, dir, javaCommand);
      if (result.code !== 0) {
        const tail = String(result.output || "").trim().split(/\r?\n/).slice(-6).join(" | ");
        throw new Error(`NeoForge installer exited with code ${result.code}${tail ? `: ${tail}` : ""}`);
      }

      const runtime = detectRuntime(dir);
      if (!runtime) {
        const tail = String(result.output || "").trim().split(/\r?\n/).slice(-4).join(" | ");
        throw new Error(`NeoForge installation completed, but no runnable launch artifact was detected for ${mc} (${selected}).${tail ? ` Output: ${tail}` : ""}`);
      }

      const exec = this.getExecution({ dir, row: null, _runtime: runtime });
      const file = runtime.mode === "jar" ? runtime.value : "server.jar";
      const outPath = runtime.mode === "jar" ? join(dir, runtime.value) : dir;
      return {
        ok: true,
        file,
        jar: file,
        path: outPath,
        size: runtime.mode === "jar" && existsSync(outPath) ? statSync(outPath).size : 0,
        sourceFile: installerName,
        exec,
        eula: this.eula,
        custom: this.custom,
        loader: this.id,
        version: mc,
        loaderVersion: selected,
        neoforgeVersion: selected,
        launchType: runtime.mode === "argsFile" ? "args_file" : "jar",
        javaVersion: recommendedJava(mc),
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
