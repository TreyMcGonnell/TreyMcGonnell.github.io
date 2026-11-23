import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import type { Scenario } from './mock-api';

export const MOCK = 'http://localhost:8787';

export async function scenario(page: Page, s: Scenario = {}) {
  const r = await page.request.post(`${MOCK}/__scenario`, { data: s });
  expect(r.ok()).toBeTruthy();
}

export async function stats(page: Page): Promise<{ warm: number; tokenize: number[]; chat: number }> {
  return (await page.request.get(`${MOCK}/__stats`)).json();
}

/** Every test fails on console errors and page errors (test E9). Network status lines for deliberate
 *  error scenarios ("Failed to load resource") are the browser's, not the page's, and are ignored. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await use(errors);
    expect(errors, 'console errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

/** axe-core with stylesheet preloading off: its CSS fetches would (rightly) trip the page's CSP. */
export function axe(page: Page) {
  return new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).options({ preload: false });
}

/** Serious and critical issues only, as readable strings. */
export async function axeIssues(page: Page, label: string, exclude?: string): Promise<string[]> {
  const builder = axe(page);
  if (exclude) builder.exclude(exclude);
  const r = await builder.analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

export const botText = (page: Page) => page.locator('.msg-bot:not(#greeting)').last();
