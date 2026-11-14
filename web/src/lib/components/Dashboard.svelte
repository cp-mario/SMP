<script>
  import { router, requestNewServer } from "../router.js";
  import Button from "./ui/Button.svelte";
  import Badge from "./ui/Badge.svelte";
  import EmptyState from "./ui/EmptyState.svelte";
  import Icon from "./ui/Icon.svelte";

  let { servers = [], busyId = null, onStart, onStop, onRestart, onForceStop, onRefresh, onCreateModpack = undefined } = $props();

  let refreshing = $state(false);

  const running = $derived(servers.filter((s) => s.online === 1).length);
  const stopped = $derived(servers.length - running);

  function open(id) { router.navigate(`/server/${id}`); }
  function start(s) { onStart?.(s.id); }
  function stop(s) { onStop?.(s.id); }
  function restart(s) { onRestart?.(s.id); }
  function forceStop(s) { onForceStop?.(s.id); }

  function initial(name) {
    return (String(name || "?").trim().charAt(0) || "?").toUpperCase();
  }

  function hue(name) {
    let h = 0;
    for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try { await onRefresh?.(); } finally { refreshing = false; }
  }
</script>

<header class="page-header">
  <div>
    <div class="page-eyebrow"><Icon name="grid" size={12} /> Workspace</div>
    <h1>Servers</h1>
    <div class="subtitle">
      {servers.length} instance{servers.length === 1 ? "" : "s"} · {running} running · {stopped} stopped
    </div>
  </div>
  <div class="header-actions">
    {#if onCreateModpack}
      <Button size="sm" variant="outline" onclick={onCreateModpack} title="Create a server from a modpack">
        <Icon name="package" size={14} /> From modpack
      </Button>
    {/if}
    <Button size="sm" variant="outline" loading={refreshing} onclick={refresh}>
      {#if !refreshing}<Icon name="refresh" size={14} />{/if} Refresh
    </Button>
    <Button size="sm" variant="primary" onclick={() => requestNewServer()}>
      <Icon name="plus" size={14} /> New server
    </Button>
  </div>
</header>

{#if servers.length === 0}
  <EmptyState icon="server" title="No servers yet" description="Create your first Minecraft server to get started. Pick a loader, a version and the panel downloads and configures everything.">
    <Button size="sm" variant="primary" onclick={() => requestNewServer()}>
      <Icon name="plus" size={14} /> Create a server
    </Button>
  </EmptyState>
{:else}

  <div class="grid">
    {#each servers as s (s.id)}
      <article
        class="card server-card"
        class:running={s.online === 1}
        style={`--avatar-hue:${hue(s.name)}`}
      >
        <a
          class="card-link"
          href={`#/server/${s.id}`}
          aria-label={`Open ${s.name}`}
          onclick={(e) => { e.preventDefault(); open(s.id); }}
        ></a>
        <header class="server-head">
          <span class="server-avatar" aria-hidden="true">
            <span class="avatar-fallback">{initial(s.name)}</span>
            {#if s.has_icon}
              <img src={`/api/servers/${s.id}/icon?t=${s.icon_version || 0}`} alt="" loading="lazy" onerror={(e) => e.currentTarget.remove()} />
            {/if}
          </span>
          <div class="server-title">
            <div class="server-name" title={s.name}>{s.name}</div>
            <div class="server-tags">
              <Badge tone="accent">{s.loader}</Badge>
              <Badge tone={s.online === 1 ? "success" : "neutral"} dot>{s.online === 1 ? "Online" : "Offline"}</Badge>
              {#if s.update?.recommended || s.update?.build?.recommended}
                <Badge tone="warning" dot title={s.update.recommended ? `${s.update.recommended} is available` : `Build ${s.update.build.recommended} is available`}>Update</Badge>
              {/if}
            </div>
          </div>
          <span class="server-chevron" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>
        </header>

        <div class="server-meta">
          <div class="meta-item">
            <span class="meta-label">Version</span>
            <span class="meta-value" title={`${s.loader_version || "—"}${s.loader_build ? ` / ${s.loader_build}` : ""}`}>
              {s.loader_version || "—"}{#if s.loader_build}<span class="meta-sub"> / {s.loader_build}</span>{/if}
            </span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Memory</span>
            <span class="meta-value">{s.memory_max}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Port</span>
            <span class="meta-value">{s.port}</span>
          </div>
        </div>

        <div class="server-actions">
          {#if s.online === 1}
            <Button size="sm" variant="danger" loading={busyId === s.id} onclick={() => stop(s)}>
              {#if busyId !== s.id}<Icon name="square" size={12} />{/if} Stop
            </Button>
            <Button size="sm" variant="outline" loading={busyId === s.id} onclick={() => restart(s)}>
              {#if busyId !== s.id}<Icon name="rotate" size={13} />{/if} Restart
            </Button>
            <Button size="sm" variant="danger" loading={busyId === s.id} onclick={() => forceStop(s)} title="Kill the process immediately without saving">
              {#if busyId !== s.id}<Icon name="zap" size={12} />{/if} Force stop
            </Button>
          {:else}
            <Button size="sm" variant="primary" loading={busyId === s.id} onclick={() => start(s)}>
              {#if busyId !== s.id}<Icon name="play" size={12} />{/if} Start
            </Button>
          {/if}
        </div>
      </article>
    {/each}
  </div>
{/if}

<style>
  

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }

  .server-card {
    position: relative;
    gap: 0;
    padding: 16px;
    cursor: pointer;
  }
  .card-link {
    position: absolute;
    inset: 0;
    z-index: 2;
    border-radius: inherit;
  }
  .card-link:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
  .server-card:has(.card-link:focus-visible) { box-shadow: var(--ring), var(--shadow); }
  .server-card::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(420px 120px at 10% 0%, hsla(var(--avatar-hue), 60%, 60%, 0.06), transparent 70%);
    border-radius: inherit;
  }
  .server-card.running { border-color: color-mix(in srgb, var(--success) 18%, var(--border)); }

  .server-head { position: relative; z-index: 1; display: flex; align-items: center; gap: 11px; min-width: 0; }
  .server-avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    overflow: hidden;
    color: hsl(var(--avatar-hue), 60%, 78%);
    font-size: 0.95rem;
    font-weight: 800;
    background: linear-gradient(145deg, hsla(var(--avatar-hue), 55%, 55%, 0.22), hsla(var(--avatar-hue), 55%, 55%, 0.08));
    border: 1px solid hsla(var(--avatar-hue), 55%, 60%, 0.28);
    border-radius: 9px;
  }
  .server-avatar img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
  .server-title { flex: 1; min-width: 0; }
  .server-name { overflow: hidden; font-size: 0.94rem; font-weight: 700; letter-spacing: -0.01em; text-overflow: ellipsis; white-space: nowrap; }
  .server-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 5px; }
  .server-chevron { display: inline-flex; color: var(--text-disabled); transition: color var(--t-fast), transform var(--t-fast); }
  .server-card:hover .server-chevron { color: var(--text-secondary); transform: translateX(2px); }

  .server-meta {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 0.8fr);
    gap: 8px;
    margin: 14px 0;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--input-bg) 72%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .meta-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .meta-label { color: var(--text-disabled); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; }
  .meta-value { overflow: hidden; font-family: var(--font-mono); font-size: 0.76rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .meta-sub { color: var(--text-disabled); font-weight: 400; }

  .server-actions { position: relative; z-index: 3; display: flex; gap: 7px; flex-wrap: wrap; margin-top: auto; }

  @media (max-width: 560px) {
    .grid { grid-template-columns: minmax(0, 1fr); }
    .server-meta { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .meta-item:last-child { display: none; }
  }
</style>
