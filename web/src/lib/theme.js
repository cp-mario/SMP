/**
 * Accent colour handling.
 *
 * The CSS derives every accent shade from `--accent` (see app.css), so applying a
 * colour is a single custom-property write. Keeping the persistence and the
 * `<meta name="theme-color">` sync here means the first paint can reuse the same
 * value (main.js / index.html) instead of flashing the default purple.
 */
export const DEFAULT_ACCENT = "#9255E8";
const STORAGE_KEY = "smp.accent";

/** @param {string} value */
export function normalizeAccent(value) {
  const raw = String(value || "").trim();
  const short = raw.match(/^#([0-9a-f]{3})$/i);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const long = raw.match(/^#([0-9a-f]{6})$/i);
  if (long) return `#${long[1]}`.toUpperCase();
  return "";
}

/**
 * Apply an accent colour to the document.
 * @param {string} color
 * @param {{ persist?: boolean }} [options]
 * @returns {string} the normalised colour actually applied
 */
export function applyAccent(color, { persist = true } = {}) {
  if (typeof document === "undefined") return normalizeAccent(color) || DEFAULT_ACCENT;
  const hex = normalizeAccent(color) || DEFAULT_ACCENT;
  const root = document.documentElement;
  root.style.setProperty("--accent", hex);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", hex);
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, hex); } catch { /* storage may be unavailable */ }
  }
  return hex;
}

/** Read the persisted accent (if any) without applying it. */
export function readStoredAccent() {
  try { return normalizeAccent(localStorage.getItem(STORAGE_KEY) || ""); } catch { return ""; }
}

/** Read the persisted accent (if any) and apply it before the app mounts. */
export function applyStoredAccent() {
  const saved = readStoredAccent();
  return applyAccent(saved || DEFAULT_ACCENT, { persist: false });
}