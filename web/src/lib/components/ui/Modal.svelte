<script module>
  // Several modals can be open at once (confirm on top of a form). Reference-count the
  // scroll lock so closing one does not unlock the page while another is still visible.
  let lockCount = 0;
  let prevOverflow = "";
  let prevPadding = "";

  function lockScroll() {
    if (typeof document === "undefined") return;
    if (lockCount === 0) {
      const body = document.body;
      const before = body.getBoundingClientRect().width;
      prevOverflow = body.style.overflow;
      prevPadding = body.style.paddingRight;
      body.style.overflow = "hidden";
      // Compensate only when the body actually gets wider (the scrollbar
      // disappeared). With `scrollbar-gutter: stable` the width does not change,
      // so adding padding here would shift the page instead of preventing it.
      const gap = body.getBoundingClientRect().width - before;
      if (gap > 0) body.style.paddingRight = `${gap}px`;
    }
    lockCount++;
  }

  function unlockScroll() {
    if (typeof document === "undefined" || lockCount === 0) return;
    lockCount--;
    if (lockCount === 0) {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPadding;
    }
  }
</script>

<script>
  import { fade, fly } from "svelte/transition";
  import { cx } from "./cx.js";
  import Icon from "./Icon.svelte";

  /**
   * Modal shell with backdrop click, Escape handling, focus trap and scroll lock.
   * `bind:open` toggles visibility; the body is a snippet so callers keep full layout control.
   */
  let {
    open = $bindable(false),
    title = "",
    subtitle = "",
    size = "md",
    dismissible = true,
    closeOnBackdrop = true,
    class: className = "",
    children = undefined,
    footer,
    onclose = undefined,
  } = $props();

  const SIZES = { sm: 420, md: 600, lg: 820, xl: 1100, full: 1680 };
  // Modal-to-modal switches must crossfade: the outgoing overlay fades out while
  // the incoming one fades in, so the page backdrop never flashes through.
  const reduceMotion = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const backdropMs = reduceMotion ? 0 : 180;
  const panelMs = reduceMotion ? 0 : 220;
  let panelEl = $state(null);
  let lastFocus = null;

  function requestClose() {
    if (!dismissible) return;
    open = false;
    onclose?.();
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== "Tab" || !panelEl) return;
    const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodes = [...panelEl.querySelectorAll(selector)].filter((el) => el.getClientRects?.().length || el === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  $effect(() => {
    if (open) {
      lastFocus = document.activeElement;
      lockScroll();
      let cancelled = false;
      requestAnimationFrame(() => {
        if (cancelled || !panelEl) return;
        // Prefer a real field over the close button, so opening a form puts the caret in it.
        const auto = panelEl.querySelector("[data-autofocus]")
          || panelEl.querySelector('input:not([type="hidden"]), textarea, select')
          || panelEl.querySelector("button")
          || panelEl;
        auto.focus?.();
      });
      return () => {
        cancelled = true;
        unlockScroll();
        try { if (lastFocus?.isConnected) lastFocus.focus?.(); } catch { /* ignore */ }
      };
    }
  });
</script>

{#if open}
  <div
    class={cx("modal-overlay", size === "full" && "modal-overlay-full", className)}
    style="--modal-w:{SIZES[size] || SIZES.md}px"
    role="presentation"
    onclick={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) requestClose(); }}
    onkeydown={onKeydown}
    transition:fade={{ duration: backdropMs }}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-label={title || "Dialog"} tabindex="-1" bind:this={panelEl} transition:fly={{ y: 14, duration: panelMs }}>
      {#if title || dismissible}
        <div class="modal-header">
          <div class="modal-heading">
            <div class="modal-title">{title}</div>
            {#if subtitle}<div class="modal-subtitle">{subtitle}</div>{/if}
          </div>
          {#if dismissible}
            <button class="modal-close" type="button" aria-label="Close" onclick={requestClose}>
              <Icon name="x" size={15} />
            </button>
          {/if}
        </div>
      {/if}
      <div class="modal-body">
        {#if children}
          {@render children?.()}
        {:else if $$slots.children}
          <slot name="children" />
        {:else}
          <slot />
        {/if}
      </div>
      {#if footer}
        <div class="form-actions modal-footer">{@render footer()}</div>
      {:else if $$slots.footer}
        <div class="form-actions modal-footer"><slot name="footer" /></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-overlay { align-items: center; justify-content: center; }
  .modal { max-width: var(--modal-w); }
  .modal-heading { min-width: 0; }
  .modal-subtitle { color: var(--text-secondary); font-size: 0.8rem; margin-top: 3px; }
  .modal:focus { outline: none; }
  .modal-footer {
    padding: 14px 20px 18px;
    margin-top: 0;
    border-top: 1px solid var(--border);
    justify-content: flex-end;
    background: color-mix(in srgb, var(--panel-elevated) 55%, transparent);
    position: sticky;
    bottom: 0;
    z-index: 2;
  }

  /* Near full-screen dialog used by the mod store: the body scrolls, the header and footer stay put. */
  .modal-overlay-full { padding: 12px; }
  .modal-overlay-full .modal {
    width: 100%;
    max-width: min(var(--modal-w), calc(100vw - 24px));
    height: calc(100vh - 100px);
    max-height: calc(100vh - 100px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .modal-overlay-full :global(.modal-body) { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px 20px 22px; }
  .modal-overlay-full :global(.modal-footer) { flex: 0 0 auto; }
</style>
