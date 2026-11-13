<script>
  import { cx } from "./cx.js";

  /**
   * Bootstrap spinner / skeleton block.
   * `variant="spinner"` renders a spinner, `variant="block"` a pulsing placeholder.
   */
  let {
    variant = "spinner",
    size = 20,
    label = "Loading…",
    width = "100%",
    height = 14,
    radius = 6,
    class: className = "",
  } = $props();
</script>

{#if variant === "spinner"}
  <span class={cx("spinner-wrap", className)} role="status" aria-label={label}>
    <span class="spinner" style="width:{size}px;height:{size}px;border-width:{Math.max(2, Math.round(size / 10))}px"></span>
    {#if label}<span class="spinner-label">{label}</span>{/if}
  </span>
{:else}
  <span class={cx("skeleton", className)} style="width:{width};height:{height}px;border-radius:{radius}px" aria-hidden="true"></span>
{/if}

<style>
  .spinner-wrap { display: inline-flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 0.82rem; }
  .spinner {
    display: inline-block;
    border-style: solid;
    border-color: var(--border-secondary);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: uispin 0.8s linear infinite;
    flex: 0 0 auto;
  }
  @keyframes uispin { to { transform: rotate(360deg); } }
  .skeleton {
    display: block;
    background: linear-gradient(90deg, var(--panel-elevated), var(--border-secondary), var(--panel-elevated));
    background-size: 200% 100%;
    animation: uipulse 1.4s ease-in-out infinite;
  }
  @keyframes uipulse {
    0% { background-position: 200% 0; opacity: 0.7; }
    50% { opacity: 1; }
    100% { background-position: -200% 0; opacity: 0.7; }
  }
</style>