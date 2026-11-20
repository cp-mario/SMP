import { existsSync, statSync, renameSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { serverLogPath } from "./config.js";
import { getLogState, setLogState, clearLogState, getAllLogIds, LOG_LINES_MAX } from "./logStore.js";
import { LOG_FLUSH_MS, LOG_MAX_BYTES, LOG_EVENT_FLUSH_MS } from "./constants.js";

export const logStreams = new Map(); // id -> Set<ReadableStreamDefaultController>

function flushLogs(id) {
  const st = getLogState(id);
  if (st.flushTimer) { clearTimeout(st.flushTimer); st.flushTimer = null; }
  if (!st.pending || st.pending.length === 0) return;
  const text = st.pending.join("\n") + "\n";
  st.pending.length = 0;
  try {
    const logPath = serverLogPath(id);
    if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
      try { renameSync(logPath, logPath + ".1"); } catch {}
    }
    appendFileSync(logPath, text);
  } catch {}
}
function flushAllLogs() {
  for (const id of getAllLogIds()) { try { flushLogs(id); } catch {} }
}
function loadLogsFromDisk(id) {
  const st = getLogState(id);
  if (st.loaded) return st;
  st.loaded = true;
  try {
    const logPath = serverLogPath(id);
    if (existsSync(logPath)) {
      const txt = readFileSync(logPath, "utf8");
      const lines = txt.split(/\r?\n/).filter(l => l.trim());
      const start = Math.max(0, lines.length - LOG_LINES_MAX);
      st.lines = lines.slice(start).map((t, i) => ({ n: start + i, t }));
      st.next = start + st.lines.length;
    }
  } catch {}
  return st;
}
function clearLogs(id) {
  clearLogState(id);
  try { writeFileSync(serverLogPath(id), ""); } catch {}
  const pending = logPending.get(id);
  if (pending?.timer) clearTimeout(pending.timer);
  logPending.delete(id);
  pushLogEvent(id, { clear: true, next: 0 });
}
/**
 * SSE fan-out.
 *
 * A chatty server writes dozens of lines per frame. Enqueuing one event per
 * line means dozens of separate `data:` writes, each with its own TextEncoder
 * encode and stream chunk. Lines are coalesced into one event per tick, and the
 * encoder is reused (it is stateless).
 */
const logEncoders = new Map();
const logPending = new Map(); // id -> { lines: string[], next: number|null, clear?: boolean }

function logEncoder() {
  let enc = logEncoders.get("sse");
  if (!enc) { enc = new TextEncoder(); logEncoders.set("sse", enc); }
  return enc;
}

function pushLogEvent(id, payload) {
  const set = logStreams.get(id);
  if (!set || !set.size) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  let bytes;
  const enc = logEncoder();
  for (const c of [...set]) {
    try { c.enqueue(bytes || (bytes = enc.encode(msg))); } catch { set.delete(c); }
  }
}

/**
 * Push a typed SSE event (e.g. `event: stats`) to all listeners of a server.
 * Unlike plain `data:` messages, typed events use the `event:` field so the
 * client can distinguish stats from log lines on the same EventSource.
 */
function pushTypedEvent(id, eventType, payload) {
  const set = logStreams.get(id);
  if (!set || !set.size) return;
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  let bytes;
  const enc = logEncoder();
  for (const c of [...set]) {
    try { c.enqueue(bytes || (bytes = enc.encode(msg))); } catch { set.delete(c); }
  }
}

function flushLogEvents(id) {
  const pending = logPending.get(id);
  if (!pending) return;
  logPending.delete(id);
  if (pending.clear) { pushLogEvent(id, { clear: true, next: pending.next ?? 0 }); return; }
  if (!pending.lines.length) return;
  pushLogEvent(id, { lines: pending.lines, next: pending.next });
}

function queueLogLines(id, lines, next) {
  if (!lines.length) return;
  let pending = logPending.get(id);
  if (!pending) { pending = { lines: [], next }; logPending.set(id, pending); }
  pending.lines.push(...lines);
  if (Number.isFinite(next)) pending.next = next;
  if (!pending.timer) {
    pending.timer = setTimeout(() => {
      const current = logPending.get(id);
      if (current) current.timer = null;
      flushLogEvents(id);
    }, LOG_EVENT_FLUSH_MS);
    pending.timer.unref?.();
  }
}

function logLine(id, text) {
  const st = getLogState(id);
  const raw = String(text ?? "").replace(/\r?\n$/, "");
  if (raw === "") return;
  const entry = { n: st.next++, t: `[${new Date().toISOString()}] ${raw}` };
  st.lines.push(entry);
  if (st.lines.length > LOG_LINES_MAX) st.lines.splice(0, st.lines.length - LOG_LINES_MAX);
  st.pending.push(entry.t);
  if (st.pending.length >= 500) flushLogs(id);
  else if (!st.flushTimer) st.flushTimer = setTimeout(() => { st.flushTimer = null; flushLogs(id); }, LOG_FLUSH_MS);
  // Coalesced: the client applies an array of lines per event instead of one
  // event per line, so a burst costs one JSON encode and one stream write.
  const set = logStreams.get(id);
  if (set && set.size) queueLogLines(id, [entry.t], entry.n + 1);
}
process.on("exit", flushAllLogs);
function getLogs(id, after, limit) {
  const st = loadLogsFromDisk(id);
  const a = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : null;
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  if (a != null) {
    const firstN = st.lines.length ? st.lines[0].n : st.next;
    if (a > st.next) return { lines: [], next: st.next, full: false };
    const from = a <= firstN ? 0 : a - firstN;
    let list = st.lines.slice(from).map(x => x.t);
    if (lim) list = list.slice(-lim);
    return { lines: list, next: st.next, full: false };
  }
  let list = st.lines.map(x => x.t);
  if (lim) list = list.slice(-lim);
  return { lines: list, next: st.next, full: true };
}

export { getLogState, flushLogs, flushAllLogs, loadLogsFromDisk, clearLogs, logEncoder, pushLogEvent, pushTypedEvent, flushLogEvents, queueLogLines, logLine, getLogs };
