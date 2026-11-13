<script>
  import { cx } from "./cx.js";

  /**
   * Button with the shared visual variants. Renders <button> by default,
   * or an <a> when `href` is provided.
   */
  let {
    variant = "secondary",
    size = "md",
    href = null,
    type = "button",
    disabled = false,
    loading = false,
    idle = false,
    title = null,
    class: className = "",
    children = undefined,
    onclick = undefined,
    ...rest
  } = $props();

  const VARIANTS = ["primary", "secondary", "outline", "danger", "ghost", "subtle"];
  const SIZES = ["xs", "sm", "md"];

  let classes = $derived(cx("btn", `btn-${VARIANTS.includes(variant) ? variant : "secondary"}`, size !== "md" && `btn-${SIZES.includes(size) ? size : "sm"}`, idle && "btn-idle", className));
  let isDisabled = $derived(disabled || loading);
  let label = $derived(children ?? (loading ? "Loading…" : ""));
  let resolvedType = $derived(/** @type {"button"|"submit"|"reset"} */ (type === "submit" || type === "reset" ? type : "button"));
</script>

{#if href && !isDisabled}
  <a class={classes} {href} {title} onclick={onclick} {...rest}>{@render label()}</a>
{:else}
  <button class={classes} type={resolvedType} disabled={isDisabled} {title} aria-busy={loading || undefined} onclick={onclick} {...rest}>
    {#if loading}<span class="btn-spinner" aria-hidden="true"></span>{/if}
    {@render label()}
  </button>
{/if}

<style>
  .btn-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    display: inline-block;
    animation: btnspin 0.7s linear infinite;
    flex: 0 0 auto;
  }
  @keyframes btnspin { to { transform: rotate(360deg); } }
</style>