// Mirrors protocol/frame.schema.json (schema version 1). Test B1 validates fixtures against the JSON Schema.

export type Source = string; // 'rules' | 'bio' | 'question' | 'answer' | `note:${file}`

export interface Meta {
  v: 1; model: string; layers: number; hidden: number; mlp: number; vocab: number;
  temperature: number; neurons_per_layer: number; lens_layers: number[];
}
export type Phase = 'queued' | 'waking' | 'retrieving' | 'prefill' | 'generating' | 'done';
export interface Status { phase: Phase; elapsed_ms: number; queue_pos?: number }
export interface RetrievalResult { file: string; title: string; score: number; used: boolean; snippet: string; highlights: [number, number][] }
export interface Retrieval { results: RetrievalResult[]; error?: string }
export interface PromptSection { kind: 'rules' | 'bio' | 'note' | 'question'; label: string; source: Source; tokens: number; start: number; sample?: string[] }
export interface Prompt { sections: PromptSection[]; total: number }
export interface Prefill { ms: number; tokens: number }
export interface TopK { text: string; p: number }
export interface TokenFrame {
  i: number; id: number; text: string; p: number; topk: TopK[];
  neurons: string; // base64, layers x neurons_per_layer bytes
  top_neuron: { layer: number; index: number; row: number | null; label?: string };
  attention: { text: string; src: Source; w: number }[];
  looking_at: { src: Source; w: number }[];
  logit_lens: { layer: number; text: string }[];
}
export interface Done { tokens: number; ms: number; sources: { src: Source; share: number }[] }
export type ErrorCode = 'rate_limited' | 'chat_disabled' | 'model_error' | 'bad_input' | 'busy' | 'blocked';
export interface StreamError {
  code: ErrorCode; message: string; retry_after?: number;
  /** for rate limits: 'window' (10 in 10 min), 'ip_day' (this visitor's daily cap), 'global_day' (the site's daily cap) */
  reason?: string;
}

export type StreamEvent =
  | { event: 'meta'; data: Meta; t?: number }
  | { event: 'status'; data: Status; t?: number }
  | { event: 'retrieval'; data: Retrieval; t?: number }
  | { event: 'prompt'; data: Prompt; t?: number }
  | { event: 'prefill'; data: Prefill; t?: number }
  | { event: 'token'; data: TokenFrame; t?: number }
  | { event: 'done'; data: Done; t?: number }
  | { event: 'error'; data: StreamError; t?: number };

export interface Replay {
  v: 1; question: string; question_tokens: { ids: number[]; pieces: string[] };
  recorded_at: string; seed: number; events: StreamEvent[];
}

export interface TokenizeResult {
  ids: number[]; pieces: string[]; count: number; chars: number; vocab: number; hidden: number;
  embed_preview: number[][] | null; embed_scale: number;
}

export interface Health { chat_enabled: boolean; gpu_ready: boolean; version: string; schema_v: number; model_error?: string | null }

export const SCHEMA_V = 1;

/** Decode the base64 neuron bytes into values 0..1. */
export function decodeNeurons(b64: string): Float32Array {
  const bin = atob(b64);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}
