import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { db, queryOne } from "../core/db.js";
import { DATA_DIR, JAVA_DIR, serverPath, serverFilesDir, serverBackupsDir, serverEulaPath, isValidServerId } from "../core/config.js";
import { parseMemoryMb, formatMemoryMb, clampMemoryMb, normalizeJvmArgs, parseExec } from "../core/util.js";
import { getLoader, loaderIds } from "../loaders/index.js";
import { portProfile, allocateServerPorts, saveServerPorts, applyPortsToConfig, PortConflictError } from "../runtime/ports.js";
import { defaultJavaId, detectJava } from "../runtime/java.js";
import { modsTarget, folderForTarget } from "../mods/loaders.js";

function validateServerInput(body) {
  const errors = [];
  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    errors.push("name is required");
  }
  if (body.name && body.name.length > 100) {
    errors.push("name too long (max 100 chars)");
  }
  const valid = loaderIds();
  if (body.loader && !valid.includes(body.loader)) {
    errors.push("invalid loader");
  }
  if (body.port !== undefined && (typeof body.port !== "number" || body.port < 1 || body.port > 65535)) {
    errors.push("invalid port");
  }
  const mem = body.memory_max ?? body.memoryMin ?? body.memory ?? body.ram;
  if (mem !== undefined && mem !== "" && !/^\d+\s*(MB|M|GB|G)?$/i.test(String(mem))) {
    errors.push("invalid memory format");
  }
  if (body.jvm_args !== undefined && typeof body.jvm_args !== "string") {
    errors.push("invalid jvm_args");
  }
  return errors;
}

function isEndstoneServer(id) {
  try { return String(queryOne("SELECT loader FROM servers WHERE id = ?", id)?.loader || "").toLowerCase() === "endstone"; } catch { return false; }
}
function serverPropPath(id) {
  return isEndstoneServer(id)
    ? join(serverFilesDir(id), "bedrock_server", "server.properties")
    : join(serverFilesDir(id), "server.properties");
}

function modFromRow(row) {
  return {
    ...row,
    game_versions: parseJsonField(row.game_versions, []),
    loaders: parseJsonField(row.loaders, []),
    dependencies: parseJsonField(row.dependencies, []),
    meta: parseJsonField(row.meta, null),
    enabled: !!row.enabled,
  };
}

function modsFolder(serverId, loader) {
  return join(serverFilesDir(serverId), folderForTarget(modsTarget(loader)));
}

function modsFolderFor(serverId, loader, projectType) {
  return modsFolder(serverId, projectType === "datapack" ? "vanilla" : loader);
}

function createServerRecordSync(body) {
  const errors = validateServerInput(body);
  if (errors.length > 0) {
    const err = new Error(errors.join(", "));
    err.status = 400;
    err.errors = errors;
    throw err;
  }
  const loader = body.loader || "vanilla";
  const loaderMeta = (getLoader(loader) || { meta: () => ({}) }).meta?.() || {};
  const jvmManaged = !!loaderMeta.java;
  const defaultPort = portProfile(loader).find((p) => p.role === "game")?.defaultPort ?? 25565;
  const { name, loader_version, loader_build, java_version, memory_min = "512M", port = defaultPort, motd = "A SMP Server", jar = "server.jar", auto_start = 0 } = body;
  const safePort = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535 ? Number(port) : defaultPort;
  const memory_max = jvmManaged ? formatMemoryMb(clampMemoryMb(parseMemoryMb(body.memory_max ?? body.memory ?? body.ram ?? "2G", 2048))) : "2G";
  const jvm_args = jvmManaged ? normalizeJvmArgs(body.jvm_args) : "";
  const id = crypto.randomUUID();
  ensureServerDir(id);
  writeServerEula(id, false);
  db.prepare("INSERT INTO servers(id,name,dir,loader,loader_version,loader_build,java_version,jar,memory_max,memory_min,port,motd,auto_start,jvm_args) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, name, serverPath(id), loader, loader_version || "", loader_build || "", java_version || "", jar, memory_max, memory_min, safePort, motd, auto_start ? 1 : 0, jvm_args);
  const propPath = serverPropPath(id);
  mkdirSync(dirname(propPath), { recursive: true });
  writeFileSync(propPath, loader === "endstone"
    ? `server-name=${motd}\nserver-port=${safePort}\n`
    : `motd=${motd}\nserver-port=${safePort}\nenable-query=true\n`);
  return { id, loader: loaderMeta, loaderId: loader };
}

function uploadDir() {
  const dir = join(DATA_DIR, "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveUpload(uploadId) {
  if (typeof uploadId !== "string" || !/^[0-9a-f-]{36}$/i.test(uploadId)) return null;
  const path = join(uploadDir(), `${uploadId}.zip`);
  return existsSync(path) ? path : null;
}

function serverDataFromRow(row) {
  const lm = (getLoader(row.loader) || { meta: () => ({}) }).meta?.() || {};
  return {
    name: row.name,
    loader: row.loader,
    loader_version: row.loader_version,
    loader_build: row.loader_build,
    loader_channel: row.loader_channel,
    java_version: row.java_version,
    memory_min: row.memory_min,
    memory_max: row.memory_max,
    jvm_args: row.jvm_args,
    port: row.port,
    motd: row.motd,
    online: !!row.online,
    created_at: row.created_at,
    eula_required: !!lm.eula,
    custom: !!lm.custom,
    java: !!lm.java,
    exec: parseExec(row.exec),
  };
}
function readServerEula(id) {
  try {
    const p = serverEulaPath(id);
    if (!existsSync(p)) return { accepted: false, value: "false", exists: false };
    const txt = readFileSync(p, "utf8");
    const m = txt.match(/^\s*eula\s*=\s*(true|false)\s*$/im);
    const value = m ? m[1].toLowerCase() : "false";
    return { accepted: value === "true", value, exists: true };
  } catch { return { accepted: false, value: "false", exists: false }; }
}
function writeServerEula(id, accepted) {
  ensureServerDir(id);
  writeFileSync(serverEulaPath(id), `eula=${accepted ? "true" : "false"}\n`, "utf8");
}

function ensureServerDir(id) {
  const p = serverPath(id);
  mkdirSync(p, { recursive: true });
  mkdirSync(serverFilesDir(id), { recursive: true });
  mkdirSync(serverBackupsDir(id), { recursive: true });

  const eulaPath = serverEulaPath(id);
  if (!existsSync(eulaPath)) writeFileSync(eulaPath, "eula=false\n", "utf8");

  return serverFilesDir(id);
}

function getProp(id, key, def) {
  try {
    const lookup = key === "motd" && isEndstoneServer(id) ? "server-name" : key;
    const txt = readFileSync(serverPropPath(id), "utf8");
    const line = txt.split(/\r?\n/).find(l => l.startsWith(lookup + "="));
    return line ? line.split("=").slice(1).join("=") : def;
  } catch (e) { return def; }
}

function setProp(id, key, value) {
  const p = serverPropPath(id);
  const actualKey = key === "motd" && isEndstoneServer(id) ? "server-name" : key;
  let txt = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = txt.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ""));
  const idx = lines.findIndex(l => l.startsWith(actualKey + "="));
  if (idx >= 0) lines[idx] = `${actualKey}=${value}`;
  else lines.push(`${actualKey}=${value}`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
}

function setServerPid(id, pid) {
  try { db.prepare("UPDATE servers SET pid = ?, online = ? WHERE id = ?").run(pid ?? null, pid ? 1 : 0, id); } catch {}
}
function getServerRow(id) {
  if (!isValidServerId(id)) return null;
  return queryOne("SELECT * FROM servers WHERE id = ?", id);
}

async function createServerRecord(body = {}) {
  const loaderId = String(body.loader || "vanilla");
  const profile = portProfile(loaderId);
  const defaultPort = profile.find((p) => p.role === "game")?.defaultPort ?? 25565;
  const requestedPorts = body.ports && typeof body.ports === "object" && !Array.isArray(body.ports) ? { ...body.ports } : {};
  if (body.port !== undefined && body.port !== null && body.port !== "") requestedPorts.game = Number(body.port);
  delete body.ports;
  let allocation;
  try {
    allocation = await allocateServerPorts({
      serverId: null,
      loaderId,
      requested: Object.keys(requestedPorts).length ? requestedPorts : null,
      checkOs: true,
    });
  } catch (e) {
    if (e instanceof PortConflictError) { e.status = 409; e.errors = [e.message]; }
    throw e;
  }
  const gamePort = allocation.ports.find((p) => p.role === "game")?.port ?? defaultPort;
  // New Java servers default to the newest installed runtime, or the newest
  // available one (which the start check will ask the user to install).
  const loaderMeta = (getLoader(loaderId) || { meta: () => ({}) }).meta?.() || {};
  let javaVersion = String(body.java_version || "").trim();
  if (!javaVersion && loaderMeta.java) {
    try { javaVersion = defaultJavaId(JAVA_DIR, await detectJava(JAVA_DIR)); } catch { javaVersion = ""; }
  }
  const created = createServerRecordSync({ ...body, port: gamePort, java_version: javaVersion });
  saveServerPorts(created.id, allocation.ports);
  applyPortsToConfig({ dir: serverFilesDir(created.id), loaderId, ports: allocation.ports });
  return { ...created, ports: allocation.ports };
}

export { getServerRow, setServerPid, createServerRecordSync, createServerRecord, modFromRow, getProp, setProp, readServerEula, writeServerEula, ensureServerDir, serverDataFromRow, uploadDir, resolveUpload, modsFolder, modsFolderFor };
