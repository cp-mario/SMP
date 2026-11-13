<script>
  import { cx } from "./cx.js";

  /** List of key/value rows, with optional monospace values and wrapping. */
  let {
    rows = [],
    class: className = "",
    columns = 1,
  } = $props();

  const list = $derived(rows.map((r) => (Array.isArray(r) ? { key: r[0], value: r[1], mono: r[2] } : r)));
</script>

<div class={cx("kv-grid", className)} style="--kv-cols:{columns}">
  {#each list as row}
    <div class="kv-item">
      <span class="kv-k">{row.key}</span>
      <span class={cx("kv-v", row.mono === false && "sans", row.wrap === false && "nowrap")}>{row.value ?? "—"}</span>
    </div>
  {/each}
</div>

<style>
  .kv-grid {
    display: grid;
    grid-template-columns: repeat(var(--kv-cols, 1), minmax(0, 1fr));
    gap: 0 22px;
    padding: 4px 0;
  }
  .kv-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.82rem;
    min-width: 0;
  }
  .kv-item:last-child { border-bottom: none; }
  .kv-k { color: var(--text-secondary); flex: 0 0 auto; }
  .kv-v { color: var(--text); font-family: var(--font-mono); text-align: right; overflow-wrap: anywhere; min-width: 0; font-size: 0.79rem; }
  .kv-v.sans { font-family: var(--font); font-size: 0.82rem; }
  .kv-v.nowrap { white-space: nowrap; }
  @media (max-width: 720px) {
    .kv-grid { grid-template-columns: minmax(0, 1fr); }
  }
</style>
