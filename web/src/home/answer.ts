// One answer's state, built the same way from a live stream or a recorded replay.
import type { Done, Meta, Prefill, Prompt, Retrieval, Status, StreamError, StreamEvent, TokenFrame } from '../protocol/types';

export interface AnswerState {
  question: string;
  qPieces?: string[];
  meta?: Meta;
  status?: Status;
  retrieval?: Retrieval;
  prompt?: Prompt;
  prefill?: Prefill;
  tokens: TokenFrame[];
  done?: Done;
  error?: StreamError;
  /** Set when the stream reported the model was asleep: how long it took to wake, in ms. */
  wakeMs?: number;
  queuePos?: number;
}

export function emptyAnswer(question: string, qPieces?: string[]): AnswerState {
  return { question, qPieces, tokens: [] };
}

export function reduce(s: AnswerState, e: StreamEvent): AnswerState {
  switch (e.event) {
    case 'meta': s.meta = e.data; break;
    case 'status':
      s.status = e.data;
      if (e.data.phase === 'waking') s.wakeMs = e.data.elapsed_ms;
      s.queuePos = e.data.phase === 'queued' ? e.data.queue_pos : undefined;
      break;
    case 'retrieval': s.retrieval = e.data; break;
    case 'prompt': s.prompt = e.data; break;
    case 'prefill': s.prefill = e.data; break;
    case 'token': s.tokens.push(e.data); break;
    case 'done': s.done = e.data; break;
    case 'error': s.error = e.data; break;
  }
  return s;
}

export function answerText(s: AnswerState, upTo = s.tokens.length): string {
  return s.tokens.slice(0, upTo).map((t) => t.text).join('');
}

/** Short readable name for a source key. */
export function sourceLabel(src: string): string {
  if (src.startsWith('note:')) return src.slice(5).split('/').pop() || src;
  return ({ rules: 'the rules', bio: "Trey's bio", question: 'you', answer: 'its answer so far' } as Record<string, string>)[src] || src;
}
