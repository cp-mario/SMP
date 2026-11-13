<script>
  import StoreBrowser from "./StoreBrowser.svelte";
  import Badge from "./ui/Badge.svelte";
  import Icon from "./ui/Icon.svelte";
  import { router } from "../router.js";
  import { STORE_SOURCES } from "../storeBrowser.js";

  let { appState, onServerCreated = undefined } = $props();

  let targetServerId = $state("");
  let servers = $derived(appState?.servers || []);
  let systemInfo = $derived(appState?.systemInfo || null);
  let targetServer = $derived(servers.find((s) => s.id === targetServerId) || null);

  $effect(() => {
    if (!servers.length) { targetServerId = ""; return; }
    if (!servers.some((s) => s.id === targetServerId)) targetServerId = servers[0].id;
  });
</script>

<header class="page-header">
  <div>
    <h1>Mods & Plugins</h1>
    <div class="subtitle">Search every store, inspect versions and install into a server.</div>
    <div class="store-list">
      {#each STORE_SOURCES as s}<Badge>{s.label}</Badge>{/each}
    </div>
  </div>
  {#if targetServer}
    <button class="manage-link" type="button" onclick={() => router.navigate(`/server/${targetServer.id}`)}>
      <Icon name="settings" size={14} /> Manage {targetServer.name} <Icon name="arrow-right" size={14} />
    </button>
  {/if}
</header>

<StoreBrowser
  {servers}
  {systemInfo}
  bind:targetServerId
  onInstalled={() => {}}
  onCreated={(id) => { onServerCreated?.(); router.navigate(`/server/${id}`); }}
/>
<small class="hint">Results update as you type. “Use server target” follows a server’s loader / version; change the filters to search something else.</small>

<style>
  .store-list { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .manage-link {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 12px;
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-btn);
    box-shadow: var(--shadow-xs);
    cursor: pointer;
    transition: color var(--t-fast), border-color var(--t-fast), background var(--t-fast);
  }
  .manage-link:hover { color: var(--text); background: var(--panel-elevated); border-color: var(--border-strong); }
  .hint { display: block; margin-top: 14px; color: var(--text-disabled); font-size: 0.74rem; line-height: 1.5; }
</style>