// Modal can't report how far a cold start has got, so progress is estimated from elapsed time
// and held at 90% until the backend says the model is ready. Test D5.
export const TYPICAL_BOOT_MS = 25_000;

export function warmupProgress(elapsedMs: number, ready: boolean, typicalMs = TYPICAL_BOOT_MS): number {
  if (ready) return 1;
  const linear = Math.max(0, elapsedMs) / typicalMs;
  return Math.min(0.9, linear);
}

/** Every visit plays the city's boot: at least this long from page load, even when the model is already awake. */
export const MIN_BOOT_MS = 3500;
/** Once the model is ready, the windows still dark fill in over this long instead of switching on at once. */
export const FINISH_MS = 1500;

/**
 * How lit the city is, 0..1. While the model wakes, it follows the warm-up estimate. Once the model is ready
 * (`readySinceMs`, ms after page load, with the city at `startP` then), it eases up to 1 and ends no sooner than
 * MIN_BOOT_MS after load. With reduced motion it jumps straight to lit.
 */
export function cityBoot(elapsedMs: number, readySinceMs: number | null, startP: number, reduceMotion = false): { p: number; done: boolean } {
  if (readySinceMs === null) return { p: warmupProgress(elapsedMs, false), done: false };
  if (reduceMotion) return { p: 1, done: true };
  const end = Math.max(MIN_BOOT_MS, readySinceMs + FINISH_MS);
  const span = end - readySinceMs;
  const k = span <= 0 ? 1 : Math.min(1, Math.max(0, (elapsedMs - readySinceMs) / span));
  const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  return { p: startP + (1 - startP) * eased, done: k >= 1 };
}
