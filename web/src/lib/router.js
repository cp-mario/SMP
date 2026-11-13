import { writable } from "svelte/store";

/**
 * Tiny hash router.
 *
 * - `router.path` holds the current hash path (e.g. "/server/<id>").
 * - `router.navigate(to)` pushes a new hash.
 * - `router.isActive(view, prefix)` is a convenience for nav highlighting.
 */
function readPath() {
  const hash = typeof location === "undefined" ? "#/" : (location.hash || "#/");
  const clean = hash.replace(/^#/, "");
  return clean.startsWith("/") ? clean : "/";
}

function createRouter() {
  const store = writable(readPath());
  let started = false;

  function start() {
    if (started || typeof window === "undefined") return () => {};
    started = true;
    const onChange = () => store.set(readPath());
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      started = false;
    };
  }

  return {
    subscribe: store.subscribe,
    start,
    get path() { return readPath(); },
    navigate(to) {
      const target = String(to || "/");
      const next = target.startsWith("#") ? target : `#${target.startsWith("/") ? target : "/" + target}`;
      if (typeof location !== "undefined" && location.hash !== next) location.hash = next;
      else store.set(readPath());
    },
    /** True when the current path matches `view` (optionally by prefix). */
    isActive(view, prefix = false) {
      const p = readPath();
      const base = view === "/" ? "/" : `/${String(view).replace(/^\/+/, "")}`;
      return prefix ? (p === base || p.startsWith(base + "/")) : p === base;
    },
  };
}

export const router = createRouter();

/** Navigate to the "create server" flow (handled by App). */
export function requestNewServer() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("smp:new-server"));
}