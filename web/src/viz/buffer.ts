// Frames arrive as fast as the model makes them; the stage shows them at a readable pace. Test D3.
import type { TokenFrame } from '../protocol/types';

export class FrameBuffer {
  readonly frames: TokenFrame[] = [];
  private startAt: number | null = null;
  private finished = false;

  constructor(private rate = 5, private now: () => number = () => performance.now()) {}

  /** Visual pace in tokens per second (the stage never runs faster than this). */
  get interval(): number { return 1000 / this.rate; }

  push(f: TokenFrame): void {
    if (this.startAt === null) this.startAt = this.now();
    this.frames.push(f);
  }

  markDone(): void { this.finished = true; }

  get received(): number { return this.frames.length; }

  /** Index of the frame the stage should show now, or -1 before the first frame. */
  visibleIndex(): number {
    if (this.startAt === null || !this.frames.length) return -1;
    const paced = Math.floor((this.now() - this.startAt) / this.interval);
    return Math.min(this.frames.length - 1, paced);
  }

  /** True once the stream has ended and the stage has shown the last frame. */
  caughtUp(): boolean {
    return this.finished && this.frames.length > 0 && this.visibleIndex() === this.frames.length - 1;
  }

  get done(): boolean { return this.finished; }

  /** Exact frame for scrubbing on the Done screen. */
  at(i: number): TokenFrame | undefined { return this.frames[i]; }
}
