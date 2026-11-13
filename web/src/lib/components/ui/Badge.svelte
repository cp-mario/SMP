<script>
  import { cx } from "./cx.js";

  /** Small uppercase status label. */
  let {
    tone = "neutral",
    dot = false,
    class: className = "",
    children = undefined,
    title = null,
  } = $props();

  const TONES = ["neutral", "success", "danger", "warning", "info", "accent"];
</script>

<span class={cx("badge", tone !== "neutral" && `badge-${TONES.includes(tone) ? tone : "neutral"}`, dot && "badge-dot", className)} {title}>{@render children()}</span>

<style>
  .badge { display: inline-flex; align-items: center; gap: 5px; }
  .badge-dot::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    flex: 0 0 auto;
  }
</style>
