<script>
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";

  /**
   * Empty state block with an optional icon, title, description and action snippet.
   * `icon` accepts a name from the shared Icon set.
   */
  let {
    icon = "",
    title = "",
    description = "",
    size = "md",
    class: className = "",
    children = undefined,
  } = $props();
</script>

<div class={cx("empty-state", size === "sm" && "empty-sm", className)}>
  {#if icon}<div class="empty-icon" aria-hidden="true"><Icon name={icon} size={size === "sm" ? 20 : 24} /></div>{/if}
  {#if title}<div class="empty-title">{title}</div>{/if}
  {#if description}<div class="empty-desc">{description}</div>{/if}
  {#if children}<div class="empty-actions">{@render children()}</div>{/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 48px 24px;
    color: var(--text-secondary);
    text-align: center;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.015), transparent);
    border: 1px dashed var(--border-secondary);
    border-radius: var(--radius-lg);
  }
  .empty-sm { padding: 28px 16px; gap: 6px; }
  .empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    margin-bottom: 2px;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent-ring);
    border-radius: var(--radius);
  }
  .empty-sm .empty-icon { width: 36px; height: 36px; }
  .empty-title { color: var(--text); font-weight: 700; font-size: 0.95rem; letter-spacing: -0.01em; }
  .empty-desc { max-width: 46ch; font-size: 0.83rem; line-height: 1.5; }
  .empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }
</style>
