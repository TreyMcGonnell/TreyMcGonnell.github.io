import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';
import { createSSEParser } from '../../src/api/sse';
import { Asker } from '../../src/home/asker';
import { emptyAnswer, reduce } from '../../src/home/answer';
import { ReplayPlayer, scheduleReplay } from '../../src/replay/player';
import { FrameBuffer } from '../../src/viz/buffer';
import { heat } from '../../src/viz/heat';
import { cityBoot, FINISH_MS, MIN_BOOT_MS, warmupProgress } from '../../src/viz/warmup';
import { replay, stream, tokenFrame, toSSE } from '../fixtures/frames';

const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../protocol/frame.schema.json'), 'utf8'));

describe('B1 contract: site fixtures match the shared schema', () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  it('every fixture event validates', () => {
    for (const e of [...stream(9, { waking: true }), ...replay().events]) {
      const ok = validate(e);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });
});

describe('D1 stream reader', () => {
  it('handles events split across chunks and several events per chunk', () => {
    const got: string[] = [];
    const p = createSSEParser((e) => got.push(e.event));
    const text = toSSE(stream(3));
    for (let i = 0; i < text.length; i += 7) p.push(text.slice(i, i + 7));
    expect(got).toEqual(stream(3).map((e) => e.event));
    expect(p.pending()).toBe('');
  });
  it('emits error events and ignores incomplete trailing data', () => {
    const got: unknown[] = [];
    const p = createSSEParser((e) => got.push(e));
    p.push('event: error\ndata: {"code":"model_error","message":"x"}\n\nevent: token\ndata: {"i":');
    expect(got).toEqual([{ event: 'error', data: { code: 'model_error', message: 'x' } }]);
    expect(p.pending()).toContain('event: token');
  });
  it('handles CRLF line endings', () => {
    const got: string[] = [];
    const p = createSSEParser((e) => got.push(e.event));
    p.push('event: done\r\ndata: {"tokens":1,"ms":1,"sources":[]}\r\n\r\n');
    expect(got).toEqual(['done']);
  });
});

describe('D2 replay player', () => {
  it('tells the story in order and ends with a sources beat', () => {
    const s = scheduleReplay(replay());
    expect(s.marks.question).toBeLessThan(s.marks.memory);
    expect(s.marks.memory).toBeLessThan(s.marks.reading);
    expect(s.marks.reading).toBeLessThan(s.marks.writing);
    expect(s.marks.writing).toBeLessThan(s.marks.sources);
    expect(s.duration).toBeGreaterThan(s.marks.sources);
    expect(s.duration).toBeLessThanOrEqual(22_000);
  });
  it('plays, pauses, seeks and ends', () => {
    let t = 0;
    const p = new ReplayPlayer(replay(), () => t);
    p.play();
    t = 1000; p.tick();
    expect(p.position).toBe(1000);
    p.pause(); t = 5000; p.tick();
    expect(p.position).toBe(1000);
    p.seek(p.schedule.marks.writing + p.schedule.tokenMs * 2 + 1);
    expect(p.stateAt().tokens.length).toBe(3);
    expect(p.step()).toBe('writing');
    p.play(); t += p.duration * 2; p.tick();
    expect(p.ended).toBe(true);
    expect(p.step()).toBe('sources');
    expect(p.stateAt().done).toBeDefined();
  });
  it('keeps the writing beat readable even for long answers', () => {
    expect(scheduleReplay(replay(200)).tokenMs).toBeGreaterThanOrEqual(120);
  });
});

describe('D3 frame buffer', () => {
  it('never shows frames faster than 6 a second, even when they arrive at once', () => {
    let t = 0;
    const b = new FrameBuffer(5, () => t);
    for (let i = 0; i < 20; i++) b.push(tokenFrame(i));
    expect(b.visibleIndex()).toBe(0);
    t = 1000;
    expect(b.visibleIndex()).toBeLessThanOrEqual(6);
  });
  it('never drops the last frame and reports caught-up only after showing it', () => {
    let t = 0;
    const b = new FrameBuffer(5, () => t);
    for (let i = 0; i < 4; i++) b.push(tokenFrame(i));
    b.markDone();
    t = 500;
    expect(b.caughtUp()).toBe(false);
    t = 10_000;
    expect(b.visibleIndex()).toBe(3);
    expect(b.caughtUp()).toBe(true);
  });
  it('scrubbing returns the exact frame', () => {
    const b = new FrameBuffer();
    for (let i = 0; i < 5; i++) b.push(tokenFrame(i));
    expect(b.at(2)?.i).toBe(2);
  });
});

describe('D4 heat colors', () => {
  it('maps the four stops exactly', () => {
    expect(heat(0)).toBe('rgb(34,44,82)');
    expect(heat(0.45)).toBe('rgb(116,84,120)');
    expect(heat(0.8)).toBe('rgb(255,181,71)');
    expect(heat(1)).toBe('rgb(255,240,200)');
  });
  it('clamps out-of-range values', () => {
    expect(heat(-1)).toBe(heat(0));
    expect(heat(2)).toBe(heat(1));
  });
});

describe('D5 warm-up estimate', () => {
  it('holds at 90% until ready, then reaches 100%', () => {
    expect(warmupProgress(0, false)).toBe(0);
    expect(warmupProgress(10_000, false)).toBeCloseTo(0.4);
    expect(warmupProgress(120_000, false)).toBe(0.9);
    expect(warmupProgress(120_000, true)).toBe(1);
    expect(warmupProgress(100, true)).toBe(1);
  });
});

describe('D6 queue while waking', () => {
  it('sends a question asked while waking exactly once, when ready', async () => {
    let ready = false;
    const send = vi.fn(async () => {});
    const a = new Asker(() => ready, send);
    expect(a.ask('What has Trey built?')).toBe(true);
    expect(a.state).toBe('waiting');
    a.poke();
    expect(send).not.toHaveBeenCalled();
    ready = true;
    a.poke(); a.poke();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('What has Trey built?');
  });
  it('allows only one stream at a time', async () => {
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const a = new Asker(() => true, send);
    expect(a.ask('one')).toBe(true);
    expect(a.ask('two')).toBe(false);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.state).toBe('idle');
    expect(a.ask('three')).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('answer state', () => {
  it('records how long the model took to wake', () => {
    const s = emptyAnswer('q');
    for (const e of stream(2, { waking: true })) reduce(s, e);
    expect(s.wakeMs).toBe(1200);
    expect(s.tokens.length).toBe(2);
    expect(s.done?.tokens).toBe(2);
  });
});

describe('city boot on every visit', () => {
  it('plays a full boot even when the model is already awake', () => {
    const at = (ms: number) => cityBoot(ms, 200, 0);
    expect(at(200).p).toBeCloseTo(0);
    expect(at(1800).p).toBeGreaterThan(0.3);
    expect(at(1800).p).toBeLessThan(0.7);
    expect(at(MIN_BOOT_MS - 1).done).toBe(false);
    expect(at(MIN_BOOT_MS)).toEqual({ p: 1, done: true });
  });

  it('follows the warm-up while the model wakes, then fills the rest in smoothly', () => {
    expect(cityBoot(10_000, null, 0)).toEqual({ p: warmupProgress(10_000, false), done: false });
    const start = warmupProgress(22_000, false);
    expect(cityBoot(22_000, 22_000, start).p).toBeCloseTo(start);
    expect(cityBoot(22_000 + FINISH_MS / 2, 22_000, start).p).toBeGreaterThan(start);
    expect(cityBoot(22_000 + FINISH_MS, 22_000, start)).toEqual({ p: 1, done: true });
  });

  it('never goes backwards', () => {
    let last = -1;
    for (let ms = 300; ms <= MIN_BOOT_MS; ms += 50) {
      const { p } = cityBoot(ms, 300, 0.01);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it('switches straight on with reduced motion', () => {
    expect(cityBoot(300, 300, 0, true)).toEqual({ p: 1, done: true });
  });
});
