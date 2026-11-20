import { corsAllowedOrigins } from "./config.js";

/**
 * Per-IP request limiter.
 *
 * The panel is a low-traffic control surface, but every request can touch
 * SQLite, spawn a process query or call an external mod API. Nothing stopped a
 * runaway loop (a buggy client, a script, a port scan) from generating
 * hundreds of requests per second and starving the panel.
 *
 * Design: a sliding window counter per client IP. On every request the IP's
 * timestamps older than the window are dropped, and the request is allowed only
 * while the remaining count is below the limit. This caps the sustained rate to
 * `limit` per `windowMs` while still allowing short bursts (a detail view opens
 * ~10 requests at once, which is a tiny slice of the per-second budget).
 *
 * The default budget is deliberately generous: a single server-detail tab peaks
 * around 2 requests per second (1 s stats poll + 2 s log poll + 5 s status
 * polls), so a normal user with several tabs open stays far below the default of
 * 60/s, while a flood of hundreds per second is rejected within the first second.
 *
 * Tunables (env):
 *   SMP_RATE_LIMIT        max requests allowed per window per IP   (default 60)
 *   SMP_RATE_WINDOW_MS    window length in milliseconds            (default 1000)
 */

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const LIMIT = readPositiveInt("SMP_RATE_LIMIT", 60);
const WINDOW_MS = readPositiveInt("SMP_RATE_WINDOW_MS", 1000);

const MAX_TRACKED_IPS = 50_000;

/** ip -> ascending list of request timestamps (ms) within the current window. */
const buckets = new Map();

function clientIp(request, server) {
  // The socket peer is authoritative: trusting x-forwarded-for directly would
  // let any client spoof its way past the limit. Fall back to the proxy headers
  // only when the socket address is unavailable (unix socket / closed request).
  try {
    const socket = server?.requestIP?.(request);
    if (socket?.address) return socket.address;
  } catch {
    /* ignore and fall through */
  }
  const forwarded = request?.headers?.get?.("x-forwarded-for") || "";
  const first = forwarded.split(",")[0]?.trim();
  if (first) return first;
  return request?.headers?.get?.("x-real-ip")?.trim() || "unknown";
}

function corsHeaders(request) {
  const origin = request?.headers?.get?.("origin");
  if (!origin) return {};
  const allowed = corsAllowedOrigins();
  if (!allowed.includes("*") && !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

/**
 * Elysia `onRequest` hook. Returns a 429 Response when the IP is over budget,
 * or `undefined` to let the request continue.
 */
export function rateLimit(request, server) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const ip = clientIp(request, server);

  let hits = buckets.get(ip);
  if (!hits) {
    // Bound memory: an attacker cannot create unlimited IPs, but a long-lived
    // panel seen by many clients could. Drop the oldest entry once oversized.
    if (buckets.size >= MAX_TRACKED_IPS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    hits = [];
    buckets.set(ip, hits);
  }

  let drop = 0;
  while (drop < hits.length && hits[drop] <= cutoff) drop++;
  if (drop > 0) hits.splice(0, drop);

  if (hits.length >= LIMIT) {
    const retryAfterMs = Math.max(1000, (hits[0] + WINDOW_MS) - now);
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(retryAfterSec),
      "X-RateLimit-Limit": String(LIMIT),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(Math.ceil((hits[0] + WINDOW_MS) / 1000)),
      ...corsHeaders(request),
    };
    const body = JSON.stringify({
      ok: false,
      error: `Too many requests. Retry in ${retryAfterSec}s.`,
    });
    return new Response(body, { status: 429, headers });
  }

  hits.push(now);
  return undefined;
}

// Drop idle IPs so the map does not grow without bound while the panel runs.
const sweep = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, hits] of buckets) {
    let drop = 0;
    while (drop < hits.length && hits[drop] <= cutoff) drop++;
    if (drop > 0) hits.splice(0, drop);
    if (hits.length === 0) buckets.delete(ip);
  }
}, Math.min(WINDOW_MS, 60_000));
sweep.unref?.();

export const rateLimitConfig = Object.freeze({ limit: LIMIT, windowMs: WINDOW_MS });