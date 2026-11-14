import { BaseLoader, fetchJson, fetchText, downloadToFile } from "./BaseLoader.js";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";

const META = "https://meta.fabricmc.net/v2";
const MAVEN = "https://maven.fabricmc.net";
const INSTALLER_GROUP = "net/fabricmc/fabric-installer";
const LAUNCH_JAR = "fabric-server-launch.jar";

async function tryFetchJson(url) {
  try { return await fetchJson(url, { timeoutMs: 45000 }); } catch (e) { return { __error: e }; }
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

function runInstaller(installerJar, targetDir, args, javaCommand = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaBinary(javaCommand), ["-jar", installerJar, ...args], {
      cwd: targetDir, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    let settled = false;
    const keep = (chunk) => { output = (output + String(chunk)).slice(-28000); };
    const end = (err, value) => { if (settled) return; settled = true; clearTimeout(limit); err ? reject(err) : resolve(value); };
    const limit = setTimeout(() => { try { proc.kill(); } catch {} end(new Error("Fabric installer timed out")); }, 30 * 60 * 1000);
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("error", (e) => end(e));
    proc.on("close", (code) => end(null, { code: code ?? -1, output, args: ["-jar", installerJar, ...args] }));
  });
}

export class FabricLoader extends BaseLoader {
  static id = "fabric";
  static name = "Fabric";
  static type = "java";
  static java = true;
  static eula = true;

  async getVersions() {
    let mc = await tryFetchJson(`${META}/versions/game`);
    if (mc?.__error || !Array.isArray(mc)) {
      // fallback: combined endpoint
      const all = await tryFetchJson(`${META}/versions`);
      if (all?.__error || !all?.game) {
        const msg = mc?.__error?.message || all?.__error?.message || "no response";
        throw new Error(`Could not load Minecraft versions for Fabric (meta.fabricmc.net): ${msg}`);
      }
      mc = all.game;
    }
    const list = (Array.isArray(mc) ? mc : []).map((v) => ({
      id: String(v?.version ?? ""),
      stable: !!v?.stable,
      channel: v?.stable ? "stable" : "experimental",
    })).filter((v) => v.id);
    if (!list.length) throw new Error("Fabric Meta returned an empty list of Minecraft versions.");
    return list;
  }

  async getLoaderVersions(version) {
    let loaders = await tryFetchJson(`${META}/versions/loader/${encodeURIComponent(version)}`);
    if (loaders?.__error || !Array.isArray(loaders)) {
      const msg = loaders?.__error?.message || "invalid response";
      throw new Error(`Could not load Fabric Loader versions for ${version}: ${msg}`);
    }
    const list = loaders.map((e) => {
      const v = e?.loader?.version || e?.version;
      if (!v) return null;
      const id = String(v);
      const pre = /-(?:beta|alpha|rc|pre|snapshot|dev|canary)\b/i.test(id);
      return { id, name: id, stable: !pre, channel: pre ? "experimental" : "stable", build: e?.loader?.build ?? null, meta: e };
    }).filter(Boolean);
    // The Meta API already returns loader builds newest-first. Do NOT sort by the
    // `build` field: newer loader lines restart build numbering (e.g. 0.20.1 = build 1
    // while the legacy 0.10.6+build.214 has a much higher number).
    if (!list.length) throw new Error(`Fabric Meta returned no Fabric Loader versions for ${version}.`);
    return list;
  }

  async _pickLoader(version, requestedLoaderVersion = null) {
    if (requestedLoaderVersion) return String(requestedLoaderVersion).trim();
    const loaders = await this.getLoaderVersions(version);
    const pick = loaders.find((e) => e.stable) || loaders[0];
    if (!pick?.id) throw new Error(`No Fabric Loader version found for Minecraft ${version}`);
    return String(pick.id);
  }

  async _latestInstallerVersion() {
    const xml = await fetchText(`${MAVEN}/${INSTALLER_GROUP}/maven-metadata.xml`);
    const m = String(xml).match(/<release>([^<]+)<\/release>/) || String(xml).match(/<latest>([^<]+)<\/latest>/);
    if (!m) throw new Error("Could not resolve the latest Fabric Installer version from Maven metadata.");
    return m[1].trim();
  }

  /**
   * The Fabric Meta `/server/json` endpoint no longer ships a bundled server jar,
   * so the official Fabric Installer is used to assemble `fabric-server-launch.jar`
   * plus the required libraries and the vanilla server jar.
   */
  async install({ version, dir, channel = "all", loaderVersion = null, javaCommand = null } = {}) {
    mkdirSync(dir, { recursive: true });
    const vinfo = await this.resolveVersion(version, channel);
    version = vinfo.id;
    const pick = await this._pickLoader(version, loaderVersion);

    const installerVersion = await this._latestInstallerVersion();
    const installerName = `fabric-installer-${installerVersion}.jar`;
    const installerUrl = `${MAVEN}/${INSTALLER_GROUP}/${installerVersion}/${installerName}`;
    const installerPath = join(dir, installerName);
    await downloadToFile(installerUrl, installerPath);

    const args = ["server", "-dir", dir, "-mcversion", version, "-loader", pick, "-downloadMinecraft"];
    let result;
    try {
      result = await runInstaller(installerPath, dir, args, javaCommand);
      if (result.code !== 0) {
        const tail = String(result.output || "").trim().split(/\r?\n/).slice(-8).join(" | ");
        throw new Error(`Fabric installer exited with code ${result.code}${tail ? `: ${tail}` : ""}`);
      }
    } finally {
      try { if (existsSync(installerPath)) rmSync(installerPath, { force: true }); } catch {}
      try { if (existsSync(`${installerPath}.log`)) rmSync(`${installerPath}.log`, { force: true }); } catch {}
    }

    const launchPath = join(dir, LAUNCH_JAR);
    if (!existsSync(launchPath)) {
      let sample = "";
      try { sample = readdirSync(dir).slice(0, 25).join(", "); } catch {}
      throw new Error(`Fabric installer completed but ${LAUNCH_JAR} was not produced for ${version}/${pick}.${sample ? ` Dir: ${sample}` : ""}`);
    }

    const exec = this.getExecution({ jar: LAUNCH_JAR, row: null });
    return {
      ok: true,
      file: LAUNCH_JAR,
      path: launchPath,
      size: statSync(launchPath).size,
      sourceFile: installerName,
      exec,
      eula: this.eula,
      custom: this.custom,
      loader: this.id,
      version,
      channel: vinfo.channel,
      loaderVersion: pick,
      installerVersion,
      resolvedVersion: vinfo.resolved ? vinfo : undefined,
      javaCommand,
    };
  }

  getExecution({ jar = LAUNCH_JAR, row = null } = {}) {
    const extra = typeof row?.jvm_args === "string" ? row.jvm_args.trim().split(/\s+/).filter(Boolean) : [];
    return { type: "java", command: "java", args: [`-Xmx${row?.memory_max || "2G"}`, `-Xms${row?.memory_min || "512M"}`, ...extra, "-jar", jar, "nogui"], jar };
  }
}