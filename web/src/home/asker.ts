// A question asked while the model is still waking is kept and sent exactly once when it is ready.
// Only one answer streams at a time. Test D6.
export type AskState = 'idle' | 'waiting' | 'streaming';

export class Asker {
  state: AskState = 'idle';
  private pending: string | null = null;

  constructor(private isReady: () => boolean, private send: (q: string) => Promise<void>) {}

  /** Returns false if a different answer is already streaming (the UI offers Stop first). */
  ask(q: string): boolean {
    if (this.state === 'streaming') return false;
    if (!this.isReady()) {
      this.pending = q;
      this.state = 'waiting';
      return true;
    }
    void this.run(q);
    return true;
  }

  /** Call whenever readiness may have changed. */
  poke(): void {
    if (this.state === 'waiting' && this.pending !== null && this.isReady()) {
      const q = this.pending;
      this.pending = null;
      void this.run(q);
    }
  }

  cancel(): void { this.pending = null; if (this.state === 'waiting') this.state = 'idle'; }

  get waitingFor(): string | null { return this.pending; }

  private async run(q: string): Promise<void> {
    this.state = 'streaming';
    try { await this.send(q); } finally { this.state = 'idle'; }
  }
}
