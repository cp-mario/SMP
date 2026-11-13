<script>
  import { cx } from "./cx.js";

  /** Segmented pill group. `options` entries may be strings or { value, label, hint }. */
  let {
    options = [],
    value = $bindable(null),
    label = "",
    size = "md",
    disabled = false,
    class: className = "",
    onchange = undefined,
  } = $props();

  const normalized = $derived(options.map((o) => (typeof o === "object" && o !== null ? { value: o.value ?? o.id, label: o.label ?? o.name ?? String(o.value ?? o.id), hint: o.hint ?? "", disabled: !!o.disabled } : { value: o, label: String(o), hint: "", disabled: false })));

  function select(v, disabled) {
    if (disabled) return;
    value = v;
    onchange?.(v);
  }
</script>

{#if label}<div class="label">{label}</div>{/if}
<div class={cx("segmented", size === "sm" && "segmented-sm", className)} role="group" aria-label={label || "Options"}>
  {#each normalized as opt}
    <button
      type="button"
      class="segment"
      class:selected={value === opt.value}
      disabled={disabled || opt.disabled}
      aria-pressed={value === opt.value}
      title={opt.hint || undefined}
      onclick={() => select(opt.value, opt.disabled)}
    >{opt.label}</button>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 3px;
    padding: 3px;
    width: fit-content;
    max-width: 100%;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.22);
  }
  .segment {
    padding: 5px 11px;
    color: var(--text-secondary);
    font-size: 0.77rem;
    font-weight: 600;
    white-space: nowrap;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    transition: color var(--t-fast), background var(--t-fast), border-color var(--t-fast);
  }
  .segment:hover:not(:disabled) { color: var(--text); background: var(--panel-elevated); }
  .segment.selected {
    color: var(--text);
    background: var(--panel-elevated);
    border-color: var(--border-secondary);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .segment.selected::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 4px;
    margin-right: 6px;
    margin-bottom: 1px;
    vertical-align: middle;
    background: var(--accent);
    border-radius: 50%;
  }
  .segment:disabled { opacity: 0.5; cursor: not-allowed; }
  .segmented-sm .segment { padding: 4px 9px; font-size: 0.71rem; }
</style>
