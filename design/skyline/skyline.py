"""Procedural Cincinnati night skyline for trey-lm.

Writes two SVGs with identical geometry:
  skyline-awake.svg    city fully lit, bridge necklace on, tiara glowing
  skyline-warming.svg  same city, fewer windows lit, bridge lights partly on,
                       tiara dark (it lights up when the model is ready)

The bridge cable lights double as the warm-up indicator: in the live site they
switch on left to right as warm-up time passes.

usage: python -I skyline.py <out_dir>
"""
import math
import os
import random
import sys

W, H = 1440, 900
BASE = 712  # riverbank, where buildings stand

AMBER = "#FFB547"
WARM = "#F6CB85"
COOL = "#B4C9F4"
BLUE = "#4CA6E8"


def f(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


class Svg:
    def __init__(self):
        self.parts = []

    def add(self, s):
        self.parts.append(s)

    def rect(self, x, y, w, h, fill, op=None, rx=None):
        o = f' opacity="{op:.2f}"' if op is not None else ""
        r = f' rx="{f(rx)}"' if rx else ""
        self.add(f'<rect x="{f(x)}" y="{f(y)}" width="{f(w)}" height="{f(h)}"{r} fill="{fill}"{o}/>')

    def circle(self, cx, cy, r, fill, op=None):
        o = f' opacity="{op:.2f}"' if op is not None else ""
        self.add(f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="{fill}"{o}/>')

    def ellipse(self, cx, cy, rx, ry, fill, op=None):
        o = f' opacity="{op:.2f}"' if op is not None else ""
        self.add(f'<ellipse cx="{f(cx)}" cy="{f(cy)}" rx="{f(rx)}" ry="{f(ry)}" fill="{fill}"{o}/>')

    def line(self, x1, y1, x2, y2, stroke, w=1, op=None, cap="butt"):
        o = f' opacity="{op:.2f}"' if op is not None else ""
        self.add(
            f'<line x1="{f(x1)}" y1="{f(y1)}" x2="{f(x2)}" y2="{f(y2)}" stroke="{stroke}" '
            f'stroke-width="{f(w)}" stroke-linecap="{cap}"{o}/>'
        )

    def path(self, d, fill="none", stroke=None, w=1, op=None, evenodd=False):
        s = f' stroke="{stroke}" stroke-width="{f(w)}"' if stroke else ""
        o = f' opacity="{op:.2f}"' if op is not None else ""
        r = ' fill-rule="evenodd"' if evenodd else ""
        self.add(f'<path d="{d}" fill="{fill}"{s}{o}{r}/>')


def quad(p0, p1, p2, t):
    x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
    y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
    return x, y


def build(variant):
    awake = variant == "awake"
    lit_p = 0.36 if awake else 0.14
    bridge_frac = 1.0 if awake else 0.42
    rnd = random.Random(1788)  # same seed -> same city in both variants
    s = Svg()
    s.add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
    s.add(
        "<defs>"
        '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#0F1630"/><stop offset="0.38" stop-color="#1D2850"/>'
        '<stop offset="0.66" stop-color="#3B3D74"/><stop offset="0.79" stop-color="#5C4F86"/>'
        "</linearGradient>"
        '<linearGradient id="river" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#262D60"/><stop offset="0.3" stop-color="#1A2150"/>'
        '<stop offset="1" stop-color="#0D1330"/></linearGradient>'
        '<linearGradient id="glass" x1="0" y1="0" x2="1" y2="0">'
        '<stop offset="0" stop-color="#3C4A8A"/><stop offset="0.45" stop-color="#2F3A74"/>'
        '<stop offset="1" stop-color="#232B5C"/></linearGradient>'
        '<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">'
        '<stop offset="0" stop-color="#8E73B8" stop-opacity="0.38"/>'
        '<stop offset="1" stop-color="#8E73B8" stop-opacity="0"/></radialGradient>'
        '<radialGradient id="tglow" cx="0.5" cy="0.5" r="0.5">'
        '<stop offset="0" stop-color="#DCE8FF" stop-opacity="0.42"/>'
        '<stop offset="0.6" stop-color="#9FB8F0" stop-opacity="0.14"/>'
        '<stop offset="1" stop-color="#9FB8F0" stop-opacity="0"/></radialGradient>'
        '<radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">'
        f'<stop offset="0" stop-color="{AMBER}" stop-opacity="0.55"/>'
        f'<stop offset="1" stop-color="{AMBER}" stop-opacity="0"/></radialGradient>'
        '<radialGradient id="bhalo" cx="0.5" cy="0.5" r="0.5">'
        f'<stop offset="0" stop-color="{BLUE}" stop-opacity="0.5"/>'
        f'<stop offset="1" stop-color="{BLUE}" stop-opacity="0"/></radialGradient>'
        "</defs>"
    )
    s.rect(0, 0, W, H, "url(#sky)")
    s.ellipse(620, BASE, 940, 190, "url(#glow)")

    # stars, denser and brighter toward the top
    for _ in range(190):
        x = rnd.uniform(0, W)
        y = 640 * rnd.random() ** 1.5
        r = rnd.choice([0.6, 0.7, 0.9, 1.1, 1.4])
        op = rnd.uniform(0.25, 0.85) * max(0.15, 1 - y / 700)
        s.circle(x, y, r, "#DCE6FF", op)

    # far hills (Kentucky side rises to the right)
    s.path("M0 702 C 220 692 420 700 620 698 C 780 696 900 688 1000 670 "
           "C 1120 648 1270 626 1440 606 L1440 714 L0 714 Z", fill="#2A2A59")
    s.path("M960 714 C 1100 690 1260 676 1440 662 L1440 714 Z", fill="#242552", op=0.75)

    def windows(x, y0, w, y1, colstep=7, rowstep=9, ww=3, wh=4, p_scale=1.0, unlit="#222A56"):
        cols = max(1, int((w - 8) // colstep))
        pad = (w - (cols - 1) * colstep - ww) / 2
        rows = int((y1 - y0) // rowstep)
        for r in range(rows):
            for c in range(cols):
                a, b, c2 = rnd.random(), rnd.random(), rnd.random()
                wx = x + pad + c * colstep
                wy = y0 + r * rowstep
                if a < lit_p * p_scale:
                    col = AMBER if b < 0.68 else (WARM if b < 0.84 else COOL)
                    s.rect(wx, wy, ww, wh, col, 0.62 + 0.38 * c2)
                elif c2 < 0.55:
                    s.rect(wx, wy, ww, wh, unlit, 0.9)

    # Covington bank, mostly behind the chat panel
    x = 1090
    while x < W:
        w = rnd.uniform(18, 34)
        top = rnd.uniform(664, 694)
        s.rect(x, top, w, BASE - top, "#252A57")
        windows(x, top + 6, w, BASE - 4, colstep=6, rowstep=8, ww=2, wh=3, p_scale=0.7, unlit="#20264E")
        x += w + rnd.uniform(2, 10)

    # background downtown layer, dimmer, for depth
    x = -6
    while x < 470:
        w = rnd.uniform(22, 40)
        top = rnd.uniform(588, 664)
        s.rect(x, top, w, BASE - top, "#252D5F")
        windows(x, top + 8, w, BASE - 6, colstep=7, rowstep=9, ww=2, wh=3, p_scale=0.45, unlit="#212955")
        x += w + rnd.uniform(-4, 6)

    fg = "#2D3568"
    edge = "#3D4886"
    reflect_cols = []

    def tower_block(x, w, top, fill=fg):
        s.rect(x, top, w, BASE - top, fill)
        s.rect(x, top, 1.5, BASE - top, edge, 0.7)
        windows(x, top + 9, w, BASE - 8)
        reflect_cols.append((x, w, top))

    # generic mid-rises
    tower_block(0, 44, 600)
    tower_block(40, 58, 556)
    s.rect(46, 547, 46, 10, fg)  # setback, overlaps the roof by 1px so they join
    tower_block(150, 38, 610)
    tower_block(186, 44, 590)
    tower_block(296, 40, 584)
    tower_block(338, 50, 600)

    # Scripps Center: pyramid top sitting on the shaft
    tower_block(102, 44, 562)
    s.path("M102 563 L124 518 L146 563 Z", fill="#36417C")
    s.path("M124 518 L146 563 L124 563 Z", fill="#2A3263")
    s.circle(124, 517, 1.6, AMBER, 0.95)

    # Carew Tower: stepped art-deco top (each tier overlaps the one below by 2px)
    tower_block(232, 60, 520)
    s.rect(242, 502, 40, 20, fg)
    s.rect(252, 488, 20, 16, fg)
    s.rect(242, 502, 1.5, 20, edge, 0.7)
    s.rect(252, 488, 1.5, 16, edge, 0.7)
    windows(244, 506, 36, 520, colstep=7, rowstep=8)
    s.line(262, 488, 262, 472, "#9AA8D6", 1.2, 0.8)
    s.circle(262, 471, 1.6, AMBER, 0.95)

    # --- Great American Tower: glass shaft lit in office-floor bands, elliptical tiara crown ---
    gx, gw, roof = 390, 64, 480
    s.rect(gx, roof, gw, BASE - roof, "url(#glass)")
    s.rect(gx, roof, 1.5, BASE - roof, "#56649E", 0.8)
    mx = gx + 4
    while mx < gx + gw - 2:  # vertical mullion fins
        s.line(mx, roof + 3, mx, BASE, "#4D5A98", 0.6, 0.45)
        mx += 6
    fy = roof + 8
    while fy < BASE - 6:  # floors lit in bands, the way an office tower reads at night
        nseg = int((gw - 6) // 9)
        x0 = gx + (gw - nseg * 9) / 2  # whole segments only, centred, so no stubs at the edge
        for k in range(nseg):
            a, b = rnd.random(), rnd.random()
            if a < (0.42 if awake else 0.17):
                s.rect(x0 + k * 9, fy, 8, 2.4, "#F2E2BD" if b < 0.8 else COOL, 0.55 + 0.3 * b)
        fy += 7
    reflect_cols.append((gx, gw, roof))
    # roof parapet the tiara stands on
    s.rect(gx - 2, roof - 4, gw + 4, 5, "#3B4782")
    s.line(gx - 2, roof - 4, gx + gw + 2, roof - 4, "#7F8EC8", 1, 0.8)

    cx, rx, th = gx + gw / 2, 30, 50  # tiara: centre, half-width, height (~130 ft on a 665 ft tower)
    tb = roof - 4                      # tiara base = top of parapet

    def tiara_top(x):
        u = (x - cx) / rx
        return tb - th * math.sqrt(max(0.0, 1 - u * u))

    crown = "#EAF1FF" if awake else "#7E8BB8"
    if awake:
        s.ellipse(cx, tb - th * 0.45, 56, 46, "url(#tglow)")
    n = 12
    hi = 0.9 if awake else 0.7
    for i in range(1, n):  # back ribs, half a step offset, dimmer
        x = cx - rx * math.cos(math.pi * i / n)
        s.line(x, tb, x, tiara_top(x) + 1, crown, 0.7, 0.28)
    front = [cx - rx * math.cos(math.pi * (i + 0.5) / n) for i in range(n)]
    pts = [cx - rx] + front + [cx + rx]

    def arch(x0, x2, lo, peak, w, op):
        # quadratic arch from rib x0 to rib x2; springs at `lo` of the local height, peaks at `peak`
        y0 = tb - (tb - tiara_top(x0)) * lo
        y2 = tb - (tb - tiara_top(x2)) * lo
        xm = (x0 + x2) / 2
        ypk = tb - (tb - tiara_top(xm)) * peak
        cy = 2 * ypk - (y0 + y2) / 2  # control point that puts the curve's apex at ypk
        s.path(f"M{f(x0)} {f(y0)} Q{f(xm)} {f(cy)} {f(x2)} {f(y2)}", stroke=crown, w=w, op=op)

    # interlaced arches, each spanning two rib gaps: the tiara's tracery
    for i in range(len(pts) - 2):
        arch(pts[i], pts[i + 2], 0.38, 0.8, 0.9, 0.75 if awake else 0.55)
    # a band of small loops near the base
    for i in range(len(pts) - 1):
        arch(pts[i], pts[i + 1], 0.0, 0.2, 0.8, 0.6 if awake else 0.45)
    for x in front:  # front ribs (cosine spacing = fins wrapping an elliptical roof)
        s.line(x, tb, x, tiara_top(x) + 0.6, crown, 1.0, hi)
    s.path(f"M{f(cx - rx)} {f(tb)} A {rx} {th} 0 0 1 {f(cx + rx)} {f(tb)}", stroke=crown, w=1.8, op=0.95 if awake else 0.75)
    s.line(cx - rx - 1, tb, cx + rx + 1, tb, crown, 1.8, hi)
    s.circle(cx, tb - th - 4, 8, "url(#halo)")
    s.circle(cx, tb - th - 4, 2.4, AMBER)

    # riverfront ballpark, foreground left
    s.path("M16 712 L16 699 Q72 684 130 699 L130 712 Z", fill="#283062")
    for px in (24, 122):
        on = awake or px == 24
        s.line(px, 699, px, 662, "#7F8CBB", 1.2, 0.8)
        s.rect(px - 5, 659, 10, 3, "#F4E9C6", 0.95 if on else 0.25)
        if on:
            s.circle(px, 660, 10, "url(#halo)")

    # river
    s.rect(0, 713, W, H - 713, "url(#river)")

    # reflections of buildings and their lit windows
    for (x, w, top) in reflect_cols:
        h = (BASE - top) * 0.42
        s.rect(x + 3, 716, w - 6, h, "#2B3368", 0.3)
        for _ in range(int(w / 5)):
            a, b, c, d = rnd.random(), rnd.random(), rnd.random(), rnd.random()
            if a < lit_p / 0.36 * 0.8:
                yy = 722 + 140 * b
                L = 4 + 14 * c
                xx = x + 3 + (w - 6 - L) * d
                col = AMBER if c < 0.75 else COOL
                s.line(xx, yy, xx + L, yy, col, 1.4, max(0.08, 0.42 - (yy - 722) / 420))

    # water shimmer
    for _ in range(170):
        x = rnd.uniform(-20, W)
        y = 720 + 180 * rnd.random() ** 0.9
        L = rnd.uniform(10, 64)
        s.line(x, y, x + L, y, "#41538F", 1, rnd.uniform(0.08, 0.28))

    # promenade + streetlights along the Ohio bank
    s.rect(0, 712, W, 3, "#161C40")
    n_lamps = 19
    for i in range(n_lamps):
        lx = 10 + i * 21
        on = (i / n_lamps) < (1.0 if awake else 0.6)
        s.circle(lx, 709.5, 1.4, AMBER if on else "#4A4A6E", 0.95 if on else 0.6)

    # --- Roebling Suspension Bridge ---
    p_l, p_r = 560, 900
    saddle = 628           # cables rest on top of the towers
    deck_top, deck_bot = 706, 713
    s.rect(462, 700, 28, 14, "#2A2850")   # anchorages
    s.rect(1062, 700, 30, 14, "#2A2850")
    for tx in (p_l, p_r):                 # tower reflections
        s.rect(tx - 20, 745, 40, 80, "#2A2752", 0.35)

    left = ((p_l, saddle), (516, 684), (476, 704))
    main = ((p_l, saddle), ((p_l + p_r) / 2, 734), (p_r, saddle))
    right = ((p_r, saddle), (984, 684), (1076, 704))

    def qpath(c, dy=0.0):
        (a, b, c2) = c
        return f"M{f(a[0])} {f(a[1] + dy)} Q{f(b[0])} {f(b[1] + dy)} {f(c2[0])} {f(c2[1] + dy)}"

    # suspenders run from the cable down to the deck
    for c, n_s in ((left, 5), (main, 26), (right, 9)):
        for i in range(1, n_s):
            x, y = quad(*c, i / n_s)
            s.line(x, y, x, deck_top, BLUE, 0.8, 0.32)
    # deck (drawn before the towers so the road shows through the arches)
    s.rect(462, deck_top, 630, deck_bot - deck_top, "#24305F")
    s.line(462, deck_top, 1092, deck_top, BLUE, 2, 0.95)

    def bridge_tower(x):
        top = saddle + 4
        body = f"M{x - 22} {top} H{x + 22} V745 H{x - 22} Z"
        arches = ""
        for ax in (x - 17, x + 5):  # twin arches the roadway passes through
            arches += f" M{ax} {deck_bot} V668 A 6 6 0 0 1 {ax + 12} 668 V{deck_bot} Z"
        s.path(body + arches, fill="#2F2B4F", evenodd=True)
        s.rect(x - 22, top, 1.8, 745 - top, "#4A4573", 0.8)
        s.rect(x - 22, top + 14, 44, 3, "#403B69")
        s.rect(x - 25, saddle - 2, 50, 8, "#3B3662")   # cap
        s.rect(x - 20, saddle - 10, 4, 8, "#3B3662")   # corner turrets
        s.rect(x + 16, saddle - 10, 4, 8, "#3B3662")

    bridge_tower(p_l)
    bridge_tower(p_r)
    for c in (left, main, right):
        s.path(qpath(c, 3), stroke=BLUE, w=1.2, op=0.45)
        s.path(qpath(c), stroke=BLUE, w=2.2, op=0.95)

    # the necklace: cable lights switch on in order, left to right, as warm-up time passes
    lights = []
    for c, n_l in ((left, 4), (main, 14), (right, 6)):
        for i in range(n_l + 1):
            if c is not left and i == 0:
                continue
            lights.append(quad(*c, i / n_l))
    total = len(lights)
    for i, (x, y) in enumerate(lights):
        on = (i + 1) / total <= bridge_frac + 1e-9
        if on:
            s.circle(x, y, 7, "url(#bhalo)")
            s.circle(x, y, 2.3, "#E6F3FF")
        else:
            s.circle(x, y, 1.8, "#3A4878")
    # deck lights (not on the tower piers) + their reflections
    xs = [x for x in range(482, 1080, 16) if abs(x - p_l) > 24 and abs(x - p_r) > 24]
    for i, x in enumerate(xs):
        on = (i + 1) / len(xs) <= bridge_frac + 1e-9
        s.circle(x, 709.5, 1.2, "#CFE6FF" if on else "#3A4878", 0.85)
        if on and i % 2 == 0:
            for j in range(3):
                yy = 724 + j * 14 + rnd.uniform(0, 8)
                s.line(x - 4, yy, x + 4, yy, BLUE, 1.3, 0.32 - j * 0.08)

    s.add("</svg>")
    return "\n".join(s.parts)


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for v in ("awake", "warming"):
        p = os.path.join(out, f"skyline-{v}.svg")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(build(v))
        print(p, os.path.getsize(p))


if __name__ == "__main__":
    main()
