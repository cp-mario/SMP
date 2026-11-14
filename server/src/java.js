import { existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, createWriteStream, realpathSync } from "fs";
import { join, basename, delimiter } from "path";
import { spawn } from "child_process";
import { pipeline, Readable } from "stream";
import { promisify } from "util";
import AdmZip from "adm-zip";

const streamPipeline = promisify(pipeline);

export const AVAILABLE_JAVA_VERSIONS = [
  { id: "8", major: 8, name: "Java 8 (LTS)", lts: true },
  { id: "11", major: 11, name: "Java 11 (LTS)", lts: true },
  { id: "17", major: 17, name: "Java 17 (LTS)", lts: true },
  { id: "21", major: 21, name: "Java 21 (LTS)", lts: true },
  { id: "22", major: 22, name: "Java 22", lts: false },
  { id: "23", major: 23, name: "Java 23", lts: false },
  { id: "24", major: 24, name: "Java 24", lts: false },
  { id: "25", major: 25, name: "Java 25 (LTS)", lts: true },
];

function javaBinName() {
  return process.platform === "win32" ? "java.exe" : "java";
}

function resolveJavaHome(dir) {
  if (!dir || !existsSync(dir)) return null;
  const bin = join(dir, "bin", javaBinName());
  if (existsSync(bin)) return dir;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const nested = join(dir, e.name);
      if (existsSync(join(nested, "bin", javaBinName()))) return nested;
    }
  } catch {}
  return null;
}

export function javaBinFromHome(home) {
  if (!home) return null;
  const bin = join(home, "bin", javaBinName());
  return existsSync(bin) ? bin : null;
}

export function getInstalledJavaHome(javaDir, id) {
  if (!id) return null;
  const raw = String(id).trim();
  if (!raw || raw === "system") return null;
  if (existsSync(raw) && statSync(raw).isDirectory()) {
    const h = resolveJavaHome(raw);
    if (h) return h;
  }
  const candidates = [join(javaDir, raw), join(javaDir, `java-${raw}`)];
  for (const c of candidates) {
    const h = resolveJavaHome(c);
    if (h) return h;
  }
  return null;
}

function runJavaVersion(cmd) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      const t = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 4000);
      child.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? (out.split(/\r?\n/).find(Boolean) || out.trim()) : null); });
      child.on("error", () => { clearTimeout(t); resolve(null); });
    } catch { resolve(null); }
  });
}

function normalizePath(p) {
  if (!p) return "";
  let real = p;
  try { real = realpathSync(p); } catch {}
  real = real.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function findExecutable(cmd) {
  if (!cmd) return null;
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd) ? cmd : null;
  const dirs = (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const full = join(d, javaBinName());
    if (existsSync(full)) return full;
  }
  return null;
}

async function detectEntry(source, pathOrCmd, label) {
  const ver = await runJavaVersion(pathOrCmd);
  if (!ver) return null;
  const exe = findExecutable(pathOrCmd);
  return {
    id: `detected:${source}:${pathOrCmd}`,
    source,
    name: label || source,
    version: ver,
    path: pathOrCmd,
    exe,
    realPath: normalizePath(exe),
    installed: true,
    managed: false,
    detected: true,
  };
}

export function listInstalledJava(javaDir) {
  if (!existsSync(javaDir)) return [];
  const out = [];
  try {
    for (const e of readdirSync(javaDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const home = resolveJavaHome(join(javaDir, e.name));
      const bin = javaBinFromHome(home);
      if (!bin) continue;
      const id = e.name.replace(/^java-/, "") || e.name;
      out.push({ id, dirId: e.name, source: "managed", name: `Java ${id} (installed)`, path: bin, home, installed: true, managed: true });
    }
  } catch {}
  out.sort((a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0));
  return out;
}

export async function detectJava(javaDir) {
  const found = [];
  const byRealPath = new Map();
  const byVersion = new Map();
  const managedSeen = new Set();
  const push = (e) => {
    if (!e) return;
    if (e.managed) {
      const key = `${normalizePath(e.path)}|${e.version || ""}`;
      if (managedSeen.has(key)) return;
      managedSeen.add(key);
      found.push({ ...e, sources: [e.source] });
      return;
    }
    const versionKey = (e.version || "").trim().toLowerCase();
    const target = (e.realPath && byRealPath.get(e.realPath)) || (versionKey && byVersion.get(versionKey));
    if (target) {
      if (!target.sources.includes(e.source)) target.sources.push(e.source);
      if (e.source !== "system" && !target.names.includes(e.name)) target.names.push(e.name);
      target.name = target.names.join(" · ");
      if (versionKey && !byVersion.has(versionKey)) byVersion.set(versionKey, target);
      if (e.realPath && !byRealPath.has(e.realPath)) byRealPath.set(e.realPath, target);
      return;
    }
    const entry = { ...e, sources: [e.source], names: [e.name] };
    found.push(entry);
    if (versionKey) byVersion.set(versionKey, entry);
    if (e.realPath) byRealPath.set(e.realPath, entry);
  };
  push(await detectEntry("path", "java", "Java en PATH"));
  const jh = process.env.JAVA_HOME;
  if (jh) {
    const home = resolveJavaHome(jh) || jh;
    const bin = javaBinFromHome(home) || join(jh, "bin", javaBinName());
    push(await detectEntry("JAVA_HOME", bin, `JAVA_HOME (${basename(jh)})`));
  }
  if (process.platform === "win32") {
    const roots = [
      join(process.env["ProgramFiles"] || "C:\\Program Files", "Eclipse Adoptium"),
      join(process.env["ProgramFiles"] || "C:\\Program Files", "Java"),
      join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Java"),
      join(process.env.LOCALAPPDATA || "", "Programs", "Eclipse Adoptium"),
    ].filter(Boolean);
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        for (const e of readdirSync(root, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const home = resolveJavaHome(join(root, e.name));
          const bin = javaBinFromHome(home);
          if (bin) push(await detectEntry("system", bin, e.name));
        }
      } catch {}
    }
  }
  for (const inst of listInstalledJava(javaDir)) push({ ...inst, detected: true });
  return found;
}

function adoptiumPlatform() {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "aarch64" : process.arch === "ia32" ? "x86" : process.arch;
  return { os, arch };
}

export async function installJava(javaDir, version, onProgress) {
  const ver = String(version || "").replace(/^java-?/i, "").trim();
  if (!/^\d+$/.test(ver)) throw new Error("Invalid Java version");
  mkdirSync(javaDir, { recursive: true });
  const { os, arch } = adoptiumPlatform();
  const ext = os === "windows" ? "zip" : "tar.gz";
  const url = `https://api.adoptium.net/v3/binary/latest/${encodeURIComponent(ver)}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse?project=jdk`;
  const targetDir = join(javaDir, `java-${ver}`);
  if (existsSync(targetDir) && javaBinFromHome(resolveJavaHome(targetDir))) {
    return { ok: true, already: true, id: ver, path: javaBinFromHome(resolveJavaHome(targetDir)), home: resolveJavaHome(targetDir) };
  }
  const tmp = join(javaDir, `.tmp-java-${ver}-${Date.now()}.${ext}`);
  const stage = join(javaDir, `.stage-java-${ver}-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  try {
    onProgress?.({ stage: "download", version: ver });
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "SMP-Panel" } });
    if (!res.ok) throw new Error(`Adoptium download failed (${res.status}) for Java ${ver} ${os}/${arch}`);
    if (!res.body) throw new Error(`Empty Adoptium response for Java ${ver}`);
    await streamPipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    onProgress?.({ stage: "extract", version: ver });
    if (ext === "zip") {
      const zip = new AdmZip(tmp);
      zip.extractAllTo(stage, true);
    } else {
      const tar = await import("tar");
      await tar.x({ file: tmp, cwd: stage });
    }
    rmSync(targetDir, { recursive: true, force: true });
    renameSync(stage, targetDir);
    const home = resolveJavaHome(targetDir);
    const bin = javaBinFromHome(home);
    if (!bin) throw new Error("The Java installation does not contain an executable bin/java");
    onProgress?.({ stage: "done", version: ver });
    return { ok: true, id: ver, path: bin, home, name: `Java ${ver} (installed)` };
  } catch (e) {
    try { rmSync(stage, { recursive: true, force: true }); } catch {}
    try { rmSync(targetDir, { recursive: true, force: true }); } catch {}
    throw e;
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

export function uninstallJava(javaDir, version) {
  const ver = String(version || "").replace(/^java-?/i, "").trim();
  const dir = join(javaDir, `java-${ver}`);
  if (!existsSync(dir)) return { ok: false, error: "Not installed" };
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

export async function resolveJavaCommand(javaDir, requested, fallback = "java") {
  const raw = String(requested || "").trim();
  if (!raw || raw === "system") {
    const jh = process.env.JAVA_HOME;
    if (jh) { const b = javaBinFromHome(resolveJavaHome(jh) || jh); if (b) return b; }
    return fallback;
  }
  if (existsSync(raw) && !statSync(raw).isDirectory()) return raw;
  const home = getInstalledJavaHome(javaDir, raw);
  const bin = javaBinFromHome(home);
  return bin || fallback;
}

function javaMajorFromText(text) {
  const value = String(text || "");
  const versionMatch = value.match(/version\s+"?(\d+)(?:\.(\d+))?/i);
  const homeMatch = value.match(/(?:jdk|jre|java)[-_]?(\d+)(?:[._](\d+))?/i);
  const m = versionMatch || homeMatch || value.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  // `java version "1.8.0_392"` means Java 8.
  return major === 1 && m[2] != null ? Number(m[2]) : major;
}

/**
 * Newest installed runtime id (managed folder or detected system Java), or null.
 * Managed ids win ties so the stored value stays portable ("21" instead of a path).
 */
export function newestInstalledJavaId(javaDir, detected = []) {
  let best = null;
  const consider = (id, major, managed) => {
    if (id == null || id === "" || major == null) return;
    const value = String(id);
    if (!best || major > best.major || (major === best.major && managed && !best.managed)) {
      best = { id: value, major, managed: !!managed };
    }
  };
  for (const inst of listInstalledJava(javaDir)) consider(inst.id, javaMajorFromText(inst.id), true);
  for (const entry of Array.isArray(detected) ? detected : []) {
    if (entry?.managed) continue; // already covered by listInstalledJava
    consider(entry?.path || entry?.id, javaMajorFromText(entry?.version || entry?.path || entry?.id), false);
  }
  return best?.id || null;
}

/** Default runtime for new servers: newest installed, else newest available. */
export function defaultJavaId(javaDir, detected = []) {
  const installed = newestInstalledJavaId(javaDir, detected);
  if (installed) return installed;
  const newest = [...AVAILABLE_JAVA_VERSIONS].sort((a, b) => b.major - a.major)[0];
  return String(newest?.id || "25");
}

/**
 * Resolve the executable used to launch a Java server, or explain what to install.
 * `requested` may be a managed id ("21"), "system", a path, a bare command or empty.
 */
export async function resolveJavaForServer(javaDir, requested) {
  const raw = String(requested || "").trim();

  if (raw && raw !== "system" && !/^\d+$/.test(raw)) {
    if (existsSync(raw) && !statSync(raw).isDirectory()) return { ok: true, command: raw, version: raw };
    const managed = javaBinFromHome(getInstalledJavaHome(javaDir, raw));
    if (managed) return { ok: true, command: managed, version: raw };
    if (!raw.includes("/") && !raw.includes("\\")) {
      const onPath = findExecutable("java");
      if (onPath) return { ok: true, command: onPath, version: raw };
    }
    return { ok: false, error: `Could not find the selected Java (${raw}). Install it in Settings → Java or choose another runtime.` };
  }

  if (raw === "system") {
    const jh = process.env.JAVA_HOME;
    if (jh) {
      const bin = javaBinFromHome(resolveJavaHome(jh) || jh);
      if (bin) return { ok: true, command: bin, version: "system" };
    }
    const onPath = findExecutable("java");
    if (onPath) return { ok: true, command: onPath, version: "system" };
    return { ok: false, error: "Could not find a system Java (PATH/JAVA_HOME). Install a runtime in Settings → Java or select a managed one." };
  }

  if (/^\d+$/.test(raw)) {
    const bin = javaBinFromHome(getInstalledJavaHome(javaDir, raw));
    if (bin) return { ok: true, command: bin, version: raw };
    return { ok: false, error: `Java ${raw} is not installed. Install it in Settings → Java before starting the server.`, javaVersion: raw };
  }

  // No explicit runtime: newest installed, else tell the user which one to install.
  const detected = await detectJava(javaDir).catch(() => []);
  const installedId = newestInstalledJavaId(javaDir, detected);
  if (installedId) return await resolveJavaForServer(javaDir, installedId);
  const fallback = defaultJavaId(javaDir, detected);
  return {
    ok: false,
    error: `No Java installed. Install Java ${fallback} in Settings → Java before starting the server.`,
    javaVersion: fallback,
  };
}