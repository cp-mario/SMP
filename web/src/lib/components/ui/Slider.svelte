<script>
  import { cx } from "./cx.js";

  /**
   * Range slider with optional value bubble and a numeric read-out.
   * `value` is bindable; when `steps` is supplied the slider snaps to those values
   * (no tick buttons: selection is done by dragging the bar).
   */
  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    steps = null,
    label = "",
    hint = "",
    disabled = false,
    format = (v) => String(v),
    id = null,
    class: className = "",
    onchange = undefined,
  } = $props();

  let uid = $state(Math.random().toString(36).slice(2, 9));
  let sliderId = $derived(id || `ui-range-${uid}`);

  // When `steps` is supplied the slider works on indexes (discrete jumps), otherwise on raw values.
  let marks = $derived.by(() => {
    if (!steps || !steps.length) return [];
    return steps.map((v) => (typeof v === "object" ? (v.value ?? v.id) : v));
  });
  let discrete = $derived(marks.length > 0);
  let lo = $derived(discrete ? 0 : Number(min));
  let hi = $derived(discrete ? Math.max(0, marks.length - 1) : Number(max));
  let index = $derived.by(() => {
    const v = Number(value);
    if (discrete) {
      let idx = 0;
      for (let i = 0; i < marks.length; i++) if (marks[i] <= v) idx = i;
      return idx;
    }
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  });
  let percent = $derived(hi > lo ? ((index - lo) / (hi - lo)) * 100 : 0);

  function commit(e) {
    const raw = Number(e.currentTarget.value);
    const next = discrete ? (marks[Math.max(0, Math.min(marks.length - 1, Math.round(raw)))] ?? value) : raw;
    value = next;
    onchange?.(next);
  }
</script>

<div class={cx("range", disabled && "is-disabled", className)}>
  {#if label}
    <div class="range-head">
      <label class="label" for={sliderId}>{label}</label>
      <output class="range-value" for={sliderId}>{format(value)}</output>
    </div>
  {/if}
  <input
    id={sliderId}
    class="range-input"
    type="range"
    min={lo}
    max={hi}
    step={discrete ? 1 : (step || 1)}
    value={index}
    {disabled}
    style="--pct:{percent}%"
    aria-valuetext={format(value)}
    oninput={commit}
  />
  {#if hint}<div class="range-hint">{hint}</div>{/if}
</div>

<style>
  .range { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .range-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .range-value { color: var(--accent); font-size: 0.84rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .range-input {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 5px;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--accent) 0%, var(--accent) var(--pct), var(--border-secondary) var(--pct), var(--border-secondary) 100%);
    outline: none;
    cursor: pointer;
  }
  .range-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--panel-elevated);
    border: 2px solid var(--accent);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
    cursor: grab;
    transition: transform var(--t-fast), background var(--t-fast);
  }
  .range-input::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--panel-elevated);
    border: 2px solid var(--accent);
    cursor: grab;
  }
  .range-input:hover::-webkit-slider-thumb { background: var(--accent-light); }
  .range-input:active::-webkit-slider-thumb { cursor: grabbing; transform: scale(1.08); }
  .range-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .range-hint { font-size: 0.76rem; color: var(--text-secondary); line-height: 1.35; }
  .is-disabled { opacity: 0.75; }
</style>