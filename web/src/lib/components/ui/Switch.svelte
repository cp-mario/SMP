<script>
  import { cx } from "./cx.js";

  /** Accessible on/off toggle. `checked` is bindable. */
  let {
    checked = $bindable(false),
    label = "",
    hint = "",
    disabled = false,
    size = "md",
    id = null,
    class: className = "",
    onchange = undefined,
  } = $props();

  let uid = $state(Math.random().toString(36).slice(2, 9));
  let inputId = $derived(id || `ui-switch-${uid}`);
  let classes = $derived(cx("switch-field", disabled && "is-disabled", className));

  function onChange(e) {
    checked = e.currentTarget.checked;
    onchange?.(e);
  }
</script>

<div class={classes}>
  <label class="switch" class:sm={size === "sm"} for={inputId}>
    <input id={inputId} type="checkbox" bind:checked={checked} {disabled} onchange={onChange} />
    <span class="slider" aria-hidden="true"></span>
  </label>
  {#if label || hint}
    <label class="switch-text" for={inputId}>
      {#if label}<span class="switch-label">{label}</span>{/if}
      {#if hint}<span class="switch-hint">{hint}</span>{/if}
    </label>
  {/if}
</div>

<style>
  .switch-field { display: flex; align-items: flex-start; gap: 10px; }
  .switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: 0 0 auto; margin-top: 2px; }
  .switch.sm { width: 32px; height: 18px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute;
    inset: 0;
    cursor: pointer;
    background: #3f3f46;
    transition: background 0.18s ease;
    border-radius: 999px;
  }
  .slider::before {
    content: "";
    position: absolute;
    height: 16px;
    width: 16px;
    left: 3px;
    bottom: 3px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.18s ease;
  }
  .switch.sm .slider::before { height: 12px; width: 12px; }
  input:checked + .slider { background: var(--accent); }
  input:checked + .slider::before { transform: translateX(18px); }
  .switch.sm input:checked + .slider::before { transform: translateX(14px); }
  input:focus-visible + .slider { box-shadow: 0 0 0 3px var(--accent-light); }
  input:disabled + .slider { opacity: 0.5; cursor: not-allowed; }
  .switch-text { display: flex; flex-direction: column; gap: 1px; cursor: pointer; min-width: 0; }
  .switch-label { font-size: 0.86rem; color: var(--text); }
  .switch-hint { font-size: 0.75rem; color: var(--text-secondary); }
  .is-disabled .switch-text { cursor: not-allowed; opacity: 0.7; }
</style>