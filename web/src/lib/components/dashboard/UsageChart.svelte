<script>
  /**
   * Minimal dependency-free area/line chart.
   * Values are plotted against `max`; the scale grows when a sample exceeds it.
   */
  let {
    data = [],
    max = 100,
    color = "var(--accent)",
    height = 44,
    label = "usage chart",
  } = $props();

  const W = 100;
  const gradId = `usage-grad-${Math.random().toString(36).slice(2, 9)}`;

  const scaleMax = $derived(Math.max(Number(max) || 0, ...data.map((v) => Number(v) || 0), 1));

  const points = $derived.by(() => {
    const n = data.length;
    if (!n) return "";
    return data
      .map((value, i) => {
        const v = Math.min(Math.max(Number(value) || 0, 0), scaleMax);
        const x = n === 1 ? W : (i / (n - 1)) * W;
        const y = height - (v / scaleMax) * height;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  });

  const area = $derived(points ? `0,${height} ${points} ${W},${height}` : "");
</script>

<div class="usage-chart" style={`--chart-color:${color};--chart-height:${height}px`}>
  <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
    <defs>
      <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color={color} stop-opacity="0.32" />
        <stop offset="100%" stop-color={color} stop-opacity="0" />
      </linearGradient>
    </defs>
    <line x1="0" y1={height} x2={W} y2={height} class="chart-base" />
    {#if points}
      <polygon points={area} fill={`url(#${gradId})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    {/if}
  </svg>
</div>

<style>
  .usage-chart { width: 100%; height: var(--chart-height, 44px); }
  .usage-chart svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .chart-base { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
</style>