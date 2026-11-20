/**
 * Periodic stats push over the SSE log stream.
 *
 * Instead of the client polling `/api/servers/:id/stats` every second, the
 * server computes stats and pushes them as a typed SSE event (`event: stats`)
 * on the same connection that delivers log lines. One connection replaces two.
 *
 * Each SSE stream registers a stats timer when opened and removes it when
 * closed. The timer is shared per server — multiple tabs share one timer.
 */

import { parseMemoryMb } from "./util.js";
import { query } from "./db.js";
import { isRunning, runningServers, readProcessUsage, procUsageSamples } from "../instances/process.js";
import { pushTypedEvent } from "./logs.js";

/** How often stats are pushed over SSE (ms). */
const STATS_INTERVAL_MS = 1000;

/** id -> { timer, lastSample: { cpuSeconds, t } } — per-server stats state. */
const statsState = new Map();

/** Number of active SSE streams listening for stats per server. */
const statsListeners = new Map(); // id -> count

/**
 * Increment the listener count for a server. When it goes from 0 → 1 the
 * periodic stats timer is started.
 */
function addListener(id) {
  const count = (statsListeners.get(id) || 0) + 1;
  statsListeners.set(id, count);
  if (count === 1) startStatsTimer(id);
}

/**
 * Decrement the listener count. When it reaches 0 the timer is stopped.
 */
function removeListener(id) {
  const count = (statsListeners.get(id) || 1) - 1;
  if (count <= 0) {
    statsListeners.delete(id);
    stopStatsTimer(id);
  } else {
    statsListeners.set(id, count);
  }
}

function startStatsTimer(id) {
  stopStatsTimer(id);
  const state = { timer: null, lastSample: null };
  state.timer = setInterval(() => pushStatsFor(id), STATS_INTERVAL_MS);
  state.timer.unref?.();
  // Push an initial sample immediately so the client doesn't wait 1 s.
  pushStatsFor(id);
  statsState.set(id, state);
}

function stopStatsTimer(id) {
  const state = statsState.get(id);
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  statsState.delete(id);
}

/**
 * Compute stats for one server and push as a typed SSE event.
 */
async function pushStatsFor(id) {
  const row = findServerRow(id);
  if (!row) return;
  const memoryMaxBytes = parseMemoryMb(row.memory_max, 2048) * 1024 * 1024;
  const online = isRunning(id);
  const pid = online ? (runningServers.get(id)?.proc?.pid || row.pid || null) : null;

  if (!online || !pid) {
    procUsageSamples.delete(row.pid);
    pushTypedEvent(id, "stats", {
      id,
      online: false,
      pid: null,
      cpuPercent: 0,
      memoryBytes: 0,
      memoryMaxBytes,
      timestamp: Date.now(),
    });
    return;
  }

  const sample = await readProcessUsage(pid);
  if (!sample) {
    pushTypedEvent(id, "stats", {
      id,
      online: true,
      pid,
      cpuPercent: 0,
      memoryBytes: 0,
      memoryMaxBytes,
      error: "Process stats unavailable",
      timestamp: Date.now(),
    });
    return;
  }

  const now = Date.now();
  const prev = procUsageSamples.get(pid);
  let cpuPercent = 0;
  if (prev && now > prev.t && sample.cpuSeconds >= prev.cpuSeconds) {
    cpuPercent = ((sample.cpuSeconds - prev.cpuSeconds) / ((now - prev.t) / 1000)) * 100;
  }
  procUsageSamples.set(pid, { cpuSeconds: sample.cpuSeconds, t: now });

  pushTypedEvent(id, "stats", {
    id,
    online: true,
    pid,
    cpuPercent: Math.max(0, Math.round(cpuPercent * 10) / 10),
    memoryBytes: sample.memoryBytes,
    memoryMaxBytes,
    timestamp: now,
  });
}

/** Look up a server row by id without using the cache helper. */
function findServerRow(id) {
  const rows = query("SELECT id, memory_max FROM servers WHERE id = ?", [id]);
  return rows[0] || null;
}

export { addListener, removeListener };
