<script>
  import { onMount, onDestroy } from "svelte";
  import { subscribe as subscribeStream } from "../../serverStream.js";
  import Panel from "../ui/Panel.svelte";
  import UsageChart from "./UsageChart.svelte";

  let { serverId } = $props();

  const MAX_POINTS = 60;

  let cpuHistory = $state([]);
  let ramHistory = $state([]);
  let cpuPercent = $state(0);
  let memoryBytes = $state(0);
  let memoryMaxBytes = $state(0);
  let isOnline = $state(false);
  let error = $state("");
  let destroyed = false;
  let streamSub = null;

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function onStats(s) {
    if (destroyed) return;
    isOnline = !!s.online;
    error = s.error || "";
    cpuPercent = Number(s.cpuPercent) || 0;
    memoryBytes = Number(s.memoryBytes) || 0;
    memoryMaxBytes = Number(s.memoryMaxBytes) || 0;
    const cpu = isOnline && !error ? cpuPercent : 0;
    const ram = isOnline && !error ? memoryBytes : 0;
    cpuHistory = [...cpuHistory, cpu].slice(-MAX_POINTS);
    ramHistory = [...ramHistory, ram].slice(-MAX_POINTS);
  }

  onMount(() => {
    streamSub = subscribeStream(serverId, { stats: true }, { onStats });
  });

  onDestroy(() => {
    destroyed = true;
    if (streamSub) { streamSub.unsubscribe(); streamSub = null; }
  });

  const cpuMax = $derived(Math.max(100, ...cpuHistory));
  const status = $derived(isOnline ? (error ? "limited" : "live") : "offline");
</script>

<Panel title="Performance" icon="activity" subtitle={status}>
  <div class="res">
    <div class="res-row">
      <span class="res-label">CPU</span>
      <span class="res-value" class:dim={!isOnline}>{(cpuPercent || 0).toFixed(1)}%</span>
    </div>
    <UsageChart data={cpuHistory} max={cpuMax} color="var(--info)" height={40} label="CPU usage" />

    <div class="res-row">
      <span class="res-label">RAM</span>
      <span class="res-value" class:dim={!isOnline}>
        {formatBytes(memoryBytes)}{#if memoryMaxBytes}<span class="res-sub"> / {formatBytes(memoryMaxBytes)}</span>{/if}
      </span>
    </div>
    <UsageChart data={ramHistory} max={memoryMaxBytes || 1} color="var(--accent)" height={40} label="RAM usage" />

    {#if !isOnline && !error}
      <div class="res-note">Start the server to see live usage.</div>
    {:else if error}
      <div class="res-note error">{error}</div>
    {/if}
  </div>
</Panel>

<style>
  .res { display: flex; flex-direction: column; gap: 6px; }
  .res-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 4px; }
  .res-label { color: var(--text-secondary); font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .res-value { color: var(--text); font-family: var(--font-mono); font-size: 0.82rem; font-variant-numeric: tabular-nums; }
  .res-value.dim { color: var(--text-disabled); }
  .res-sub { color: var(--text-disabled); font-size: 0.7rem; }
  .res-note { margin-top: 4px; color: var(--text-disabled); font-size: 0.72rem; }
  .res-note.error { color: var(--danger); }
</style>