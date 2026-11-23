// Modal can't report how far a cold start has got, so progress is estimated from elapsed time
// and held at 90% until the backend says the model is ready. Test D5.
export const TYPICAL_BOOT_MS = 25_000;

export function warmupProgress(elapsedMs: number, ready: boolean, typicalMs = TYPICAL_BOOT_MS): number {
  if (ready) return 1;
  const linear = Math.max(0, elapsedMs) / typicalMs;
  return Math.min(0.9, linear);
}
