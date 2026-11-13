<script>
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";

  /** Panel container with an optional icon, header, body and actions. */
  let {
    title = "",
    subtitle = "",
    icon = "",
    actions = null,
    flush = false,
    class: className = "",
    children = undefined,
  } = $props();
</script>

<section class={cx("panel", className)}>
  {#if title || actions}
    <header class="panel-header">
      <div class="panel-heading">
        {#if icon}<span class="panel-icon"><Icon name={icon} size={15} /></span>{/if}
        <span class="panel-title">{title}</span>
        {#if subtitle}<span class="panel-subtitle">{subtitle}</span>{/if}
      </div>
      {#if actions}<div class="panel-actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class={cx("panel-body", flush && "panel-body-flush")}>{@render children?.()}</div>
</section>

<style>
  .panel-header { flex-wrap: wrap; }
  .panel-heading { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .panel-icon { display: inline-flex; color: var(--accent); }
  .panel-title { font-size: 0.73rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-secondary); }
  .panel-subtitle { font-size: 0.73rem; color: var(--text-disabled); text-transform: none; letter-spacing: 0; font-weight: 500; }
  .panel-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .panel-body-flush { padding: 0; }
</style>
