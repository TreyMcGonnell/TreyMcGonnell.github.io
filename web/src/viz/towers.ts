// 28 layers drawn as towers, each window one tracked neuron. One canvas per tower set.
import { heat } from './heat';

export interface TowerOptions {
  layers: number;
  rows: number;
  /** layers x rows values in 0..1 (row-major by layer). Null draws a quiet city. */
  values?: Float32Array | null;
  mode?: 'heat' | 'quiet' | 'sweep';
  /** 1-based layer the prefill sweep has reached (sweep mode). */
  sweep?: number;
  /** The strongest neuron: 1-based layer and window row (null row = not one of the shown windows). */
  hot?: { layer: number; row: number | null } | null;
  /** Draw a leader line from the canvas top edge to the hot window (the callout sits on that edge). */
  leader?: boolean;
  labels?: number[];
  towerW?: number;
  win?: number;
  gap?: number;
  labelH?: number;
  seed?: number;
}

export interface TowerLayout { towerX: (layer: number) => number; hotPoint: { x: number; y: number } | null }

function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws into `canvas` sized to its CSS box (width x height in CSS px) and returns where things landed. */
export function drawTowers(canvas: HTMLCanvasElement, width: number, height: number, o: TowerOptions): TowerLayout {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const g = canvas.getContext('2d');
  const towerW = o.towerW ?? 15, win = o.win ?? 7, gap = o.gap ?? 3, labelH = o.labelH ?? 20;
  const L = o.layers, R = o.rows, mode = o.mode ?? (o.values ? 'heat' : 'quiet');
  const step = L > 1 ? (width - towerW) / (L - 1) : 0;
  const towerX = (layer: number) => (layer - 1) * step; // left edge, 1-based layer
  const bodyBottom = height - labelH;
  const windowsH = R * (win + gap) - gap;
  const r = rng(o.seed ?? 1818);
  let hotPoint: TowerLayout['hotPoint'] = null;
  if (!g) return { towerX, hotPoint };
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);

  for (let layer = 1; layer <= L; layer++) {
    const cap = 3 + Math.floor(r() * 4) * 3;
    const antenna = r() < 0.35 ? 8 : 0;
    const x = towerX(layer);
    const top = bodyBottom - 1 - 3 - windowsH - cap - 1;
    // tower body
    g.fillStyle = '#1A2148';
    g.fillRect(x, top, towerW, bodyBottom - top);
    g.strokeStyle = 'rgba(160,190,255,0.14)';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, top + 0.5, towerW - 1, bodyBottom - top - 1);
    if (antenna) {
      g.strokeStyle = 'rgba(160,190,255,0.35)';
      g.beginPath(); g.moveTo(x + towerW / 2, top); g.lineTo(x + towerW / 2, top - antenna); g.stroke();
    }
    // windows, top row = row 0
    const wx = x + (towerW - win) / 2;
    for (let row = 0; row < R; row++) {
      const wy = bodyBottom - 1 - 3 - windowsH + row * (win + gap);
      let fill = heat(0);
      let v = 0;
      if (mode === 'heat' && o.values) {
        v = o.values[(layer - 1) * R + row] ?? 0;
        fill = heat(v);
      } else if (mode === 'sweep' && o.sweep !== undefined) {
        if (layer < o.sweep) fill = 'rgb(66,64,108)';
        else if (layer === o.sweep) fill = heat(0.62 + 0.3 * ((row * 7 + layer) % 5) / 4);
      }
      if (v > 0.82) { g.fillStyle = 'rgba(255,181,71,0.28)'; g.fillRect(wx - 1.5, wy - 1.5, win + 3, win + 3); }
      g.fillStyle = fill;
      g.fillRect(wx, wy, win, win);
      if (o.hot && o.hot.layer === layer && o.hot.row === row) {
        g.strokeStyle = '#FFF0C8'; g.lineWidth = 2;
        g.strokeRect(wx - 1, wy - 1, win + 2, win + 2);
        g.fillStyle = 'rgba(255,200,120,0.35)'; g.fillRect(wx - 4, wy - 4, win + 8, win + 8);
        g.fillStyle = heat(1); g.fillRect(wx, wy, win, win);
        hotPoint = { x: x + towerW / 2, y: wy - 2 };
      }
    }
    if (o.hot && o.hot.layer === layer && o.hot.row === null) hotPoint = { x: x + towerW / 2, y: top - antenna };
    if (o.labels?.includes(layer)) {
      g.fillStyle = '#8390B4';
      g.font = '11px "Martian Mono", ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillText(String(layer), x + towerW / 2, height - 6);
    }
  }
  if (mode === 'sweep' && o.sweep !== undefined && o.sweep >= 1 && o.sweep <= L) {
    const sx = towerX(o.sweep) + towerW + Math.max(1, (step - towerW) / 2);
    g.fillStyle = 'rgba(255,181,71,0.1)';
    g.fillRect(towerX(o.sweep) - 1, 0, towerW + 2, bodyBottom);
    g.fillStyle = '#FFB547';
    g.shadowColor = 'rgba(255,181,71,0.85)'; g.shadowBlur = 10;
    g.fillRect(sx - 1, 0, 2, bodyBottom);
    g.shadowBlur = 0;
  }
  if (o.leader && hotPoint) {
    g.strokeStyle = '#FFB547'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(hotPoint.x, 0); g.lineTo(hotPoint.x, hotPoint.y); g.stroke();
  }
  return { towerX, hotPoint };
}
