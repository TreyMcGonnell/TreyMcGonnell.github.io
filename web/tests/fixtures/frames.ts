// Deterministic, schema-valid stream events for tests and the mocked API. No personal content: sample text only.
import type { Replay, StreamEvent, TokenFrame } from '../../src/protocol/types';

export const ANSWER = ['Sample', ' answer', ':', ' Trey', ' built', ' a', ' sample', ' tool', '.'];
export const LAYERS = 28;
export const PER_LAYER = 14;

function neurons(i: number): string {
  let s = '';
  for (let k = 0; k < LAYERS * PER_LAYER; k++) s += String.fromCharCode((i * 37 + k * 11) % 256);
  return btoa(s);
}

export function tokenFrame(i: number, text = ANSWER[i % ANSWER.length]): TokenFrame {
  return {
    i, id: 1000 + i, text, p: 0.52,
    topk: [{ text: text, p: 0.52 }, { text: ' app', p: 0.19 }, { text: ' model', p: 0.11 }, { text: ' system', p: 0.08 }, { text: ' bot', p: 0.05 }],
    neurons: neurons(i),
    top_neuron: { layer: 20, index: 4821, row: 3, label: 'words like “tool”, “app”, “built”' },
    attention: [{ text: ' tool', src: 'note:projects/sample.md', w: 0.31 }, { text: ' Trey', src: 'bio', w: 0.12 }],
    looking_at: [{ src: 'note:projects/sample.md', w: 0.41 }, { src: 'answer', w: 0.24 }, { src: 'bio', w: 0.14 }, { src: 'question', w: 0.09 }, { src: 'rules', w: 0.12 }],
    logit_lens: [4, 10, 16, 22, 28].map((layer, k) => ({ layer, text: k < 3 ? ' the' : text })),
  };
}

export function stream(n = ANSWER.length, opts: { waking?: boolean } = {}): StreamEvent[] {
  const ev: StreamEvent[] = [
    { event: 'meta', data: { v: 1, model: 'sample', layers: LAYERS, hidden: 3072, mlp: 8192, vocab: 128256, temperature: 0.7, neurons_per_layer: PER_LAYER, lens_layers: [4, 10, 16, 22, 28] } },
    { event: 'status', data: { phase: 'retrieving', elapsed_ms: 5 } },
    { event: 'retrieval', data: { results: [
      { file: 'projects/sample.md', title: 'Sample project', score: 0.84, used: true, snippet: 'SAMPLE: Trey built a sample tool.', highlights: [[8, 12], [13, 18]] },
      { file: 'notes/sample-clubs.md', title: 'Sample clubs', score: 0.22, used: false, snippet: 'SAMPLE: clubs.', highlights: [] },
    ] } },
    { event: 'prompt', data: { sections: [
      { kind: 'rules', label: 'Rules', source: 'rules', tokens: 74, start: 0, sample: ['You', ' are'] },
      { kind: 'bio', label: "Trey's bio", source: 'bio', tokens: 120, start: 74, sample: ['SAMPLE', ' BIO'] },
      { kind: 'note', label: 'projects/sample.md', source: 'note:projects/sample.md', tokens: 60, start: 200, sample: ['SAMPLE'] },
      { kind: 'question', label: 'You', source: 'question', tokens: 6, start: 270, sample: ['What', ' has'] },
    ], total: 290 } },
  ];
  if (opts.waking) ev.push({ event: 'status', data: { phase: 'waking', elapsed_ms: 1200 } });
  ev.push({ event: 'status', data: { phase: 'prefill', elapsed_ms: 40 } });
  ev.push({ event: 'prefill', data: { ms: 85, tokens: 290 } });
  for (let i = 0; i < n; i++) ev.push({ event: 'token', data: tokenFrame(i) });
  ev.push({ event: 'done', data: { tokens: n, ms: 400, sources: [{ src: 'note:projects/sample.md', share: 0.41 }, { src: 'bio', share: 0.14 }] } });
  ev.push({ event: 'status', data: { phase: 'done', elapsed_ms: 500 } });
  return ev;
}

export function toSSE(events: StreamEvent[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

export function replay(n = ANSWER.length): Replay {
  return {
    v: 1, question: 'What is Trey studying?', question_tokens: { ids: [3923, 374, 28132, 21630, 30], pieces: ['What', ' is', ' Trey', ' studying', '?'] },
    recorded_at: '2026-11-18T00:00:00+00:00', seed: 7,
    events: stream(n).map((e, k) => ({ ...e, t: k * 10 })),
  };
}
