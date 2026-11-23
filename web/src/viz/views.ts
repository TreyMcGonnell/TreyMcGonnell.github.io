// The stage's screens (canvas v2): typing, thinking, writing, done, plus landing and error states.
// Coordinates follow the 940 x 520 stage of the mockups.
import { answerText, sourceLabel, type AnswerState } from '../home/answer';
import { decodeNeurons, type Prompt, type TokenFrame, type TokenizeResult } from '../protocol/types';
import { diverge } from './heat';
import { drawTowers } from './towers';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Token text as a chip shows it: a dot marks a leading space, newlines become ↵. */
export const vis = (t: string) => esc(t.replace(/^ /, '·').replace(/\n/g, '↵'));
const pct = (p: number) => `${Math.round(p * 100)}%`;
/** A candidate word as a bar label: trimmed, unless another candidate trims to the same text (then show the space as ·). */
export function wordLabel(text: string, all: string[]): string {
  const t = text.trim() || text;
  return all.filter((x) => (x.trim() || x) === t).length > 1 ? vis(text) : esc(t);
}
const TINTS = ['t1', 't2', 't3', 't4'];
const LABELS_28 = [1, 5, 9, 13, 17, 21, 25, 28];

export function towerLabels(layers: number): number[] {
  if (layers === 28) return LABELS_28;
  const out = new Set([1, layers]);
  for (let l = 1 + Math.round(layers / 7); l < layers; l += Math.round(layers / 7)) out.add(l);
  return [...out].sort((a, b) => a - b);
}

/** Canonical left-to-right order of prompt sources, plus the color each gets. */
export function sourceOrder(prompt?: Prompt): { src: string; color: string; dark: boolean }[] {
  const notes = (prompt?.sections || []).filter((s) => s.kind === 'note').map((s) => s.source);
  const noteColors = ['var(--src-note-1)', 'var(--src-note-2)', 'var(--src-note-3)'];
  return [
    { src: 'rules', color: 'var(--src-rules)', dark: false },
    { src: 'bio', color: 'var(--src-bio)', dark: false },
    ...notes.map((src, i) => ({ src, color: noteColors[i % 3], dark: true })),
    { src: 'question', color: 'var(--src-you)', dark: true },
    { src: 'answer', color: 'var(--src-answer)', dark: false },
  ];
}

/** A stacked bar of shares with the notes bracketed underneath (prompt makeup and "where it's looking"). */
export function sourceBar(shares: Map<string, number>, prompt: Prompt | undefined, opts: { labels: boolean; height?: number }): string {
  const order = sourceOrder(prompt).filter((o) => (shares.get(o.src) || 0) > 0);
  if (!order.length) return '';
  const total = order.reduce((a, o) => a + (shares.get(o.src) || 0), 0);
  const seg = order.map((o) => {
    const w = (shares.get(o.src) || 0) / total;
    const label = !opts.labels || w < 0.07 ? '' : o.src.startsWith('note:') ? `${sourceLabel(o.src)} ${pct(w)}` : o.src === 'bio' ? 'bio' : o.src === 'question' ? 'you' : o.src === 'answer' ? 'its answer so far' : 'rules';
    return `<span data-src="${esc(o.src)}" style="flex:${w.toFixed(4)};background:${o.color}" class="${o.dark ? 'dark-text' : ''}"><i>${esc(label)}</i></span>`;
  }).join('');
  const notes = order.map((o, i) => [o, i] as const).filter(([o]) => o.src.startsWith('note:'));
  let bracket = '';
  if (notes.length) {
    const a = notes[0][1], b = notes[notes.length - 1][1];
    const parts: string[] = [];
    order.forEach((o, i) => {
      const w = ((shares.get(o.src) || 0) / total).toFixed(4);
      if (i < a) parts.push(`<span style="flex:${w};min-width:0;margin-right:2px"></span>`);
      if (i > b) parts.push(`<span style="flex:${w};min-width:0;margin-left:2px"></span>`);
      if (i === a) {
        const nw = notes.reduce((s, [n]) => s + (shares.get(n.src) || 0), 0) / total;
        parts.push(`<span class="bracket" style="flex:${nw.toFixed(4)} 1 ${2 * (b - a)}px;min-width:0"></span>`);
      }
    });
    bracket = `<div class="bracket-row" aria-hidden="true">${parts.join('')}</div>`;
  }
  return `<div class="srcbar" style="height:${opts.height ?? 20}px">${seg}</div>${bracket}`;
}

function towersCanvas(host: HTMLElement, sel: string, width: number, height: number, opts: Parameters<typeof drawTowers>[3]) {
  const c = host.querySelector<HTMLCanvasElement>(sel);
  if (!c) return null;
  c.style.width = `${width}px`;
  return drawTowers(c, width, height, opts);
}

// ---------------------------------------------------------------- landing
export function renderLanding(body: HTMLElement, opts: { layers: number; replayAvailable: boolean; reduceMotion: boolean }) {
  body.innerHTML = `
    <div class="abs towers-wrap" style="left:190px;top:170px;width:560px;height:220px"><canvas class="towers"></canvas></div>
    ${opts.replayAvailable ? '<button class="play-big" type="button" data-action="play-replay">Play a 20-second replay</button>' : ''}
    <p class="abs center-note">${opts.replayAvailable ? 'A real answer, recorded from this model.' : 'Ask anything in the chat to watch the model answer.'}</p>`;
  towersCanvas(body, 'canvas.towers', 560, 220, { layers: opts.layers, rows: 14, mode: 'quiet', labels: towerLabels(opts.layers), towerW: 14 });
}

// ---------------------------------------------------------------- typing
export function renderTyping(body: HTMLElement, tok: TokenizeResult | null, q: string, hidden = 3072) {
  if (!tok) {
    body.innerHTML = `<p class="abs muted" style="left:32px;top:100px">Splitting your question into tokens…</p>`;
    return;
  }
  const shown = tok.pieces.slice(0, 9);
  const chips = shown.map((p, i) => `<div class="tok-big"><span class="tok ${TINTS[i % 4]}${i === shown.length - 1 ? ' live' : ''}">${vis(p)}</span><span class="id">${tok.ids[i]}</span></div>`).join('')
    + (tok.pieces.length > shown.length ? `<div class="tok-big"><span class="tok">…</span><span class="id">+${tok.pieces.length - shown.length}</span></div>` : '');
  // find a word the tokenizer had to split
  // a word the tokenizer split: a piece followed by pieces that continue it with letters (not punctuation)
  const words: string[][] = [];
  tok.pieces.forEach((p) => { if (!words.length || !/^[A-Za-z0-9]/.test(p)) words.push([p]); else words[words.length - 1].push(p); });
  const split = words.find((w) => w.length > 1 && /^\s?[A-Za-z0-9]/.test(w[0]) && w.join('').trim().length > 3);
  const explain = split
    ? `Models read tokens, not letters. Common words are one token. A rarer word like <b>${esc(split.join('').trim())}</b> is split into ${split.length} pieces the model has seen before.`
    : 'Models read tokens, not letters. Common words are one token each; rare words get split into smaller pieces.';
  const rows = (tok.embed_preview || []).slice(0, 8).map((vals, i) => `
    <div class="embed-row"><span class="lab"${i === Math.min(7, tok.pieces.length - 1) ? ' style="color:var(--blue-soft)"' : ''}>${vis(tok.pieces[i] || '')}</span>
      <div class="cells">${vals.map((v) => `<i style="background:${diverge(v, tok.embed_scale)}"></i>`).join('')}</div></div>`).join('');
  body.innerHTML = `
    <div class="abs" style="left:32px;top:96px;display:flex;gap:10px;align-items:flex-start;max-width:876px;overflow:hidden">${chips}</div>
    <div class="abs stats" style="left:32px;top:192px"><div><b>${tok.count}</b><span>tokens</span></div><div><b>${q.length}</b><span>characters</span></div><div><b>${tok.vocab.toLocaleString('en-US')}</b><span>tokens in its vocabulary</span></div></div>
    <p class="abs" style="left:32px;top:262px;width:780px;margin:0;font-size:15px;line-height:22px;color:#C9D2E8">${explain}</p>
    ${rows ? `<div class="abs below-fold" style="left:32px;top:326px"><h3 class="col-title" style="font-size:15px">Each token becomes a list of ${hidden.toLocaleString('en-US')} numbers</h3><p class="col-sub">First 56 shown. Blue is negative, amber is positive. Press Enter and these lists travel through all the layers.</p></div>
    <div class="abs embed-rows below-fold" style="left:32px;top:374px">${rows}</div>` : ''}`;
}

// ---------------------------------------------------------------- thinking
export interface ThinkingOpts { sweep: number; layers: number; waking: boolean; wakeElapsedMs: number; reading: boolean }

export function renderThinking(body: HTMLElement, s: AnswerState, o: ThinkingOpts) {
  const r = s.retrieval;
  const used = r?.results.find((x) => x.used);
  let passage = '';
  if (used) {
    let html = '', last = 0;
    for (const [a, b] of used.highlights) { html += esc(used.snippet.slice(last, a)) + `<mark>${esc(used.snippet.slice(a, b))}</mark>`; last = b; }
    html += esc(used.snippet.slice(last));
    passage = `<div class="passage"><div class="src">${esc(used.file)} · matched passage</div><p>“${html}”</p></div>`;
  }
  const results = (r?.results || []).slice(0, 4).map((x) => `
    <div class="result${x.used ? '' : ' unused below-fold'}"><span class="f">${esc(x.file.split('/').pop() || x.file)}</span><span class="tr"><i style="width:${Math.round(x.score * 100)}%"></i></span><span class="sc">${x.score.toFixed(2).replace(/^0/, '')}</span></div>`).join('');
  const step1 = r
    ? `<li class="done"><span class="num">1</span><div style="flex:1;min-width:0"><h3>Searched Trey's memory</h3>
        <p>${r.error ? esc(r.error) + '. Answering from his bio.' : used ? 'Supermemory matched your question to his notes.' : 'No note matched, so it answers from his bio.'}</p>
        ${results ? `<div class="results">${results}</div>` : ''}${passage}</div></li>`
    : `<li class="active"><span class="num">1</span><div><h3>Searching Trey's memory</h3><p>Matching your question to his notes.</p></div></li>`;
  let step2: string;
  if (o.waking) step2 = `<li class="active"><span class="num">2</span><div><h3>Waking the model · ${Math.round(o.wakeElapsedMs / 1000)} s</h3><p>It was asleep on a cloud GPU. This usually takes 20 to 40 seconds.</p></div></li>`;
  else if (s.queuePos) step2 = `<li class="active"><span class="num">2</span><div><h3>Waiting for a turn</h3><p>Someone else is being answered. You're number ${s.queuePos} in line.</p></div></li>`;
  else if (s.wakeMs) step2 = `<li class="done"><span class="num">2</span><div><h3>Model is awake</h3><p>It was asleep, so this took ${Math.round(s.wakeMs / 1000)} s.</p></div></li>`;
  else step2 = `<li class="done"><span class="num">2</span><div><h3>Model is awake</h3><p>Already warm, so no wait.</p></div></li>`;
  const total = s.prompt?.total;
  const step3 = `<li class="${o.reading ? 'active' : 'waiting'}"><span class="num">3</span><div><h3>Reading the whole prompt</h3><p>${total ? `${total.toLocaleString('en-US')} tokens${s.prompt?.sections.some((x) => x.kind === 'note') ? ', notes included' : ''}, all layers at once.` : 'Your question, Trey\'s bio and his notes, all at once.'}</p></div></li>`;
  const step4 = `<li class="waiting below-fold"><span class="num">4</span><div><h3>Writing the answer</h3><p>One token at a time. Starts in a moment.</p></div></li>`;

  let makeup = '', reading = '';
  if (s.prompt) {
    const shares = new Map<string, number>();
    for (const sec of s.prompt.sections) shares.set(sec.source, (shares.get(sec.source) || 0) + sec.tokens);
    const notes = s.prompt.sections.filter((x) => x.kind === 'note');
    const rules = shares.get('rules') || 0, you = shares.get('question') || 0;
    const noteTokens = notes.reduce((a, n) => a + n.tokens, 0);
    makeup = `<div class="abs right-col below-fold" style="top:342px">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h3 class="col-title" style="font-size:14px">What's in the prompt</h3><span class="muted" style="font-size:12px">Rules <span class="mono">${rules}</span> · You <span class="mono">${you}</span></span></div>
      <div style="margin-top:8px">${sourceBar(shares, s.prompt, { labels: true })}</div>
      ${notes.length ? `<p class="src-caption" style="text-align:right">From Supermemory: ${notes.map((n) => esc(n.label.split('/').pop() || n.label)).join(', ')} · <span class="mono">${noteTokens}</span> tokens</p>` : ''}
    </div>`;
    const tag = (k: string) => (k === 'bio' ? 'tag-bio' : k === 'note' ? 'tag-note' : k === 'question' ? 'tag-you' : 'tag-rules');
    const strip = s.prompt.sections.filter((x) => x.kind !== 'rules').map((x) => `<span class="tok ${tag(x.kind)}">[${x.kind === 'note' ? esc(x.label.split('/').pop() || '') : x.kind === 'question' ? 'you' : 'bio'}]</span>${(x.sample || []).slice(0, 3).map((t) => `<span class="tok">${vis(t)}</span>`).join('')}<span class="tok muted">…</span>`).join('');
    reading = `<div class="abs right-col reading below-fold"><p class="muted" style="margin:0;font-size:13px">What the model is reading right now</p><div class="chips-row" style="flex-wrap:wrap;margin-top:8px;max-height:51px">${strip}</div></div>`;
  }
  body.innerHTML = `
    <ol class="abs steps">${step1}${step2}${step3}${step4}</ol>
    <div class="abs right-col layer-count"><span>Layer <b class="amber">${o.reading ? o.sweep : '–'}</b> of ${o.layers}</span><span class="mono muted" style="font-size:13px">${total ? `${total.toLocaleString('en-US')} tokens in parallel` : ''}</span></div>
    <div class="abs right-col" style="top:124px;height:206px"><canvas class="towers"></canvas></div>
    ${makeup}${reading}`;
  towersCanvas(body, 'canvas.towers', 480, 206, { layers: o.layers, rows: 14, mode: o.reading ? 'sweep' : 'quiet', sweep: o.sweep, labels: [1, 10, 20, o.layers], towerW: 14, win: 8 });
}

// ---------------------------------------------------------------- writing
export function renderWriting(body: HTMLElement, s: AnswerState, idx: number) {
  const f = s.tokens[idx];
  const layers = s.meta?.layers ?? 28, per = s.meta?.neurons_per_layer ?? 14;
  const before = s.tokens.slice(0, idx);
  let chars = 0;
  const tail: TokenFrame[] = [];
  for (let i = before.length - 1; i >= 0 && chars < 62; i--) { tail.unshift(before[i]); chars += before[i].text.length + 2; }
  const chips = tail.map((t, i) => `<span class="tok ${TINTS[(before.length - tail.length + i) % 4]}">${vis(t.text)}</span>`).join('');
  const lead = before.length > tail.length ? '<span class="tok muted">…</span>' : '';
  const picked = f.topk.findIndex((k) => k.text === f.text);
  const bars = f.topk.map((k, i) => `
    <div class="bar-row${i === picked ? ' pick' : ''}"${i === picked ? ' data-pick' : ''}><span class="word">${wordLabel(k.text, f.topk.map((x) => x.text))}</span><span class="track"><span class="fill" style="width:${(k.p * 100).toFixed(1)}%"></span></span><span class="pct">${pct(k.p)}</span></div>`).join('');
  const lens = f.logit_lens.map((l, i, all) => `<div class="${i === all.length - 1 ? 'final' : ''}"><span class="l">L${l.layer}</span><span class="w" title="${esc(l.text)}">${esc(l.text.trim() || l.text)}</span></div>`).join('');
  const shares = new Map(f.looking_at.map((x) => [x.src, x.w]));
  const noteShare = f.looking_at.filter((x) => x.src.startsWith('note:')).reduce((a, x) => a + x.w, 0);
  const noteFiles = f.looking_at.filter((x) => x.src.startsWith('note:')).map((x) => sourceLabel(x.src));
  const chipsBack = f.attention.slice(0, 4).map((a) => `<span class="look-chip" style="background:rgba(76,166,232,${(0.18 + 0.5 * Math.min(1, a.w / (f.attention[0]?.w || 1))).toFixed(2)})"><span class="t">${vis(a.text)}</span><span class="s">${esc(a.src.startsWith('note:') ? sourceLabel(a.src) : a.src === 'question' ? 'you' : a.src)}</span></span>`).join('');
  const tn = f.top_neuron;
  const pickedWord = esc(f.text.trim() || f.text);
  body.innerHTML = `
    <div class="abs answer-row chips-row"><span class="label">Answer so far</span>${lead}${chips}<span class="tok next">next?</span></div>
    <div class="abs towers-wrap"><div class="callout" style="bottom:176px">
      <b>Layer ${tn.layer} · neuron ${tn.index.toLocaleString('en-US')}</b> is the strongest window.${tn.label ? ` It lights up for ${esc(tn.label)}.` : ''}${tn.row === null ? ' It isn\'t one of the 14 windows shown, so the line points at its tower.' : ''}</div><canvas class="towers"></canvas></div>
    <div class="abs below-fold" style="left:32px;top:378px;width:540px">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h3 class="col-title" style="font-size:14px">Where it's looking</h3><span class="muted" style="font-size:12px">Share of attention back into the prompt, upper layers</span></div>
      <div style="margin-top:8px">${sourceBar(shares, s.prompt, { labels: true, height: 22 })}</div>
      ${noteFiles.length ? `<p class="src-caption">Notes from Supermemory: ${pct(noteShare)} of where it's looking (${noteFiles.slice(0, 2).map(esc).join(', ')}${noteFiles.length > 2 ? ` +${noteFiles.length - 2}` : ''})</p>` : ''}
    </div>
    <div class="abs look-chips below-fold" style="left:32px;top:460px;width:540px"><span class="muted" style="font-size:13px;margin-right:4px;white-space:nowrap">Looking back at</span>${chipsBack}</div>
    <div class="abs" style="left:600px;top:144px;width:308px">
      <h3 class="col-title">Top 5 next words</h3><p class="col-sub">The model's odds after the last layer</p>
      <div class="bars" style="margin-top:12px">${bars}</div>
      <p class="col-sub" style="margin-top:12px">Picked “${pickedWord}” at temperature ${s.meta?.temperature ?? 0.7}</p>
      <div class="below-fold"><h3 class="col-title" style="margin-top:30px">What each layer would have said</h3><p class="col-sub">Early guesses sharpen as the layers go on</p>
      <div class="lens" style="margin-top:10px">${lens}</div></div>
    </div>`;
  const vals = decodeNeurons(f.neurons);
  const drawn = towersCanvas(body, 'canvas.towers', 520, 176, { layers, rows: per, values: vals, hot: { layer: tn.layer, row: tn.row }, leader: true, labels: towerLabels(layers), win: 7 });
  const cv = body.querySelector<HTMLCanvasElement>('canvas.towers');
  if (cv && drawn?.hotPoint) { cv.dataset.leaderX = String(drawn.hotPoint.x); cv.dataset.leaderY = String(drawn.hotPoint.y); } // geometry test hook (F2)
  // place the callout centered over the hot tower, inside the left column
  const wrap = body.querySelector<HTMLElement>('.towers-wrap');
  const callout = body.querySelector<HTMLElement>('.callout');
  if (wrap && callout) {
    const x = (tn.layer - 1) * ((520 - 15) / Math.max(1, layers - 1)) + 7.5;
    callout.style.left = `${Math.max(0, Math.min(520 - 440, x - 220))}px`;
  }
}

// ---------------------------------------------------------------- done
export type DoneMode = 'sure' | 'source';

export function renderDone(body: HTMLElement, s: AnswerState, sel: number, mode: DoneMode, projectSlugs: Set<string>) {
  const order = sourceOrder(s.prompt);
  const color = new Map(order.map((o) => [o.src, o.color]));
  const chips = s.tokens.map((t, i) => {
    const top = [...t.looking_at].sort((a, b) => b.w - a.w)[0]?.src ?? 'answer';
    const u = mode === 'sure'
      ? `<span class="u" style="background:linear-gradient(90deg,var(--ink-2) ${(t.p * 100).toFixed(0)}%,rgba(255,255,255,0.07) 0)"></span>`
      : top === 'rules' ? '<span class="u dashed"></span>' : `<span class="u" style="background:${color.get(top) || 'rgba(160,170,200,0.3)'}"></span>`;
    return `<button class="done-chip" type="button" data-i="${i}" aria-pressed="${i === sel}" aria-label="Word ${i + 1}, ${esc(t.text.trim())}, ${mode === 'sure' ? `${pct(t.p)} sure` : `looked most at ${esc(sourceLabel(top))}`}"><span class="t">${vis(t.text)}</span>${u}</button>`;
  }).join('');
  const f = s.tokens[sel];
  const legend = mode === 'sure'
    ? '<span><i style="background:var(--ink-2)"></i>bar length = how sure it was</span>'
    : order.filter((o) => o.src !== 'question').map((o) => o.src === 'rules'
      ? '<span><i style="height:0;border-top:2px dashed var(--ink-2)"></i>the rules</span>'
      : `<span><i style="background:${o.color}"></i>${o.src.startsWith('note:') ? `<span class="mono" style="font-size:11.5px">${esc(sourceLabel(o.src))}</span>` : esc(sourceLabel(o.src))}</span>`).join('');
  const notes = (s.done?.sources || []).filter((x) => x.src.startsWith('note:'));
  const noteTotal = notes.reduce((a, x) => a + x.share, 0) || 1;
  const noteRows = notes.slice(0, 3).map((n) => {
    const file = n.src.slice(5);
    const slug = file.startsWith('projects/') ? file.slice(9).replace(/\.md$/, '') : null;
    const link = slug && projectSlugs.has(slug) ? `<a href="/projects/${esc(slug)}/">Open the project page →</a>` : '';
    return `<div class="note-row"><div class="top"><span class="f">${esc(file.split('/').pop() || file)}</span><span class="tr" style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.07);position:relative"><i style="position:absolute;left:0;top:0;bottom:0;width:${pct(n.share / noteTotal)};border-radius:3px;background:${color.get(n.src) || 'var(--src-note-1)'}"></i></span><span class="mono" style="width:34px;text-align:right;font-size:12px">${pct(n.share / noteTotal)}</span></div>${link}</div>`;
  }).join('') || '<p class="col-sub" style="margin-top:12px">No notes were used for this answer; it came from the bio and the rules.</p>';
  let cards = '';
  if (f) {
    const bars = f.topk.map((k) => `<div class="bar-row${k.text === f.text ? ' pick' : ''}"><span class="word">${wordLabel(k.text, f.topk.map((x) => x.text))}</span><span class="track"><span class="fill" style="width:${(k.p * 100).toFixed(1)}%"></span></span><span class="pct">${pct(k.p)}</span></div>`).join('');
    const guesses = f.logit_lens.map((l, i, all) => (i === all.length - 1 ? `<span class="amber" style="font-weight:700">${esc(l.text.trim())}</span>` : esc(l.text.trim()))).join(' <span style="color:var(--ink-4)">→</span> ');
    const tn = f.top_neuron;
    cards = `
      <div class="card"><h3>Word ${sel + 1}: <span class="mono amber">${esc(f.text.trim())}</span></h3><p class="col-sub">Top 5 odds, picked at temperature ${s.meta?.temperature ?? 0.7}</p>
        <div class="bars">${bars}</div>
        <p class="col-sub" style="margin-top:18px">Each layer's guess</p><p class="mono" style="margin:6px 0 0;font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${guesses}</p></div>
      <div class="card"><h3>Inside the model then</h3>
        <div style="margin-top:12px;height:86px;position:relative"><canvas class="mini"></canvas></div>
        <p style="margin:10px 0 0;font-size:13px;line-height:19px;color:#DDE4F3"><span class="amber" style="font-weight:600">Layer ${tn.layer}, neuron ${tn.index.toLocaleString('en-US')}</span> was strongest${tn.label ? `: it lights up for ${esc(tn.label)}` : ''}.</p>
        <p class="col-sub" style="margin-top:10px">Where it looked for this word</p>
        <div style="margin-top:6px">${sourceBar(new Map(f.looking_at.map((x) => [x.src, x.w])), s.prompt, { labels: false, height: 10 })}</div></div>
      <div class="card"><h3>Notes it leaned on</h3><p class="col-sub">Whole answer, from Supermemory</p>${noteRows}
        <p class="foot">Based on where it looked while writing: a strong hint about sources, not proof.</p></div>`;
  }
  body.innerHTML = `
    <div class="abs done-chips" role="group" aria-label="The answer, one button per word">${chips}</div>
    <div class="abs legend-row">${legend}</div>
    <div class="abs cards below-fold">${cards}</div>`;
  const mini = body.querySelector<HTMLCanvasElement>('canvas.mini');
  if (mini && f) {
    const w = mini.parentElement!.clientWidth || 240;
    mini.style.width = `${w}px`;
    drawTowers(mini, w, 86, { layers: s.meta?.layers ?? 28, rows: s.meta?.neurons_per_layer ?? 14, values: decodeNeurons(f.neurons), hot: { layer: f.top_neuron.layer, row: f.top_neuron.row }, towerW: 7, win: 4, gap: 1, labelH: 6 });
  }
}

// ---------------------------------------------------------------- error
export function renderError(body: HTMLElement, title: string, message: string, action?: { label: string; name: string }) {
  body.innerHTML = `<div class="abs stage-error"><h3>${esc(title)}</h3><p>${esc(message)}</p>${action ? `<button class="text-btn" type="button" data-action="${esc(action.name)}">${esc(action.label)}</button>` : ''}</div>`;
}

// ---------------------------------------------------------------- text view (screen readers, "Show as text")
export function summarize(view: string, s: AnswerState | null, idx: number): string {
  if (!s) return '<p>The model is idle. Type a question in the chat, or play the replay.</p>';
  const parts: string[] = [`<p>Question: ${esc(s.question)}</p>`];
  if (s.retrieval) {
    const used = s.retrieval.results.filter((r) => r.used).map((r) => r.file);
    parts.push(`<p>${s.retrieval.error ? esc(s.retrieval.error) + '.' : `Searched Trey's notes and used ${used.length} of them${used.length ? `: ${used.map(esc).join(', ')}` : ''}.`}</p>`);
  }
  if (s.prompt) parts.push(`<p>The prompt is ${s.prompt.total} tokens long.</p>`);
  const f = s.tokens[idx];
  if (view === 'writing' && f) {
    parts.push(`<p>Choosing word ${idx + 1}. Most likely next words: ${f.topk.map((k) => `${esc(k.text.trim())} ${pct(k.p)}`).join(', ')}. It picked “${esc(f.text.trim())}”.</p>`);
    parts.push(`<p>Strongest neuron: layer ${f.top_neuron.layer}, number ${f.top_neuron.index}. It is looking mostly at ${esc(sourceLabel([...f.looking_at].sort((a, b) => b.w - a.w)[0]?.src || 'answer'))}.</p>`);
    parts.push(`<p>Earlier layers would have said: ${f.logit_lens.map((l) => `layer ${l.layer} “${esc(l.text.trim())}”`).join(', ')}.</p>`);
  }
  if (s.done) parts.push(`<p>Answer: ${esc(answerText(s))}</p>`);
  return parts.join('');
}
