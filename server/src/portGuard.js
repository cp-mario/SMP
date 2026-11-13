import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Strict port guard.
 *
 * A plugin runs inside the server process, so the panel cannot intercept its
 * bind() call. What it can do is inspect the process's listening sockets and
 * stop the server as soon as an unreserved port appears. This is enforcement,
 * not prevention: the bind succeeds briefly, then the process is stopped and
 * the port is written to the server log.
 *
 * Only listening sockets are considered:
 *   - TCP: state LISTENING / LISTEN.
 *   - UDP: bound, unconnected sockets. Connected UDP sockets (DNS, etc.) are
 *     ignored so normal outbound traffic does not trigger false positives.
 */

function portFromAddress(value) {
  const m = String(value || "").trim().match(/:(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Parse `netstat -ano` output for a PID (Windows). */
export function parseWindowsNetstat(text, pid) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const proto = cols[0].toLowerCase();
    if (proto !== "tcp" && proto !== "udp" && proto !== "tcpv6" && proto !== "udpv6") continue;
    if (Number(cols[cols.length - 1]) !== Number(pid)) continue;
    if (proto.startsWith("tcp") && String(cols[3]).toUpperCase() !== "LISTENING") continue;
    if (proto.startsWith("udp") && String(cols[2]) !== "*:*") continue;
    const port = portFromAddress(cols[1]);
    if (port) out.push({ port, protocol: proto.startsWith("tcp") ? "tcp" : "udp" });
  }
  return out;
}

/** Parse `ss -lntupH` output for a PID (Linux). */
export function parseSsOutput(text, pid) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pidMatch = line.match(/pid=(\d+)/);
    if (!pidMatch || Number(pidMatch[1]) !== Number(pid)) continue;
    const cols = line.trim().split(/\s+/);
    const proto = cols[0].toLowerCase();
    if (proto !== "tcp" && proto !== "udp") continue;
    const local = cols.slice(3, 6).find((t) => /:(\d+)$/.test(t));
    const port = portFromAddress(local);
    if (port) out.push({ port, protocol: proto });
  }
  return out;
}

/** Parse `lsof -nP -a -p PID -iTCP|-iUDP` output (Linux/macOS fallback). */
export function parseLsofOutput(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const idx = cols.findIndex((c) => c === "TCP" || c === "UDP");
    if (idx < 0) continue;
    const port = portFromAddress(cols[idx + 1]);
    if (port) out.push({ port, protocol: cols[idx].toLowerCase() });
  }
  return out;
}

async function lsofPorts(pid) {
  const base = ["-nP", "-a", "-p", String(pid)];
  const [tcp, udp] = await Promise.all([
    execFileAsync("lsof", [...base, "-iTCP", "-sTCP:LISTEN"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }),
    execFileAsync("lsof", [...base, "-iUDP"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }),
  ]);
  return [...parseLsofOutput(tcp.stdout), ...parseLsofOutput(udp.stdout)];
}

/**
 * Listening sockets for a PID, deduplicated by protocol+port.
 * Returns null when the OS tooling failed (so callers can distinguish that
 * from a process that simply has no listeners yet).
 */
export async function listListeningPorts(pid) {
  if (!pid) return null;
  try {
    let ports;
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano"], {
        windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024,
      });
      ports = parseWindowsNetstat(stdout, pid);
    } else if (process.platform === "linux") {
      try {
        const { stdout } = await execFileAsync("ss", ["-lntupH"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
        ports = parseSsOutput(stdout, pid);
      } catch {
        ports = await lsofPorts(pid);
      }
    } else {
      ports = await lsofPorts(pid);
    }
    const unique = new Map();
    for (const p of ports) unique.set(`${p.protocol}:${p.port}`, p);
    return [...unique.values()];
  } catch {
    return null;
  }
}

const guards = new Map();

export function stopPortGuard(id) {
  const guard = guards.get(id);
  if (guard) {
    guard.cancel();
    guards.delete(id);
  }
}

/**
 * Watch a running server until it exits or opens an unreserved port.
 * `allowed` contains `protocol:port` strings (loader roles + extra ports).
 */
export function startPortGuard({
  id,
  pid,
  allowed,
  log = () => {},
  stop = async () => {},
  initialDelayMs = Number(process.env.SMP_PORT_GUARD_DELAY_MS) || 15000,
  intervalMs = Number(process.env.SMP_PORT_GUARD_INTERVAL_MS) || 10000,
} = {}) {
  stopPortGuard(id);
  const allowedKeys = new Set(
    [...allowed].map((key) => {
      const [protocol, port] = String(key).split(":");
      return `${String(protocol).toLowerCase()}:${Number(port)}`;
    }),
  );
  let stopped = false;
  let warned = false;
  let timer = null;

  const check = async () => {
    if (stopped) return;
    const ports = await listListeningPorts(pid);
    if (ports == null) {
      if (!warned) {
        warned = true;
        log("[ports] Strict mode: could not inspect this server's listening ports on this system.");
      }
      return;
    }
    const bad = ports.find((p) => !allowedKeys.has(`${p.protocol}:${Number(p.port)}`));
    if (!bad) return;
    stopped = true;
    if (timer) clearInterval(timer);
    guards.delete(id);
    log(`[ports] Strict mode: ${bad.port}/${bad.protocol.toUpperCase()} is not reserved for this server. Add it under Plugin / extra ports. Stopping the server.`);
    try { await stop(); } catch {}
  };

  const delay = setTimeout(() => {
    if (stopped) return;
    check();
    timer = setInterval(check, intervalMs);
    timer.unref?.();
  }, initialDelayMs);
  delay.unref?.();

  const guard = {
    cancel() {
      stopped = true;
      clearTimeout(delay);
      if (timer) clearInterval(timer);
    },
  };
  guards.set(id, guard);
  return guard;
}
