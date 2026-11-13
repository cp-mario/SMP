import { createHash } from "crypto";
import { createReadStream, readFileSync } from "fs";
import { fetchWithTimeout } from "../loaders/BaseLoader.js";

export class StoreError extends Error {
  constructor(message, { status = 0, code = "", data = null } = {}) {
    super(message);
    this.name = "StoreError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const JSON_HEADERS = { Accept: "application/json" };
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function withUserAgent(headers = {}) {
  return { "User-Agent": BROWSER_UA, ...headers };
}

export async function getJsonWithMeta(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const res = await fetchWithTimeout(url, { headers: withUserAgent({ ...JSON_HEADERS, ...headers }), timeoutMs });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      detail = body.slice(0, 300);
    } catch { /* ignore */ }
    throw new StoreError(`HTTP ${res.status} for ${url}${detail ? `: ${detail}` : ""}`, { status: res.status });
  }
  return { data: await res.json(), headers: res.headers };
}

export async function getJson(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const { data } = await getJsonWithMeta(url, { headers, timeoutMs });
  return data;
}

export async function getText(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const res = await fetchWithTimeout(url, { headers: withUserAgent(headers), timeoutMs });
  if (!res.ok) throw new StoreError(`HTTP ${res.status} for ${url}`, { status: res.status });
  return res.text();
}

export async function postJson(url, body, { headers = {}, timeoutMs = 30000 } = {}) {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: withUserAgent({ ...JSON_HEADERS, "Content-Type": "application/json", ...headers }),
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new StoreError(`HTTP ${res.status} for ${url}${detail ? `: ${detail}` : ""}`, { status: res.status });
  }
  return res.json();
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

export function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const n = value > 1e12 ? value : value * 1000;
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

export function htmlToText(html) {
  let text = String(html || "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export function shortHash(hash, size = 10) {
  const s = String(hash || "");
  if (!s) return "";
  return s.length > size * 2 ? `${s.slice(0, size)}…${s.slice(-size)}` : s;
}

export function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha1");
    const s = createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * CurseForge fingerprints are murmur2 (seed 1) over the file bytes with
 * whitespace bytes removed. The result is an unsigned 32-bit integer.
 */
export function fingerprintFile(filePath) {
  return fingerprintFileFromBytes(readFileSync(filePath));
}

export function fingerprintBuffer(buffer) {
  return fingerprintFileFromBytes(buffer);
}

function fingerprintFileFromBytes(data) {
  const whitespace = new Set([9, 10, 13, 32]);
  const filtered = [];
  for (let i = 0; i < data.length; i++) {
    if (!whitespace.has(data[i])) filtered.push(data[i]);
  }
  const multiplex = 1540483477;
  const filteredLength = filtered.length;
  let fingerprint = (1 ^ filteredLength) >>> 0;
  let chunkFingerprint = 0;
  let chunkAcc = 0;
  for (let i = 0; i < filteredLength; i++) {
    chunkFingerprint |= filtered[i] << chunkAcc;
    chunkAcc += 8;
    if (chunkAcc === 32) {
      const num6 = Math.imul(chunkFingerprint, multiplex);
      const num7 = Math.imul(num6 ^ (num6 >>> 24), multiplex);
      fingerprint = (Math.imul(fingerprint, multiplex) ^ num7) >>> 0;
      chunkFingerprint = 0;
      chunkAcc = 0;
    }
  }
  if (chunkAcc > 0) {
    fingerprint = Math.imul(fingerprint ^ chunkFingerprint, multiplex) >>> 0;
  }
  const num6 = Math.imul(fingerprint ^ (fingerprint >>> 13), multiplex);
  return (num6 ^ (num6 >>> 15)) >>> 0;
}

export function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha512");
    const s = createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export function compareVersionLike(a, b) {
  const pa = String(a || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? -1;
    const db = pb[i] ?? -1;
    if (da !== db) return da - db;
  }
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
}

function versionParts(value) {
  const base = String(value || "").trim().toLowerCase().split(/[-+ ]/)[0];
  return base.split(/[^0-9]+/).filter(Boolean).map(Number);
}

function compareVersionPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Minecraft versions are reported with different levels of precision by stores:
 * Spigot only lists coarse versions ("1.21"), Hangar/CurseForge list exact ones
 * ("1.21.1"), and some use ranges. Match those instead of requiring an exact string.
 */
export function gameVersionMatches(value, wanted) {
  if (!wanted) return true;
  const have = String(value || "").trim().toLowerCase();
  const want = String(wanted || "").trim().toLowerCase();
  if (!have) return true;
  if (have === want) return true;

  const range = have.match(/^(\d+(?:\.\d+)*)\s*-\s*(\d+(?:\.\d+)*)$/);
  if (range) {
    return compareVersionPrefix(versionParts(want), versionParts(range[1])) >= 0
      && compareVersionPrefix(versionParts(want), versionParts(range[2])) <= 0;
  }

  const hp = versionParts(have);
  const wp = versionParts(want);
  if (!hp.length || !wp.length) return false;
  const n = Math.min(hp.length, wp.length);
  for (let i = 0; i < n; i++) {
    if (hp[i] !== wp[i]) return false;
  }
  return true;
}

export function anyGameVersionMatches(versions, wanted) {
  if (!wanted) return true;
  const list = asArray(versions);
  if (!list.length) return true;
  return list.some((v) => gameVersionMatches(v, wanted));
}