// A stand-in for the trey-lm gateway with real HTTP streaming, so the end-to-end tests see the same
// timing behaviour as production (chunks arriving over time, cold starts, mid-stream errors).
// Tests pick a scenario with POST /__scenario and read counters from GET /__stats.
import { createServer, type ServerResponse } from 'node:http';
import { stream } from '../fixtures/frames.ts';
import type { StreamEvent } from '../../src/protocol/types';

export interface Scenario {
  healthDown?: boolean;
  chatEnabled?: boolean;
  /** ms after the scenario is set until the model reports ready (cold start). */
  readyAfterMs?: number;
  /** HTTP error for /api/chat instead of a stream. */
  chatStatus?: 429 | 503 | 500;
  tokenDelayMs?: number;
  tokens?: number;
  /** send an error event after this many tokens */
  failAfter?: number;
  schemaV?: number;
}

let scenario: Scenario = {};
let setAt = Date.now();
let stats = { warm: 0, tokenize: [] as number[], chat: 0 };
const PORT = Number(process.env.MOCK_PORT || 8787);

const ready = () => Date.now() - setAt >= (scenario.readyAfterMs ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
}
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const sse = (e: StreamEvent) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;

async function chat(res: ServerResponse) {
  stats.chat++;
  if (scenario.chatEnabled === false || scenario.chatStatus === 503) return json(res, 503, { code: 'chat_disabled', message: 'The chat is turned off right now.' });
  if (scenario.chatStatus === 429) return json(res, 429, { code: 'rate_limited', message: "You've asked a lot of questions. Try again in 7 minutes.", retry_after: 420 }, { 'Retry-After': '420' });
  if (scenario.chatStatus) return json(res, scenario.chatStatus, { code: 'model_error', message: 'Server error' });
  cors(res);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let closed = false;
  res.on('close', () => { closed = true; });
  const events = stream(scenario.tokens ?? 9);
  const t0 = Date.now();
  let tokens = 0;
  for (const e of events) {
    if (closed) return;
    if (e.event === 'status' && e.data.phase === 'prefill') {
      while (!ready() && !closed) {
        res.write(sse({ event: 'status', data: { phase: 'waking', elapsed_ms: Date.now() - t0 } }));
        await sleep(1000);
      }
    }
    if (e.event === 'token') {
      if (scenario.failAfter !== undefined && tokens >= scenario.failAfter) {
        res.write(sse({ event: 'error', data: { code: 'model_error', message: 'Something went wrong while writing. The partial answer is kept; try again.' } }));
        break;
      }
      tokens++;
      await sleep(scenario.tokenDelayMs ?? 40);
    }
    if (e.event === 'meta' && scenario.schemaV) (e.data as { v: number }).v = scenario.schemaV;
    res.write(sse(e));
  }
  res.end();
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  if (url.pathname === '/__scenario' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    scenario = body ? JSON.parse(body) : {};
    setAt = Date.now();
    stats = { warm: 0, tokenize: [], chat: 0 };
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__stats') return json(res, 200, stats);
  if (url.pathname === '/api/health') {
    if (scenario.healthDown) { res.destroy(); return; }
    return json(res, 200, { chat_enabled: scenario.chatEnabled !== false, gpu_ready: ready(), version: 'test', schema_v: scenario.schemaV ?? 1, model_error: null });
  }
  if (url.pathname === '/api/warm' && req.method === 'POST') { stats.warm++; return json(res, 200, { ok: true, gpu_ready: ready() }); }
  if (url.pathname === '/api/tokenize') {
    stats.tokenize.push(Date.now());
    const q = url.searchParams.get('q') || '';
    const pieces = q.match(/\s*[A-Za-z0-9]+|\s*[^\sA-Za-z0-9]/g) || [];
    const ids = pieces.map((p, i) => 1000 + ((p.length * 131 + i * 17) % 120000));
    const rows = pieces.slice(0, 16).map((_, i) => Array.from({ length: 56 }, (_, k) => Math.sin(i * 3 + k) * 0.05));
    return json(res, 200, { ids, pieces, count: ids.length, chars: q.length, vocab: 128256, hidden: 3072, embed_preview: rows, embed_scale: 0.05 });
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') { for await (const _ of req) { /* drain */ } return chat(res); }
  json(res, 404, { code: 'bad_input', message: 'not found' });
}).listen(PORT, () => console.log(`mock API on http://localhost:${PORT}`));
