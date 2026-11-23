// Cincinnati night skyline: the background of every trey-lm page.
// Ported from design/background/skyline.html (verified: windows only change during boot; see verify()).
// Drawing code is kept as-is; only the wiring around it changed:
//   - boot progress comes from the real model warm-up (setProgress / setReady) instead of a demo timer,
//   - the ?frame / ?verify / ?bench modes became exported functions used by the tests.
/* eslint-disable */
// @ts-nocheck

export function createScene(canvas, opts = {}) {
  // ---------- world constants (design space is 1440 x 900; the scene scales by viewport height) ----------
  const H = 900, BASE = 712, WY = 713, LY0 = 360, LY1 = 760;
  const AMBER = '#FFB547', BLUE = '#4CA6E8';
  const P_LIT = 0.36;             // share of window groups lit once the model is awake
  const BOOT = 9;                 // demo boot length in seconds (a real Modal cold start is 10 to 40 s)
  const STAR_SPIN = 0.0026;       // rad/s around a pole above the frame: a slow, visible drift

  const ctx = canvas.getContext('2d', { alpha: false });

  // ---------- helpers ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function quad(p0, p1, p2, t) {
    const u = 1 - t;
    return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
  }
  function vg(g, y0, y1, c0, c1) { const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, c0); gr.addColorStop(1, c1); return gr; }
  function line(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
  function poly(g, pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fill(); }

  // ---------- state ----------
  let vw = 0, vh = 0, sc = 1, eff = 1, k = 1, WW = 1440, dprCap = 2, lite = false;
  const L = {};
  let wins = [], necklace = [], deckLights = [], beacons = [], blinkers = [], glints = [];
  let stars = [], pole = [0, 0], clouds = [], crests = [];
  const SP = {};
  let skyGrad, domeA, domeB, waterGrad, mistGrad, tiaraSprite;
  let T = 0, lastNow = 0, paused = false, needsRender = true;
  let bootStart = 0.6, renderedP = -1, renderedTiara = -1, lastStatus = '';
  let meteor = null, nextMeteor = 11;
  let costEMA = 0, costFrames = 0;

  // ---------- offscreen layers ----------
  function makeLayer(y0, y1, res) {
    const kk = k * (res || 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(WW * kk));
    c.height = Math.max(1, Math.ceil((y1 - y0) * kk));
    const g = c.getContext('2d');
    g.setTransform(kk, 0, 0, kk, 0, -y0 * kk);
    return { c, g, y0, y1, kk };
  }
  function clearLayer(l) { l.g.save(); l.g.setTransform(1, 0, 0, 1, 0, 0); l.g.clearRect(0, 0, l.c.width, l.c.height); l.g.restore(); }
  function blit(l) { ctx.drawImage(l.c, 0, l.y0, l.c.width / l.kk, l.c.height / l.kk); }

  function glow(r, rgb, a0, mid) {
    const s = Math.max(4, Math.ceil(r * 2 * k));
    const c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, `rgba(${rgb},${a0})`);
    gr.addColorStop(mid || 0.3, `rgba(${rgb},${a0 * 0.32})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    return { c, r };
  }
  function sprite(g, sp, x, y, scale) { const r = sp.r * (scale || 1); g.drawImage(sp.c, x - r, y - r, r * 2, r * 2); }

  // ---------- windows ----------
  const STYLE = {
    punched: { cs: 6, cside: 4, ww: 3, wh: 4, fs: 9, mx: 4, my: 8, unlit: '#1B2251' },
    band:    { cs: 6, cside: 4, ww: 5, wh: 3, fs: 7, mx: 3, my: 6, unlit: '#222B5E' },
    strip:   { cs: 5, cside: 4, ww: 2, wh: 6, fs: 9, mx: 4, my: 8, unlit: '#1B2251' },
    deco:    { cs: 5, cside: 4, ww: 2.4, wh: 4, fs: 7, mx: 4, my: 6, unlit: '#1D2353' },
    small:   { cs: 5, cside: 4, ww: 2, wh: 3, fs: 7, mx: 3, my: 6, unlit: '#1F2655' },
    tiny:    { cs: 4, cside: 3, ww: 1.6, wh: 2.2, fs: 5, mx: 2, my: 4, unlit: '#252C5C' },
  };
  function pickCol(r) { return r < 0.6 ? AMBER : r < 0.82 ? '#F6CB85' : '#D6E4FF'; }

  // Lights come on in office-like groups: a run of windows on one floor shares a color and a switch-on time.
  function facade(g, rng, x0, fw, yTop, yEnd, S, dim, side, pLit) {
    const PL = pLit === undefined ? P_LIT : pLit;
    const cs = side ? S.cside : S.cs;
    const ww = side ? Math.max(1.2, S.ww * 0.55) : S.ww;
    const cols = Math.max(1, Math.floor((fw - 2 * S.mx - ww) / cs) + 1);
    const pad = (fw - ((cols - 1) * cs + ww)) / 2;
    g.fillStyle = S.unlit;
    for (let y = yTop + S.my; y + S.wh <= yEnd; y += S.fs) {
      let c = 0;
      while (c < cols) {
        const seg = 2 + Math.floor(rng() * 5);
        const lit = rng() < PL, base = rng() < 0.34, tg = 0.04 + 0.9 * rng();
        const col = pickCol(rng()), br = (0.72 + 0.28 * rng()) * dim;
        for (let j = 0; j < seg && c < cols; j++, c++) {
          const wx = x0 + pad + c * cs;
          g.fillRect(wx, y, ww, S.wh);
          const r1 = rng(), r2 = rng();
          if (lit ? r1 < 0.88 : r1 < 0.035) {
            wins.push({ x: wx, y, w: ww, h: S.wh, col: lit ? col : pickCol(r2), a: br * (0.82 + 0.18 * r2),
              st: lit && !base ? 2 : 1, t: clamp(tg + (r2 - 0.5) * 0.06, 0.02, 0.97) });
          }
        }
      }
    }
  }

  // ---------- buildings ----------
  function building(g, rng, b) {
    const { x, w, top } = b, d = b.d || 0, S = STYLE[b.win], dim = b.dim || 1;
    const c0 = b.c0 || '#252D5E', c1 = b.c1 || '#303A72';
    if (d) { g.fillStyle = vg(g, top, BASE, '#151B40', '#1D2450'); g.fillRect(x + w, top, d, BASE - top); }
    g.fillStyle = vg(g, top, BASE, c0, c1);
    if (b.slope) poly(g, [[x, top + b.slope], [x + w, top], [x + w, BASE], [x, BASE]]);
    else g.fillRect(x, top, w, BASE - top);
    const ft = top + (b.slope || 0);
    if (b.piers) { g.fillStyle = 'rgba(140,150,210,0.13)'; for (let px = x + 3; px < x + w - 1; px += S.cs) g.fillRect(px, ft + 2, 0.8, BASE - ft - 2); }
    g.fillStyle = 'rgba(96,112,180,0.35)'; g.fillRect(x, ft, 0.9, BASE - ft);
    if (d) { g.fillStyle = 'rgba(130,150,215,0.22)'; g.fillRect(x + w - 0.7, top, 0.7, BASE - top); }
    facade(g, rng, x, w, ft, BASE - 9, S, dim, false);
    if (d) facade(g, rng, x + w, d, top, BASE - 9, S, 0.6 * dim, true);
    if (b.cornice) { g.fillStyle = '#3D3F74'; g.fillRect(x - 1, top, w + 2 + d, 2.2); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, top + 2.2, w + d, 0.8); }
    else if (!b.slope) { g.fillStyle = '#39457F'; g.fillRect(x - 0.5, top - 1.3, w + 1 + d * 0.6, 1.3); }
    if (b.slope) { g.strokeStyle = 'rgba(160,200,245,0.6)'; g.lineWidth = 0.9; line(g, x, top + b.slope, x + w, top); }
    if (b.set) {
      const sx = x + b.set.inset, sw = w - 2 * b.set.inset, st = top - b.set.h;
      g.fillStyle = vg(g, st, top, c0, c1); g.fillRect(sx, st, sw, b.set.h + 0.5);
      if (d) { g.fillStyle = '#171D43'; g.fillRect(sx + sw, st, d * 0.7, b.set.h + 0.5); }
      facade(g, rng, sx, sw, st - 3, top, STYLE.small, dim, false);
      g.fillStyle = '#39457F'; g.fillRect(sx - 0.5, st - 1.2, sw + 1, 1.2);
    }
    if (b.mech) { g.fillStyle = '#1E254F'; g.fillRect(x + w * 0.22, top - 7, w * 0.42, 7); g.fillStyle = '#2E3769'; g.fillRect(x + w * 0.22, top - 7, w * 0.42, 1); }
    if (b.ant) {
      const ay = top - (b.set ? b.set.h : 0);
      g.strokeStyle = '#8A97C6'; g.lineWidth = 0.8; line(g, x + b.ant.dx, ay, x + b.ant.dx, ay - b.ant.h);
      g.lineWidth = 0.5; line(g, x + b.ant.dx - 3, ay - b.ant.h * 0.45, x + b.ant.dx + 3, ay - b.ant.h * 0.45);
      blinkers.push({ x: x + b.ant.dx, y: ay - b.ant.h - 1, ph: rng() });
    }
    if (b.lobby) { g.fillStyle = 'rgba(255,210,150,0.4)'; g.fillRect(x + 2, BASE - 7, w - 4, 3); }
  }

  function tierBlock(g, rng, x, w, top, bottom, d) {
    g.fillStyle = vg(g, top, bottom, '#151B40', '#1B224D'); g.fillRect(x + w, top, d, bottom - top);
    g.fillStyle = vg(g, top, bottom, '#2A3062', '#323A70'); g.fillRect(x, top, w, bottom - top);
    g.fillStyle = 'rgba(140,150,210,0.13)'; for (let px = x + 3; px < x + w - 1; px += 5) g.fillRect(px, top + 2, 0.8, bottom - top - 2);
    g.fillStyle = 'rgba(96,112,180,0.35)'; g.fillRect(x, top, 0.9, bottom - top);
    facade(g, rng, x, w, top - 2, bottom - 1, STYLE.deco, 1, false);
    g.fillStyle = '#3A4580'; g.fillRect(x - 0.6, top - 1.4, w + 1.2 + d * 0.6, 1.4);
  }

  function scripps(g, rng) {
    building(g, rng, { x: 102, w: 44, top: 563, d: 8, win: 'band', c0: '#273170', c1: '#2F3A78' });
    g.fillStyle = vg(g, 516, 564, '#4A579A', '#34407E'); poly(g, [[101, 563.5], [124, 516], [124, 563.5]]);
    g.fillStyle = vg(g, 516, 564, '#36417C', '#28306A'); poly(g, [[124, 516], [147, 563.5], [124, 563.5]]);
    g.fillStyle = '#1A2049'; poly(g, [[124, 516], [147, 563.5], [155, 563.5]]);
    g.strokeStyle = 'rgba(170,190,240,0.2)'; g.lineWidth = 0.5;
    for (let i = 1; i < 6; i++) { const y = 516 + i * 7.8, hw = (y - 516) / 47.5 * 23; line(g, 124 - hw, y, 124 + hw, y); }
    g.strokeStyle = 'rgba(255,236,205,0.75)'; g.lineWidth = 0.8;
    line(g, 101, 563.5, 124, 516); line(g, 124, 516, 147, 563.5);
    beacons.push({ x: 124, y: 515.5, sp: 'warm', s: 0.55 });
  }

  function carew(g, rng) {
    building(g, rng, { x: 232, w: 60, top: 520, d: 10, win: 'deco', piers: true, c0: '#272D5D', c1: '#323A70' });
    tierBlock(g, rng, 242, 40, 502, 521, 8);
    tierBlock(g, rng, 252, 20, 488, 503, 6);
    g.fillStyle = '#2C3466'; poly(g, [[253, 488.6], [262, 480], [271, 488.6]]);
    g.strokeStyle = '#9AA8D6'; g.lineWidth = 0.9; line(g, 262, 480, 262, 467);
    blinkers.push({ x: 262, y: 466, ph: 0.35 });
    // warm floodlights wash the stepped crown from below
    g.fillStyle = vg(g, 486, 522, 'rgba(255,214,160,0)', 'rgba(255,214,160,0.2)');
    g.fillRect(242, 502, 40, 19); g.fillRect(252, 488, 20, 15);
    beacons.push({ x: 262, y: 505, sp: 'flood', s: 1 });
  }

  // Great American Tower: glass shaft lit in office-floor bands, elliptical tiara crown.
  const T_CX = 422, T_RX = 30, T_TH = 50, T_TB = 476;
  function tiaraTop(x) { const u = (x - T_CX) / T_RX; return T_TB - T_TH * Math.sqrt(Math.max(0, 1 - u * u)); }
  function drawTiara(g, color, am) {
    g.save(); g.strokeStyle = color; g.lineCap = 'round';
    const n = 12;
    g.globalAlpha = 0.3 * am; g.lineWidth = 0.7;
    for (let i = 1; i < n; i++) { const x = T_CX - T_RX * Math.cos(Math.PI * i / n); line(g, x, T_TB, x, tiaraTop(x) + 1); }
    const front = [];
    for (let i = 0; i < n; i++) front.push(T_CX - T_RX * Math.cos(Math.PI * (i + 0.5) / n));
    const pts = [T_CX - T_RX].concat(front, [T_CX + T_RX]);
    const arch = (x0, x2, lo, pk) => {
      const y0 = T_TB - (T_TB - tiaraTop(x0)) * lo, y2 = T_TB - (T_TB - tiaraTop(x2)) * lo;
      const xm = (x0 + x2) / 2, ypk = T_TB - (T_TB - tiaraTop(xm)) * pk;
      g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(xm, 2 * ypk - (y0 + y2) / 2, x2, y2); g.stroke();
    };
    g.globalAlpha = 0.75 * am; g.lineWidth = 0.9;
    for (let i = 0; i < pts.length - 2; i++) arch(pts[i], pts[i + 2], 0.38, 0.8);
    g.globalAlpha = 0.6 * am; g.lineWidth = 0.8;
    for (let i = 0; i < pts.length - 1; i++) arch(pts[i], pts[i + 1], 0, 0.2);
    g.globalAlpha = 0.9 * am; g.lineWidth = 1;
    for (const x of front) line(g, x, T_TB, x, tiaraTop(x) + 0.6);
    g.globalAlpha = 0.95 * am; g.lineWidth = 1.8;
    g.beginPath(); g.ellipse(T_CX, T_TB, T_RX, T_TH, 0, Math.PI, 2 * Math.PI); g.stroke();
    line(g, T_CX - T_RX - 1, T_TB, T_CX + T_RX + 1, T_TB);
    g.restore();
  }
  function gat(g, rng) {
    const gx = 390, gw = 64, roof = 480, gd = 10;
    g.fillStyle = vg(g, roof, BASE, '#161C45', '#1E2553'); g.fillRect(gx + gw, roof + 1, gd, BASE - roof - 1);
    const hg = g.createLinearGradient(gx, 0, gx + gw, 0);
    hg.addColorStop(0, '#3E4D90'); hg.addColorStop(0.4, '#32407C'); hg.addColorStop(1, '#252E62');
    g.fillStyle = hg; g.fillRect(gx, roof, gw, BASE - roof);
    g.fillStyle = vg(g, roof, BASE, 'rgba(8,12,34,0.3)', 'rgba(8,12,34,0)'); g.fillRect(gx, roof, gw, BASE - roof);
    g.fillStyle = 'rgba(14,20,52,0.5)';
    for (let y = roof + 6; y < BASE - 4; y += 6) g.fillRect(gx, y + 2.8, gw, 1.1);
    const nseg = 7, sw = 8, sx0 = gx + (gw - nseg * sw) / 2 + 0.5;
    for (let y = roof + 6.4; y < BASE - 8; y += 6) {
      let s = 0;
      while (s < nseg) {
        const run = 1 + Math.floor(rng() * 4);
        const lit = rng() < 0.42, base = rng() < 0.34, tg = 0.04 + 0.9 * rng();
        const col = rng() < 0.75 ? '#F2E2BD' : '#D6E4FF', br = 0.62 + 0.3 * rng();
        for (let j = 0; j < run && s < nseg; j++, s++) {
          const r1 = rng();
          if (lit && r1 < 0.9) wins.push({ x: sx0 + s * sw, y, w: sw - 1, h: 2.3, col, a: br, st: base ? 1 : 2, t: clamp(tg + (r1 - 0.5) * 0.04, 0.02, 0.97) });
        }
      }
      if (rng() < 0.3) wins.push({ x: gx + gw + 1.5, y, w: gd - 3, h: 2.1, col: '#F2E2BD', a: 0.42, st: rng() < 0.4 ? 1 : 2, t: 0.04 + 0.9 * rng() });
    }
    g.fillStyle = 'rgba(95,115,185,0.3)';
    for (let mx = gx + 4; mx < gx + gw - 1; mx += 4.5) g.fillRect(mx, roof + 3, 0.5, BASE - roof - 3);
    g.fillStyle = 'rgba(130,150,215,0.65)'; g.fillRect(gx, roof, 1, BASE - roof);
    g.fillStyle = '#3B4782'; g.fillRect(gx - 2, roof - 4, gw + 4 + gd * 0.6, 5);
    g.fillStyle = 'rgba(160,175,230,0.7)'; g.fillRect(gx - 2, roof - 4, gw + 4, 0.8);
    drawTiara(g, '#7E8BB8', 0.72);
    beacons.push({ x: T_CX, y: T_TB - T_TH - 4, sp: 'amber', s: 0.7 });
  }

  // ---------- terrain, distant city, riverfront ----------
  function hillY(x) {
    if (x < 960) return 697 - 5 * Math.sin(x / 150) - 3 * Math.sin(x / 41 + 1);
    if (x < 1440) return 697 - 80 * smooth(960, 1440, x) - 5 * Math.sin(x / 61) * smooth(960, 1100, x);
    return 617 - 5 * Math.sin(x / 61) - 16 * Math.sin((x - 1440) / 210);
  }
  function hills(g) {
    const rng = mulberry32(11);
    // a further, hazier ridge for depth
    g.fillStyle = 'rgba(48,46,96,0.75)';
    g.beginPath(); g.moveTo(880, 716);
    for (let x = 880; x <= WW + 6; x += 6) g.lineTo(x, hillY(x) - 16 * smooth(900, 1200, x) - 4 * Math.sin(x / 33));
    g.lineTo(WW + 6, 716); g.closePath(); g.fill();
    g.fillStyle = vg(g, 600, 716, '#28295E', '#1E2150');
    g.beginPath(); g.moveTo(-10, 716);
    const ridge = [];
    for (let x = -10; x <= WW + 10; x += 3) {
      const y = hillY(x) - rng() * 2.2 - (rng() < 0.08 ? rng() * 3.5 : 0);
      ridge.push([x, y]); g.lineTo(x, y);
    }
    g.lineTo(WW + 10, 716); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(70,72,130,0.45)'; g.lineWidth = 0.7;
    g.beginPath(); ridge.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    // house and street lights scattered over the hillside (Mount Adams side)
    const hr = mulberry32(12);
    const count = Math.round((WW - 980) * 0.42);
    for (let i = 0; i < count; i++) {
      const x = 980 + hr() * (WW - 980), top = hillY(x) + 5;
      if (top > 702) continue;
      const y = top + hr() * (706 - top), warm = hr() < 0.82;
      g.fillStyle = warm ? (hr() < 0.6 ? '#FFD49A' : '#FFC46B') : '#CFE0FF';
      g.globalAlpha = 0.45 + 0.5 * hr();
      const s = 0.9 + hr() * 0.7; g.fillRect(x, y, s, s);
    }
    g.globalAlpha = 1;
  }
  function distant(g) {
    const rng = mulberry32(21);
    let x = 440;
    while (x < 1110) {
      // far side of downtown: low, sparse, washed into the haze
      const tall = rng() < 0.18, w = 6 + rng() * 14, top = tall ? 664 + rng() * 14 : 682 + rng() * 22;
      g.fillStyle = vg(g, top, BASE, '#33376C', '#30356A'); g.fillRect(x, top, w, BASE - top);
      facade(g, rng, x, w, top, BASE - 3, STYLE.tiny, 0.38, false, 0.14);
      x += w + 1 + rng() * 9;
    }
  }
  function haze(g) {
    g.fillStyle = vg(g, 620, BASE, 'rgba(124,104,172,0)', 'rgba(124,104,172,0.3)');
    g.fillRect(0, 600, WW, BASE - 600);
  }
  function midLayer(g) {
    const rng = mulberry32(31);
    let x = -6;
    while (x < 470) {
      const w = 18 + rng() * 22, top = 582 + rng() * 80;
      building(g, rng, { x, w, top, win: 'small', c0: '#20285A', c1: '#283164', dim: 0.78 });
      x += w + (rng() * 10 - 4);
    }
  }
  function mainCluster(g) {
    const rng = mulberry32(41);
    building(g, rng, { x: 0, w: 40, top: 600, d: 6, win: 'punched', c0: '#2A2C5E', c1: '#33376E', cornice: true, lobby: true });
    building(g, rng, { x: 40, w: 54, top: 556, d: 8, win: 'band', set: { inset: 6, h: 10 }, ant: { dx: 34, h: 24 } });
    scripps(g, rng);
    building(g, rng, { x: 150, w: 36, top: 610, d: 6, win: 'punched', cornice: true, lobby: true, c0: '#2B2D5F', c1: '#34386F' });
    building(g, rng, { x: 186, w: 42, top: 590, d: 7, win: 'strip', mech: true });
    carew(g, rng);
    building(g, rng, { x: 296, w: 38, top: 584, d: 7, win: 'band', slope: 9 });
    building(g, rng, { x: 338, w: 48, top: 600, d: 8, win: 'punched', mech: true, lobby: true });
    gat(g, rng);
  }
  function rightBank(g) {
    const rng = mulberry32(51);
    let x = 1096;
    while (x < WW + 10) {
      const w = 14 + rng() * 22, top = 662 + rng() * 34;
      building(g, rng, { x, w, top, d: 3, win: 'small', c0: '#222959', c1: '#2A3263', dim: 0.8, cornice: rng() < 0.4 });
      x += w + 3 + rng() * 8;
    }
    for (let lx = 1104; lx < WW; lx += 24) { beacons.push({ x: lx, y: 707, sp: 'warm', s: 0.55 }); glints.push({ x: lx, w: 2.6, a: 0.42, rgb: '255,206,140', n: 9, ph: lx * 0.37 }); }
  }
  function tree(g, x, r) {
    const cy = BASE - 2 - r * 0.8;
    g.fillStyle = '#111735'; g.fillRect(x - 0.5, cy, 1, BASE - cy);
    g.beginPath(); g.arc(x, cy, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(64,76,136,0.5)'; g.lineWidth = 0.6;
    g.beginPath(); g.arc(x, cy, r - 0.3, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  }
  function riverfront(g) {
    const rng = mulberry32(61);
    // ballpark: stands, rim lights and light towers
    g.fillStyle = '#242B5D';
    g.beginPath(); g.moveTo(12, 712); g.lineTo(12, 700); g.quadraticCurveTo(72, 680, 134, 700); g.lineTo(134, 712); g.closePath(); g.fill();
    g.fillStyle = '#1B2150';
    g.beginPath(); g.moveTo(18, 712); g.lineTo(18, 704); g.quadraticCurveTo(72, 690, 128, 704); g.lineTo(128, 712); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,220,170,0.55)';
    for (let i = 0; i <= 18; i++) { const [px, py] = quad([14, 699], [72, 680.5], [132, 699], i / 18); g.fillRect(px - 0.4, py - 0.4, 0.9, 0.9); }
    for (const px of [20, 72, 126]) {
      g.strokeStyle = '#6F7BAE'; g.lineWidth = 1; line(g, px, 700, px, 652);
      g.fillStyle = '#3A4374'; g.fillRect(px - 6.5, 647.5, 13, 5);
      g.fillStyle = '#F7F1DE'; for (let j = 0; j < 4; j++) g.fillRect(px - 5.5 + j * 3, 648.5, 2, 1.4), g.fillRect(px - 5.5 + j * 3, 650.6, 2, 1.4);
      beacons.push({ x: px, y: 650, sp: 'white', s: 1 });
      glints.push({ x: px, w: 5, a: 0.5, rgb: '235,240,255', n: 12, ph: px });
    }
    // bank, railing, posts
    g.fillStyle = '#131938'; g.fillRect(0, 711, WW, 5);
    g.fillStyle = 'rgba(90,105,165,0.55)'; g.fillRect(0, 709.4, 470, 0.6);
    for (let px = 2; px < 470; px += 8) g.fillRect(px, 709.4, 0.5, 1.8);
    // street trees in front of the towers
    let x = 140;
    while (x < 458) { const r = 3.6 + rng() * 3.6; tree(g, x, r); x += r * 1.35 + rng() * 5; }
    // promenade lamps
    for (let i = 0; i < 22; i++) {
      const lx = 8 + i * 21; if (lx > 466) break;
      g.strokeStyle = '#3A4270'; g.lineWidth = 0.7; line(g, lx, 711, lx, 703.5);
      g.fillStyle = '#FFE2B0'; g.fillRect(lx - 1, 702.5, 2, 1.4);
      beacons.push({ x: lx, y: 703, sp: 'warm', s: 0.7 });
      glints.push({ x: lx, w: 2.6, a: 0.5, rgb: '255,206,140', n: 10, ph: lx * 0.71 });
    }
  }

  // ---------- Roebling Suspension Bridge ----------
  function bridge(g) {
    const pl = 560, pr = 900, sad = 628, dTop = 706, dBot = 713;
    const left = [[pl, sad], [516, 684], [476, 703]];
    const main = [[pl, sad], [(pl + pr) / 2, 734], [pr, sad]];
    const right = [[pr, sad], [984, 684], [1078, 703]];
    function anchorage(x, w) {
      g.fillStyle = vg(g, 692, 716, '#3A3458', '#2A2647'); g.fillRect(x, 692, w, 24);
      g.fillStyle = 'rgba(10,8,30,0.22)'; for (let y = 696; y < 716; y += 4) g.fillRect(x, y, w, 0.5);
      g.fillStyle = '#463F6A'; g.fillRect(x - 1, 691, w + 2, 2);
    }
    anchorage(458, 34); anchorage(1058, 38);
    // diagonal stays fan out from each tower top to the deck
    g.strokeStyle = 'rgba(120,180,235,0.22)'; g.lineWidth = 0.55;
    for (const tx of [pl, pr]) for (let i = 1; i <= 5; i++) for (const dir of [-1, 1]) line(g, tx, sad + 6, tx + dir * (16 + i * 17), dTop);
    // suspenders from the cables down to the deck
    g.strokeStyle = 'rgba(76,166,232,0.34)'; g.lineWidth = 0.7;
    for (const [c, n] of [[left, 6], [main, 30], [right, 9]]) for (let i = 1; i < n; i++) { const [x, y] = quad(c[0], c[1], c[2], i / n); line(g, x, y, x, dTop); }
    // deck and truss, drawn before the towers so the road shows through the arches
    g.fillStyle = '#1F2958'; g.fillRect(462, dTop, 630, dBot - dTop);
    g.strokeStyle = 'rgba(110,150,220,0.3)'; g.lineWidth = 0.45;
    g.beginPath(); for (let x = 462; x < 1092; x += 6) { g.moveTo(x, dTop + 1); g.lineTo(x + 3, dBot - 1); g.lineTo(x + 6, dTop + 1); } g.stroke();
    g.fillStyle = 'rgba(76,166,232,0.9)'; g.fillRect(462, dTop - 0.7, 630, 1.4);
    g.fillStyle = 'rgba(8,10,30,0.5)'; g.fillRect(462, dBot - 0.6, 630, 0.6);
    function btower(x) {
      const top = sad + 4, bot = 746;
      const body = new Path2D();
      body.rect(x - 22, top, 44, bot - top);
      for (const ax of [x - 17, x + 5]) { body.moveTo(ax, dBot); body.lineTo(ax, 668); body.arc(ax + 6, 668, 6, Math.PI, 0); body.lineTo(ax + 12, dBot); body.closePath(); }
      g.fillStyle = vg(g, top, bot, '#3B3559', '#2A2647'); g.fill(body, 'evenodd');
      g.save(); g.clip(body, 'evenodd');
      g.fillStyle = vg(g, top, dBot, 'rgba(255,205,150,0)', 'rgba(255,205,150,0.12)'); g.fillRect(x - 22, top, 44, dBot - top);
      g.fillStyle = 'rgba(12,10,32,0.2)'; for (let y = top + 4; y < bot; y += 5) g.fillRect(x - 22, y, 44, 0.45);
      g.fillStyle = 'rgba(12,10,32,0.14)'; for (let y = top + 4, row = 0; y < bot; y += 5, row++) for (let bx = x - 22 + (row % 2) * 4; bx < x + 22; bx += 8) g.fillRect(bx, y, 0.45, 5);
      g.fillStyle = 'rgba(120,110,170,0.35)'; g.fillRect(x - 22, top, 2.2, bot - top);
      g.fillStyle = 'rgba(10,8,28,0.3)'; g.fillRect(x + 19.8, top, 2.2, bot - top);
      g.restore();
      g.fillStyle = '#463F6A'; g.fillRect(x - 23, top + 14, 46, 2.4); g.fillRect(x - 23, 660, 46, 1.6);
      g.fillStyle = '#3B3662'; g.fillRect(x - 25, sad - 2, 50, 8);
      g.fillStyle = '#4E4775'; g.fillRect(x - 25, sad - 2, 50, 1);
      for (const tx of [x - 21, x + 15]) {
        g.fillStyle = '#3B3662'; g.fillRect(tx, sad - 10, 6, 8.5);
        g.fillStyle = '#4A436F'; poly(g, [[tx - 0.6, sad - 10], [tx + 3, sad - 16], [tx + 6.6, sad - 10]]);
      }
    }
    btower(pl); btower(pr);
    function strokeQuad(c, dy, col, w) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(c[0][0], c[0][1] + dy); g.quadraticCurveTo(c[1][0], c[1][1] + dy, c[2][0], c[2][1] + dy); g.stroke(); }
    for (const c of [left, main, right]) { strokeQuad(c, 2.6, 'rgba(76,166,232,0.42)', 1.1); strokeQuad(c, 0, BLUE, 2); }
    necklace = [];
    for (const [c, n] of [[left, 4], [main, 14], [right, 6]]) for (let i = 0; i <= n; i++) { if (c !== left && i === 0) continue; necklace.push(quad(c[0], c[1], c[2], i / n)); }
    deckLights = [];
    for (let x = 482; x < 1080; x += 16) if (Math.abs(x - pl) > 24 && Math.abs(x - pr) > 24) deckLights.push(x);
  }

  // ---------- build all static layers ----------
  function renderStructure() {
    wins = []; beacons = []; blinkers = []; glints = [];
    clearLayer(L.struct);
    const g = L.struct.g;
    hills(g); distant(g); haze(g); midLayer(g); mainCluster(g); rightBank(g); riverfront(g); bridge(g);
    wins.sort((a, b) => (a.col < b.col ? -1 : a.col > b.col ? 1 : 0));
    // tiara, lit: a separate sprite faded in when the model is ready
    const sx = 380, sy = 408, sw = 84, sh = 74;
    const c = document.createElement('canvas'); c.width = Math.ceil(sw * k); c.height = Math.ceil(sh * k);
    const tg = c.getContext('2d'); tg.setTransform(k, 0, 0, k, -sx * k, -sy * k);
    tg.shadowColor = 'rgba(200,220,255,0.95)'; tg.shadowBlur = 5 * k; drawTiara(tg, '#F4F8FF', 1);
    tg.shadowBlur = 0; drawTiara(tg, '#FFFFFF', 0.9);
    tiaraSprite = { c, x: sx, y: sy, w: sw, h: sh };
  }

  function renderWindows(p) {
    clearLayer(L.win);
    const g = L.win.g;
    let col = '';
    for (const w of wins) {
      let a = w.a;
      if (w.st === 2) { const f = (p - w.t) / 0.035; if (f <= 0) continue; if (f < 1) a *= f; }
      if (w.col !== col) { col = w.col; g.fillStyle = col; }
      g.globalAlpha = a; g.fillRect(w.x, w.y, w.w, w.h);
    }
    g.globalAlpha = 1;
    clearLayer(L.bloom);
    L.bloom.g.drawImage(L.win.c, 0, LY0, WW, LY1 - LY0);
    const cg = L.city.g;
    clearLayer(L.city);
    cg.drawImage(L.struct.c, 0, LY0, WW, LY1 - LY0);
    cg.drawImage(L.win.c, 0, LY0, WW, LY1 - LY0);
    if (!lite) { cg.globalCompositeOperation = 'lighter'; cg.globalAlpha = 0.5; cg.drawImage(L.bloom.c, 0, LY0, WW, LY1 - LY0); cg.globalCompositeOperation = 'source-over'; cg.globalAlpha = 1; }
  }

  function buildReflection(ta) {
    const R = L.refl, g = R.g, kk = R.kk;
    clearLayer(R);
    g.save();
    g.setTransform(kk, 0, 0, -kk, 0, (2 * BASE - WY) * kk);   // mirror about the bank line
    if ('filter' in g) g.filter = `blur(${(0.7 * kk).toFixed(2)}px)`;
    g.drawImage(L.city.c, 0, LY0, WW, LY1 - LY0);
    if (ta > 0) { g.globalAlpha = ta; g.drawImage(tiaraSprite.c, tiaraSprite.x, tiaraSprite.y, tiaraSprite.w, tiaraSprite.h); g.globalAlpha = 1; }
    g.restore();
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(12,16,42,0.42)'; g.fillRect(0, 0, R.c.width, R.c.height);
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createLinearGradient(0, 0, 0, R.c.height);
    fade.addColorStop(0, 'rgba(0,0,0,0.95)'); fade.addColorStop(0.55, 'rgba(0,0,0,0.5)'); fade.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = fade; g.fillRect(0, 0, R.c.width, R.c.height);
    g.restore();
  }

  function genStars() {
    const rng = mulberry32(4242);
    pole = [WW * 0.42, -820];
    const rmin = 800;
    const rmax = Math.max(Math.hypot(pole[0], 680 - pole[1]), Math.hypot(WW - pole[0], 680 - pole[1])) + 20;
    const n = Math.min(7000, Math.round(Math.PI * (rmax * rmax - rmin * rmin) * (400 / (1440 * 640))));
    stars = [];
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(rmin * rmin + rng() * (rmax * rmax - rmin * rmin)), th = rng() * Math.PI * 2, mag = rng();
      const cr = rng();
      stars.push({ cx: r * Math.cos(th), cy: r * Math.sin(th),
        s: mag > 0.985 ? 1.9 : mag > 0.93 ? 1.35 : mag > 0.6 ? 0.95 : 0.65,
        a: 0.3 + 0.7 * mag * mag, tw: 0.1 + rng() * 0.45, f: 0.6 + rng() * 2.6, ph: rng() * 6.283,
        c: cr < 0.12 ? '#FFE7C4' : cr < 0.3 ? '#CFE0FF' : '#F2F5FF', big: mag > 0.985 });
    }
    stars.sort((a, b) => (a.c < b.c ? -1 : 1));
  }

  function cloudSprite(rng, w, h) {
    const res = 0.5 * k, c = document.createElement('canvas');
    c.width = Math.ceil(w * res); c.height = Math.ceil(h * res);
    const g = c.getContext('2d'); g.setTransform(res, 0, 0, res, 0, 0);
    for (let i = 0; i < 46; i++) {
      const cx = w * (0.08 + 0.84 * rng()), cy = h * (0.5 + 0.25 * (rng() - 0.5)), r = 14 + rng() * 34;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(150,132,196,0.11)'); gr.addColorStop(1, 'rgba(150,132,196,0)');
      g.save(); g.translate(cx, cy); g.scale(1, 0.36); g.translate(-cx, -cy);
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); g.restore();
    }
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = vg(g, 0, h, 'rgba(46,44,96,0.55)', 'rgba(210,166,210,0.5)'); g.fillRect(0, 0, w, h);
    return c;
  }
  function genClouds() {
    const rng = mulberry32(99);
    clouds = [];
    const specs = [[640, 120, 170, 0.5, 5.5], [520, 100, 300, 0.42, 3.8], [760, 130, 420, 0.38, 2.6], [460, 90, 250, 0.3, 7]];
    specs.forEach(([w, h, y, a, v], i) => clouds.push({ c: cloudSprite(rng, w, h), w, h, y, a, v, x: rng() * (WW + w) + i * 300 }));
  }
  function genCrests() {
    const rng = mulberry32(77);
    crests = [];
    const n = lite ? 120 : 240;
    for (let i = 0; i < n; i++) {
      const d = Math.pow(rng(), 1.25);
      crests.push({ y: WY + 4 + d * (H - WY - 8), x: rng() * (WW + 80), len: (5 + d * 34) * (0.5 + rng()), th: 0.6 + d * 1.2,
        v: (2 + d * 9) * (0.6 + 0.8 * rng()), a: (0.05 + 0.12 * rng()) * (0.55 + d * 0.6), f: 0.8 + rng() * 1.6, ph: rng() * 6.283, bob: 0.3 + d * 1.3 });
    }
  }

  function buildAll() {
    SP.blue = glow(7, '76,166,232', 0.55); SP.warm = glow(7, '255,206,140', 0.5); SP.red = glow(6, '255,72,60', 0.85);
    SP.amber = glow(9, '255,181,71', 0.65); SP.white = glow(16, '235,240,255', 0.42); SP.star = glow(3, '230,238,255', 0.9, 0.25);
    SP.tiara = glow(64, '205,222,255', 0.3, 0.4); SP.flood = glow(34, '255,214,160', 0.22, 0.4);
    L.struct = makeLayer(LY0, LY1); L.win = makeLayer(LY0, LY1); L.bloom = makeLayer(LY0, LY1, 0.25);
    L.city = makeLayer(LY0, LY1);          // struct + windows + glow, composited only when windows change
    L.refl = makeLayer(WY, H, 0.5);        // the reflection is blurred anyway, so half resolution is plenty
    L.sky = makeLayer(0, WY, 0.5);         // smooth gradients: cached once at half resolution
    if ('filter' in L.bloom.g) L.bloom.g.filter = 'blur(1px)';
    skyGrad = ctx.createLinearGradient(0, 0, 0, WY);
    [[0, '#0A1027'], [0.22, '#111A3D'], [0.42, '#1B2650'], [0.62, '#2F3369'], [0.74, '#4A4479'], [0.8, '#5E4F86'], [1, '#6A5A8E']].forEach(([o, c]) => skyGrad.addColorStop(o, c));
    domeA = ctx.createRadialGradient(300, 740, 0, 300, 740, 640); domeA.addColorStop(0, 'rgba(196,124,150,0.22)'); domeA.addColorStop(1, 'rgba(196,124,150,0)');
    domeB = ctx.createRadialGradient(960, 730, 0, 960, 730, 520); domeB.addColorStop(0, 'rgba(120,112,196,0.14)'); domeB.addColorStop(1, 'rgba(120,112,196,0)');
    waterGrad = ctx.createLinearGradient(0, WY, 0, H);
    [[0, '#2A2B5D'], [0.25, '#1B2150'], [1, '#080C22']].forEach(([o, c]) => waterGrad.addColorStop(o, c));
    mistGrad = ctx.createLinearGradient(0, WY, 0, WY + 34); mistGrad.addColorStop(0, 'rgba(130,110,180,0.16)'); mistGrad.addColorStop(1, 'rgba(130,110,180,0)');
    const sg = L.sky.g;
    sg.fillStyle = skyGrad; sg.fillRect(0, 0, WW, WY);
    sg.fillStyle = domeA; sg.fillRect(0, 0, WW, WY); // whole sky: the glow fades to nothing on its own, so no edge
    sg.fillStyle = domeB; sg.fillRect(0, 0, WW, WY);
    renderStructure(); genStars(); genClouds(); genCrests();
    renderedP = -1; renderedTiara = -1; needsRender = true;
  }

  // ---------- per-frame drawing ----------
  function drawSky() { blit(L.sky); }
  function drawStars() {
    const ang = -STAR_SPIN * T, ca = Math.cos(ang), sa = Math.sin(ang), [px, py] = pole;
    let col = '';
    for (const s of stars) {
      const x = px + s.cx * ca - s.cy * sa, y = py + s.cx * sa + s.cy * ca;
      if (y < -4 || y > 672 || x < -4 || x > WW + 4) continue;
      const fade = clamp((684 - y) / 300, 0, 1);
      const a = s.a * fade * (1 - s.tw * (0.5 + 0.5 * Math.sin(T * s.f + s.ph)));
      if (a < 0.02) continue;
      if (s.c !== col) { col = s.c; ctx.fillStyle = col; }
      ctx.globalAlpha = a; ctx.fillRect(x - s.s / 2, y - s.s / 2, s.s, s.s);
      if (s.big) { ctx.globalAlpha = a * 0.55; sprite(ctx, SP.star, x, y, 1.4); }
    }
    ctx.globalAlpha = 1;
  }
  function drawMeteor() {
    if (paused) return;
    if (!meteor && T > nextMeteor) {
      meteor = { x: 260 + Math.random() * (WW - 520), y: 50 + Math.random() * 200, ang: Math.PI * (0.8 + Math.random() * 0.1), len: 110 + Math.random() * 70, t0: T, dur: 0.85 };
      nextMeteor = T + 22 + Math.random() * 26;
    }
    if (!meteor) return;
    const p = (T - meteor.t0) / meteor.dur;
    if (p >= 1) { meteor = null; return; }
    const dx = Math.cos(meteor.ang), dy = Math.sin(meteor.ang), travel = 260 * p;
    const hx = meteor.x + dx * travel, hy = meteor.y + dy * travel, tail = meteor.len * Math.min(1, p * 3);
    const gr = ctx.createLinearGradient(hx, hy, hx - dx * tail, hy - dy * tail);
    gr.addColorStop(0, `rgba(240,245,255,${0.85 * Math.sin(Math.PI * p)})`); gr.addColorStop(1, 'rgba(240,245,255,0)');
    ctx.strokeStyle = gr; ctx.lineWidth = 1.2; ctx.lineCap = 'round'; line(ctx, hx, hy, hx - dx * tail, hy - dy * tail);
  }
  function drawClouds() {
    for (const cl of clouds) {
      const span = WW + cl.w;
      const x = (((cl.x - cl.v * T) % span) + span) % span - cl.w;
      ctx.globalAlpha = cl.a; ctx.drawImage(cl.c, x, cl.y, cl.w, cl.h);
    }
    ctx.globalAlpha = 1;
  }
  function drawWater(ta, p) {
    ctx.fillStyle = waterGrad; ctx.fillRect(0, WY, WW, H - WY);
    const R = L.refl, kk = R.kk, step = lite ? 3 : 2, depth = H - WY;
    for (let d = 0; d < depth; d += step) {
      const amp = 0.5 + (d / depth) * 4.2;
      const off = amp * (0.62 * Math.sin(d * 0.23 + T * 1.55) + 0.38 * Math.sin(d * 0.071 - T * 0.92 + 1.7));
      const sh = Math.min(step + 0.6, depth - d);
      ctx.drawImage(R.c, 0, d * kk, R.c.width, Math.min(sh * kk, R.c.height - d * kk), off, WY + d, WW, sh);
    }
    ctx.fillStyle = mistGrad; ctx.fillRect(0, WY, WW, 34);
    ctx.fillStyle = '#A29EDC';
    const span = WW + 80;
    for (const c of crests) {
      const x = (((c.x - c.v * T) % span) + span) % span - 40;
      ctx.globalAlpha = c.a * (0.55 + 0.45 * Math.sin(T * c.f + c.ph));
      ctx.fillRect(x, c.y + Math.sin(T * c.f * 0.6 + c.ph) * c.bob, c.len, c.th);
    }
    ctx.globalAlpha = 1;
    // light columns shimmering on the water
    ctx.globalCompositeOperation = 'lighter';
    const nOn = necklaceOn(p);
    for (let i = 0; i < nOn; i++) glintColumn(necklace[i][0], 2.4, 0.42, '120,190,245', 9, i * 1.7);
    for (const x of deckLights) glintColumn(x, 1.8, 0.22, '200,225,255', 7, x * 0.13);
    for (const s of glints) glintColumn(s.x, s.w, s.a, s.rgb, s.n, s.ph);
    if (ta > 0) glintColumn(T_CX, 9, 0.32 * ta, '215,228,255', 14, 3.1);
    glintColumn(262, 5, 0.18, '255,214,160', 10, 1.2);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  function glintColumn(x, w, a, rgb, n, ph) {
    ctx.fillStyle = `rgb(${rgb})`;
    for (let j = 0; j < n; j++) {
      const yy = WY + 2 + j * (2.6 + j * 0.55);
      if (yy > H) break;
      const ww = w * (0.7 + j * 0.09);
      const wob = Math.sin(T * 1.7 + j * 1.3 + ph) * (0.4 + j * 0.28);
      const flick = 0.4 + 0.6 * Math.abs(Math.sin(T * 2.4 + j * 2.17 + ph * 1.3));
      ctx.globalAlpha = a * (1 - j / n) * flick;
      ctx.fillRect(x - ww / 2 + wob, yy, ww, 0.9 + j * 0.05);
    }
  }
  function necklaceOn(p) { return Math.round((p >= 1 ? 1 : 0.9 * p) * necklace.length); }
  function drawLights(ta, p) {
    const nOn = necklaceOn(p);
    for (let i = 0; i < necklace.length; i++) {
      const [x, y] = necklace[i];
      if (i < nOn) { sprite(ctx, SP.blue, x, y); ctx.fillStyle = '#E6F3FF'; ctx.beginPath(); ctx.arc(x, y, 1.15, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.fillStyle = '#34416F'; ctx.beginPath(); ctx.arc(x, y, 0.9, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.fillStyle = '#CFE6FF'; ctx.globalAlpha = 0.85;
    for (const x of deckLights) ctx.fillRect(x - 0.6, 709, 1.2, 1.2);
    ctx.globalAlpha = 1;
    for (const b of beacons) sprite(ctx, SP[b.sp], b.x, b.y, b.s);
    for (const b of blinkers) {
      const ph = ((T / 1.6 + b.ph) % 1 + 1) % 1, on = ph < 0.16 ? 1 : 0.12;
      ctx.globalAlpha = on; sprite(ctx, SP.red, b.x, b.y, 0.8);
      ctx.fillStyle = '#FF5A4E'; ctx.fillRect(b.x - 0.7, b.y - 0.7, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = AMBER; ctx.beginPath(); ctx.arc(T_CX, T_TB - T_TH - 4, 1.6, 0, Math.PI * 2); ctx.fill();
    if (ta > 0) {
      ctx.globalAlpha = ta; sprite(ctx, SP.tiara, T_CX, T_TB - T_TH * 0.45, 1);
      ctx.drawImage(tiaraSprite.c, tiaraSprite.x, tiaraSprite.y, tiaraSprite.w, tiaraSprite.h);
      ctx.globalAlpha = 1;
    }
  }

  // ---------- boot control ----------
  let progress = 0, readyAt = null;
  const listeners = { lite: opts.onLite || null };
  function bootP() { return readyAt !== null ? 1 : clamp(progress, 0, 0.999); }
  function tiaraAlpha() { return readyAt === null ? 0 : clamp((T - readyAt) / 1.2, 0, 1); }

  function render() {
    const p = bootP(), ta = tiaraAlpha();
    let reflDirty = false;
    if (p !== renderedP && !(p >= 1 && renderedP >= 1)) { renderWindows(p); reflDirty = true; }
    renderedP = p;
    if (ta !== renderedTiara) { renderedTiara = ta; reflDirty = true; }
    if (reflDirty) buildReflection(ta);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawSky(); drawStars(); drawMeteor(); drawClouds();
    drawWater(ta, p);
    blit(L.city);
    drawLights(ta, p);
  }

  // ---------- loop, sizing, adaptivity ----------
  let raf = 0, alive = true;
  function tick(now) {
    if (!alive) return;
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (!paused) T += dt;
    const tiaraMoving = readyAt !== null && T - readyAt < 1.3;
    if (!paused || needsRender || tiaraMoving) {
      const c0 = performance.now();
      render();
      needsRender = false;
      adapt(performance.now() - c0);
    }
    raf = requestAnimationFrame(tick);
  }
  function adapt(cost) {
    if (paused) return;
    costEMA = costEMA ? costEMA * 0.95 + cost * 0.05 : cost;
    if (++costFrames < 150) return;
    if (costEMA > 12 && dprCap > 1) { dprCap = 1; costFrames = 0; costEMA = 0; resize(); }
    else if (costEMA > 16 && !lite) { lite = true; listeners.lite && listeners.lite(); genCrests(); renderedP = -1; costFrames = 0; costEMA = 0; }
  }
  function resize() {
    vw = canvas.clientWidth || window.innerWidth; vh = canvas.clientHeight || window.innerHeight;
    sc = vh / H;
    WW = Math.max(1440, Math.ceil(vw / sc) + 2);
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr || dprCap);
    // pixel budget: soft scenery doesn't need every device pixel on very large or very dense screens
    eff = Math.max(0.5, Math.min(dpr, 4096 / (WW * sc), Math.sqrt(3.7e6 / (vw * vh))));
    k = sc * eff;
    canvas.width = Math.round(vw * eff); canvas.height = Math.round(vh * eff);
    buildAll();
  }
  let rt = 0;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(resize, 120); };
  window.addEventListener('resize', onResize);

  paused = !!opts.paused;
  resize();
  if (opts.ready) { readyAt = -10; }
  if (opts.animate !== false) raf = requestAnimationFrame(tick);
  else render();

  const api = {
    /** Warm-up progress 0..1 while the model boots (the page caps it at 0.9 until ready). */
    setProgress(p) { if (readyAt === null && p !== progress) { progress = p; needsRender = true; } },
    /** The model is ready: every window and bridge light on, then the tiara fades in. */
    setReady() { if (readyAt === null) { readyAt = T; needsRender = true; } },
    /** Back to the dark, pre-boot city (for a replayed boot). */
    reset() { progress = 0; readyAt = null; renderedP = -1; renderedTiara = -1; needsRender = true; },
    setPaused(v) { paused = !!v; needsRender = true; },
    get paused() { return paused; },
    get ready() { return readyAt !== null; },
    get lite() { return lite; },
    /** Render one frame at time t (seconds) with the given boot state; for screenshots and tests. */
    renderAt(t, p = 1, ready = true) {
      T = t; progress = p; readyAt = ready ? Math.min(t - 2, readyAt ?? t - 2) : null; render();
    },
    /** Frame-time benchmark (test G3). One GPU sync at the end of each run, so queued drawing is counted.
     *  (A readback every frame would make Chrome move the canvas off the GPU and measure the wrong thing.) */
    bench() {
      const sync = () => ctx.getImageData(0, 0, 1, 1);
      api.reset(); T = 2; sync(); let t0 = performance.now();
      for (let i = 0; i < 90; i++) { T += 1 / 60; progress = Math.min(0.9, 0.2 + i / 120); render(); }
      sync();
      const bootFrameMs = +((performance.now() - t0) / 90).toFixed(2);
      readyAt = 0; T = 30; render(); sync(); t0 = performance.now();
      for (let i = 0; i < 90; i++) { T += 1 / 60; render(); }
      sync();
      const steadyFrameMs = +((performance.now() - t0) / 90).toFixed(2);
      return { bootFrameMs, steadyFrameMs, windows: wins.length, stars: stars.length, canvas: [canvas.width, canvas.height] };
    },
    /** Test D7: windows change only during boot; stars and water keep moving after it. */
    verify() {
      const hash = (data) => { let h = 2166136261; for (let i = 0; i < data.length; i += 8) h = Math.imul(h ^ (data[i] + data[i + 1] * 3 + data[i + 3] * 7), 16777619) >>> 0; return h; };
      const layerHash = () => hash(L.win.g.getImageData(0, 0, L.win.c.width, L.win.c.height).data);
      const area = (x, y, w, h) => hash(ctx.getImageData(Math.round(x * k), Math.round(y * k), Math.round(w * k), Math.round(h * k)).data);
      const snap = (t, p, ready) => { T = t; progress = p; if (ready && readyAt === null) readyAt = t; render(); return { win: layerHash(), sky: area(500, 40, 400, 200), water: area(0, 740, 400, 120) }; };
      api.reset();
      const b1 = snap(3, 0.25, false), b2 = snap(5, 0.55, false);
      const r1 = snap(14, 0.9, true), r2 = snap(47, 0.9, true), r3 = snap(120, 0.9, true);
      return {
        windowsChangeDuringBoot: b1.win !== b2.win,
        windowsStaticAfterBoot: r1.win === r2.win && r2.win === r3.win,
        starsMoveAfterBoot: r1.sky !== r2.sky,
        wavesMoveAfterBoot: r1.water !== r2.water,
      };
    },
    destroy() { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); },
  };
  return api;
}
