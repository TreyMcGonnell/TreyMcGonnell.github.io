// Content pages: a still skyline behind a readable column. No animation loop, so these pages stay light.
import '../styles/base.css';
import '../styles/pages.css';
import { createScene } from '../scene/skyline.js';
import { enableFonts } from '../fonts';

enableFonts();

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (canvas) {
  const scene = createScene(canvas, { animate: false, ready: true, maxDpr: 1.5, onLite: () => document.body.classList.add('lite') });
  const draw = () => scene.renderAt(30, 1, true);
  draw();
  let t = 0;
  addEventListener('resize', () => { clearTimeout(t); t = window.setTimeout(draw, 200); });
}
