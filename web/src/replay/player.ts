// Plays a recorded answer through the same stage as a live one, on a ~20 second timeline. Test D2.
import { emptyAnswer, reduce, type AnswerState } from '../home/answer';
import type { Replay, StreamEvent } from '../protocol/types';

export interface Scheduled { at: number; e: StreamEvent }
export type ReplayStep = 'question' | 'memory' | 'reading' | 'writing' | 'sources';

export interface Schedule {
  items: Scheduled[];
  duration: number;
  marks: { question: number; memory: number; reading: number; writing: number; sources: number };
  tokenMs: number;
}

/** Compress the real timings into a story: question, memory search, one pass, words at a readable pace. */
export function scheduleReplay(r: Replay, maxWritingMs = 9_000): Schedule {
  const tokens = r.events.filter((x) => x.event === 'token');
  // Short answers play slowly (up to 0.6 s a word) so the towers can be watched; long ones speed up to fit.
  const tokenMs = Math.max(120, Math.min(600, maxWritingMs / Math.max(1, tokens.length)));
  const marks = { question: 0, memory: 2200, reading: 4200, writing: 6000, sources: 0 };
  const items: Scheduled[] = [];
  let ti = 0;
  for (const e of r.events) {
    switch (e.event) {
      case 'meta': items.push({ at: 0, e }); break;
      case 'status': break; // live-only noise (waking, queued); the replay was recorded warm
      case 'retrieval': items.push({ at: marks.memory, e }); break;
      case 'prompt': items.push({ at: marks.memory + 900, e }); break;
      case 'prefill': items.push({ at: marks.reading, e }); break;
      case 'token': items.push({ at: marks.writing + ti++ * tokenMs, e }); break;
      case 'done': items.push({ at: marks.writing + ti * tokenMs + 300, e }); break;
      case 'error': break;
    }
  }
  marks.sources = marks.writing + ti * tokenMs + 300;
  return { items, duration: marks.sources + 2600, marks, tokenMs };
}

export function stepAt(s: Schedule, ms: number): ReplayStep {
  if (ms >= s.marks.sources) return 'sources';
  if (ms >= s.marks.writing) return 'writing';
  if (ms >= s.marks.reading) return 'reading';
  if (ms >= s.marks.memory) return 'memory';
  return 'question';
}

export class ReplayPlayer {
  readonly schedule: Schedule;
  private pos = 0;
  private lastTick: number | null = null;
  playing = false;

  constructor(readonly replay: Replay, private now: () => number = () => performance.now()) {
    this.schedule = scheduleReplay(replay);
  }

  get duration(): number { return this.schedule.duration; }
  get position(): number { return this.pos; }
  get ended(): boolean { return this.pos >= this.duration; }

  play(): void { if (this.ended) this.pos = 0; this.playing = true; this.lastTick = this.now(); }
  pause(): void { this.tick(); this.playing = false; this.lastTick = null; }
  seek(ms: number): void { this.pos = Math.max(0, Math.min(this.duration, ms)); this.lastTick = this.playing ? this.now() : null; }

  /** Advance the clock; returns true while playing. */
  tick(): boolean {
    if (!this.playing) return false;
    const t = this.now();
    if (this.lastTick !== null) this.pos = Math.min(this.duration, this.pos + (t - this.lastTick));
    this.lastTick = t;
    if (this.ended) this.playing = false;
    return this.playing;
  }

  /** The answer as it stands at `ms` on the timeline. */
  stateAt(ms = this.pos): AnswerState {
    const s = emptyAnswer(this.replay.question, this.replay.question_tokens.pieces);
    for (const it of this.schedule.items) {
      if (it.at > ms) break;
      reduce(s, it.e);
    }
    return s;
  }

  step(ms = this.pos): ReplayStep { return stepAt(this.schedule, ms); }
}
