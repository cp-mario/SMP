<script>
  import { cx } from "./cx.js";

  /**
   * Text / number / password / search input with label, hint and error message.
   * Values flow both ways through `bind:value`.
   */
  let {
    value = $bindable(""),
    label = "",
    hint = "",
    error = "",
    placeholder = "",
    type = "text",
    id = null,
    name = null,
    disabled = false,
    readonly = false,
    required = false,
    autofocus = false,
    maxlength = undefined,
    inputmode = undefined,
    autocomplete = undefined,
    accept = undefined,
    multiple = false,
    class: className = "",
    oninput = undefined,
    onchange = undefined,
    onblur = undefined,
    onfocus = undefined,
    onkeydown = undefined,
    children = undefined,
    ...rest
  } = $props();

  let uid = $state(Math.random().toString(36).slice(2, 9));
  let inputId = $derived(id || `ui-input-${uid}`);
  let describedBy = $derived(error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined);
  let classes = $derived(cx("field", error && "field-invalid", disabled && "field-disabled", className));

  function handleInput(e) {
    value = e.currentTarget.value;
    oninput?.(e);
  }
</script>

<div class={classes}>
  {#if label}
    <label class="label" for={inputId}>{label}{#if required}<span class="field-required" aria-hidden="true"> *</span>{/if}</label>
  {/if}
  <div class="field-control">
    <input
      id={inputId}
      class="input"
      {type}
      {name}
      {placeholder}
      {disabled}
      {readonly}
      {required}
      {maxlength}
      {inputmode}
      {autocomplete}
      {accept}
      {multiple}
      value={type === "file" ? undefined : value}
      aria-invalid={error ? "true" : undefined}
      aria-describedby={describedBy}
      data-autofocus={autofocus || undefined}
      oninput={handleInput}
      onchange={onchange}
      onblur={onblur}
      onfocus={onfocus}
      onkeydown={onkeydown}
      {...rest}
    />
    {#if children}{@render children()}{/if}
  </div>
  {#if error}
    <div class="field-msg field-msg-error" id={`${inputId}-error`} role="alert">{error}</div>
  {:else if hint}
    <div class="field-msg" id={`${inputId}-hint`}>{hint}</div>
  {/if}
</div>

<style>
  .field { display: flex; flex-direction: column; min-width: 0; }
  .field-control { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .field-required { color: var(--danger); }
  .field-msg { font-size: 0.76rem; color: var(--text-secondary); margin-top: 6px; line-height: 1.35; }
  .field-msg-error { color: var(--danger); }
  .field-invalid :global(.input) { border-color: var(--danger); }
  .field-invalid :global(.input:focus) { box-shadow: 0 0 0 3px rgba(233, 67, 67, 0.18); }
  .field-disabled { opacity: 0.7; }
</style>