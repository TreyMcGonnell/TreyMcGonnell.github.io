// The "Quiet → Firing" scale shared by the towers, the legend and the skyline windows. Test D4.
const STOPS: [number, [number, number, number]][] = [
  [0, [34, 44, 82]],
  [0.45, [116, 84, 120]],
  [0.8, [255, 181, 71]],
  [1, [255, 240, 200]],
];

export function heatRGB(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    if (x <= p1) {
      const [p0, c0] = STOPS[i - 1];
      const t = (x - p0) / (p1 - p0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function heat(v: number): string {
  const [r, g, b] = heatRGB(v);
  return `rgb(${r},${g},${b})`;
}

/** Diverging scale for embedding numbers: blue negative, amber positive, quiet zero. */
export function diverge(v: number, scale: number): string {
  const t = Math.max(-1, Math.min(1, v / (scale || 1)));
  const zero = [34, 44, 82], neg = [76, 166, 232], pos = [255, 181, 71];
  const to = t < 0 ? neg : pos, m = Math.abs(t);
  return `rgb(${zero.map((z, k) => Math.round(z + (to[k] - z) * m)).join(',')})`;
}
