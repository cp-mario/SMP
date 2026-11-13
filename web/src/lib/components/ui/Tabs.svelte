<script>
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";

  /** Controlled tab bar. Items may be strings or `{ value, label, icon, badge }`. */
  let {
    items = [],
    value = $bindable(null),
    size = "md",
    stretch = false,
    class: className = "",
    onchange = undefined,
  } = $props();

  const normalized = $derived(
    items.map((i) =>
      typeof i === "object" && i !== null
        ? {
            value: i.value ?? i.id,
            label: i.label ?? i.name ?? String(i.value ?? i.id),
            icon: i.icon ?? "",
            badge: i.badge ?? null,
            disabled: !!i.disabled,
          }
        : { value: i, label: String(i), icon: "", badge: null, disabled: false }
    )
  );

  function select(v, disabled) {
    if (disabled) return;
    value = v;
    onchange?.(v);
  }
</script>

<div class={cx("tabs", size === "sm" && "tabs-sm", stretch && "tabs-stretch", className)} role="tablist">
  {#each normalized as item}
    <button
      class="tab-btn"
      class:active={value === item.value}
      type="button"
      role="tab"
      aria-selected={value === item.value}
      disabled={item.disabled}
      onclick={() => select(item.value, item.disabled)}
    >
      {#if item.icon}<Icon name={item.icon} size={15} />{/if}
      <span>{item.label}</span>
      {#if item.badge != null && item.badge > 0}<span class="tab-badge">{item.badge}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    width: fit-content;
    max-width: 100%;
    margin-bottom: 20px;
    padding: 4px;
    overflow-x: auto;
    background: color-mix(in srgb, var(--panel) 82%, transparent);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.22);
  }
  .tab-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 7px 13px;
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 600;
    white-space: nowrap;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }
  .tab-btn:hover:not(:disabled) { color: var(--text); background: var(--panel-elevated); }
  .tab-btn.active {
    color: var(--text);
    background: var(--panel-elevated);
    border-color: var(--border-secondary);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), var(--shadow-xs);
  }
  .tab-btn.active :global(.icon) { color: var(--accent); }
  .tabs-stretch { width: 100%; }
  .tabs-stretch .tab-btn { flex: 1; }
  .tabs-sm .tab-btn { padding: 5px 10px; font-size: 0.74rem; }
  .tab-badge {
    min-width: 18px;
    padding: 1px 5px;
    color: var(--accent);
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
    background: var(--accent-light);
    border-radius: 4px;
  }
  .tab-btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
