<script>
  import { toasts } from "../../toast.js";
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";

  const ICONS = {
    success: "check-circle",
    error: "alert",
    warning: "alert",
    info: "info",
  };
</script>

<div class="toast-container" role="region" aria-label="Notifications">
  {#each $toasts as t (t.id)}
    <div class={cx("toast", `toast-${t.type}`)} role={t.type === "error" ? "alert" : "status"}>
      <span class="toast-icon" aria-hidden="true"><Icon name={ICONS[t.type] || ICONS.info} size={16} /></span>
      <span class="toast-text">{t.message}</span>
      <button class="toast-close" type="button" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}>
        <Icon name="x" size={13} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    right: 22px;
    bottom: 24px;
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    max-width: min(420px, calc(100vw - 32px));
    pointer-events: none;
  }
  @media (max-width: 900px) {
    .toast-container { bottom: calc(76px + env(safe-area-inset-bottom)); right: 12px; left: 12px; max-width: none; }
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 11px 12px;
    color: var(--text);
    font-size: 0.82rem;
    line-height: 1.4;
    background: linear-gradient(180deg, var(--panel-elevated), var(--panel));
    border: 1px solid var(--border-secondary);
    border-left-width: 2px;
    border-radius: var(--radius);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), var(--shadow-lg);
    animation: toastin 0.2s var(--ease-out);
  }
  @keyframes toastin { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .toast-icon { display: inline-flex; flex: 0 0 auto; margin-top: 1px; }
  .toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .toast-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    color: inherit;
    opacity: 0.55;
    border-radius: var(--radius-xs);
  }
  .toast-close:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); }
  .toast-success { border-left-color: var(--success); }
  .toast-success .toast-icon { color: var(--success); }
  .toast-error { border-left-color: var(--danger); }
  .toast-error .toast-icon { color: var(--danger); }
  .toast-warning { border-left-color: var(--warning); }
  .toast-warning .toast-icon { color: var(--warning); }
  .toast-info { border-left-color: var(--info); }
  .toast-info .toast-icon { color: var(--info); }
</style>
