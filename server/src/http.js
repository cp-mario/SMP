import { gzipSync } from "bun:zlib";
import { createHash } from "crypto";
import { statSync } from "fs";

/**
 * HTTP response helpers for the API.
 *
 * Two costs dominated the panel's steady-state request mix:
 *
 *   - JSON payloads were sent uncompressed on every poll. `gzip` cuts the
 *     dashboard list and server detail by ~70-85% (they are very repetitive).
 *   - Polls always got a full 200. A strong ETag turns an unchanged poll into
 *     a header-only 304, so the client does no transfer and no JSON parsing.
 */

const MIN_GZIP_BYTES = 1024;

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest|wasm)|image\/svg\+xml)/i;

/** Best-effort response compression; leaves streaming/binary bodies alone. */
export async function compressResponse(request, response) {
  if (!(response instanceof Response)) return response;
  if (response.headers.get("Content-Encoding")) return response;
  if (response.body == null) return response;

  const type = response.headers.get("Content-Type") || "";
  if (!COMPRESSIBLE.test(type)) return response;
  if (!acceptsGzip(request)) return response;

  const len = Number(response.headers.get("Content-Length") || 0);
  if (len && len < MIN_GZIP_BYTES) return response;

  // Streaming bodies (SSE, downloads) must pass through untouched.
  if (response.body instanceof ReadableStream && !response.headers.get("Content-Length")) {
    return response;
  }

  try {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length < MIN_GZIP_BYTES) return response;
    const compressed = gzipSync(buf);
    if (compressed.length >= buf.length) return response;

    const headers = new Headers(response.headers);
    headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(compressed.length));
    headers.set("Vary", "Accept-Encoding");
    return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}

export function acceptsGzip(request) {
  const header = request?.headers?.get?.("accept-encoding") || "";
  return /\bgzip\b/i.test(header);
}

/**
 * Static file response with a strong ETag (size+mtime, so it costs no read on
 * a revalidation) and header-only 304s.
 *
 * Hashed asset filenames are cached immutably by the browser, but the HTML
 * shell and the favicon are revalidated on every load; without this they were
 * a full body transfer each time.
 */
export function fileResponse(request, filePath, contentType, cacheControl) {
  let size = 0;
  let mtimeMs = 0;
  try {
    const st = statSync(filePath);
    size = st.size;
    mtimeMs = Math.floor(st.mtimeMs);
  } catch { /* fall through: Bun.file will 404 */ }

  const etag = size || mtimeMs ? `"${size.toString(16)}-${mtimeMs.toString(16)}"` : null;
  const headers = { "Content-Type": contentType, "Cache-Control": cacheControl };
  if (etag) headers.ETag = etag;

  if (etag && isNotModified(request, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(Bun.file(filePath), { headers });
}

/** Strong ETag over a JSON-serialisable payload. */
export function etagFor(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${createHash("sha1").update(text).digest("base64").slice(0, 22)}"`;
}

/** True when the client already holds this representation. */
export function isNotModified(request, etag) {
  if (!etag) return false;
  const header = request?.headers?.get?.("if-none-match");
  if (!header) return false;
  return header.split(",").some((candidate) => candidate.trim() === etag || candidate.trim() === "*");
}

/**
 * JSON response with a strong ETag and a header-only 304 on revalidation.
 *
 * `extraHeaders` still wins, so a route can add Cache-Control without losing
 * the validator.
 */
export function jsonResponse(request, value, { status = 200, etag = true, extraHeaders = null } = {}) {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...(extraHeaders || {}) };
  const tag = etag ? etagFor(value) : null;
  if (tag) headers.ETag = tag;

  if (tag && isNotModified(request, tag)) {
    return new Response(null, { status: 304, headers });
  }

  const body = JSON.stringify(value);
  headers["Content-Length"] = String(Buffer.byteLength(body));
  return new Response(body, { status, headers });
}