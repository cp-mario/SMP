import net from "node:net";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "./db.js";

/**
 * Port management for Minecraft servers.
 *
 * Every loader exposes one or more "roles" (game, query, rcon, bedrock, ...).
 * Each role is reserved in the `server_ports` table and checked against the
 * correct transport:
 *   - Java Edition and RCON listen on TCP.
 *   - Bedrock (RakNet), query and Pumpkin's Bedrock listener use UDP.
 *   - Pumpkin serves Java (TCP) and Bedrock (UDP) at the same time.
 *   - Velocity reads its bind from velocity.toml instead of server.properties.
 *
 * TCP and UDP are independent: a Java server and a Bedrock server may use the
 * same numeric port, but two servers of the same transport cannot.
 */

const MIN_PORT = 1;
const MAX_PORT = 65535;
const FIRST_UNPRIVILEGED = 1024;

export class PortConflictError extends Error {
  constructor(message, conflicts = []) {
    super(message);
    this.name = "PortConflictError";
    this.status = 409;
    this.conflicts = conflicts;
  }
}

// ---------- Port profiles ----------

const JAVA_ROLES = [
  { role: "game", label: "Game", protocol: "tcp", defaultPort: 25565, required: true },
  { role: "query", label: "Query", protocol: "udp", defaultPort: 25565, required: false, follow: "game", enableKey: "enable-query" },
  { role: "rcon", label: "RCON", protocol: "tcp", defaultPort: 25575, required: false, enableKey: "enable-rcon" },
];

const BEDROCK_ROLES = [
  { role: "game", label: "Game (IPv4)", protocol: "udp", defaultPort: 19132, required: true },
  { role: "game_v6", label: "Game (IPv6)", protocol: "udp", defaultPort: 19133, required: false, family: 6 },
];

const PUMPKIN_ROLES = [
  { role: "game", label: "Java Edition", protocol: "tcp", defaultPort: 25565, required: true },
  { role: "bedrock", label: "Bedrock Edition", protocol: "udp", defaultPort: 19132, required: false, family: 4 },
];

const VELOCITY_ROLES = [
  { role: "game", label: "Proxy", protocol: "tcp", defaultPort: 25565, required: true },
  { role: "query", label: "Query", protocol: "udp", defaultPort: 25565, required: false, follow: "game" },
];

/** Port roles required by a loader, in display order. */
export function portProfile(loaderId) {
  switch (String(loaderId || "").toLowerCase()) {
    case "bedrock": return BEDROCK_ROLES.map((r) => ({ ...r }));
    case "endstone": return BEDROCK_ROLES.map((r) => ({ ...r }));
    case "pumpkinmc": return PUMPKIN_ROLES.map((r) => ({ ...r }));
    case "velocity": return VELOCITY_ROLES.map((r) => ({ ...r }));
    default: return JAVA_ROLES.map((r) => ({ ...r }));
  }
}

export function isPortNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

function protocolOf(value) {
  return String(value || "").toLowerCase() === "udp" ? "udp" : "tcp";
}

function portKey(protocol, port) {
  return `${protocolOf(protocol)}:${Number(port)}`;
}

// ---------- Schema / migration ----------

export function migrateServerPorts() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_ports (
      server_id TEXT NOT NULL,
      role TEXT NOT NULL,
      port INTEGER NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'tcp',
      PRIMARY KEY (server_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_server_ports_lookup ON server_ports(protocol, port);
    CREATE INDEX IF NOT EXISTS idx_server_ports_server ON server_ports(server_id);
    CREATE TABLE IF NOT EXISTS server_extra_ports (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      label TEXT NOT NULL,
      port INTEGER NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'tcp',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_server_extra_ports_lookup ON server_extra_ports(protocol, port);
    CREATE INDEX IF NOT EXISTS idx_server_extra_ports_server ON server_extra_ports(server_id);
  `);

  const rows = db.prepare("SELECT id, loader, port FROM servers").all();
  const insert = db.prepare("INSERT INTO server_ports(server_id, role, port, protocol) VALUES(?,?,?,?)");
  for (const row of rows) {
    const count = db.prepare("SELECT COUNT(*) AS c FROM server_ports WHERE server_id = ?").get(row.id);
    if (Number(count?.c) > 0) continue;
    const profile = portProfile(row.loader);
    const game = profile.find((p) => p.role === "game") || profile[0];
    const gamePort = isPortNumber(row.port) ? Number(row.port) : game.defaultPort;
    insert.run(row.id, game.role, gamePort, game.protocol);
    for (const desc of profile) {
      if (desc.role === game.role) continue;
      const used = usedPorts(row.id);
      const start = desc.follow === "game" ? gamePort : desc.defaultPort;
      const port = nextFreeFromDb(start, desc.protocol, used);
      if (port) insert.run(row.id, desc.role, port, desc.protocol);
    }
  }
}

// ---------- Lookups ----------

export function getServerPorts(serverId) {
  const rows = db.prepare(
    "SELECT role, port, protocol FROM server_ports WHERE server_id = ? ORDER BY rowid ASC"
  ).all(serverId);
  if (rows.length) {
    return rows.map((r) => ({
      role: r.role,
      port: Number(r.port),
      protocol: protocolOf(r.protocol),
    }));
  }
  const server = db.prepare("SELECT loader, port FROM servers WHERE id = ?").get(serverId);
  if (!server) return [];
  const game = portProfile(server.loader).find((p) => p.role === "game");
  return [{
    role: "game",
    port: isPortNumber(server.port) ? Number(server.port) : game.defaultPort,
    protocol: game.protocol,
  }];
}

/** Extra ports reserved for plugins (Geyser, voice chat, Dynmap, ...). */
export function getServerExtraPorts(serverId) {
  return db.prepare(
    "SELECT id, label, port, protocol FROM server_extra_ports WHERE server_id = ? ORDER BY rowid ASC"
  ).all(serverId).map((r) => ({
    id: r.id,
    label: r.label,
    port: Number(r.port),
    protocol: protocolOf(r.protocol),
  }));
}

/** All reservations held by other servers, keyed by `protocol:port`. */
function usedPorts(excludeServerId = null) {
  const rows = db.prepare(`
    SELECT sp.server_id, sp.role, sp.port, sp.protocol, s.name AS server_name, NULL AS extra_id
    FROM server_ports sp
    LEFT JOIN servers s ON s.id = sp.server_id
    UNION ALL
    SELECT ep.server_id, ep.label AS role, ep.port, ep.protocol, s.name AS server_name, ep.id AS extra_id
    FROM server_extra_ports ep
    LEFT JOIN servers s ON s.id = ep.server_id
  `).all();
  const map = new Map();
  for (const row of rows) {
    if (excludeServerId && row.server_id === excludeServerId) continue;
    map.set(portKey(row.protocol, row.port), {
      serverId: row.server_id,
      serverName: row.server_name,
      role: row.role,
      protocol: protocolOf(row.protocol),
      port: Number(row.port),
      extraId: row.extra_id || null,
    });
  }
  return map;
}

/** Owner of a port/protocol across both loader and extra reservations. */
export function findPortOwner(port, protocol, { excludeExtraId = null, excludeServerId = null } = {}) {
  if (!isPortNumber(port)) return null;
  const proto = protocolOf(protocol);
  const rows = db.prepare(`
    SELECT sp.server_id, sp.role, sp.port, sp.protocol, s.name AS server_name, NULL AS extra_id
    FROM server_ports sp
    LEFT JOIN servers s ON s.id = sp.server_id
    WHERE sp.port = ? AND sp.protocol = ?
    UNION ALL
    SELECT ep.server_id, ep.label AS role, ep.port, ep.protocol, s.name AS server_name, ep.id AS extra_id
    FROM server_extra_ports ep
    LEFT JOIN servers s ON s.id = ep.server_id
    WHERE ep.port = ? AND ep.protocol = ?
  `).all(Number(port), proto, Number(port), proto);
  const row = rows.find((r) =>
    !(excludeExtraId && r.extra_id === excludeExtraId) &&
    !(excludeServerId && r.server_id === excludeServerId)
  );
  if (!row) return null;
  return {
    serverId: row.server_id,
    serverName: row.server_name,
    role: row.role,
    protocol: proto,
    port: Number(row.port),
    extraId: row.extra_id || null,
  };
}

export function insertServerExtraPort({ serverId, label, port, protocol }) {
  const id = randomUUID();
  db.prepare("INSERT INTO server_extra_ports(id, server_id, label, port, protocol) VALUES(?,?,?,?,?)")
    .run(id, serverId, label, Number(port), protocolOf(protocol));
  return { id, label, port: Number(port), protocol: protocolOf(protocol) };
}

export function updateServerExtraPort(serverId, id, { port }) {
  db.prepare("UPDATE server_extra_ports SET port = ? WHERE id = ? AND server_id = ?")
    .run(Number(port), id, serverId);
}

export function deleteServerExtraPort(serverId, id) {
  db.prepare("DELETE FROM server_extra_ports WHERE server_id = ? AND id = ?").run(serverId, id);
}

function nextFreeFromDb(start, protocol, used) {
  for (let i = 0; i < MAX_PORT; i++) {
    let port = Number(start) + i;
    if (port > MAX_PORT) port = FIRST_UNPRIVILEGED + (port - MAX_PORT - 1);
    if (port < MIN_PORT) continue;
    if (!used.has(portKey(protocol, port))) return port;
  }
  return null;
}

// ---------- Transport availability ----------

function canBindTcp(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch {}
      resolve(ok);
    };
    srv.once("error", () => done(false));
    try {
      srv.listen({ port, host: "0.0.0.0", exclusive: true }, () => done(true));
    } catch {
      done(false);
    }
  });
}

function canBindUdp(port, family = 4) {
  return new Promise((resolve) => {
    const type = Number(family) === 6 ? "udp6" : "udp4";
    const address = type === "udp6" ? "::" : "0.0.0.0";
    const sock = dgram.createSocket(type);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      resolve(ok);
    };
    sock.once("error", () => done(false));
    try {
      sock.bind({ port, address, exclusive: true }, () => done(true));
    } catch {
      done(false);
    }
  });
}

/** Whether this process could bind the port right now for the given transport. */
export function isPortBindable(port, protocol = "tcp", family = 4) {
  if (!isPortNumber(port)) return Promise.resolve(false);
  return protocolOf(protocol) === "udp" ? canBindUdp(port, family) : canBindTcp(port);
}

// ---------- Allocation ----------

function normalizeRequest(requested, profile) {
  const out = new Map();
  if (requested == null) return out;
  if (typeof requested === "number" || typeof requested === "string") {
    out.set("game", Number(requested));
    return out;
  }
  if (typeof requested !== "object") return out;
  for (const desc of profile) {
    let value;
    if (desc.role === "game") value = requested.game ?? requested.port;
    else value = requested[desc.role] ?? requested[desc.role.replace(/_/g, "-")];
    if (value !== undefined && value !== null && value !== "") out.set(desc.role, Number(value));
  }
  return out;
}

async function findFreePort({ start, protocol, family, used, taken }) {
  for (let i = 0; i < MAX_PORT; i++) {
    let port = Number(start) + i;
    if (port > MAX_PORT) port = FIRST_UNPRIVILEGED + (port - MAX_PORT - 1);
    if (port < MIN_PORT) continue;
    const key = portKey(protocol, port);
    if (used.has(key) || taken.has(key)) continue;
    if (await isPortBindable(port, protocol, family)) return port;
  }
  throw new PortConflictError(`No free ${protocol.toUpperCase()} port available.`);
}

/**
 * Resolve and reserve the complete port set for a server.
 *
 * Explicitly requested ports that are taken throw PortConflictError instead of
 * being moved. Existing reservations and defaults are moved to the next free
 * port when they collide, so a loader switch or a legacy duplicate can never
 * leave two servers on the same transport/port.
 *
 * @param {object} opts
 * @param {string|null} opts.serverId
 * @param {string} opts.loaderId
 * @param {number|object} [opts.requested]
 * @param {boolean} [opts.checkOs] - probe the OS (skip while the server itself is running)
 */
async function allocateServerPortsUnsafe({ serverId = null, loaderId = "vanilla", requested = null, checkOs = true } = {}) {
  const profile = portProfile(loaderId);
  const wanted = normalizeRequest(requested, profile);
  const existing = serverId ? getServerPorts(serverId) : [];
  const existingByRole = new Map(existing.map((p) => [p.role, p]));
  const used = usedPorts(serverId);
  // The server's own plugin ports still reserve ports for its loader listeners.
  if (serverId) {
    for (const ep of getServerExtraPorts(serverId)) {
      used.set(portKey(ep.protocol, ep.port), {
        serverId, serverName: null, role: ep.label, protocol: ep.protocol, port: ep.port, extraId: ep.id,
      });
    }
  }
  const chosen = new Map();
  const taken = new Set();
  const conflicts = [];

  for (const desc of profile) {
    const explicit = wanted.has(desc.role) ? wanted.get(desc.role) : null;
    if (explicit != null && !isPortNumber(explicit)) {
      throw new PortConflictError(`Port ${explicit} for ${desc.label} must be between 1 and 65535.`, [{
        role: desc.role, label: desc.label, port: explicit, protocol: desc.protocol, reason: "invalid",
      }]);
    }

    const previous = existingByRole.get(desc.role);
    const previousGame = existingByRole.get("game");
    let candidate = explicit;

    if (candidate == null && desc.follow === "game" && previous && previousGame && Number(previous.port) === Number(previousGame.port)) {
      candidate = chosen.get("game")?.port ?? previousGame.port;
    }
    if (candidate == null && previous && previous.protocol === desc.protocol) candidate = previous.port;
    if (candidate == null) candidate = desc.defaultPort;

    let conflict = used.get(portKey(desc.protocol, candidate));
    if (!conflict && taken.has(portKey(desc.protocol, candidate))) {
      conflict = { serverId, serverName: null, role: desc.role, protocol: desc.protocol, port: candidate };
    }

    let bindable = true;
    if (!conflict && checkOs) bindable = await isPortBindable(candidate, desc.protocol, desc.family);

    if (conflict || !bindable) {
      if (explicit != null) {
        conflicts.push({
          role: desc.role,
          label: desc.label,
          port: candidate,
          protocol: desc.protocol,
          reason: conflict ? "server" : "system",
          serverId: conflict?.serverId || null,
          serverName: conflict?.serverName || null,
        });
        continue;
      }
      candidate = await findFreePort({
        start: desc.follow === "game" ? (chosen.get("game")?.port ?? desc.defaultPort) : desc.defaultPort,
        protocol: desc.protocol,
        family: desc.family,
        used,
        taken,
      });
    }

    const entry = {
      role: desc.role,
      label: desc.label,
      port: Number(candidate),
      protocol: desc.protocol,
      required: !!desc.required,
    };
    chosen.set(desc.role, entry);
    taken.add(portKey(desc.protocol, entry.port));
  }

  if (conflicts.length) {
    const first = conflicts[0];
    const owner = first.serverName ? ` (used by "${first.serverName}")` : first.reason === "system" ? " (occupied by another process)" : "";
    const message = `Port ${first.port}/${first.protocol.toUpperCase()} for ${first.label} is already in use${owner}.`;
    throw new PortConflictError(message, conflicts);
  }

  const ports = profile.map((desc) => chosen.get(desc.role)).filter(Boolean);
  return { ports, profile };
}

// Serialize allocations so two concurrent requests cannot reserve the same port
// while the other is still awaiting an OS bind probe.
let allocationQueue = Promise.resolve();

export function allocateServerPorts(opts = {}) {
  const run = allocationQueue.then(
    () => allocateServerPortsUnsafe(opts),
    () => allocateServerPortsUnsafe(opts),
  );
  allocationQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Persist a resolved port set and keep servers.port in sync with the game role. */
export function saveServerPorts(serverId, ports) {
  const list = Array.isArray(ports) ? ports : [];
  const write = db.transaction(() => {
    db.prepare("DELETE FROM server_ports WHERE server_id = ?").run(serverId);
    const insert = db.prepare("INSERT INTO server_ports(server_id, role, port, protocol) VALUES(?,?,?,?)");
    for (const p of list) {
      if (!p || !p.role || !isPortNumber(p.port)) continue;
      insert.run(serverId, p.role, Number(p.port), protocolOf(p.protocol));
    }
    const game = list.find((p) => p.role === "game");
    if (game) db.prepare("UPDATE servers SET port = ? WHERE id = ?").run(Number(game.port), serverId);
  });
  write();
}

/** Resolved ports plus collision and label information for API/UI consumers. */
export function serverPortsStatus(row) {
  if (!row?.id) return [];
  const profile = portProfile(row.loader);
  const labels = new Map(profile.map((p) => [p.role, p]));
  const used = usedPorts(row.id);
  const conflictOf = (port, protocol) => {
    const other = used.get(portKey(protocol, port)) || null;
    return other ? { serverId: other.serverId, serverName: other.serverName, role: other.role } : null;
  };
  const loaderPorts = getServerPorts(row.id).map((p) => {
    const desc = labels.get(p.role) || {};
    return {
      role: p.role,
      label: desc.label || p.role,
      port: p.port,
      protocol: p.protocol,
      required: !!desc.required,
      custom: false,
      conflict: conflictOf(p.port, p.protocol),
    };
  });
  const extras = getServerExtraPorts(row.id).map((e) => ({
    id: e.id,
    role: `extra:${e.id}`,
    label: e.label,
    port: e.port,
    protocol: e.protocol,
    required: true,
    custom: true,
    conflict: conflictOf(e.port, e.protocol),
  }));
  return [...loaderPorts, ...extras];
}

// ---------- Startup checks ----------

function readProperties(dir, file = "server.properties") {
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  try {
    const map = new Map();
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
    }
    return map;
  } catch {
    return null;
  }
}

function readTomlValue(text, section, key) {
  const lines = String(text || "").split(/\r?\n/);
  let current = "";
  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) { current = header[1].trim(); continue; }
    if (current !== section) continue;
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

/** Best-effort: is this optional role actually going to bind its port? */
function optionalRoleEnabled(dir, loaderId, desc) {
  const loader = String(loaderId || "").toLowerCase();
  if (loader === "velocity") {
    if (desc.role === "query") {
      const path = join(dir, "velocity.toml");
      if (!existsSync(path)) return false;
      return /^true$/i.test(readTomlValue(readFileSync(path, "utf8"), "query", "enabled") || "");
    }
    return true;
  }
  if (loader === "pumpkinmc") {
    const path = join(dir, "pumpkin.toml");
    if (!existsSync(path)) return true; // Pumpkin enables Java and Bedrock by default
    const text = readFileSync(path, "utf8");
    const section = desc.role === "bedrock" ? "networking.bedrock" : "networking.java";
    const enabled = readTomlValue(text, section, "enabled");
    return enabled == null ? true : /^true$/i.test(enabled);
  }
  if (desc.enableKey) {
    const props = readProperties(dir);
    return !!props && /^true$/i.test(props.get(desc.enableKey) || "");
  }
  return true;
}

/**
 * Every port that will be bound when this server starts, with conflicts.
 * Required roles are always checked; optional ones only when enabled in config.
 */
export async function checkServerStartupPorts(row, dir) {
  if (!row?.id) return [];
  const profile = portProfile(row.loader);
  const descs = new Map(profile.map((p) => [p.role, p]));
  const used = usedPorts(row.id);
  const out = [];
  for (const p of getServerPorts(row.id)) {
    const desc = descs.get(p.role);
    const required = desc ? !!desc.required : true;
    if (!required && desc && !optionalRoleEnabled(dir, row.loader, desc)) continue;
    const other = used.get(portKey(p.protocol, p.port)) || null;
    let reason = null;
    if (other) reason = "server";
    else if (!(await isPortBindable(p.port, p.protocol, desc?.family))) reason = "system";
    out.push({
      role: p.role,
      label: desc?.label || p.role,
      port: p.port,
      protocol: p.protocol,
      reason,
      serverId: other?.serverId || null,
      serverName: other?.serverName || null,
    });
  }
  // Plugin/extra ports are bound by the same process, so probe them too.
  for (const ep of getServerExtraPorts(row.id)) {
    const other = used.get(portKey(ep.protocol, ep.port)) || null;
    let reason = null;
    if (other) reason = "server";
    else if (!(await isPortBindable(ep.port, ep.protocol, 4))) reason = "system";
    out.push({
      role: `extra:${ep.id}`,
      label: ep.label,
      port: ep.port,
      protocol: ep.protocol,
      reason,
      serverId: other?.serverId || null,
      serverName: other?.serverName || null,
    });
  }
  return out;
}

export function formatPortConflict(conflict) {
  const owner = conflict.serverName ? ` used by "${conflict.serverName}"` : conflict.reason === "system" ? " occupied by another process" : "";
  return `Port ${conflict.port}/${String(conflict.protocol || "tcp").toUpperCase()} (${conflict.label || conflict.role}) is already${owner}.`;
}

// ---------- Config file synchronisation ----------

function setProperty(text, key, value) {
  const lines = String(text || "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines.join("\n") + "\n";
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function setTomlSectionValue(text, section, key, value) {
  const lines = String(text || "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = `[${section}]`;
  let start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    if (lines.length) lines.push("");
    lines.push(header, `${key} = ${value}`);
    return lines.join("\n") + "\n";
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  let target = -1;
  for (let i = start + 1; i < end; i++) {
    if (keyRe.test(lines[i])) { target = i; break; }
  }
  if (target >= 0) lines[target] = `${key} = ${value}`;
  else lines.splice(end, 0, `${key} = ${value}`);
  return lines.join("\n") + "\n";
}

function tomlRootValue(text, key) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

function setTomlRootValue(text, key, value) {
  const lines = String(text || "").split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  const idx = lines.findIndex((l) => keyRe.test(l));
  const line = `${key} = ${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.unshift(line);
  return lines.join("\n") + "\n";
}

function addressHost(value, fallback = "0.0.0.0") {
  const m = String(value || "").match(/^([^:]*):(\d+)$/);
  return m && m[1] ? m[1] : fallback;
}

/**
 * Mirror reserved ports into the loader's own configuration file.
 * The database is the source of truth; this keeps the server itself in sync.
 */
export function applyPortsToConfig({ dir, loaderId, ports }) {
  const loader = String(loaderId || "").toLowerCase();
  const byRole = new Map((ports || []).map((p) => [p.role, Number(p.port)]));
  const warnings = [];
  const files = [];
  try {
    mkdirSync(dir, { recursive: true });

    if (loader === "pumpkinmc") {
      const path = join(dir, "pumpkin.toml");
      let text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const javaPort = byRole.get("game");
      if (javaPort) {
        const current = readTomlValue(text, "networking.java", "address");
        text = setTomlSectionValue(text, "networking.java", "address", tomlString(`${addressHost(current)}:${javaPort}`));
      }
      const bedrockPort = byRole.get("bedrock");
      if (bedrockPort) {
        const current = readTomlValue(text, "networking.bedrock", "address");
        text = setTomlSectionValue(text, "networking.bedrock", "address", tomlString(`${addressHost(current)}:${bedrockPort}`));
      }
      writeFileSync(path, text, "utf8");
      files.push(path);
      return { ok: true, files, warnings };
    }

    if (loader === "velocity") {
      const path = join(dir, "velocity.toml");
      let text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const gamePort = byRole.get("game");
      if (gamePort) {
        const bind = tomlRootValue(text, "bind");
        text = setTomlRootValue(text, "bind", tomlString(`${addressHost(bind)}:${gamePort}`));
      }
      const queryPort = byRole.get("query");
      if (queryPort) text = setTomlSectionValue(text, "query", "port", String(queryPort));
      writeFileSync(path, text, "utf8");
      files.push(path);
      return { ok: true, files, warnings };
    }

    if (loader === "endstone") {
      const path = join(dir, "bedrock_server", "server.properties");
      mkdirSync(dirname(path), { recursive: true });
      let text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const gamePort = byRole.get("game");
      const v6Port = byRole.get("game_v6");
      if (gamePort) text = setProperty(text, "server-port", gamePort);
      if (v6Port) text = setProperty(text, "server-portv6", v6Port);
      writeFileSync(path, text, "utf8");
      files.push(path);
      return { ok: true, files, warnings };
    }

    const path = join(dir, "server.properties");
    let text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (loader === "bedrock") {
      const gamePort = byRole.get("game");
      const v6Port = byRole.get("game_v6");
      if (gamePort) text = setProperty(text, "server-port", gamePort);
      if (v6Port) text = setProperty(text, "server-portv6", v6Port);
    } else {
      const gamePort = byRole.get("game");
      const queryPort = byRole.get("query");
      const rconPort = byRole.get("rcon");
      if (gamePort) text = setProperty(text, "server-port", gamePort);
      if (queryPort) text = setProperty(text, "query.port", queryPort);
      if (rconPort) text = setProperty(text, "rcon.port", rconPort);
    }
    writeFileSync(path, text, "utf8");
    files.push(path);
  } catch (e) {
    warnings.push(`Could not update port configuration: ${e?.message || String(e)}`);
  }
  return { ok: warnings.length === 0, files, warnings };
}
