/**
 * Tiny TTL + in-flight cache.
 *
 * Every store/loader/version list ends up behind one of these. Two properties
 * matter for a panel that polls every few seconds:
 *
 *   - in-flight dedupe: ten concurrent requests share one call instead of
 *     starting ten (the old code had a "cache miss stampede" on /api/servers
 *     while a loader list was still loading).
 *   - stale-while-error: a failed refresh keeps serving the last good value
 *     instead of turning a brief network hiccup into empty UI.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createTtlCache({ ttlMs = DEFAULT_TTL_MS, maxEntries = 128, name = "cache" } = {}) {
  const entries = new Map();
  const inflight = new Map();

  function get(key) {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  function set(key, value, ttl = ttlMs) {
    if (entries.size >= maxEntries && !entries.has(key)) {
      // Drop the oldest insertion; Map preserves insertion order.
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(key, { value, expiresAt: Date.now() + Math.max(1, ttl) });
    return value;
  }

  function invalidate(key) {
    if (key === undefined) {
      entries.clear();
      inflight.clear();
      return;
    }
    entries.delete(key);
    inflight.delete(key);
  }

  /** Drops every key that starts with `prefix` (per-loader build lists). */
  function deleteMatching(prefix) {
    for (const key of [...entries.keys()]) {
      if (String(key).startsWith(prefix)) entries.delete(key);
    }
    for (const key of [...inflight.keys()]) {
      if (String(key).startsWith(prefix)) inflight.delete(key);
    }
  }

  /**
   * `loader` runs at most once per key while a request is pending. A rejection
   * falls back to the previous value when one exists.
   */
  async function wrap(key, loader, { ttl = ttlMs } = {}) {
    const hit = get(key);
    if (hit !== undefined) return hit;

    const pending = inflight.get(key);
    if (pending) return await pending;

    const run = (async () => {
      try {
        return set(key, await loader(), ttl);
      } catch (e) {
        // Serve the previous value past its expiry rather than an empty state.
        const stale = entries.get(key)?.value;
        if (stale === undefined) throw e;
        return stale;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, run);
    return await run;
  }

  function stats() {
    return { entries: entries.size, inflight: inflight.size, name };
  }

  return { get, set, invalidate, deleteMatching, wrap, stats, ttlMs };
}

/** One shared cache for loader version lists, keyed by loader id. */
export const loaderVersionsCache = createTtlCache({ name: "loader-versions" });

/** One shared cache for loader build lists, keyed by `loader:mcVersion`. */
export const loaderBuildsCache = createTtlCache({ name: "loader-builds" });