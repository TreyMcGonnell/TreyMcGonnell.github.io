// The Google Fonts stylesheet is loaded as media="print" so it never blocks the first paint (test G1);
// once scripts run it applies to the screen. Text shows in the fallback font for a moment, then swaps.
export function enableFonts(): void {
  document.querySelectorAll<HTMLLinkElement>('link[data-fonts]').forEach((l) => { l.media = 'all'; });
}
