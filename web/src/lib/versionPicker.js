/**
 * Pure helpers for the "new server" version picker.
 *
 * Keeping this logic out of App.svelte makes it unit-testable and guarantees the same
 * behaviour for Minecraft versions and loader builds.
 *
 * @typedef {{ id: string, stable?: boolean, channel?: string }} VersionEntry
 */

/** @param {any} v */
export function versionId(v) {
  if (typeof v === "string") return v;
  return v?.id || "";
}

/** @param {any} v */
export function isStable(v) {
  if (typeof v === "string") return true;
  return v?.stable !== false && v?.channel !== "experimental";
}

/** @param {any} v */
export function versionChannel(v) {
  return isStable(v) ? "stable" : "experimental";
}

/** @param {any} v */
function channelOf(v) {
  return v?.channel || (v?.stable !== false ? "stable" : "experimental");
}

/**
 * Filter a version/build list by channel and search term.
 * @param {any[]} versions
 * @param {string} channel "all" | "stable" | "experimental"
 * @param {string} search
 */
export function filterByChannel(versions, channel = "all", search = "") {
  const term = String(search || "").trim().toLowerCase();
  return (versions || []).filter((v) => {
    if (channel === "stable" && channelOf(v) !== "stable") return false;
    if (channel === "experimental" && channelOf(v) !== "experimental") return false;
    if (!term) return true;
    return String(versionId(v)).toLowerCase().includes(term);
  });
}

/** Alias used by the version picker component for readability. */
export const filterVersions = filterByChannel;

/**
 * Filter loader builds by channel only (builds have no free-text search).
 * @param {any[]} builds
 * @param {string} channel
 */
export function filterBuilds(builds, channel = "all") {
  if (channel === "all") return builds || [];
  return (builds || []).filter((b) => channelOf(b) === channel);
}

/**
 * Pick the newest entry for `want` ("stable" | "experimental").
 *
 * Prefers the server-provided `latest` metadata, then falls back to scanning the loaded
 * list (some loaders expose no `latest` at all), then to the first entry.
 *
 * @param {any[]} list
 * @param {{ latest?: any } | null} meta
 * @param {string} want
 */
export function pickLatest(list, meta, want = "stable") {
  const items = list || [];
  const key = want === "experimental" ? "experimental" : "stable";
  const direct = meta?.latest?.[key];
  if (direct) return String(direct);
  if (!items.length) return null;
  const match = items.find((v) => (key === "experimental" ? !isStable(v) : isStable(v)));
  return versionId(match) || versionId(items[0]) || null;
}

/**
 * Pick a loader build for `want`, honouring the "reset to All first" rule.
 * @param {any[]} builds
 * @param {{ latest?: any } | null} meta
 * @param {string} want
 */
export function pickLatestBuild(builds, meta, want = "stable") {
  const items = builds || [];
  const key = want === "experimental" ? "experimental" : "stable";
  const latest = meta?.latest || {};
  const direct = latest[key] || latest.default;
  if (direct) return String(direct);
  if (!items.length) return null;
  const match = items.find((b) => (key === "experimental" ? channelOf(b) === "experimental" : channelOf(b) === "stable"));
  return versionId(match) || versionId(items[0]) || null;
}

/**
 * True when `id` is still present in `list` (used to keep a selection across a reload).
 * @param {any[]} list
 * @param {string} id
 */
export function containsVersion(list, id) {
  if (!id) return false;
  return (list || []).some((v) => versionId(v) === id);
}

/**
 * Keep a filter/selection consistent: if the currently selected id is filtered out, move to the
 * first visible entry.
 * @param {any[]} list
 * @param {string} channel
 * @param {string} selected
 */
export function reconcileSelection(list, channel, selected) {
  const visible = filterByChannel(list, channel);
  if (!visible.length) return selected;
  if (containsVersion(visible, selected)) return selected;
  return versionId(visible[0]) || selected;
}