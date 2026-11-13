<script>
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";

  /** Compact icon-only button with an accessible label. */
  let {
    label = "",
    icon = "",
    variant = "outline",
    size = "sm",
    href = null,
    disabled = false,
    title = null,
    class: className = "",
    children = undefined,
    onclick = undefined,
    ...rest
  } = $props();

  const VARIANTS = ["primary", "secondary", "outline", "danger", "ghost", "subtle"];
  const classes = $derived(cx("btn", `btn-${VARIANTS.includes(variant) ? variant : "outline"}`, size === "sm" ? "btn-sm" : size === "xs" ? "btn-xs" : "", "icon-btn", className));
  const tooltip = $derived(title || label);
</script>

{#if href && !disabled}
  <a class={classes} {href} title={tooltip} aria-label={label} onclick={onclick} {...rest}>
    {#if icon}<Icon name={icon} size={15} />{:else}{@render children?.()}{/if}
  </a>
{:else}
  <button class={classes} type="button" {disabled} title={tooltip} aria-label={label} onclick={onclick} {...rest}>
    {#if icon}<Icon name={icon} size={15} />{:else}{@render children?.()}{/if}
  </button>
{/if}

<style>
  .icon-btn { padding: 6px 8px; min-width: 32px; justify-content: center; }
</style>
