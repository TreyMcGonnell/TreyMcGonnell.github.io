// Turns a .dc.html artboard into a plain HTML page that headless Chrome can screenshot.
// It runs the artboard's Component.renderVals(), expands <sc-for>/<sc-if>, fills {{holes}},
// and maps /_blob/<id> asset urls to local files.
//
// usage: node dc_preview.mjs <in.dc.html> <out.html> [blobId=relative/path ...]
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath, ...maps] = process.argv;
let src = readFileSync(inPath, 'utf8');
for (const m of maps) {
  const [id, file] = m.split('=');
  src = src.split(`/_blob/${id}`).join(file);
}
const tpl = src.match(/<x-dc>([\s\S]*)<\/x-dc>/)[1];
const script = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const runtime = String.raw`
class DCLogic { constructor(props) { this.props = props || {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } forceUpdate() {} }
const Component = new Function('DCLogic', SCRIPT + '\nreturn Component;')(DCLogic);
const vals = new Component({}).renderVals();
function get(scope, p) {
  p = p.trim();
  if (p === 'true') return true;
  if (p === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(p)) return Number(p);
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
}
function interp(str, scope) {
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => { const v = get(scope, p); return v == null ? '' : String(v); });
}
function hole(attr, scope) { const m = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/.exec(attr || ''); return m ? get(scope, m[1]) : attr; }
function proc(node, scope) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) { if (child.nodeValue.includes('{{')) child.nodeValue = interp(child.nodeValue, scope); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'sc-for') {
      const list = hole(child.getAttribute('list'), scope) || [];
      const as = child.getAttribute('as') || 'item';
      const out = document.createDocumentFragment();
      list.forEach((item, i) => {
        const frag = document.createDocumentFragment();
        for (const c of child.childNodes) frag.appendChild(c.cloneNode(true));
        const sc = Object.create(scope); sc[as] = item; sc.$index = i;
        proc(frag, sc);
        out.appendChild(frag);
      });
      child.replaceWith(out);
      continue;
    }
    if (tag === 'sc-if') {
      if (hole(child.getAttribute('value'), scope)) {
        const frag = document.createDocumentFragment();
        for (const c of Array.from(child.childNodes)) frag.appendChild(c);
        proc(frag, scope);
        child.replaceWith(frag);
      } else child.remove();
      continue;
    }
    for (const a of Array.from(child.attributes)) if (a.value.includes('{{')) child.setAttribute(a.name, interp(a.value, scope));
    proc(child, scope);
  }
}
const t = document.createElement('template');
t.innerHTML = TPL;
const helmet = t.content.querySelector('helmet');
if (helmet) { for (const c of Array.from(helmet.childNodes)) document.head.appendChild(c); helmet.remove(); }
proc(t.content, vals);
document.body.appendChild(t.content);
// Measuring mode: preview.html#sel1||sel2 dumps each match's box as [left, top, right, bottom].
const sels = decodeURIComponent(location.hash.slice(1)).split('||').filter(Boolean);
if (sels.length) document.fonts.ready.then(() => {
  const r1 = (v) => Math.round(v * 10) / 10;
  const out = {};
  for (const s of sels) out[s] = Array.from(document.querySelectorAll(s)).map((e) => {
    const r = e.getBoundingClientRect(); return [r1(r.left), r1(r.top), r1(r.right), r1(r.bottom)];
  });
  const pre = document.createElement('pre'); pre.id = 'measure'; pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
});
`;

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<script>const TPL = ${JSON.stringify(tpl)}; const SCRIPT = ${JSON.stringify(script)};
${runtime}</script></body></html>`;
writeFileSync(outPath, html);
console.log('wrote', outPath);
