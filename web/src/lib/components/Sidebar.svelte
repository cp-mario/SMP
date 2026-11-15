<script>
  import { router, requestNewServer } from "../router.js";
  import Button from "./ui/Button.svelte";
  import Icon from "./ui/Icon.svelte";

  let {
    servers = [],
    activeView = "servers",
    accentColor = "#9255E8",
    currentPath = "/",
    updateAvailable = false,
    updateVersion = null,
  } = $props();

  let items = $derived([
    { id: "servers", label: "Servers", path: "/", icon: "grid" },
    { id: "mods", label: "Mods & Plugins", path: "/mods", icon: "puzzle" },
    { id: "settings", label: "Settings", path: "/settings", icon: "settings" },
  ]);

  let current = $derived(currentPath || "/");
  let onlineCount = $derived(servers.filter((s) => s.online === 1).length);
  let total = $derived(servers.length);

  const initial = (name) => (String(name || "?").trim().charAt(0) || "?").toUpperCase();
</script>

<aside class="sidebar">
  <a
    class="brand"
    href="#/"
    onclick={(e) => { e.preventDefault(); router.navigate("/"); }}
    aria-label="SMP panel home"
  >
    <span class="brand-logo"><img src="/icons/misc/favicon.svg" alt="SMP Logo" /></span>
    <span class="brand-text">
      <strong>SMP</strong>
      <small>Server panel</small>
    </span>
  </a>

  <nav class="nav" aria-label="Primary">
    <div class="section-label">Workspace</div>
    {#each items as item}
      <button
        class="nav-item"
        class:active={activeView === item.id}
        type="button"
        aria-current={activeView === item.id ? "page" : undefined}
        onclick={() => router.navigate(item.path)}
      >
        <span class="nav-icon" aria-hidden="true"><Icon name={item.icon} size={17} /></span>
        <span class="nav-label">{item.label}</span>
        {#if item.id === "servers" && total}<span class="nav-count">{total}</span>{/if}
        {#if item.id === "settings" && updateAvailable}
          <span class="nav-dot" title={updateVersion ? `Update available: ${updateVersion}` : "Update available"} aria-label={updateVersion ? `Update available: ${updateVersion}` : "Update available"}></span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="instances">
    <div class="instances-head">
      <div>
        <div class="section-label">Instances</div>
        <div class="instances-meta">{onlineCount}/{total} online</div>
      </div>
      <Button size="xs" variant="primary" onclick={() => requestNewServer()} title="Create a new server">
        <Icon name="plus" size={13} /> New
      </Button>
    </div>

    <ul class="server-list">
      {#each servers as s (s.id)}
        <li>
          <a
            class="server-item"
            class:active={current === `/server/${s.id}`}
            href={`#/server/${s.id}`}
            title={s.name}
          >
            <span class="server-avatar" aria-hidden="true">
              <span class="avatar-fallback">{initial(s.name)}</span>
              {#if s.has_icon}
                <img src={`/api/servers/${s.id}/icon?t=${s.icon_version || 0}`} alt="" loading="lazy" onerror={(e) => e.currentTarget.remove()} />
              {/if}
            </span>
            <span class="server-name">{s.name}</span>
            <span class="status-dot" class:offline={s.online !== 1} title={s.online === 1 ? "Online" : "Offline"}></span>
          </a>
        </li>
      {:else}
        <li class="server-empty">No servers yet</li>
      {/each}
    </ul>
  </div>

  <div class="sidebar-footer">
    <div class="panel-status">
      <span class="status-dot" class:offline={onlineCount === 0}></span>
      <span>{onlineCount === 0 ? "All instances stopped" : `${onlineCount} instance${onlineCount === 1 ? "" : "s"} running`}</span>
    </div>
  </div>
</aside>

<style>
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: var(--z-sidebar);
    display: flex;
    flex-direction: column;
    gap: 18px;
    width: var(--sidebar-w);
    padding: 14px 12px;
    overflow-y: auto;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--sidebar) 94%, var(--accent) 2%) 0%, var(--sidebar) 42%),
      var(--sidebar);
    border-right: 1px solid var(--border);
  }

  /* ---------- Brand ---------- */

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 6px;
    color: var(--text);
    border-radius: var(--radius);
  }
  .brand:hover { color: var(--text); }
  .brand-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
  }
  .brand-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
  .brand-text strong { font-size: 0.98rem; font-weight: 700; letter-spacing: -0.01em; }
  .brand-text small { margin-top: 2px; color: var(--text-disabled); font-size: 0.66rem; letter-spacing: 0.04em; }

  /* ---------- Navigation ---------- */

  .section-label {
    padding: 0 8px;
    color: var(--text-disabled);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }
  .nav { display: flex; flex-direction: column; gap: 3px; }
  .nav-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 9px;
    color: var(--text-secondary);
    font-size: 0.82rem;
    font-weight: 500;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius);
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }
  .nav-item:hover { color: var(--text); background: var(--panel-elevated); }
  .nav-item.active {
    color: var(--text);
    background: var(--accent-soft);
    border-color: var(--accent-ring);
  }
  .nav-item.active::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 7px;
    bottom: 7px;
    width: 2px;
    background: var(--accent);
    border-radius: 2px;
    box-shadow: 0 0 8px var(--accent-ring);
  }
  .nav-icon { display: inline-flex; color: var(--text-disabled); transition: color var(--t-fast); }
  .nav-item:hover .nav-icon { color: var(--text-secondary); }
  .nav-item.active .nav-icon { color: var(--accent); }
  .nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-count {
    min-width: 19px;
    padding: 1px 5px;
    color: var(--text-disabled);
    font-family: var(--font-mono);
    font-size: 0.64rem;
    text-align: center;
    background: var(--panel-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
  }
  .nav-item.active .nav-count { color: var(--accent); background: var(--accent-light); border-color: var(--accent-ring); }
  .nav-dot {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    background: var(--accent);
    border-radius: 50%;
    box-shadow: 0 0 0 3px var(--accent-soft), 0 0 8px var(--accent-ring);
    animation: nav-dot-pulse 2.4s ease-in-out infinite;
  }
  @keyframes nav-dot-pulse {
    0%, 100% { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 8px var(--accent-ring); }
    50% { box-shadow: 0 0 0 5px transparent, 0 0 12px var(--accent-ring); }
  }
  @media (prefers-reduced-motion: reduce) { .nav-dot { animation: none; } }

  /* ---------- Instances ---------- */

  .instances {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 9px;
    min-height: 0;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }
  .instances-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; padding: 0 2px; }
  .instances-head .section-label { padding: 0 6px; }
  .instances-meta { padding: 2px 6px 0; color: var(--text-disabled); font-size: 0.66rem; font-variant-numeric: tabular-nums; }

  .server-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow-y: auto;
    list-style: none;
  }
  .server-item {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding: 5px 7px;
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 500;
    border: 1px solid transparent;
    border-radius: var(--radius);
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }
  .server-item:hover { color: var(--text); background: var(--panel-elevated); }
  .server-item.active { color: var(--text); background: var(--panel-elevated); border-color: var(--border-secondary); }
  .server-avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 23px;
    height: 23px;
    flex: 0 0 auto;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 0.68rem;
    font-weight: 700;
    background: var(--panel-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .server-avatar img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
  .server-item.active .server-avatar {
    color: var(--accent);
    background: var(--accent-light);
    border-color: var(--accent-ring);
  }
  .server-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .server-empty { padding: 8px 8px; color: var(--text-disabled); font-size: 0.75rem; }

  /* ---------- Footer ---------- */

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 8px 0;
    border-top: 1px solid var(--border);
  }
  .panel-status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--text-secondary);
    font-size: 0.72rem;
  }
  .panel-status span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  @media (max-width: 900px) {
    .sidebar { display: none; }
  }
</style>
