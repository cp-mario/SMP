import { Elysia } from "elysia";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { db, getSetting } from "../core/db.js";
import { getUpdateState, applyUpdate, normalizeChannel, defaultChannel } from "../core/version.js";
import { stopAllServers } from "../instances/process.js";
import { stopSftpServer } from "../runtime/sftp.js";

// The channel chosen in Settings wins, then the stored preference, then the one
// implied by the running version (pre-release builds start on experimental).
function resolveUpdateChannel(explicit) {
  if (explicit) return normalizeChannel(explicit);
  const stored = getSetting("update_channel", "");
  return normalizeChannel(stored || defaultChannel());
}

export const updatesRoute = new Elysia({ prefix: "/api/updates" })
  .get("/", async ({ query }) => getUpdateState({ channel: resolveUpdateChannel(query?.channel) }))
  .post("/check", async ({ body }) => getUpdateState({ channel: resolveUpdateChannel(body?.channel), force: true }))

  // Tail of the updater log (written by the detached updater and the relaunched
  // panel), consumed by the /update console page.
  .get("/log", () => {
    const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
    try {
      const buf = readFileSync(join(process.env.SMP_DATA_DIR || join(homedir(), ".smp"), "update.log"));
      return new Response(buf.subarray(Math.max(0, buf.length - 65536)).toString("utf8"), { headers });
    } catch {
      return new Response("", { headers });
    }
  })

  .post("/apply", async ({ body }) => {
    const target = String(body?.version || "").trim();
    const channel = resolveUpdateChannel(body?.channel);
    const state = await getUpdateState({ channel, force: true });
    const { ids, stopped } = await stopAllServers();
    const result = await applyUpdate({ target, current: state.current, channel });
    // The detached updater replaces the installation once this process exits.
    if (result.ok && result.restarting) {
      setTimeout(() => { try { process.exit(0); } catch {} }, 1500);
    }
    return { ok: result.ok, code: result.code || null, message: result.message || null, target, channel, version: state.current, servers: { total: ids.length, stopped }, applying: true };
  })
  .post("/shutdown", async ({ body, set }) => {
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "Panel shutdown requested";
    const { ids, stopped } = await stopAllServers();
    try { stopSftpServer(); } catch {}
    console.log(`[panel] ${reason} (stopped ${stopped.length}/${ids.length} servers)`);
    // Answer the request first; the process exits a moment later.
    setTimeout(() => {
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
      process.exit(0);
    }, 600);
    set.status = 202;
    return { ok: true, stopping: true, reason, stopped, etaMs: 600 };
  });
