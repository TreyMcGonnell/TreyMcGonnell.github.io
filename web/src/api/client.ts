import type { Health, StreamEvent, StreamError, TokenizeResult } from '../protocol/types';
import { createSSEParser } from './sse';

export const API_BASE: string = (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'http://localhost:8000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, public body: StreamError) { super(body.message); }
}

async function errorFrom(r: Response): Promise<ApiError> {
  let body: StreamError = { code: 'model_error', message: 'The model is offline right now.' };
  try { body = await r.json(); } catch { /* not JSON: keep the default */ }
  return new ApiError(r.status, body);
}

export async function health(signal?: AbortSignal): Promise<Health> {
  const r = await fetch(`${API_BASE}/api/health`, { signal, cache: 'no-store' });
  if (!r.ok) throw await errorFrom(r);
  return r.json();
}

export async function warm(): Promise<void> {
  await fetch(`${API_BASE}/api/warm`, { method: 'POST' }).catch(() => undefined);
}

export async function tokenize(q: string, signal?: AbortSignal): Promise<TokenizeResult> {
  const r = await fetch(`${API_BASE}/api/tokenize?q=${encodeURIComponent(q)}`, { signal });
  if (!r.ok) throw await errorFrom(r);
  return r.json();
}

/** POST /api/chat and stream events. Resolves when the stream ends; rejects with ApiError on 4xx/5xx. */
export async function streamChat(q: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const r = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }), signal,
  });
  if (!r.ok || !r.body) throw await errorFrom(r);
  const parser = createSSEParser((e) => onEvent(e as StreamEvent));
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(dec.decode(value, { stream: true }));
  }
  parser.push(dec.decode());
}

export async function fetchJSON<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
