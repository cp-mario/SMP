<script>
  import { onDestroy } from "svelte";
  import { api } from "../../stores.js";
  import { ansiToHtml } from "../../ansi.js";
  import { classifyLogLevel } from "../../logLevel.js";
  import { subscribe as subscribeStream, loadInitialLogs, destroyChannel } from "../../serverStream.js";
  import Button from "../ui/Button.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Icon from "../ui/Icon.svelte";

  let { serverId, online = false, active = true } = $props();

  let lines = $state([]);
  let input = $state("");
  let el = $state(null);
  let inputEl = $state(null);
  let next = 0;
  let streamSub = null;
  let destroyed = false;
  let cmdError = $state("");
  let autoScroll = $state(true);
  let atBottom = $state(true);
  let lastScrollTop = 0;
  let lastActive = true;
  let history = $state([]);
  let historyIdx = $state(-1);
  let historyDraft = $state("");
  let showHistory = $state(false);
  let sending = $state(false);
  let copied = $state(false);
  let copyTimer = null;
  let cleared = $state(false);

  const MAX_LINES = 3000;
  const INITIAL_LINES = 300;
  let lineSeq = 0;

  function makeLine(text) {
    const value = String(text ?? "");
    return { id: ++lineSeq, text: value, html: ansiToHtml(value), level: classifyLogLevel(value) };
  }

  function setLines(list) {
    const arr = Array.isArray(list) ? list : [];
    lines = arr.slice(-MAX_LINES).map(makeLine);
  }

  function scroll(force = false) {
    if (!el) return;
    if (!force && (!autoScroll || !atBottom)) return;
    requestAnimationFrame(() => {
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      atBottom = true;
    });
  }

  function onScroll() {
    if (!el) return;
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    lastScrollTop = el.scrollTop;
  }

  function append(newLines) {
    if (!newLines?.length) return;
    // Keep the array stable when the buffer is not full: growing a plain array
    // in place is far cheaper than copying 3000 entries per burst.
    const mapped = newLines.map(makeLine);
    if (lines.length + mapped.length <= MAX_LINES) {
      lines = lines.concat(mapped);
    } else {
      lines = lines.concat(mapped).slice(-MAX_LINES);
    }
    scroll();
  }

  async function loadFull() {
    try {
      const res = await loadInitialLogs(serverId, INITIAL_LINES);
      if (destroyed) return;
      const list = Array.isArray(res.lines) ? res.lines : (res.logs ? String(res.logs).split("\n").filter(Boolean) : []);
      setLines(list.slice(-INITIAL_LINES));
      next = Number.isFinite(res.next) ? res.next : lines.length;
      cleared = false;
      atBottom = true;
      scroll(true);
    } catch { /* offline is fine */ }
  }

  function startStream() {
    if (destroyed) return;
    stopStream();
    const after = next;
    streamSub = subscribeStream(serverId, { logs: true }, {
      onLog: (d) => {
        if (d.clear) {
          lines = [];
          next = d.next || 0;
          cleared = true;
          atBottom = true;
          scroll(true);
          return;
        }
        if (Array.isArray(d.init)) {
          if (d.init.length) {
            if (after > 0) {
              append(d.init);
            } else {
              setLines(d.init.slice(-INITIAL_LINES));
              cleared = false;
              atBottom = true;
              scroll(true);
            }
          }
          next = Number.isFinite(d.next) ? d.next : next;
        } else if (Array.isArray(d.lines)) {
          append(d.lines);
          if (Number.isFinite(d.next)) next = d.next;
        } else if (d.line != null) {
          append([d.line]);
          if (Number.isFinite(d.n)) next = d.n + 1;
          else if (Number.isFinite(d.next)) next = d.next;
        }
      },
    });
  }

  function stopStream() {
    if (streamSub) { streamSub.unsubscribe(); streamSub = null; }
  }

  onDestroy(() => {
    destroyed = true;
    stopStream();
    if (copyTimer) clearTimeout(copyTimer);
  });

  let loadToken = 0;

  function resetConsole() {
    loadToken++;
    stopStream();
    lines = [];
    next = 0;
    cleared = false;
    atBottom = true;
    lastScrollTop = 0;
    cmdError = "";
  }

  async function startConsole() {
    const token = ++loadToken;
    stopStream();
    lines = [];
    next = 0;
    cleared = false;
    atBottom = true;
    lastScrollTop = 0;
    cmdError = "";
    await loadFull();
    if (destroyed || token !== loadToken || !online) return;
    startStream();
  }

  // The last 300 lines are only loaded while the server is running. Turning it
  // off clears the console; starting it again reloads the tail and live output.
  $effect(() => {
    const isOnline = online;
    if (isOnline) startConsole();
    else resetConsole();
  });

  // The panel stays mounted while other tabs are open; restore the scroll
  // position (or stick to the bottom) when the console becomes visible again.
  $effect(() => {
    const isActive = active;
    if (isActive === lastActive) return;
    lastActive = isActive;
    if (!isActive) return;
    requestAnimationFrame(() => {
      if (!el || destroyed) return;
      if (atBottom) scroll(true);
      else el.scrollTop = lastScrollTop;
    });
  });

  function pushHistory(cmd) {
    if (!cmd) return;
    if (history[history.length - 1] !== cmd) history = [...history.filter((c) => c !== cmd), cmd].slice(-200);
    historyIdx = -1;
    historyDraft = "";
  }

  async function sendCommand(cmdOverride) {
    const cmd = String(cmdOverride ?? input).trim();
    if (!cmd || sending || !online) return;
    sending = true;
    cmdError = "";
    try {
      await api(`/servers/${serverId}/command`, { method: "POST", body: JSON.stringify({ command: cmd }), retries: 0 });
      pushHistory(cmd);
      input = "";
      showHistory = false;
    } catch (e) {
      cmdError = e?.message || String(e);
    } finally {
      sending = false;
      requestAnimationFrame(() => inputEl?.focus());
    }
  }

  function onKeydown(e) {
    if (e.key === "Enter") { e.preventDefault(); sendCommand(); return; }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!history.length) return;
      if (historyIdx < 0) { historyDraft = input; historyIdx = history.length - 1; }
      else if (historyIdx > 0) historyIdx--;
      input = history[historyIdx] ?? "";
      requestAnimationFrame(() => inputEl?.setSelectionRange(input.length, input.length));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx < 0) return;
      if (historyIdx < history.length - 1) { historyIdx++; input = history[historyIdx] ?? ""; }
      else { historyIdx = -1; input = historyDraft; }
      requestAnimationFrame(() => inputEl?.setSelectionRange(input.length, input.length));
    } else if (e.key === "Escape") {
      showHistory = false;
    }
  }

  async function clearConsole() {
    cmdError = "";
    lines = [];
    cleared = true;
    next = 0;
    atBottom = true;
    scroll(true);
    try { await api(`/servers/${serverId}/logs`, { method: "DELETE", retries: 0 }); } catch { /* noop */ }
  }

  async function copyLog() {
    const text = lines.map((l) => l.text).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
    copied = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied = false; }, 1600);
  }
</script>

<div class="panel console-panel">
  <div class="console-head">
    <span class="console-title">
      <Icon name="terminal" size={15} />
      Console
      <span class="console-live" class:offline={!online}><span class="live-dot"></span>{online ? "live" : "offline"}</span>
    </span>
    <div class="console-tools">
      <label class="auto-scroll">
        <input type="checkbox" bind:checked={autoScroll} onchange={() => { if (autoScroll) scroll(true); }} /> Auto-scroll
      </label>
      <Button size="xs" variant="outline" onclick={copyLog}><Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy"}</Button>
      <Button size="xs" variant="outline" onclick={clearConsole}><Icon name="trash" size={12} /> Clear</Button>
    </div>
  </div>

  {#if cmdError}
    <div class="console-error">{cmdError}</div>
  {/if}

  <div class="console console-ansi" bind:this={el} onscroll={onScroll}>
    {#if lines.length}
      {#each lines as line (line.id)}
        <div class="console-line" class:level-error={line.level === "error"} class:level-warn={line.level === "warn"} class:level-success={line.level === "success"} class:level-info={line.level === "info"} class:level-debug={line.level === "debug"}>{@html line.html || "&nbsp;"}</div>
      {/each}
    {:else}
      <div class="console-line muted">{cleared ? "Console cleared. New output will appear below." : (online ? "Waiting for output…" : "Server is offline. Start it from this panel to see live output and send commands.")}</div>
    {/if}
  </div>

  <div
    class="console-input-wrap"
    onfocusout={(e) => {
      const wrap = /** @type {HTMLElement} */ (e.currentTarget);
      const next = /** @type {Node | null} */ (e.relatedTarget);
      if (!next || !wrap.contains(next)) showHistory = false;
    }}
  >
    <span class="console-history-btn">
      <IconButton label="Command history" variant="outline" disabled={!history.length} onclick={() => (showHistory = !showHistory)}>
        <Icon name="clock" size={15} />
      </IconButton>
    </span>
    {#if showHistory && history.length}
      <div class="console-history-menu">
        <div class="console-history-title">Previous commands</div>
        <div class="console-history-list">
          {#each [...history].reverse() as cmd}
            <button type="button" class="console-history-item" onclick={() => { input = cmd; showHistory = false; requestAnimationFrame(() => inputEl?.focus()); }}>{cmd}</button>
          {/each}
        </div>
      </div>
    {/if}
    <input
      bind:this={inputEl}
      type="text"
      class="input console-input"
      bind:value={input}
      placeholder={online ? "Type a command… (↑/↓ history)" : "Start the server to send commands"}
      disabled={!online}
      aria-busy={sending || undefined}
      onkeydown={onKeydown}
    />
    <Button size="sm" variant="primary" disabled={!online} loading={sending} onclick={() => sendCommand()}><Icon name="arrow-right" size={13} /> Send</Button>
  </div>
</div>

<style>
  .console-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 11px 14px;
    background: color-mix(in srgb, var(--panel-elevated) 60%, transparent);
    border-bottom: 1px solid var(--border);
  }
  .console-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 0.73rem;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .console-title :global(.icon) { color: var(--accent); }
  .console-live {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    color: var(--success);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: none;
    background: var(--success-soft);
    border: 1px solid var(--success-border);
    border-radius: 999px;
  }
  .console-live.offline { color: var(--text-disabled); background: transparent; border-color: var(--border); }
  .live-dot { width: 5px; height: 5px; background: currentColor; border-radius: 50%; }
  .console-live:not(.offline) .live-dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent); }
  .console-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .auto-scroll {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary);
    font-size: 0.72rem;
    cursor: pointer;
    user-select: none;
  }
  .auto-scroll input { accent-color: var(--accent); }
  .console-error {
    padding: 8px 14px;
    color: #ffb4b4;
    font-size: 0.78rem;
    background: var(--danger-soft);
    border-bottom: 1px solid var(--danger-border);
  }
  .console-line { content-visibility: auto; contain-intrinsic-size: auto 1.5em; padding: 0 3px; border-radius: 3px; }
  .console-line.level-error { color: #ff8c8c; background: rgba(233, 67, 67, 0.1); }
  .console-line.level-warn { color: #f2c14e; background: rgba(234, 179, 8, 0.08); }
  .console-line.level-info { color: #8ab4f8; }
  .console-line.level-success { color: #5bd98a; }
  .console-line.level-debug { color: #8a8a8a; }
  .console-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 14px;
    background: color-mix(in srgb, var(--panel-elevated) 60%, transparent);
    border-top: 1px solid var(--border);
  }
  .console-input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 0.8rem; }
  .console-history-btn { display: inline-flex; flex: 0 0 auto; }
  .console-history-menu {
    position: absolute;
    left: 14px;
    bottom: calc(100% - 4px);
    z-index: 20;
    display: flex;
    flex-direction: column;
    width: min(560px, calc(100% - 28px));
    max-height: 260px;
    overflow: hidden;
    background: var(--panel-elevated);
    border: 1px solid var(--border-secondary);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
  }
  .console-history-title {
    padding: 8px 12px;
    color: var(--text-disabled);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
  }
  .console-history-list { display: flex; flex-direction: column; gap: 2px; padding: 6px; overflow: auto; }
  .console-history-item {
    width: 100%;
    padding: 7px 10px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.76rem;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
  }
  .console-history-item:hover,
  .console-history-item:focus { background: var(--input-bg); border-color: var(--border); outline: none; }
</style>