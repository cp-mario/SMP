<script>
  import { cx } from "./cx.js";

  /** Multi-line text input with optional character counter. */
  let {
    value = $bindable(""),
    label = "",
    hint = "",
    error = "",
    placeholder = "",
    rows = 3,
    id = null,
    disabled = false,
    readonly = false,
    required = false,
    maxlength = undefined,
    monospace = false,
    class: className = "",
    oninput = undefined,
    onblur = undefined,
    children = undefined,
    ...rest
  } = $props();

  let uid = $state(Math.random().toString(36).slice(2, 9));
  let areaId = $derived(id || `ui-textarea-${uid}`);
  let describedBy = $derived(error ? `${areaId}-error` : hint ? `${areaId}-hint` : undefined);
  let length = $derived(String(value ?? "").length);
  let classes = $derived(cx("field", error && "field-invalid", className));

  function handleInput(e) {
    value = e.currentTarget.value;
    oninput?.(e);
  }
</script>

<div class={classes}>
  {#if label}
    <div class="field-head">
      <label class="label" for={areaId}>{label}{#if required}<span class="field-required"> *</span>{/if}</label>
      {#if maxlength}<span class="field-count" class:near={length > maxlength * 0.9}>{length}/{maxlength}</span>{/if}
    </div>
  {/if}
  <textarea
    id={areaId}
    class="input"
    class:mono={monospace}
    {rows}
    {placeholder}
    {disabled}
    {readonly}
    {required}
    {maxlength}
    value={value}
    aria-invalid={error ? "true" : undefined}
    aria-describedby={describedBy}
    oninput={handleInput}
    onblur={onblur}
    {...rest}
  ></textarea>
  {#if error}
    <div class="field-msg field-msg-error" id={`${areaId}-error`} role="alert">{error}</div>
  {:else if hint}
    <div class="field-msg" id={`${areaId}-hint`}>{hint}</div>
  {/if}
  {#if children}{@render children()}{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; min-width: 0; }
  .field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .field-count { font-size: 0.72rem; color: var(--text-disabled); font-variant-numeric: tabular-nums; }
  .field-count.near { color: var(--warning); }
  .field-required { color: var(--danger); }
  textarea { resize: vertical; min-height: 64px; line-height: 1.5; }
  .mono { font-family: var(--font-mono); font-size: 0.82rem; }
  .field-msg { font-size: 0.76rem; color: var(--text-secondary); margin-top: 6px; }
  .field-msg-error { color: var(--danger); }
  .field-invalid :global(.input) { border-color: var(--danger); }
</style>