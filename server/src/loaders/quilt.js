import { BaseLoader, fetchJson, fetchText, downloadToFile } from "./BaseLoader.js";
import { spawn } from "child_process";
import { existsSync, readdirSync, statSync, mkdirSync, renameSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const META_BASE = "https://meta.quiltmc.org/v3";
const MAVEN_RELEASE = "https://maven.quiltmc.org/repository/release";
const INSTALLER_GROUP = "org/quiltmc/quilt-installer";
const LAUNCH_JAR = "quilt-server-launch.jar";
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$/;

function assertToken(value, label) {
  const text = String(value ?? "").trim();
  if (!TOKEN_RE.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function verParts(v) {
  // Split keeping numeric and tag tokens; normalize beta/rc ordering
  return String(v || "").split(/[.+-]/).map((n) => {
    if (/^\d+$/.test(n)) return { n: Number.parseInt(n, 10), t: 0 };
    return { s: n.toLowerCase(), t: 1 };
  });
}

function cmpVerDesc(a, b) {
  const aa = verParts(a), bb = verParts(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const av = aa[i];
    const bv = bb[i];
    // Missing segment: 1.2.3 (release) > 1.2.3-beta.1
    if (!av && bv) return bv.t === 1 ? 1 : -1;
    if (av && !bv) return av.t === 1 ? -1 : 1;
    if (av.t === 0 && bv.t === 0) { if (av.n !== bv.n) return bv.n - av.n; continue; }
    if (av.t !== bv.t) return av.t === 0 ? -1 : 1; // numeric > pre-release tag
    const s = String(bv.s).localeCompare(String(av.s));
    if (s) return s;
  }
  return String(b).localeCompare(String(a));
}

function isPreReleaseVersion(id) {
  return /-(?:beta|alpha|rc|pre|snapshot|dev|canary)\b/i.test(String(id || ""));
}

function safeUnlink(p) { try { if (p && existsSync(p)) rmSync(p, { force: true }); } catch {} }

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

function runInstaller(installerJar, targetDir, args, javaCommand = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaBinary(javaCommand), ["-jar", installerJar, ...args], {
      cwd: targetDir, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    let settled = false;
    const keep = (chunk) => { output = (output + String(chunk)).slice(-28000); };
    const end = (err, value) => { if (settled) return; settled = true; clearTimeout(limit); err ? reject(err) : resolve(value); };
    const limit = setTimeout(() => { try { proc.kill(); } catch {} end(new Error("Quilt installer timed out")); }, 30 * 60 * 1000);
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("error", (e) => end(e));
    proc.on("close", (code) => end(null, { code: code ?? -1, output, args: ["-jar", installerJar, ...args] }));
  });
}

function findLaunch(base, prefix = "") {
  if (!existsSync(base)) return null;
  const direct = [LAUNCH_JAR, "quilt-server-launcher.jar", "server-launch.jar", "launch.jar"];
  for (const n of direct) if (existsSync(join(base, n))) return prefix + n;
  let names = [];
  try { names = readdirSync(base); } catch { return null; }
  const hit = names.find((n) => /^quilt-server-launch.*\.jar$/i.test(n) && !/installer/i.test(n))
    || names.find((n) => /quilt.*launch.*\.jar$/i.test(n) && !/installer/i.test(n));
  return hit ? prefix + hit : null;
}

function detectLaunchJar(dir) {
  return findLaunch(dir) || findLaunch(join(dir, "server"), "server/");
}

function clearStaleLaunchJars(dir) {
  const stamp = Date.now();
  const moved = [];
  const tryMove = (p) => {
    if (!existsSync(p)) return;
    try { const bak = `${p}.bak-${stamp}`; renameSync(p, bak); moved.push({ p, bak }); } catch {}
  };
  for (const n of [LAUNCH_JAR, "quilt-server-launcher.jar", "server-launch.jar", "launch.jar"]) tryMove(join(dir, n));
  tryMove(join(dir, "server", LAUNCH_JAR));
  tryMove(join(dir, "server", "quilt-server-launcher.jar"));
  return moved;
}

function listDirSample(dir) {
  try { return readdirSync(dir).slice(0, 25).join(", "); } catch { return "(unreadable)"; }
}

function cleanupInstallArtifacts(dir, installerPath, movedLaunch = []) {
  safeUnlink(installerPath);
  for (const m of movedLaunch) safeUnlink(m?.bak);
  // common installer leftovers (best-effort)
  for (const n of ["installer.log", "quilt-installer.log"]) safeUnlink(join(dir, n));
}

export class QuiltLoader extends BaseLoader {
  static id = "quilt";
  static name = "Quilt";
  static type = "java";
  static java = true;
  static eula = true;

  async getVersions() {
    const payload = await fetchJson(`${META_BASE}/versions/game`);
    const items = (Array.isArray(payload) ? payload : []).map((v) => {
      const id = v?.version || v?.id;
      if (!id) return null;
      const stable = typeof v?.stable === "boolean" ? v.stable : isStableMc(id);
      return { id: String(id), stable, channel: stable ? "stable" : "experimental" };
    }).filter(Boolean);
    items.sort((a, b) => {
      if (a.stable !== b.stable) return a.stable ? -1 : 1; // stable releases first
      return cmpVerDesc(a.id, b.id);
    });
    return items;
  }

  async getLoaderVersions(version) {
    const mc = assertToken(version, "mc_version");
    const payload = await fetchJson(`${META_BASE}/versions/loader/${encodeURIComponent(mc)}`);
    const seen = new Set();
    const list = (Array.isArray(payload) ? payload : []).map((e) => {
      const v = e?.loader?.version || e?.version;
      if (!v) return null;
      const id = String(v);
      if (seen.has(id)) return null;
      seen.add(id);
      const upstreamStable = e?.loader?.stable;
      return {
        id,
        name: id,
        upstreamStable: upstreamStable === true,
        build: e?.loader?.build ?? null,
        separator: e?.loader?.separator ?? null,
        meta: e,
      };
    }).filter(Boolean);
    // newest-first by loader semantic version (line + beta + build semantics in version string), then numeric build
    list.sort((a, b) => {
      const sv = cmpVerDesc(a.id, b.id);
      if (sv) return sv;
      const ab = Number(a?.build), bb = Number(b?.build);
      if (Number.isFinite(ab) && Number.isFinite(bb) && ab !== bb) return bb - ab;
      return 0;
    });
    return list.map((x) => {
      const pre = isPreReleaseVersion(x.id);
      return {
        id: x.id,
        name: x.name,
        stable: !pre,
        channel: pre ? "experimental" : "stable",
        build: x.build,
        separator: x.separator,
        meta: x.meta,
      };
    });
  }

  async resolveInstallerVersion() {
    const xml = await fetchText(`${MAVEN_RELEASE}/${INSTALLER_GROUP}/maven-metadata.xml`);
    const m = String(xml).match(/<release>([^<]+)<\/release>/) || String(xml).match(/<latest>([^<]+)<\/latest>/);
    if (!m) return null;
    return assertToken(m[1].trim(), "installer_version");
  }

  async install({ version, dir, loaderVersion: requestedLoaderVersion = null, javaCommand = null } = {}) {
    const mc = assertToken(version, "mc_version");
    mkdirSync(dir, { recursive: true });

    const installerVersion = await this.resolveInstallerVersion();
    if (!installerVersion) throw new Error("Could not resolve latest Quilt installer version from Maven metadata.");

    let loaderVersion = requestedLoaderVersion ? assertToken(requestedLoaderVersion, "loader_version") : null;
    if (!loaderVersion) {
      const loaders = await this.getLoaderVersions(mc);
      const pick = loaders.find((x) => x.stable) || loaders[0];
      if (pick?.id) loaderVersion = pick.id;
    }

    const installerName = `quilt-installer-${installerVersion}.jar`;
    const installerUrl = `${MAVEN_RELEASE}/${INSTALLER_GROUP}/${installerVersion}/${installerName}`;
    const installerPath = join(dir, installerName);
    await downloadToFile(installerUrl, installerPath);

    const staleLaunch = detectLaunchJar(dir);
    const movedLaunch = staleLaunch ? clearStaleLaunchJars(dir) : [];

    // Try arg variants for compatibility; prefer --install-dir so artifacts land in `dir`.
    // Use --create-scripts=false to avoid generating wrappers that can confuse detection; keep --download-server.
    const variants = [];
    if (loaderVersion) variants.push(["install", "server", mc, loaderVersion, "--download-server", `--install-dir=${dir}`, "--create-scripts=false"]);
    if (loaderVersion) variants.push(["install", "server", mc, "--download-server", `--loader-version=${loaderVersion}`, `--install-dir=${dir}`, "--create-scripts=false"]);
    if (loaderVersion) variants.push(["install", "server", mc, loaderVersion, "--download-server", `--install-dir=${dir}`]);
    if (loaderVersion) variants.push(["install", "server", mc, "--download-server", `--loader-version=${loaderVersion}`, `--install-dir=${dir}`]);
    if (loaderVersion) variants.push(["install", "server", mc, loaderVersion, "--download-server"]);
    if (loaderVersion) variants.push(["install", "server", mc, "--download-server", `--loader-version=${loaderVersion}`]);
    variants.push(["install", "server", mc, "--download-server", `--install-dir=${dir}`, "--create-scripts=false"]);
    variants.push(["install", "server", mc, "--download-server", `--install-dir=${dir}`]);
    variants.push(["install", "server", mc, "--download-server"]);

    let result = null;
    let launchRel = null;
    try {
      for (const args of variants) {
        result = await runInstaller(installerPath, dir, args, javaCommand);
        launchRel = detectLaunchJar(dir);
        if (result.code === 0 && launchRel) break;
        if (/usage:|unknown|unrecognized|invalid option|where install options/i.test(result.output || "")) continue;
        if (result.code === 0 && !launchRel) continue;
      }

      // One more pass: accept success if installer created server/ subdir content and we can find launch there or move expectations
      if (!launchRel) launchRel = detectLaunchJar(dir);

      if (!result || result.code !== 0 || !launchRel) {
        for (const m of movedLaunch) try { if (existsSync(m.bak) && !existsSync(m.p)) renameSync(m.bak, m.p); } catch {}
        const tail = (result?.output || "").trim().split(/\r?\n/).slice(-12).join(" | ");
        if (!result || result.code !== 0) throw new Error(`Quilt installer failed (code ${result?.code ?? "?"}, args: ${(result?.args || []).join(" ")})${tail ? `: ${tail}` : ""}`);
        throw new Error(`Quilt installer completed but no launch jar was produced (args: ${(result.args || []).join(" ")}; dir: ${listDirSample(dir)}${existsSync(join(dir, "server")) ? `; server/: ${listDirSample(join(dir, "server"))}` : ""}${existsSync(join(dir, "libraries")) ? `; libraries/: present` : ""})${tail ? `; output: ${tail}` : ""}`);
      }
    } finally {
      cleanupInstallArtifacts(dir, installerPath, movedLaunch);
    }

    const launchPath = join(dir, launchRel);
    const exec = this.getExecution({ jar: launchRel, row: null, dir });
    return {
      ok: true, file: launchRel, path: launchPath, size: existsSync(launchPath) ? statSync(launchPath).size : 0,
      sourceFile: installerName, exec, eula: this.eula, custom: this.custom,
      loader: this.id, version: mc, loaderVersion, installerVersion,
    };
  }

  getExecution({ jar = LAUNCH_JAR, row = null } = {}) {
    const extra = typeof row?.jvm_args === "string" ? row.jvm_args.trim().split(/\s+/).filter(Boolean) : [];
    return { type: "java", command: "java", args: [`-Xmx${row?.memory_max || "2G"}`, `-Xms${row?.memory_min || "512M"}`, ...extra, "-jar", jar, "nogui"], jar };
  }
}

