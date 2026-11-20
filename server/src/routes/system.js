import { Elysia } from "elysia";
import { totalmem } from "os";
import { JAVA_DIR } from "../core/config.js";
import { AVAILABLE_JAVA_VERSIONS, detectJava, listInstalledJava, installJava, uninstallJava, defaultJavaId } from "../runtime/java.js";

// ============ JAVA ============
/**
 * `detectJava()` spawns `java -version` once per candidate (PATH, JAVA_HOME and
 * every system install), which is 3-6 processes and a few hundred ms. That is
 * too slow to run on every settings paint, so the result is cached briefly and
 * refreshed eagerly after an install/uninstall.
 */
const JAVA_SCAN_TTL_MS = Number(process.env.SMP_JAVA_SCAN_MS) || 30 * 1000;
let javaScanCache = null;

function invalidateJavaScan() {
  javaScanCache = null;
}

async function detectJavaCached() {
  const now = Date.now();
  if (javaScanCache && now - javaScanCache.at < JAVA_SCAN_TTL_MS) return javaScanCache.value;
  const detected = await detectJava(JAVA_DIR).catch(() => []);
  javaScanCache = { at: now, value: detected };
  return detected;
}

export const javaRoute = new Elysia({ prefix: "/api/java" })
  .get("/installed", () => ({ installed: listInstalledJava(JAVA_DIR), javaDir: JAVA_DIR }))
  .get("/", async () => {
    const [detected, installed] = await Promise.all([
      detectJavaCached(),
      Promise.resolve(listInstalledJava(JAVA_DIR)),
    ]);
    const installedIds = new Set(installed.map(i => String(i.id)));
    const available = AVAILABLE_JAVA_VERSIONS.map(v => ({ ...v, installed: installedIds.has(String(v.id)), managed: true }));
    const runtimes = [
      { id: "system", name: "System Java (PATH/JAVA_HOME)", source: "system", installed: detected.some(d => d.source === "path" || d.source === "JAVA_HOME") },
      ...installed.map(i => ({ id: i.id, name: "Java " + i.id + " (installed in java folder)", source: "managed", installed: true, path: i.path, home: i.home })),
      ...detected.filter(d => !d.managed).map(d => ({ id: d.path, name: d.name + (d.version ? " — " + d.version : ""), source: d.source, installed: true, path: d.path, version: d.version, detected: true })),
    ];
    const seen = new Set();
    const rt = runtimes.filter(r => { const k = String(r.id); if (seen.has(k)) return false; seen.add(k); return true; });
    return { available, installed, detected, runtimes: rt, defaultVersion: defaultJavaId(JAVA_DIR, detected), javaDir: JAVA_DIR };
  })
  .get("/runtimes", async () => {
    const [detected, installed] = await Promise.all([detectJavaCached(), Promise.resolve(listInstalledJava(JAVA_DIR))]);
    const runtimes = [
      { id: "system", name: "System Java (PATH/JAVA_HOME)", source: "system" },
      ...installed.map(i => ({ id: i.id, name: "Java " + i.id + " (installed in java folder)", source: "managed", path: i.path })),
      ...detected.filter(d => !d.managed).map(d => ({ id: d.path, name: d.name + (d.version ? " — " + d.version : ""), source: d.source, path: d.path, version: d.version })),
    ];
    const seen = new Set();
    return { runtimes: runtimes.filter(r => { const k = String(r.id); if (seen.has(k)) return false; seen.add(k); return true; }) };
  })
  .get("/detect", async () => {
    const java = await detectJavaCached();
    return { java, detected: java };
  })
  .post("/install", async ({ body, set }) => {
    const version = String(body?.version || body?.id || "").trim();
    if (!/^\d+$/.test(version)) { set.status = 400; return { ok: false, error: "Specify a valid major version (e.g. 21)" }; }
    try {
      const res = await installJava(JAVA_DIR, version);
      invalidateJavaScan();
      const [detected, installed] = await Promise.all([detectJava(JAVA_DIR).catch(() => []), Promise.resolve(listInstalledJava(JAVA_DIR))]);
      javaScanCache = { at: Date.now(), value: detected };
      return { ...res, installed, detected };
    } catch (e) {
      set.status = 500;
      return { ok: false, error: e?.message || String(e) };
    }
  })
  .delete("/:version", async ({ params, set }) => {
    const res = uninstallJava(JAVA_DIR, params.version);
    if (!res.ok) { set.status = 404; return res; }
    invalidateJavaScan();
    return { ...res, installed: listInstalledJava(JAVA_DIR) };
  });
export const systemRoute = new Elysia({ prefix: "/api/system" })
  .get("/", () => {
    const total = totalmem();
    const totalMb = Math.max(256, Math.floor(total / (1024 * 1024)));
    return {
      totalRam: total,
      totalRamMb: totalMb,
      memory: { minMb: 256, maxMb: totalMb, sliderStepMb: 512, inputStepMb: 1 },
    };
  });
