// The chat panel: the conversation log, warm-up status, and the input. Text runs at full model speed;
// the word the stage is currently explaining is highlighted, and on the Done screen words are clickable.
import type { TokenFrame } from '../protocol/types';

export type LinkState = 'waking' | 'asleep' | 'ready' | 'offline' | 'disabled';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Terminal {
  readonly input: HTMLInputElement;
  readonly form: HTMLFormElement;
  readonly stop: HTMLButtonElement;
  private log: HTMLElement;
  private status: HTMLElement;
  private bar: HTMLElement;
  private barFill: HTMLElement;
  private chips: HTMLElement;
  private count: HTMLElement;
  private hint: HTMLElement;
  private live: HTMLElement;
  private bot: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;

  constructor(private root: HTMLElement, private onWord: (i: number) => void) {
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.input = q('#chat-input');
    this.form = q('#chat-form');
    this.stop = q('#chat-stop');
    this.log = q('#term-log');
    this.status = q('#term-status');
    this.bar = q('#warm-bar');
    this.barFill = this.bar.querySelector('i') as HTMLElement;
    this.chips = q('#term-chips');
    this.count = q('#chat-count');
    this.hint = q('#chat-hint');
    this.live = q('#answer-live');
    // On phones the chat is a bottom sheet: it opens when used, and its header toggles it.
    root.addEventListener('focusin', () => { root.classList.add('focused'); root.classList.add('open'); });
    q('.term-head').addEventListener('click', () => root.classList.toggle('open'));
    root.addEventListener('focusout', () => { if (!root.contains(document.activeElement)) root.classList.remove('focused'); });
    this.log.addEventListener('click', (e) => {
      const w = (e.target as HTMLElement).closest<HTMLElement>('.w');
      if (w?.dataset.i) this.onWord(Number(w.dataset.i));
    });
  }

  /** Suggested questions. */
  onChip(fn: (q: string) => void) {
    this.chips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.textContent) fn(b.textContent.trim());
    });
  }

  hideChips() { this.chips.hidden = true; }

  setLink(state: LinkState, wakeSeconds = 0, progress = 0) {
    this.status.dataset.state = state;
    this.status.textContent = state === 'ready' ? 'Ready' : state === 'offline' ? 'Offline' : state === 'disabled' ? 'Replay only'
      : state === 'asleep' ? 'Asleep · wakes when you ask' : wakeSeconds > 0 ? `Waking up · ${wakeSeconds} s` : 'Waking up';
    this.bar.classList.toggle('hidden', state !== 'waking');
    this.barFill.style.width = state === 'waking' ? `${Math.round(progress * 100)}%` : '0%';
    if (state === 'disabled') {
      this.input.disabled = true;
      this.input.placeholder = 'The chat is off right now. Watch the replay.';
    } else if (!this.streaming) {
      this.input.disabled = false;
      this.input.placeholder = 'Ask something…';
    }
  }

  setCount(chars: number, tokens: number | null) {
    this.count.textContent = chars ? `${chars} / 300${tokens !== null ? ` · ${tokens} tokens` : ''}` : '';
  }

  private streaming = false;

  setStreaming(on: boolean) {
    this.streaming = on;
    this.stop.hidden = !on;
    this.input.disabled = on || this.status.dataset.state === 'disabled';
    this.hint.textContent = on ? 'Esc to stop' : 'Enter to send';
    if (!on && !this.input.disabled) this.input.focus({ preventScroll: true });
  }

  private add(el: HTMLElement) {
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  user(q: string) {
    this.root.classList.add('open');
    const p = document.createElement('p');
    p.className = 'msg-user';
    p.textContent = q;
    this.add(p);
    this.bot = null;
    this.noteEl = null;
  }

  /** A short status line under the question (waiting for the server, waking, in line). */
  note(html: string | null, dots = false) {
    if (html === null) { this.noteEl?.remove(); this.noteEl = null; return; }
    if (!this.noteEl) {
      this.noteEl = document.createElement('p');
      this.noteEl.className = 'msg-note';
      this.add(this.noteEl);
    }
    this.noteEl.innerHTML = html + (dots ? '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' : '');
  }

  /** Render the answer so far. `now` is the word the stage is on; `sel` the word picked on the Done screen. */
  answer(tokens: TokenFrame[], opts: { now?: number; sel?: number; writing: boolean; clickable: boolean }) {
    if (!tokens.length && !opts.writing) return;
    if (!this.bot) {
      this.note(null);
      this.bot = this.add(document.createElement('p'));
      this.bot.className = 'msg-bot';
    }
    const html = tokens.map((t, i) => {
      const cls = `w${i === opts.now ? ' now' : ''}${i === opts.sel ? ' sel' : ''}`;
      return opts.clickable ? `<span class="${cls}" data-i="${i}">${esc(t.text)}</span>` : `<span class="${cls}">${esc(t.text)}</span>`;
    }).join('');
    this.bot.innerHTML = html + (opts.writing ? '<span class="caret" aria-hidden="true"></span>' : '');
    // keep the word the stage is explaining in view (the text itself may already be further along)
    const focus = opts.now !== undefined ? this.wordEl(opts.now) : null;
    if (focus) {
      const top = focus.offsetTop - this.log.offsetTop;
      if (top < this.log.scrollTop + 8 || top + focus.offsetHeight > this.log.scrollTop + this.log.clientHeight - 8) {
        this.log.scrollTop = Math.max(0, top - this.log.clientHeight / 2);
      }
    } else if (this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60) {
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  /** The element of word i in the chat (target of the flying word). */
  wordEl(i: number): HTMLElement | null {
    return this.bot?.querySelectorAll<HTMLElement>('.w')[i] ?? null;
  }

  announce(text: string) { this.live.textContent = text; }

  error(message: string, retry?: () => void) {
    this.note(null);
    const p = document.createElement('p');
    p.className = 'msg-error';
    p.setAttribute('role', 'alert');
    p.textContent = message;
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Retry';
      b.addEventListener('click', () => { b.disabled = true; retry(); });
      p.appendChild(b);
    }
    this.add(p);
    this.bot = null;
  }
}
