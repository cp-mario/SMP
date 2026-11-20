import { readdir, stat } from "fs/promises";
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, createWriteStream } from "fs";
import { join, dirname, resolve, basename, posix as pathPosix } from "path";
import { Readable } from "stream";
import { serverFilesDir, serverPath, MIME, TEXT_EXTS, MAX_TEXT_EDIT_BYTES, STREAM_THRESHOLD_BYTES } from "../core/config.js";
import { safeName, attachmentName, rmdirRecursive, zipDirectory, sanitizePath, streamPipeline } from "../core/util.js";
import { getServerRow } from "./servers.js";

async function handleServerFiles(req, serverId, rest, query) {
  if (!getServerRow(serverId)) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  const base = serverFilesDir(serverId);
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  const method = req.method;
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const rel = rest.replace(/^\/+/, "").split("/").map(decode).join("/");
  const actionMatch = rel.match(/^(.*?)(?:\/(content|mkdir|rename|move|compress|extract|download))$/);
  const action = actionMatch ? actionMatch[2] : null;
  const targetRel = actionMatch ? actionMatch[1] : rel;
  const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const err = (msg, status = 400) => new Response(typeof msg === "string" ? msg : JSON.stringify(msg), { status, headers: { "Content-Type": typeof msg === "string" ? "text/plain; charset=utf-8" : "application/json" } });
  // Reject traversal or drive/root segments (the root listing is an empty relative path).
  if (targetRel && targetRel.split("/").some((seg) => seg === ".." || seg === "" || /^[A-Za-z]:/.test(seg))) return err("Forbidden", 403);

  if (method === "GET" && !action) {
    const dir = targetRel ? sanitizePath(base, targetRel) : base;
    if (!dir) return err("Forbidden", 403);
    if (!existsSync(dir)) return j({ files: [] });
    if (!statSync(dir).isDirectory()) return err("Not found", 404);

    // Recursive name search under the requested folder. Bounded by depth, visited
    // entries and matches so a huge world folder cannot stall the panel; the UI
    // gets `truncated` so it can tell the user to narrow the term.
    const searchTerm = String(query?.q ?? "").trim().toLowerCase();
    if (searchTerm) {
      const limit = Math.min(500, Math.max(1, Number(query?.limit) || 200));
      const maxVisited = 40000;
      const maxDepth = 16;
      const found = [];
      let visited = 0;
      let truncated = false;
      const walk = async (absDir, relDir, depth) => {
        if (truncated || depth > maxDepth) return;
        let dirents;
        try { dirents = await readdir(absDir, { withFileTypes: true }); } catch { return; }
        if (dirents.length > 1) dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of dirents) {
          if (truncated) return;
          if (e.isSymbolicLink()) continue;
          if (++visited > maxVisited) { truncated = true; return; }
          const isDir = e.isDirectory();
          const relChild = relDir ? `${relDir}/${e.name}` : e.name;
          if (e.name.toLowerCase().includes(searchTerm)) {
            let size = 0;
            let mtime = 0;
            try {
              const s = await stat(join(absDir, e.name));
              size = isDir ? 0 : s.size;
              mtime = s.mtimeMs;
            } catch { /* unreadable entry: still list it by name */ }
            found.push({ name: e.name, path: relChild, isDirectory: isDir, size, mtime });
            if (found.length >= limit) { truncated = true; return; }
          }
          if (isDir) await walk(join(absDir, e.name), relChild, depth + 1);
        }
      };
      await walk(dir, targetRel || "", 0);
      found.sort((a, b) => (b.isDirectory - a.isDirectory) || a.path.localeCompare(b.path));
      return j({ files: found, path: targetRel || "", query: searchTerm, truncated, visited });
    }

    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = [];
    const chunkSize = 100;
    for (let i = 0; i < dirents.length; i += chunkSize) {
      const batch = dirents.slice(i, i + chunkSize);
      const stats = await Promise.all(batch.map(async (e) => {
        try {
          const s = await stat(join(dir, e.name));
          return { name: e.name, isDirectory: e.isDirectory(), size: e.isDirectory() ? 0 : s.size, mtime: s.mtimeMs };
        } catch {
          return { name: e.name, isDirectory: e.isDirectory(), size: 0, mtime: 0 };
        }
      }));
      entries.push(...stats);
    }
    entries.sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
    return j({ files: entries, path: targetRel || "" });
  }

  const file = targetRel ? sanitizePath(base, targetRel) : base;
  if (!file) return err("Forbidden", 403);

  if (method === "GET" && action === "content") {
    if (!existsSync(file) || statSync(file).isDirectory()) return err("Not found", 404);
    const st = statSync(file);
    const ext = (file.split(".").pop() || "").toLowerCase();
    const isInlineImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(ext);
    const type = isInlineImage ? `image/${ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext}` : (MIME[ext] || "application/octet-stream");
    const headers = { "Content-Type": type, "Cache-Control": "no-store" };
    if (query?.download || !isInlineImage) headers["Content-Disposition"] = attachmentName(file);
    if (!query?.download && TEXT_EXTS.has(ext) && st.size > MAX_TEXT_EDIT_BYTES) {
      return new Response(JSON.stringify({ error: "File is too large to open in the editor (max 10 MB)." }), { status: 413, headers: { "Content-Type": "application/json" } });
    }
    if (st.size > STREAM_THRESHOLD_BYTES) return new Response(Bun.file(file), { headers });
    return new Response(readFileSync(file), { headers });
  }
  if (method === "POST" && action === "content") {
    mkdirSync(dirname(file), { recursive: true });
    const body = await req.text();
    writeFileSync(file, body);
    return j({ ok: true });
  }
  if (method === "POST" && action === "mkdir") {
    mkdirSync(file, { recursive: true }); return j({ ok: true });
  }
  if (method === "POST" && action === "rename") {
    if (!existsSync(file)) return err("Not found", 404);
    const body = await req.json().catch(() => ({}));
    const name = safeName(body?.name);
    if (!name) return err("Invalid name", 400);
    const dst = sanitizePath(base, pathPosix.join(dirname(targetRel), name));
    if (!dst) return err("Forbidden", 403);
    if (existsSync(dst)) return err("Target exists", 409);
    renameSync(file, dst);
    return j({ ok: true, name });
  }
  if (method === "POST" && action === "move") {
    if (!existsSync(file)) return err("Not found", 404);
    const body = await req.json().catch(() => ({}));
    const to = String(body?.to || "").replace(/^\/+/, "");
    const dstDir = sanitizePath(base, to);
    if (!dstDir) return err("Forbidden", 403);
    mkdirSync(dstDir, { recursive: true });
    const dst = sanitizePath(base, pathPosix.join(to, basename(file)));
    if (!dst) return err("Forbidden", 403);
    if (resolve(dst) !== resolve(file)) {
      if (existsSync(dst)) return err("Target exists", 409);
      renameSync(file, dst);
    }
    return j({ ok: true });
  }
  if (method === "POST" && action === "compress") {
    if (!existsSync(file)) return err("Not found", 404);
    const body = await req.json().catch(() => ({}));
    const isDir = statSync(file).isDirectory();
    const outName = safeName(body?.name) || (basename(file) + ".zip");
    if (!outName.toLowerCase().endsWith(".zip")) return err("Archive name must end with .zip", 400);
    const out = sanitizePath(base, pathPosix.join(dirname(targetRel), outName));
    if (!out) return err("Forbidden", 403);
    if (existsSync(out)) return err("Target exists", 409);
    if (isDir) {
      await zipDirectory(file, out);
    } else {
      const Archiver = (await import("archiver")).default;
      await new Promise((res, rej) => {
        const output = createWriteStream(out);
        const archive = Archiver("zip", { zlib: { level: 9 } });
        output.on("close", res); output.on("error", rej); archive.on("error", rej);
        archive.pipe(output); archive.file(file, { name: basename(file) }); archive.finalize();
      });
    }
    return j({ ok: true, file: outName });
  }
  if (method === "POST" && action === "extract") {
    if (!existsSync(file) || statSync(file).isDirectory()) return err("Archive not found", 404);
    if (!file.toLowerCase().endsWith(".zip")) return err("Only .zip extraction is supported", 400);
    const body = await req.json().catch(() => ({}));
    const toRel = body?.to != null ? String(body.to).replace(/^\/+/, "") : dirname(targetRel);
    const dst = sanitizePath(base, toRel);
    if (!dst) return err("Forbidden", 403);
    mkdirSync(dst, { recursive: true });
    const { default: AdmZip } = await import("adm-zip");
    const zip = new AdmZip(file);
    for (const e of zip.getEntries()) { if (!sanitizePath(dst, e.entryName)) return err("Archive contains unsafe paths", 400); }
    zip.extractAllTo(dst, true);
    return j({ ok: true });
  }
  if (method === "GET" && action === "download") {
    if (!existsSync(file)) return err("Not found", 404);
    const headers = { "Content-Disposition": attachmentName(file) };
    if (statSync(file).isDirectory()) {
      const tmp = join(serverPath(serverId), `_dl_${Date.now()}.zip`);
      await zipDirectory(file, tmp);
      const buf = readFileSync(tmp); try { unlinkSync(tmp); } catch {}
      return new Response(buf, { headers: { "Content-Type": "application/zip", "Content-Disposition": attachmentName(basename(file) + ".zip") } });
    }
    const ext = (file.split(".").pop() || "").toLowerCase();
    headers["Content-Type"] = MIME[ext] || "application/octet-stream";
    if (statSync(file).size > STREAM_THRESHOLD_BYTES) return new Response(Bun.file(file), { headers });
    return new Response(readFileSync(file), { headers });
  }
  if (method === "DELETE" && !action) {
    if (!existsSync(file)) return err("Not found", 404);
    if (statSync(file).isDirectory()) rmdirRecursive(file); else unlinkSync(file);
    return j({ ok: true });
  }
  return err("Not found", 404);
}

async function handleServerUpload(req, serverId, query) {
  if (!getServerRow(serverId)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  const base = serverFilesDir(serverId);
  const targetDir = query?.path ? sanitizePath(base, query.path) : base;
  if (!targetDir) return new Response("Forbidden", { status: 403 });
  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return new Response("No file", { status: 400 });
  const name = safeName(file.name);
  if (!name) return new Response("Invalid file name", { status: 400 });
  mkdirSync(targetDir, { recursive: true });
  const filePath = sanitizePath(targetDir, name);
  if (!filePath) return new Response("Forbidden", { status: 403 });
  const out = createWriteStream(filePath);
  await streamPipeline(Readable.fromWeb(file.stream()), out);
  return new Response(JSON.stringify({ ok: true, name }), { headers: { "Content-Type": "application/json" } });
}

export { handleServerFiles, handleServerUpload };
