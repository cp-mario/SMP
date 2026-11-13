import { writable } from "svelte/store";

/**
 * Global toast notifications.
 * Usage: `toasts.success("Saved")`, `toasts.error("Failed", err)`, `toasts.dismiss(id)`.
 */
const DEFAULT_DURATION = 4200;

function createToasts() {
  const { subscribe, update } = writable([]);
  let seq = 0;
  const timers = new Map();

  function dismiss(id) {
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
    update((list) => list.filter((x) => x.id !== id));
  }

  function push(message, type = "info", ms = DEFAULT_DURATION) {
    const id = ++seq;
    const text = String(message ?? "").trim();
    if (!text) return id;
    update((list) => [...list.slice(-4), { id, message: text, type }]);
    if (ms > 0) timers.set(id, setTimeout(() => dismiss(id), ms));
    return id;
  }

  return {
    subscribe,
    dismiss,
    show: (message, type = "info", ms) => push(message, type, ms),
    info: (m, ms) => push(m, "info", ms),
    success: (m, ms) => push(m, "success", ms),
    warning: (m, ms) => push(m, "warning", ms),
    error: (m, err) => push(err ? `${m}: ${err?.message || err}` : m, "error", 6000),
  };
}

export const toasts = createToasts();