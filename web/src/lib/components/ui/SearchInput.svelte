<script>
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";
  import TextField from "./TextField.svelte";

  /** Search box with a leading magnifier and a clear button. */
  let {
    value = $bindable(""),
    placeholder = "Search…",
    label = "",
    hint = "",
    disabled = false,
    class: className = "",
    oninput = undefined,
    onkeydown = undefined,
  } = $props();

  function clear() {
    value = "";
    oninput?.({ currentTarget: { value: "" } });
  }
</script>

<TextField
  class={cx("search-field", className)}
  type="search"
  {value}
  {placeholder}
  {label}
  {hint}
  {disabled}
  autocomplete="off"
  oninput={(e) => { value = e.currentTarget.value; oninput?.(e); }}
  {onkeydown}
>
  {#snippet children()}
    <span class="search-icon" aria-hidden="true"><Icon name="search" size={15} /></span>
    {#if value}
      <button class="search-clear" type="button" aria-label="Clear search" onclick={clear}>
        <Icon name="x" size={12} />
      </button>
    {/if}
  {/snippet}
</TextField>

<style>
  .search-clear {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    color: var(--text-secondary);
    background: var(--panel-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
  }
  .search-clear:hover { color: var(--text); background: var(--panel-hover); border-color: var(--border-secondary); }
  .search-icon {
    position: absolute;
    left: 11px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-disabled);
    pointer-events: none;
    display: inline-flex;
  }
  :global(.search-field .field-control .input) { padding-left: 34px; padding-right: 34px; }
</style>
