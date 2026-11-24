// Home page controller: warm-up and health, the replay, tokenizing while typing, and live answers.
// One stage renders both replays and live answers from the same AnswerState.
import { ApiError, fetchJSON, health, streamChat, tokenize, warm } from '../api/client';
import { Terminal } from '../chat/terminal';
import { SCHEMA_V, type Replay, type StreamEvent, type TokenFrame, type TokenizeResult } from '../protocol/types';
import { ReplayPlayer, type ReplayStep } from '../replay/player';
import { createScene } from '../scene/skyline.js';
import { FrameBuffer } from '../viz/buffer';
import { flyWord } from '../viz/fly';
import * as V from '../viz/views';
import { cityBoot, warmupProgress } from '../viz/warmup';
import { answerText, emptyAnswer, reduce, sourceLabel, type AnswerState } from './answer';
import { Asker } from './asker';

interface SiteContent { projects: { slug: string }[]; replays: string[]; sample: boolean }
type View = 'landing' | 'typing' | 'thinking' | 'writing' | 'done' | 'error';
type Mode = 'idle' | 'replay' | 'typing' | 'live';

interface Live {
  s: AnswerState;
  buf: FrameBuffer;
  pending: TokenFrame[];
  sweepStart: number | null;
  ended: boolean;
  caughtAt: number | null;
  lastFlown: number;
  chatKey?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const pct = (p: number) => `${Math.round(p * 100)}%`;
const ICON_PAUSE = '<svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect x="1" y="1" width="3.5" height="12" rx="1" fill="#ECF1FB"/><rect x="7.5" y="1" width="3.5" height="12" rx="1" fill="#ECF1FB"/></svg>';
const ICON_PLAY = '<svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1.5v11l9-5.5z" fill="#ECF1FB"/></svg>';
const ICON_AGAIN = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7a4.5 4.5 0 1 0 1.4-3.3M2.5 1.5v2.8h2.8" fill="none" stroke="#ECF1FB" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function startHome() {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = $('#stage');
  const body = $('#stage-body');
  const title = $('#stage-title');
  const sub = $('#stage-sub');
  const textView = $('#stage-text');
  const textToggle = $<HTMLButtonElement>('#text-toggle');
  const flyLayer = document.querySelector('#fly-layer') as SVGSVGElement;
  const term = new Terminal($('#term'), (i) => { sel = i; render(true); });

  // ---------------------------------------------------------------- layout scale + scene
  const setScale = () => document.documentElement.style.setProperty('--u', String(Math.min(innerHeight / 900, innerWidth / 1440)));
  setScale();
  addEventListener('resize', () => { setScale(); render(true); });
  const scene = createScene($<HTMLCanvasElement>('#scene'), {
    paused: reduceMotion,
    maxDpr: innerWidth < 760 ? 1.5 : undefined,
    onLite: () => document.body.classList.add('lite'),
  });
  (window as unknown as { __scene: unknown }).__scene = scene; // test hook (D7, G3)

  // ---------------------------------------------------------------- state
  let mode: Mode = 'idle';
  let replay: Replay | null = null;
  let player: ReplayPlayer | null = null;
  let projectSlugs = new Set<string>();
  let typed: { q: string; tok: TokenizeResult | null; failed: boolean } | null = null;
  let live: Live | null = null;
  let abort: AbortController | null = null;
  let sel = -1;
  let doneMode: V.DoneMode = 'sure';
  let lastQuestion = '';
  let lastKey = '';
  let link: 'unknown' | 'up' | 'down' = 'unknown';
  let chatEnabled = true;
  let gpuReady = false;
  let everReady = false;
  const t0 = performance.now();
  const SWEEP_MS = reduceMotion ? 0 : 1600;

  const asker = new Asker(() => link === 'up' && chatEnabled, (q) => runLive(q));

  // ---------------------------------------------------------------- health + warm-up
  void warm(); // exactly one warm-up request per page load (test E1)
  let lastLinkText = '';
  function updateLink() {
    const secs = Math.round((performance.now() - t0) / 1000);
    let state: Parameters<Terminal['setLink']>[0];
    if (!chatEnabled) state = 'disabled';
    else if (link === 'down') state = 'offline';
    else if (gpuReady) state = 'ready';
    else if (everReady) state = 'asleep';
    else state = 'waking';
    const p = warmupProgress(performance.now() - t0, gpuReady);
    const key = `${state}:${secs}:${Math.round(p * 50)}`;
    if (key === lastLinkText) return;
    lastLinkText = key;
    term.setLink(state, secs, p);
  }

  // The city boots on every visit: it follows the real warm-up while the model wakes, and when the model is
  // already awake it still plays a short boot so every visitor sees the lights come on.
  let cityReadySince: number | null = null;
  let cityStartP = 0;
  let cityP = -1;
  let cityDone = false;
  function updateCity() {
    if (cityDone) return;
    const elapsed = performance.now() - t0;
    const settled = gpuReady || link === 'down' || !chatEnabled; // nothing left to wait for
    if (settled && cityReadySince === null) { cityReadySince = elapsed; cityStartP = Math.max(0, cityP); }
    const { p, done } = cityBoot(elapsed, cityReadySince, cityStartP, reduceMotion);
    if (p !== cityP) { cityP = p; scene.setProgress(Math.min(p, 0.999)); }
    if (done) { cityDone = true; scene.setReady(); }
  }

  async function poll() {
    let next = 2000;
    try {
      const h = await health();
      link = 'up';
      if (h.schema_v !== SCHEMA_V) chatEnabled = false; // a frontend/backend version mismatch falls back to the replay (B1)
      else chatEnabled = h.chat_enabled;
      if (h.gpu_ready) { gpuReady = true; everReady = true; } else gpuReady = false;
      if (gpuReady || !chatEnabled) next = 30_000; // keep checking for the kill switch (J4)
    } catch {
      link = 'down';
      next = 10_000;
    }
    if (link === 'down' && asker.waitingFor) { asker.cancel(); offline(); }
    if (!chatEnabled && asker.waitingFor) { asker.cancel(); disabledFallback(); }
    asker.poke();
    updateLink();
    setTimeout(poll, next);
  }
  void poll();

  // ---------------------------------------------------------------- content + replay
  const BASE = import.meta.env.BASE_URL; // '/' on the site; './' when the build is published as a standalone page
  let contentLoading = true;
  let replayNames: string[] = [];
  const replayCache = new Map<string, Promise<Replay>>();
  const loadReplay = (name: string) => {
    if (!replayCache.has(name)) replayCache.set(name, fetchJSON<Replay>(`${BASE}replays/${name}`));
    return replayCache.get(name)!;
  };
  const wordsOf = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1));
  /** The recorded answer closest to a question (the first replay when none is close). */
  async function replayFor(q: string): Promise<Replay | null> {
    if (!replayNames.length) return replay;
    const want = wordsOf(q);
    let best: Replay | null = null, bestScore = 0.5;
    for (const name of replayNames) {
      const r = await loadReplay(name).catch(() => null);
      if (!r) continue;
      const have = wordsOf(r.question);
      const overlap = [...want].filter((w) => have.has(w)).length / Math.max(1, new Set([...want, ...have]).size);
      if (overlap >= bestScore) { best = r; bestScore = overlap; }
    }
    return best ?? replay;
  }
  void (async () => {
    try {
      const c = await fetchJSON<SiteContent>(`${BASE}content.json`);
      projectSlugs = new Set(c.projects.map((p) => p.slug));
      replayNames = c.replays;
      if (c.replays.length) {
        replay = await loadReplay(c.replays[0]);
        player = new ReplayPlayer(replay);
      }
    } catch { /* no content: the landing view without a replay */ }
    contentLoading = false;
    if (mode === 'idle') {
      if (player && !reduceMotion) startReplay();
      else render(true);
    }
  })();

  function startReplay(fromStart = true) {
    if (!player) { mode = 'idle'; render(true); return; }
    mode = 'replay';
    sel = -1;
    doneMode = 'source';
    if (fromStart) player.seek(0);
    if (!reduceMotion || !fromStart) player.play();
    render(true);
  }

  function pauseReplay() { if (player?.playing) player.pause(); }

  // ---------------------------------------------------------------- replay bar
  // The bar is in the page's HTML so it holds its space from the first paint (no layout shift when the replay starts).
  const bar = $('#replay-bar');
  const barQ = bar.querySelector('.q') as HTMLElement;
  const barTime = bar.querySelector('.time') as HTMLElement;
  const barBtn = bar.querySelector('[data-action="toggle-replay"]') as HTMLButtonElement;
  const barNarration = bar.querySelector('.narration') as HTMLElement;
  const barSegs = [...bar.querySelectorAll<HTMLElement>('.replay-progress span')];
  const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

  function narration(step: ReplayStep, s: AnswerState, ended: boolean): string {
    if (ended) return 'Your turn. Ask anything in the chat, or play this again.';
    const used = (s.retrieval?.results || []).filter((r) => r.used).map((r) => r.file.split('/').pop());
    switch (step) {
      case 'question': return `Someone asked this. First it is split into ${s.qPieces?.length ?? 'a few'} tokens, the pieces the model reads.`;
      case 'memory': return used.length ? `Supermemory searched Trey's notes and found ${used.join(', ')}. It goes into the prompt.` : "Supermemory searched Trey's notes. Nothing matched, so it answers from his bio.";
      case 'reading': return `The model reads all ${s.prompt?.total ?? ''} prompt tokens through ${s.meta?.layers ?? 28} layers in one pass.`;
      case 'writing': {
        const f = s.tokens[s.tokens.length - 1];
        if (!f) return 'Now it writes, one token at a time.';
        const top = [...f.looking_at].sort((a, b) => b.w - a.w)[0];
        return `Word ${s.tokens.length}: “${f.text.trim()}”, ${pct(f.p)} likely. Looking mostly at ${sourceLabel(top?.src || 'answer')}.`;
      }
      case 'sources': {
        const notes = (s.done?.sources || []).filter((x) => x.src.startsWith('note:'));
        const share = notes.reduce((a, x) => a + x.share, 0);
        return notes.length ? `Done. ${pct(share)} of where it looked was Trey's notes from Supermemory.` : 'Done. This answer came from his bio and the rules.';
      }
    }
  }

  function updateBar(s: AnswerState, step: ReplayStep) {
    if (!player || !replay) return;
    const m = player.schedule.marks;
    const pos = player.position;
    barQ.textContent = `“${replay.question}”`;
    barTime.textContent = `${mmss(pos)} / ${mmss(player.duration)}`;
    const icon = player.ended ? 'again' : player.playing ? 'pause' : 'play';
    if (barBtn.dataset.icon !== icon) {
      barBtn.dataset.icon = icon;
      barBtn.innerHTML = icon === 'pause' ? ICON_PAUSE : icon === 'play' ? ICON_PLAY : ICON_AGAIN;
      barBtn.setAttribute('aria-label', icon === 'pause' ? 'Pause the replay' : icon === 'play' ? 'Play the replay' : 'Play the replay again');
    }
    const bounds = [[0, m.reading], [m.reading, m.writing], [m.writing, m.sources], [m.sources, player.duration]];
    bounds.forEach(([a, b], i) => {
      const f = Math.max(0, Math.min(1, (pos - a) / Math.max(1, b - a)));
      (barSegs[i].firstElementChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
      barSegs[i].classList.toggle('now', pos >= a && pos < b);
    });
    const n = narration(step, s, player.ended);
    if (barNarration.textContent !== n) barNarration.textContent = n;
  }

  // ---------------------------------------------------------------- views
  const HEAD: Record<View, [string, string]> = {
    landing: ['Ask a question. Watch it think.', 'A 3-billion-parameter model, 28 layers drawn as towers. Each window is a neuron.'],
    typing: ['Reading your question', 'Before anything else, the text becomes tokens.'],
    thinking: ['Getting ready to answer', ''],
    writing: ['Choosing the next word', 'Every word is picked from odds the model computes across all 28 layers.'],
    done: ['How it wrote that answer', 'Click any word to see why it was chosen.'],
    error: ['Something went wrong', ''],
  };

  function defaultSel(s: AnswerState): number {
    let best = -1, bestShare = 0;
    s.tokens.forEach((t, i) => {
      if (!/[A-Za-z0-9]/.test(t.text)) return;
      const share = t.looking_at.filter((x) => x.src.startsWith('note:')).reduce((a, x) => a + x.w, 0);
      if (share > bestShare) { bestShare = share; best = i; }
    });
    return best >= 0 ? best : Math.max(0, s.tokens.length - 1);
  }

  function setHead(view: View, s: AnswerState | null, override?: [string, string], idx = -1) {
    const [h, p] = override || HEAD[view];
    title.textContent = h;
    sub.textContent = view === 'thinking' && s ? `“${s.question}”` : view === 'writing' && s ? `Word ${Math.max(0, idx) + 1}. ${p}` : p;
    stage.dataset.view = view;
    stage.classList.toggle('is-landing', view === 'landing');
  }

  let doneToggle: HTMLElement | null = null;
  function showDoneToggle(on: boolean) {
    if (on && !doneToggle) {
      doneToggle = document.createElement('div');
      doneToggle.className = 'toggle';
      doneToggle.setAttribute('role', 'group');
      doneToggle.setAttribute('aria-label', 'Underline the words by');
      doneToggle.innerHTML = '<button type="button" data-mode="sure">How sure</button><button type="button" data-mode="source">Where it looked</button>';
      $('.stage-tools').prepend(doneToggle);
    }
    if (doneToggle) {
      doneToggle.hidden = !on;
      doneToggle.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === doneMode)));
    }
  }

  function questionTokens(s: AnswerState): TokenizeResult | null {
    if (!replay) return null;
    return { ids: replay.question_tokens.ids, pieces: replay.question_tokens.pieces, count: replay.question_tokens.ids.length, chars: replay.question.length, vocab: s.meta?.vocab ?? 128256, hidden: s.meta?.hidden ?? 3072, embed_preview: null, embed_scale: 1 };
  }

  function liveView(L: Live, now: number): { view: View; idx: number } {
    if (L.s.error && !L.s.tokens.length && L.ended) return { view: 'error', idx: -1 };
    if (!L.buf.received) return { view: L.ended && !L.s.tokens.length ? 'error' : 'thinking', idx: -1 };
    const idx = L.buf.visibleIndex();
    if (L.ended && L.buf.caughtUp()) {
      L.caughtAt ??= now;
      if (now - L.caughtAt > 700 || reduceMotion) return { view: 'done', idx };
    }
    return { view: 'writing', idx };
  }

  function sweepLayer(start: number | null, now: number, dur: number, layers: number): number {
    if (start === null) return 0;
    if (dur <= 0) return layers;
    return Math.max(1, Math.min(layers, 1 + Math.floor(((now - start) / dur) * layers)));
  }

  function render(force = false) {
    const now = performance.now();
    let key = '';
    let draw: () => void = () => {};
    let summary: () => string = () => V.summarize('idle', null, -1);
    stage.classList.toggle('is-replay', mode === 'replay');
    bar.hidden = !(mode === 'replay' || (mode === 'idle' && contentLoading && !reduceMotion));

    if (mode === 'idle') {
      key = `idle:${!!player}`;
      draw = () => {
        setHead('landing', null);
        showDoneToggle(false);
        V.renderLanding(body, { layers: 28, replayAvailable: !!player, reduceMotion });
      };
    } else if (mode === 'replay' && player) {
      const s = player.stateAt();
      const step = player.step();
      const layers = s.meta?.layers ?? 28;
      const m = player.schedule.marks;
      const sweep = step === 'reading' ? sweepLayer(m.reading, player.position, m.writing - m.reading, layers) : step === 'memory' ? 0 : layers;
      const view: View = step === 'question' ? 'typing' : step === 'memory' || step === 'reading' ? 'thinking' : step === 'writing' ? 'writing' : 'done';
      if (view === 'done' && sel < 0) sel = defaultSel(s);
      if (view !== 'done') sel = -1;
      updateBar(s, step);
      key = `replay:${view}:${s.tokens.length}:${sweep}:${sel}:${doneMode}:${!!s.retrieval}:${!!s.prompt}`;
      draw = () => {
        setHead(view, s, undefined, s.tokens.length - 1);
        showDoneToggle(view === 'done');
        if (view === 'typing') V.renderTyping(body, questionTokens(s), replay!.question);
        else if (view === 'thinking') V.renderThinking(body, s, { sweep, layers, waking: false, wakeElapsedMs: 0, reading: step === 'reading' });
        else if (view === 'writing') V.renderWriting(body, s, s.tokens.length - 1);
        else V.renderDone(body, s, sel, doneMode, projectSlugs);
      };
      summary = () => V.summarize(view, s, view === 'done' ? sel : s.tokens.length - 1);
    } else if (mode === 'typing' && typed) {
      const t = typed;
      key = `typing:${t.q}:${!!t.tok}:${t.failed}`;
      draw = () => {
        setHead('typing', null);
        showDoneToggle(false);
        if (t.failed) body.innerHTML = '<p class="abs muted" style="left:32px;top:100px;width:700px;font-size:15px">The tokenizer runs on the model\'s server, which can\'t be reached right now.</p>';
        else V.renderTyping(body, t.tok, t.q, t.tok?.hidden);
      };
    } else if (mode === 'live' && live) {
      const L = live;
      const { view, idx } = liveView(L, now);
      const layers = L.s.meta?.layers ?? 28;
      const sweep = sweepLayer(L.sweepStart, now, SWEEP_MS, layers);
      if (view === 'done' && sel < 0) sel = defaultSel(L.s);
      const phase = L.s.status?.phase ?? '';
      const wakeS = phase === 'waking' ? Math.round((L.s.status?.elapsed_ms ?? 0) / 1000) : 0;
      key = `live:${view}:${idx}:${sweep}:${sel}:${doneMode}:${phase}:${wakeS}:${L.s.queuePos ?? 0}:${!!L.s.retrieval}:${!!L.s.prompt}:${!!L.s.error}`;
      draw = () => {
        if (view === 'error') {
          const e = L.s.error;
          const limited = e?.code === 'rate_limited';
          const [head, title] = !limited ? ['The answer stopped', 'No answer this time']
            : e?.reason === 'global_day' ? ['The model is resting for today', 'Daily limit reached for the site']
            : e?.reason === 'ip_day' ? ['That’s all for today', 'You’ve reached today’s limit']
            : ['Time for a short break', 'Too many questions for now'];
          setHead('error', L.s, [head, '']);
          showDoneToggle(false);
          V.renderError(body, title, e?.message || 'Something went wrong.', player ? { label: 'Watch a recorded answer', name: 'replay' } : undefined);
          return;
        }
        setHead(view, L.s, undefined, idx);
        showDoneToggle(view === 'done');
        if (view === 'thinking') V.renderThinking(body, L.s, { sweep, layers, waking: phase === 'waking', wakeElapsedMs: L.s.status?.elapsed_ms ?? 0, reading: L.sweepStart !== null });
        else if (view === 'writing') V.renderWriting(body, L.s, idx);
        else V.renderDone(body, L.s, sel, doneMode, projectSlugs);
      };
      summary = () => V.summarize(view, L.s, view === 'done' ? sel : idx);
      // chat text: full speed, with the stage's current word highlighted (only re-rendered when it changes)
      const chatKey = `${view}:${idx}:${sel}:${L.s.tokens.length}:${L.ended}`;
      if (chatKey !== L.chatKey) {
        L.chatKey = chatKey;
        if (view === 'done') term.answer(L.s.tokens, { sel, writing: false, clickable: true });
        else if (L.s.tokens.length) term.answer(L.s.tokens, { now: idx, writing: !L.ended, clickable: false });
      }
      if (view === 'writing' && idx > L.lastFlown && key !== lastKey) {
        L.lastFlown = idx;
        if (!reduceMotion) requestAnimationFrame(() => {
          const from = body.querySelector('[data-pick] .word');
          const to = term.wordEl(idx);
          if (from && to) flyWord(L.s.tokens[idx].text, from.getBoundingClientRect(), to.getBoundingClientRect(), flyLayer, 360);
        });
      }
    }
    if (key === lastKey && !force) return;
    lastKey = key;
    draw();
    if (!textView.hidden) textView.innerHTML = summary();
  }

  // ---------------------------------------------------------------- live answers
  /** When the live model can't answer, play the recorded answer closest to what was asked. */
  function fallback(message: string) {
    term.error(message);
    void (async () => {
      const r = await replayFor(lastQuestion);
      if (r && r !== replay) { replay = r; player = new ReplayPlayer(r); }
      startReplay();
    })();
  }
  function offline() { fallback("The model is offline right now. Here's a recorded answer instead."); }
  function disabledFallback() { fallback("The chat is turned off right now. Here's a recorded answer instead."); }

  function ask(raw: string) {
    const q = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!q || asker.state === 'streaming') return;
    term.hideChips();
    term.input.value = '';
    term.setCount(0, null);
    lastQuestion = q;
    term.user(q);
    if (!chatEnabled) { disabledFallback(); return; }
    if (link === 'down') { offline(); return; }
    pauseReplay();
    mode = 'live';
    live = null;
    sel = -1;
    doneMode = 'sure';
    if (link === 'unknown') term.note('Connecting to the model\'s server', true);
    asker.ask(q);
    render(true);
  }

  async function runLive(q: string) {
    const ctrl = new AbortController();
    abort = ctrl;
    const pieces = typed?.q === q ? typed.tok?.pieces : undefined;
    const L: Live = { s: emptyAnswer(q, pieces), buf: new FrameBuffer(5), pending: [], sweepStart: null, ended: false, caughtAt: null, lastFlown: -1 };
    live = L;
    typed = null;
    mode = 'live';
    sel = -1;
    term.setStreaming(true);
    term.note('Searching Trey\'s notes', true);
    let failed = false;
    try {
      await streamChat(q, (e) => onEvent(L, e), ctrl.signal);
    } catch (err) {
      failed = true;
      if (ctrl.signal.aborted) {
        term.note(L.s.tokens.length ? 'Stopped.' : 'Stopped before it started writing.');
      } else if (err instanceof ApiError) {
        L.s.error = err.body;
        if (err.body.code === 'chat_disabled') { chatEnabled = false; updateLink(); disabledFallback(); }
        else if (err.body.code === 'rate_limited') term.error(err.body.message);
        else if (err.body.code === 'bad_input') term.error(err.body.message);
        else { L.s.error = { code: 'model_error', message: 'The model is offline right now.' }; offline(); }
      } else {
        link = 'down';
        updateLink();
        L.s.error = { code: 'model_error', message: 'The model is offline right now.' };
        offline();
      }
    } finally {
      if (L.pending.length) { L.pending.forEach((f) => L.buf.push(f)); L.pending = []; }
      L.buf.markDone();
      L.ended = true;
      abort = null;
      term.setStreaming(false);
      if (L.s.done && !L.s.error) term.announce(answerText(L.s));
      if (!failed && L.s.error) {
        const message = L.s.tokens.length ? `${L.s.error.message}` : L.s.error.message;
        term.error(message, () => ask(lastQuestion));
      }
      render(true);
    }
  }

  function onEvent(L: Live, e: StreamEvent) {
    if (e.event === 'meta' && e.data.v !== SCHEMA_V) { abort?.abort(); return; }
    reduce(L.s, e);
    switch (e.event) {
      case 'status':
        if (e.data.phase === 'waking') term.note(`Waking the model · ${Math.round(e.data.elapsed_ms / 1000)} s`, true);
        else if (e.data.phase === 'queued') term.note(`Someone else is being answered. You're number ${e.data.queue_pos ?? 1} in line`, true);
        else if (e.data.phase === 'prefill') term.note('Reading the prompt', true);
        break;
      case 'prefill':
        L.sweepStart = performance.now();
        gpuReady = true; everReady = true;
        break;
      case 'token':
        if (L.sweepStart !== null && performance.now() - L.sweepStart >= SWEEP_MS) L.buf.push(e.data);
        else L.pending.push(e.data);
        break;
    }
  }

  // ---------------------------------------------------------------- typing
  let tokTimer = 0;
  let tokCtrl: AbortController | null = null;
  term.input.addEventListener('input', () => {
    const q = term.input.value;
    term.setCount(q.length, typed?.q === q.trim() && typed.tok ? typed.tok.count : null);
    clearTimeout(tokTimer);
    if (!q.trim()) {
      typed = null;
      if (mode === 'typing') { mode = player ? 'replay' : 'idle'; render(true); }
      return;
    }
    if (mode === 'live' && asker.state === 'streaming') return;
    tokTimer = window.setTimeout(async () => {
      const text = term.input.value.trim();
      if (!text) return;
      pauseReplay();
      mode = 'typing';
      typed = { q: text, tok: typed?.q === text ? typed.tok : null, failed: false };
      render();
      tokCtrl?.abort();
      const ctrl = new AbortController();
      tokCtrl = ctrl;
      try {
        const tok = await tokenize(text, ctrl.signal);
        if (typed?.q === text) { typed.tok = tok; term.setCount(term.input.value.length, tok.count); }
      } catch {
        if (!ctrl.signal.aborted && typed?.q === text) typed.failed = true;
      }
      if (mode === 'typing') render();
    }, 250); // debounced: at most one tokenize request per 250 ms (test E3)
  });

  term.form.addEventListener('submit', (e) => { e.preventDefault(); ask(term.input.value); });
  term.onChip((q) => ask(q));
  term.stop.addEventListener('click', () => abort?.abort());
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && abort) { abort.abort(); e.preventDefault(); }
  });

  // ---------------------------------------------------------------- stage controls
  stage.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'play-replay' || action === 'replay') { startReplay(); return; }
    if (action === 'toggle-replay' && player) {
      if (player.ended) player.play();
      else if (player.playing) player.pause();
      else player.play();
      render(true);
      return;
    }
    if (action === 'ask-own') { pauseReplay(); term.input.focus(); render(true); return; }
    const modeBtn = t.closest<HTMLElement>('[data-mode]');
    if (modeBtn?.dataset.mode) { doneMode = modeBtn.dataset.mode as V.DoneMode; render(true); return; }
    const chip = t.closest<HTMLElement>('.done-chip');
    if (chip?.dataset.i) { sel = Number(chip.dataset.i); render(true); }
  });
  textToggle.addEventListener('click', () => {
    const show = textView.hidden;
    textView.hidden = !show;
    textToggle.setAttribute('aria-pressed', String(show));
    textToggle.textContent = show ? 'Show the picture' : 'Show as text';
    render(true);
  });

  // ---------------------------------------------------------------- loop
  function frame() {
    updateLink();
    updateCity();
    if (mode === 'replay' && player) player.tick();
    if (live && live.pending.length && live.sweepStart !== null && performance.now() - live.sweepStart >= SWEEP_MS) {
      live.pending.forEach((f) => live!.buf.push(f));
      live.pending = [];
    }
    render();
    requestAnimationFrame(frame);
  }
  render(true);
  requestAnimationFrame(frame);
}
