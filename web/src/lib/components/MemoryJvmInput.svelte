<script>
  /**
   * Memory (MB) + JVM arguments editor.
   *
   * - `valueMb` / `jvmArgs` are bindable.
   * - `stepMb` sets the slider increment (default: 512 MB).
   * - `maxMb` clamps both the slider and the numeric textbox.
   */
  import Slider from "./ui/Slider.svelte";
  import TextField from "./ui/TextField.svelte";
  import TextArea from "./ui/TextArea.svelte";
  import { cx } from "./ui/cx.js";

  let {
    valueMb = $bindable(2048),
    jvmArgs = $bindable(""),
    maxMb = 8192,
    minMb = 256,
    stepMb = 512,
    showJvmArgs = true,
    showSlider = true,
    showTextbox = true,
    disabled = false,
    label = "RAM",
    hint = "",
    class: className = "",
    onchange = undefined,
  } = $props();

  let text = $state("");
  let lastPushed = $state(null);

  const hi = $derived(Math.max(minMb, Math.floor(Number(maxMb) || minMb)));
  const lo = $derived(Math.max(0, Math.floor(Number(minMb) || 0)));

  function clampMb(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return null;
    return Math.min(Math.max(v, lo), hi);
  }
  function formatMb(mb) {
    const v = clampMb(mb);
    return String(v ?? lo);
  }
  function formatGb(mb) {
    const v = clampMb(mb) ?? lo;
    const g = v / 1024;
    const s = (Math.round(g * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
    return `${s} GB`;
  }
  function parseMb(raw) {
    const s = String(raw ?? "").trim().replace(",", ".");
    if (!s) return null;
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(mb|m)?$/i);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return clampMb(n);
  }
  function sliderMarks(max) {
    const step = Math.max(64, Math.floor(Number(stepMb) || 512));
    // Minimum first (256), then 512, 1024, 1536, 2048… (step increments).
    const marks = [lo];
    const first = Math.ceil((lo + 1) / step) * step;
    for (let m = first; m <= max; m += step) marks.push(m);
    if (!marks.length) marks.push(lo);
    if (marks[marks.length - 1] !== max) marks.push(max);
    return marks;
  }
  const marks = $derived(sliderMarks(hi));

  $effect(() => {
    const v = clampMb(valueMb);
    if (v != null && v !== valueMb) valueMb = v;
    if (valueMb !== lastPushed) {
      text = formatMb(valueMb);
      lastPushed = valueMb;
    }
  });

  function onText(textValue) {
    const parsed = parseMb(textValue);
    if (parsed != null) {
      valueMb = parsed;
      lastPushed = parsed;
      onchange?.(parsed);
    }
  }
  function onSlider(v) {
    valueMb = clampMb(v) ?? lo;
    onchange?.(valueMb);
  }
</script>

<div class={cx("mem", disabled && "is-disabled", className)}>
  <div class="mem-head">
    <span class="mem-label">{label}</span>
    <span class="mem-value">{formatGb(valueMb)}<span class="mem-mb"> · {clampMb(valueMb) ?? lo} MB</span></span>
  </div>
  {#if showSlider}
    <Slider
      value={valueMb}
      min={lo}
      max={hi}
      steps={marks}
      disabled={disabled}
      format={(v) => formatGb(v)}
      onchange={onSlider}
    />
  {/if}
  {#if showTextbox}
    <TextField
      bind:value={text}
      type="text"
      inputmode="numeric"
      placeholder="8448"
      {disabled}
      label="Exact MB"
      hint={hint || `Mín ${lo} MB, máx ${formatGb(hi)} (${hi} MB).`}
      oninput={(e) => onText(e.currentTarget.value)}
      onblur={() => { const parsed = parseMb(text); valueMb = parsed ?? (clampMb(valueMb) ?? lo); text = formatMb(valueMb); lastPushed = valueMb; }}
      onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
    />
  {/if}
  {#if showJvmArgs}
    <TextArea
      bind:value={jvmArgs}
      label="Extra JVM arguments"
      rows={2}
      monospace
      placeholder="-XX:+UseG1GC -Dfile.encoding=UTF-8"
      {disabled}
      hint="Se aplican al iniciar el servidor."
    />
  {/if}
</div>

<style>
  .mem { display: grid; gap: 12px; }
  .mem-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .mem-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); }
  .mem-value { font-size: 0.92rem; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
  .mem-mb { color: var(--text-secondary); font-weight: 500; font-size: 0.78rem; }
  .is-disabled { opacity: 0.7; }
</style>