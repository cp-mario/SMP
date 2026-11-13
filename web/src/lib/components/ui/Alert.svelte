<script>
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";

  /**
   * Visual feedback banner for inline errors, success messages and hints.
   * Renders nothing when `message` is empty.
   */
  let {
    message = "",
    tone = "info",
    title = "",
    dismissible = false,
    class: className = "",
    children = undefined,
    ondismiss = undefined,
  } = $props();

  const TONES = ["info", "success", "warning", "danger", "accent"];
  const ICONS = { info: "info", success: "check-circle", warning: "alert", danger: "alert", accent: "sparkles" };
  const resolvedTone = $derived(TONES.includes(tone) ? tone : "info");
</script>

{#if message || children}
  <div class={cx("alert", `alert-${resolvedTone}`, className)} role={resolvedTone === "danger" ? "alert" : "status"}>
    <span class="alert-icon" aria-hidden="true"><Icon name={ICONS[resolvedTone]} size={16} /></span>
    <div class="alert-main">
      {#if title}<div class="alert-title">{title}</div>{/if}
      <div class="alert-text">
        {#if children}{@render children()}{:else}{message}{/if}
      </div>
    </div>
    {#if dismissible}
      <button class="alert-close" type="button" aria-label="Dismiss" onclick={() => ondismiss?.()}>
        <Icon name="x" size={13} />
      </button>
    {/if}
  </div>
{/if}

<style>
  .alert {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    color: var(--text);
    font-size: 0.83rem;
    line-height: 1.45;
    background: var(--panel-elevated);
    border: 1px solid var(--border);
    border-left-width: 2px;
    border-radius: var(--radius);
  }
  .alert-icon { display: inline-flex; flex: 0 0 auto; margin-top: 1px; }
  .alert-main { min-width: 0; flex: 1; }
  .alert-title { font-weight: 700; margin-bottom: 2px; }
  .alert-text { color: inherit; }
  .alert-text :global(a) { text-decoration: underline; text-underline-offset: 2px; }
  .alert-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    color: inherit;
    opacity: 0.65;
    border-radius: var(--radius-xs);
  }
  .alert-close:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); }
  .alert-info { border-left-color: var(--info); background: color-mix(in srgb, var(--info) 7%, var(--panel-elevated)); }
  .alert-info .alert-icon { color: var(--info); }
  .alert-success { border-left-color: var(--success); background: color-mix(in srgb, var(--success) 7%, var(--panel-elevated)); }
  .alert-success .alert-icon { color: var(--success); }
  .alert-warning { border-left-color: var(--warning); background: color-mix(in srgb, var(--warning) 7%, var(--panel-elevated)); }
  .alert-warning .alert-icon { color: var(--warning); }
  .alert-danger { border-left-color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, var(--panel-elevated)); }
  .alert-danger .alert-icon { color: var(--danger); }
  .alert-accent { border-left-color: var(--accent); background: var(--accent-soft); }
  .alert-accent .alert-icon { color: var(--accent); }
</style>
