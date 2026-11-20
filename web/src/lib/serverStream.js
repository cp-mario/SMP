/**
 * Shared SSE stream per server.
 *
 * Opens one `EventSource` per server id and fans out both log lines (plain
 * `data:` messages) and stats (`event: stats`) to subscribers. Components
 * subscribe to the channel they care about instead of opening their own
 * connection or polling HTTP.
 *
 * Usage:
 *   const sub = subscribe(serverId, { logs: true, stats: true }, {
 *     onLog: (payload) => { ... },
 *     onStats: (payload) => { ... },
 *   });
 *   sub.unsubscribe();
 */

const channels = new Map(); // serverId -> Channel

/**
 * A channel holds one EventSource and a set of subscribers.
 */
class Channel {
  constructor(serverId) {
    this.serverId = serverId;
    this.es = null;
    this.subs = new Set();
    this.next = 0;
    this.reconnectTimer = null;
    this.destroyed = false;
  }

  /** Open the EventSource if not already open. */
  ensure() {
    if (this.es || this.destroyed) return;
    this.connect();
  }

  connect() {
    if (this.destroyed) return;
    this.close();
    if (typeof EventSource === "undefined") return;
    try {
      this.es = new EventSource(`/api/servers/${this.serverId}/logs/stream?after=${this.next}`);
      this.es.onmessage = (e) => {
        let d;
        try { d = JSON.parse(e.data); } catch { return; }
        this.dispatchLog(d);
      };
      this.es.addEventListener("stats", (e) => {
        let d;
        try { d = JSON.parse(e.data); } catch { return; }
        this.dispatchStats(d);
      });
      this.es.onerror = () => {
        this.close();
        this.scheduleReconnect();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  close() {
    try { this.es?.close(); } catch { /* noop */ }
    this.es = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed && this.subs.size > 0) this.connect();
    }, 5000);
  }

  dispatchLog(d) {
    for (const sub of this.subs) {
      if (sub.options.logs && sub.onLog) {
        try { sub.onLog(d); } catch { /* subscriber error — ignore */ }
      }
    }
  }

  dispatchStats(d) {
    for (const sub of this.subs) {
      if (sub.options.stats && sub.onStats) {
        try { sub.onStats(d); } catch { /* subscriber error — ignore */ }
      }
    }
  }

  /**
   * Subscribe to this channel. Returns { unsubscribe }.
   * @param {{ logs?: boolean, stats?: boolean }} options
   * @param {{ onLog?: function, onStats?: function }} callbacks
   */
  subscribe(options, callbacks) {
    this.ensure();
    const sub = { options, ...callbacks };
    this.subs.add(sub);
    return {
      unsubscribe: () => {
        this.subs.delete(sub);
        if (this.subs.size === 0) {
          this.close();
          if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        }
      },
    };
  }

  /** Destroy this channel and close the connection. */
  destroy() {
    this.destroyed = true;
    this.close();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.subs.clear();
  }

  /** Update the `next` cursor (used when the console is cleared). */
  setNext(n) {
    this.next = n;
  }
}

function getChannel(serverId) {
  let ch = channels.get(serverId);
  if (!ch || ch.destroyed) {
    if (ch) channels.delete(serverId);
    ch = new Channel(serverId);
    channels.set(serverId, ch);
  }
  return ch;
}

/**
 * Subscribe to the shared SSE stream for a server.
 *
 * @param {string} serverId
 * @param {{ logs?: boolean, stats?: boolean }} options - which events to receive
 * @param {{ onLog?: function, onStats?: function }} callbacks - handlers
 * @returns {{ unsubscribe: function }}
 */
function subscribe(serverId, options, callbacks) {
  const ch = getChannel(serverId);
  return ch.subscribe(options, callbacks);
}

/**
 * Get the initial log lines (HTTP request, not SSE). Used by ConsolePanel
 * to load the last N lines before connecting to SSE.
 */
async function loadInitialLogs(serverId, limit = 300) {
  const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/logs?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to load logs: ${res.status}`);
  return res.json();
}

/**
 * Destroy a channel (e.g. when navigating away from a server).
 */
function destroyChannel(serverId) {
  const ch = channels.get(serverId);
  if (ch) ch.destroy();
  channels.delete(serverId);
}

/** Destroy all channels (e.g. on app shutdown). */
function destroyAll() {
  for (const ch of channels.values()) ch.destroy();
  channels.clear();
}

export { subscribe, loadInitialLogs, destroyChannel, destroyAll };
