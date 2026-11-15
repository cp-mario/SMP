<script>
  import { cx } from "./cx.js";

  /**
   * Icon set. The markup lives in `src/icons/ui/<name>.svg` and is inlined at
   * build time so it can inherit the surrounding text colour (`currentColor`)
   * and honour the `strokeWidth` prop.
   */
  let {
    name = "info",
    size = 18,
    strokeWidth = 1.75,
    class: className = "",
    label = "",
  } = $props();

  const modules = import.meta.glob("/src/icons/ui/*.svg", {
    query: "?raw",
    import: "default",
    eager: true,
  });

  function innerMarkup(svg) {
    if (!svg) return "";
    const open = svg.indexOf(">");
    const close = svg.lastIndexOf("</svg>");
    if (open === -1 || close === -1 || close <= open) return "";
    return svg.slice(open + 1, close).trim();
  }

  const markup = $derived(
    innerMarkup(modules[`/src/icons/ui/${name}.svg`] || modules["/src/icons/ui/info.svg"] || "")
  );
</script>

<svg
  class={cx("icon", className)}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label || undefined}
>
  {#if label}<title>{label}</title>{/if}
  {@html markup}
</svg>

<style>
  .icon {
    display: inline-block;
    flex: 0 0 auto;
    vertical-align: middle;
  }
</style>