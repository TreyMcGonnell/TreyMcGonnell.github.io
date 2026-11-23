// Server-sent events over fetch (POST bodies rule out EventSource). Test D1.

export interface RawEvent { event: string; data: unknown }

/** Feed decoded text in any chunk sizes; complete events are emitted in order. */
export function createSSEParser(onEvent: (e: RawEvent) => void) {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk.replace(/\r\n/g, '\n');
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data.join('\n')); } catch { continue; }
        onEvent({ event, data: parsed });
      }
    },
    /** Anything left that never ended with a blank line is incomplete and dropped. */
    pending() { return buf; },
  };
}
