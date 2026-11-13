import ssh2 from "ssh2";
import { generateKeyPairSync } from "crypto";
import bcrypt from "bcryptjs";
import {
  readdirSync, statSync, existsSync, readFileSync, writeFileSync,
  mkdirSync, unlinkSync, renameSync, openSync, readSync, writeSync, closeSync, fstatSync, rmdirSync
} from "fs";
import { join, resolve, dirname, posix, sep } from "path";
import { homedir } from "os";
import { db, getSetting, setSetting } from "./db.js";

const { Server } = ssh2;
// ssh2 v1 SFTP constants live under utils.sftp / protocol in some builds; use numeric fallbacks.
const STATUS = (ssh2.utils && ssh2.utils.sftp && ssh2.utils.sftp.STATUS_CODE) || { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5 };
const OPEN = (ssh2.utils && ssh2.utils.sftp && ssh2.utils.sftp.OPEN_MODE) || { READ: 0x00000001, WRITE: 0x00000002, APPEND: 0x00000004, CREAT: 0x00000008, TRUNC: 0x00000010 };

const DATA_DIR = process.env.SMP_DATA_DIR || join(homedir(), ".smp");
const SERVERS_DIR = join(DATA_DIR, "servers");
const KEY_PATH = join(DATA_DIR, "sftp_host_rsa.key");

let sftpServer = null;
let sftpPort = null;
let sftpError = null;

function serverFilesDir(id) { return join(SERVERS_DIR, id, "server-files"); }

// Sanitize an SFTP path so it can never escape the server root.
function toAbsolute(root, p) {
  const base = resolve(root);
  const segments = String(p || "/").replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  const resolved = resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(base + sep)) return null;
  return resolved;
}

// Settings keys are shared with index.js (which also cleans them up on server delete).
export function sftpPasswordKey(id) { return `sftp_pass_${id}`; }
export function sftpEnabledKey(id) { return `sftp_enabled_${id}`; }

function ensureHostKey() {
  if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH, "utf8");
  mkdirSync(DATA_DIR, { recursive: true });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  try { writeFileSync(KEY_PATH, privateKey, { mode: 0o600 }); } catch { writeFileSync(KEY_PATH, privateKey); }
  return privateKey;
}

function attrsFromStat(st) {
  const isDir = typeof st.isDirectory === "function" ? st.isDirectory() : false;
  return {
    mode: st.mode || (isDir ? 0o40755 : 0o100644),
    uid: 0, gid: 0,
    size: typeof st.size === "number" ? st.size : 0,
    atime: Math.floor((st.atimeMs || Date.now()) / 1000),
    mtime: Math.floor((st.mtimeMs || Date.now()) / 1000),
  };
}

function longname(name, st) {
  const isDir = typeof st.isDirectory === "function" ? st.isDirectory() : false;
  const mode = st.mode || (isDir ? 0o40755 : 0o100644);
  const perms = (isDir ? "d" : "-") +
    (mode & 0o400 ? "r" : "-") + (mode & 0o200 ? "w" : "-") + (mode & 0o100 ? "x" : "-") +
    (mode & 0o040 ? "r" : "-") + (mode & 0o020 ? "w" : "-") + (mode & 0o010 ? "x" : "-") +
    (mode & 0o004 ? "r" : "-") + (mode & 0o002 ? "w" : "-") + (mode & 0o001 ? "x" : "-");
  const sz = String(st.size || 0).padStart(8, " ");
  let d = "Jan 01 00:00";
  try { d = new Date(st.mtimeMs || Date.now()).toISOString().slice(0, 16).replace("T", " "); } catch {}
  return `${perms} 1 smp smp ${sz} ${d} ${name}`;
}

export function getSftpInfo(id) {
  const user = `smp-${String(id).slice(0, 8)}`;
  const hasPassword = !!getSetting(sftpPasswordKey(id), "");
  const enabled = getSetting(sftpEnabledKey(id), "0") === "1";
  return {
    enabled,
    hasPassword,
    username: user,
    host: "127.0.0.1",
    port: sftpPort || Number(process.env.SMP_SFTP_PORT || 2222),
    root: "/",
    hint: "Connect with an SFTP client (FileZilla, WinSCP) using the panel host/IP and this port.",
  };
}

export function setSftpPassword(id, password) {
  if (!password || String(password).length < 4) throw new Error("Password must be at least 4 characters");
  const hash = bcrypt.hashSync(String(password), 10);
  setSetting(sftpPasswordKey(id), hash);
  return { ok: true };
}

function verifyPassword(id, password) {
  const hash = getSetting(sftpPasswordKey(id), "");
  if (!hash) return false;
  try { return bcrypt.compareSync(String(password || ""), hash); } catch { return false; }
}

export function getSftpStatus() {
  return { running: !!sftpServer, port: sftpPort, error: sftpError };
}

export function stopSftpServer() {
  if (sftpServer) { try { sftpServer.close(); } catch {} sftpServer = null; }
  sftpPort = null;
  return { ok: true };
}

export function startSftpServer(port = Number(process.env.SMP_SFTP_PORT || 2222)) {
  if (sftpServer) return { ok: true, port: sftpPort, already: true };
  sftpError = null;
  let hostKey;
  try { hostKey = ensureHostKey(); } catch (e) { sftpError = e.message; return { ok: false, error: e.message }; }
  try {
    sftpServer = new Server({ hostKeys: [hostKey] }, (client) => {
      let serverId = null;
      let baseDir = null;

      client.on("authentication", (ctx) => {
        if (ctx.method !== "password") return ctx.reject(["password"]);
        const uname = String(ctx.username || "");
        let id = null;
        // Usernames are exactly `smp-<first 8 chars of the server uuid>`.
        if (/^smp-[0-9a-f]{8}$/i.test(uname)) {
          try { const row = db.prepare("SELECT id FROM servers WHERE id LIKE ?").get(uname.slice(4) + "%"); if (row) id = row.id; } catch {}
        }
        if (!id || getSetting(sftpEnabledKey(id), "0") !== "1" || !verifyPassword(id, ctx.password)) {
          return ctx.reject(["password"]);
        }
        serverId = id;
        baseDir = serverFilesDir(id);
        try { mkdirSync(baseDir, { recursive: true }); } catch {}
        ctx.accept();
      });

      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => {
            if (!baseDir) return;
            const s = acceptSftp();
            const handles = new Map();
            let hid = 1;
            const H = (v) => { const b = Buffer.from(String(hid++)); handles.set(b.toString("hex"), v); return b; };
            const G = (b) => handles.get(Buffer.from(b).toString("hex"));
            const D = (b) => handles.delete(Buffer.from(b).toString("hex"));
            const norm = (p) => { let x = String(p || "/"); if (!x.startsWith("/")) x = "/" + x; return posix.normalize(x).replace(/\\/g, "/"); };
            const real = (p) => toAbsolute(baseDir, norm(p).replace(/^\/+/, ""));
            const ok = (req) => s.status(req, STATUS.OK);
            const fail = (req, code = STATUS.FAILURE, msg = "Failure") => { try { s.status(req, code, msg); } catch {} };

            s.on("REALPATH", (req, p) => { try { s.name(req, [{ filename: norm(p), longname: norm(p), attrs: {} }]); } catch { fail(req); } });
            s.on("STAT", (req, p) => { const rp = real(p); if (!rp || !existsSync(rp)) return fail(req, STATUS.NO_SUCH_FILE); try { s.attrs(req, attrsFromStat(statSync(rp))); } catch { fail(req); } });
            s.on("LSTAT", (req, p) => { const rp = real(p); if (!rp || !existsSync(rp)) return fail(req, STATUS.NO_SUCH_FILE); try { s.attrs(req, attrsFromStat(statSync(rp))); } catch { fail(req); } });
            s.on("FSTAT", (req, h) => { const v = G(h); if (!v || v.fd == null) return fail(req); try { s.attrs(req, attrsFromStat(fstatSync(v.fd))); } catch { fail(req); } });

            s.on("OPENDIR", (req, p) => { const rp = real(p); if (!rp || !existsSync(rp)) return fail(req, STATUS.NO_SUCH_FILE); try { if (!statSync(rp).isDirectory()) return fail(req, STATUS.FAILURE); } catch { return fail(req); } s.handle(req, H({ type: "dir", path: rp, read: false })); });
            s.on("READDIR", (req, h) => {
              const v = G(h); if (!v || v.type !== "dir") return fail(req);
              if (v.read) return fail(req, STATUS.EOF);
              try {
                const names = readdirSync(v.path);
                const list = names.map(name => {
                  let st; try { st = statSync(join(v.path, name)); } catch { st = { isDirectory: () => false, mode: 0o100644, size: 0, atimeMs: Date.now(), mtimeMs: Date.now() }; }
                  return { filename: name, longname: longname(name, st), attrs: attrsFromStat(st) };
                });
                v.read = true;
                if (!list.length) return fail(req, STATUS.EOF);
                s.name(req, list);
              } catch { fail(req); }
            });

            s.on("OPEN", (req, p, flags) => {
              const rp = real(p); if (!rp) return fail(req, STATUS.PERMISSION_DENIED);
              try {
                mkdirSync(dirname(rp), { recursive: true });
                const acc = flags & 0x3;
                let f = "r";
                if (acc === OPEN.READ) f = "r";
                else if (acc === OPEN.WRITE) f = (flags & OPEN.APPEND) ? "a" : ((flags & OPEN.CREAT) ? "w" : "r+");
                else f = (flags & OPEN.CREAT) ? "w+" : "r+";
                if ((flags & OPEN.TRUNC) && f === "r+") f = "w+";
                if ((flags & OPEN.CREAT) && !existsSync(rp)) try { writeFileSync(rp, ""); } catch {}
                const fd = openSync(rp, f);
                s.handle(req, H({ type: "file", fd, path: rp }));
              } catch (e) { fail(req, STATUS.FAILURE, e.message); }
            });
            s.on("READ", (req, h, off, len) => {
              const v = G(h); if (!v || v.fd == null) return fail(req);
              try {
                const b = Buffer.alloc(Math.min(len, 64 * 1024)); const n = readSync(v.fd, b, 0, b.length, off);
                if (n <= 0) return fail(req, STATUS.EOF);
                s.data(req, b.slice(0, n));
              } catch { fail(req); }
            });
            s.on("WRITE", (req, h, off, data) => {
              const v = G(h); if (!v || v.fd == null) return fail(req);
              try { writeSync(v.fd, data, 0, data.length, off); ok(req); } catch { fail(req); }
            });
            s.on("CLOSE", (req, h) => { const v = G(h); if (v?.fd != null) try { closeSync(v.fd); } catch {} D(h); ok(req); });

            s.on("MKDIR", (req, p) => { const rp = real(p); if (!rp) return fail(req); try { mkdirSync(rp, { recursive: true }); ok(req); } catch { fail(req); } });
            s.on("RMDIR", (req, p) => { const rp = real(p); if (!rp) return fail(req); try { rmdirSync(rp); ok(req); } catch { fail(req); } });
            s.on("REMOVE", (req, p) => { const rp = real(p); if (!rp) return fail(req); try { unlinkSync(rp); ok(req); } catch { fail(req); } });
            s.on("RENAME", (req, p, np) => { const a = real(p), b = real(np); if (!a || !b) return fail(req); try { renameSync(a, b); ok(req); } catch { fail(req); } });
            s.on("SETSTAT", (req) => ok(req));
            s.on("FSETSTAT", (req) => ok(req));
            s.on("SYMLINK", (req) => fail(req, STATUS.PERMISSION_DENIED, "Symlinks are not supported"));
            s.on("READLINK", (req) => fail(req, STATUS.NO_SUCH_FILE));
          });
        });
      });
      client.on("error", () => {});
    });

    sftpServer.on("error", (e) => { sftpError = e.message; try { sftpServer?.close(); } catch {} sftpServer = null; });
    sftpServer.listen(port, "0.0.0.0", () => { sftpPort = port; });
    return { ok: true, port };
  } catch (e) {
    sftpError = e.message;
    sftpServer = null;
    return { ok: false, error: e.message };
  }
}

export function autoStartSftp() {
  try {
    const any = db.prepare("SELECT key FROM settings WHERE key LIKE 'sftp_enabled_%' AND value = '1' LIMIT 1").get();
    if (any || process.env.SMP_SFTP_AUTO === "1") startSftpServer();
  } catch {}
}

