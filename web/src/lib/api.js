const API = "/api";
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRYABLE = new Set([408, 425, 429, 502, 503, 504]);

export class ApiError extends Error {
  constructor(message, { status = 0, data = null, url = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.url = url;
  }
}

function isNetworkError(e) {
  if (!e) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  const msg = String(e.message || "").toLowerCase();
  return msg.includes("network") || msg.includes("failed to fetch") || msg.includes("fetch failed") || msg.includes("econn") || msg.includes("enotfound");
}

async function rawFetch(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * JSON-first API client with timeout, bounded retries and typed errors.
 * Non-2xx responses throw `ApiError` with `status`, `data` and `url` attached.
 */
export async function api(path, opts = {}) {
  const { retries = MAX_RETRIES, timeout = DEFAULT_TIMEOUT, raw = false, ...fetchOpts } = opts;
  const requestInit = /** @type {RequestInit & { headers?: Record<string, string> }} */ ({ ...fetchOpts });
  const requestHeaders = { Accept: "application/json", ...(requestInit.headers || {}) };
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const hasBody = requestInit.body != null && !(typeof FormData !== "undefined" && requestInit.body instanceof FormData);
      if (hasBody && !requestHeaders["Content-Type"]) requestHeaders["Content-Type"] = "application/json";
      const res = await rawFetch(`${API}${path}`, { ...requestInit, headers: requestHeaders }, timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        const message = (data && (data.error || data.message || data.errors)) || text || `API ${res.status}`;
        const err = new ApiError(Array.isArray(message) ? message.join(", ") : String(message), { status: res.status, data, url: path });
        const retryable = attempt < retries && (RETRYABLE.has(res.status) || res.status >= 500);
        if (retryable) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          lastError = err;
          continue;
        }
        throw err;
      }

      if (raw) return res;
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) return res.json();
      return res.text();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      lastError = e;
      const retryable = attempt < retries && isNetworkError(e);
      if (retryable) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      throw new ApiError(e?.message || String(e), { status: 0, url: path });
    }
  }
  throw lastError instanceof ApiError ? lastError : new ApiError(String(lastError), { url: path });
}

/** Small typed helpers for the handful of non-JSON endpoints. */
export function apiUrl(path) { return `${API}${path}`; }

export async function apiUpload(path, formData, { timeout = 120000 } = {}) {
  const res = await rawFetch(`${API}${path}`, { method: "POST", body: formData }, timeout);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    throw new ApiError((data && (data.error || data.message)) || text || `Upload failed (${res.status})`, { status: res.status, data, url: path });
  }
  return res.json().catch(() => ({}));
}

export function apiDownloadUrl(path) { return `${API}${path}`; }