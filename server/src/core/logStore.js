/**
 * In-memory log store per server.
 *
 * Replaces `globalThis.__smp_logs` with an explicit module-level Map so tests
 * and other modules can reason about log state without reaching into globals.
 */

import { LOG_LINES_MAX } from "./constants.js";

const logStore = new Map(); // id -> { lines: Array, next: number, loaded: boolean, pending: Array, flushTimer: null|Timer }

function getLogState(id) {
  let st = logStore.get(id);
  if (!st) {
    st = { lines: [], next: 0, loaded: false, pending: [], flushTimer: null };
    logStore.set(id, st);
  }
  if (!st.pending) st.pending = [];
  return st;
}

function setLogState(id, state) {
  const old = logStore.get(id);
  if (old?.flushTimer) clearTimeout(old.flushTimer);
  logStore.set(id, state);
}

function clearLogState(id) {
  const old = logStore.get(id);
  if (old?.flushTimer) clearTimeout(old.flushTimer);
  logStore.set(id, { lines: [], next: 0, loaded: true, pending: [], flushTimer: null });
}

function getAllLogIds() {
  return [...logStore.keys()];
}

function getLinesCount(id) {
  return logStore.get(id)?.lines.length ?? 0;
}

export { logStore, getLogState, setLogState, clearLogState, getAllLogIds, getLinesCount, LOG_LINES_MAX };
