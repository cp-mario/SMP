/**
 * Scroll helpers for long option lists.
 *
 * Kept framework-free so the behaviour is testable without a browser and can be reused by any
 * list that needs to reveal a selected item.
 */

/** @param {any} el */
function isElement(el) {
  return !!el && typeof el === "object" && typeof el.getBoundingClientRect === "function";
}

/**
 * Scroll `container` so `target` is fully visible.
 *
 * Only scrolls when needed, so opening a list does not jump when the item is already visible.
 *
 * @param {Element|null|undefined} container
 * @param {Element|null|undefined} target
 * @param {{ behavior?: ScrollBehavior, block?: ScrollLogicalPosition, inline?: ScrollLogicalPosition }} [options]
 */
export function revealInList(container, target, options = {}) {
  if (!isElement(container) || !isElement(target)) return false;
  const { behavior = "auto", block = "nearest", inline = "nearest" } = options;

  // Prefer scrolling only the list: Element.scrollIntoView also scrolls the page,
  // modal and every other scrollable ancestor, which is what made the picker jump.
  try {
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (c.height && t.height && typeof container.scrollTo === "function") {
      const top = t.top - c.top + container.scrollTop;
      const left = t.left - c.left + container.scrollLeft;
      let nextTop = container.scrollTop;
      let nextLeft = container.scrollLeft;
      if (block === "start") nextTop = top;
      else if (block === "center") nextTop = top - (c.height - t.height) / 2;
      else if (block === "end") nextTop = top - (c.height - t.height);
      else {
        if (top < container.scrollTop) nextTop = top;
        else if (top + t.height > container.scrollTop + c.height) nextTop = top + t.height - c.height;
      }
      if (inline === "start") nextLeft = left;
      else if (inline === "center") nextLeft = left - (c.width - t.width) / 2;
      else if (inline === "end") nextLeft = left - (c.width - t.width);
      else {
        if (left < container.scrollLeft) nextLeft = left;
        else if (left + t.width > container.scrollLeft + c.width) nextLeft = left + t.width - c.width;
      }
      if (nextTop !== container.scrollTop || nextLeft !== container.scrollLeft) {
        container.scrollTo({ top: nextTop, left: nextLeft, behavior });
      }
      return true;
    }
  } catch { /* fall through to scrollIntoView */ }

  try {
    target.scrollIntoView({ behavior, block, inline });
    return true;
  } catch {
    try { target.scrollIntoView(false); return true; } catch { return false; }
  }
}

/**
 * Find the element marked as selected inside a list.
 * @param {Element|null|undefined} container
 * @param {string} [selector]
 */
export function findSelected(container, selector = "[data-selected='true']") {
  if (!isElement(container) || typeof container.querySelector !== "function") return null;
  try { return container.querySelector(selector); } catch { return null; }
}

/**
 * Reveal the selected entry of a list (no-op when nothing is selected).
 *
 * @param {Element|null|undefined} container
 * @param {{ selector?: string, behavior?: ScrollBehavior } | Element|null} [options]
 */
export function scrollToSelected(container, options = {}) {
  const opts = /** @type {{ selector?: string, behavior?: ScrollBehavior }} */ (
    isElement(options) ? {} : (options || {})
  );
  const target = findSelected(container, opts.selector);
  if (!target) return false;
  return revealInList(container, target, { behavior: opts.behavior });
}

/**
 * True when `target` is fully inside `container`'s box.
 *
 * Returns false when there is no layout (all rects are zero, e.g. jsdom), because we cannot
 * prove visibility then — callers should scroll instead of assuming it is visible.
 *
 * @param {any} container
 * @param {any} target
 */
export function isVisibleInList(container, target) {
  if (!isElement(container) || !isElement(target)) return false;
  const c = container.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  if (!c.height || !t.height) return false;
  return t.top >= c.top - 1 && t.bottom <= c.bottom + 1;
}

/** Convenience used by components: scroll a list to an id using a data attribute. */
export function scrollToId(container, id, attr = "data-version") {
  if (!isElement(container) || typeof container.querySelector !== "function") return false;
  const css = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(String(id)) : String(id).replace(/["\\]/g, "\\$&");
  let el = null;
  try { el = container.querySelector(`[${attr}="${css}"]`); } catch { el = null; }
  if (!el || isVisibleInList(container, el)) return false; // already visible: do not scroll
  return revealInList(container, el);
}

/** Kept as an alias so callers can express intent ("make sure this is visible"). */
export const scrollIntoViewList = revealInList;