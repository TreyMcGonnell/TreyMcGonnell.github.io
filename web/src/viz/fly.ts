// The chosen word flies from its top-5 bar into the chat along a dotted curve. Skipped under reduced motion.
const SVG = 'http://www.w3.org/2000/svg';
let busy = false;

export function flyWord(text: string, from: DOMRect, to: DOMRect, layer: SVGSVGElement, ms = 420): void {
  if (busy || !text.trim()) return;
  busy = true;
  const sx = from.right + 6, sy = from.top + from.height / 2;
  const ex = to.left + to.width / 2, ey = to.top + to.height / 2;
  const cx = Math.max(sx, ex) + 60, cy = (sy + ey) / 2;
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', `M${sx} ${sy} Q${cx} ${cy} ${ex} ${ey}`);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#FFB547');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-dasharray', '2 6');
  path.setAttribute('stroke-linecap', 'round');
  layer.appendChild(path);
  const chip = document.createElement('div');
  chip.className = 'fly-chip';
  chip.textContent = text.trim();
  document.body.appendChild(chip);
  const w = chip.offsetWidth, h = chip.offsetHeight;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, u = 1 - t;
    const x = u * u * sx + 2 * u * t * cx + t * t * ex - w / 2;
    const y = u * u * sy + 2 * u * t * cy + t * t * ey - h / 2;
    frames.push({ transform: `translate(${x}px, ${y}px) rotate(-5deg) scale(${1 - 0.35 * t})`, opacity: t > 0.85 ? (1 - t) / 0.15 : 1 });
  }
  chip.style.left = '0px';
  chip.style.top = '0px';
  const anim = chip.animate(frames, { duration: ms, easing: 'ease-in-out', fill: 'forwards' });
  const cleanup = () => {
    chip.remove();
    path.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250 }).onfinish = () => path.remove();
    busy = false;
  };
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
}
