import { createWriteStream, existsSync, readdirSync, unlinkSync, rmdirSync } from "fs";
import { execFile } from "child_process";
import { pipeline } from "stream";
import { promisify } from "util";
import { join, resolve } from "path";
import { totalmem } from "os";

const streamPipeline = promisify(pipeline);
const execFileAsync = promisify(execFile);

function rmdirRecursive(p) {
  if (!existsSync(p)) return;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const cp = join(p, e.name);
    if (e.isDirectory()) rmdirRecursive(cp); else unlinkSync(cp);
  }
  rmdirSync(p, { recursive: true });
}

function safeName(name) {
  const n = String(name || "").replace(/[\/\\]/g, "").replace(/\.\.+/g, "").trim();
  if (!n || n === "." || n === "..") return null;
  return n;
}

// Content-Disposition filename: keep only a safe basename, RFC 5987-encode the rest.
function attachmentName(name, fallback = "download") {
  const raw = String(name || "").split(/[\\/]/).pop() || fallback;
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(raw);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function zipDirectory(srcDir, outPath) {
  const Archiver = (await import("archiver")).default;
  await new Promise((resolveZip, rejectZip) => {
    const output = createWriteStream(outPath);
    const archive = Archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolveZip(outPath));
    output.on("error", rejectZip);
    archive.on("error", rejectZip);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize().catch(rejectZip);
  });
  return outPath;
}

function parseMemoryMb(v, fallback = 2048) {
  if (v == null || v === "") return fallback;
  const s = String(v).trim().toUpperCase();
  const m = s.match(/^(\d+)\s*(MB|M|GB|G)?$/);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const u = m[2] || "M";
  return (u === "G" || u === "GB") ? n * 1024 : n;
}
function formatMemoryMb(mb) {
  const n = Math.max(256, Math.floor(Number(mb) || 256));
  return n % 1024 === 0 ? `${n / 1024}G` : `${n}M`;
}
function clampMemoryMb(mb) {
  const max = Math.max(256, Math.floor(totalmem() / (1024 * 1024)));
  return Math.min(max, Math.max(256, Math.floor(Number(mb) || 256)));
}
function normalizeJvmArgs(v) {
  if (v == null) return "";
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

function sanitizePath(base, userPath) {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(base, userPath);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + "/") && !resolvedPath.startsWith(resolvedBase + "\\")) {
    return null;
  }
  return resolvedPath;
}

function flagValue(value) {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseExec(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function parseJsonField(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export { streamPipeline, execFileAsync, rmdirRecursive, safeName, attachmentName, zipDirectory, parseMemoryMb, formatMemoryMb, clampMemoryMb, normalizeJvmArgs, sanitizePath, flagValue, formatBytes, parseExec, parseJsonField };
