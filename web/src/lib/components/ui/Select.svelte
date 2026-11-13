<script>
  import { cx } from "./cx.js";

  /** Native select wrapper with label, hint and error. */
  let {
    value = $bindable(""),
    label = "",
    hint = "",
    error = "",
    id = null,
    disabled = false,
    required = false,
    options = [],
    class: className = "",
    onchange = undefined,
    children = undefined,
  } = $props();

  let uid = $state(Math.random().toString(36).slice(2, 9));
  let selectId = $derived(id || `ui-select-${uid}`);
  let describedBy = $derived(error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined);
  let classes = $derived(cx("field", error && "field-invalid", className));

  function onChange(e) {
    value = e.currentTarget.value;
    onchange?.(e);
  }
</script>

<div class={classes}>
  {#if label}<label class="label" for={selectId}>{label}</label>{/if}
  <select
    id={selectId}
    class="input select"
    {disabled}
    {required}
    aria-invalid={error ? "true" : undefined}
    aria-describedby={describedBy}
    bind:value={value}
    onchange={onChange}
  >
    {#if children}
      {@render children()}
    {:else}
      {#each options as opt}
        <option value={opt.value ?? opt.id ?? opt}>{opt.label ?? opt.name ?? opt.value ?? opt.id ?? opt}</option>
      {/each}
    {/if}
  </select>
  {#if error}
    <div class="field-msg field-msg-error" id={`${selectId}-error`} role="alert">{error}</div>
  {:else if hint}
    <div class="field-msg" id={`${selectId}-hint`}>{hint}</div>
  {/if}
</div>

<style>
  .field { display: flex; flex-direction: column; min-width: 0; }
  select { width: 100%; }
  .field-msg { font-size: 0.76rem; color: var(--text-secondary); margin-top: 6px; }
  .field-msg-error { color: var(--danger); }
  .field-invalid :global(.select) { border-color: var(--danger); }
</style>