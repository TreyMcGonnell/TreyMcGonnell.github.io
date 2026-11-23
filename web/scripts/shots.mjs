// Screenshots of the running site for visual review (not a test): node scripts/shots.mjs [baseUrl] [outDir]
// Output goes to design/previews/ by default, which is gitignored.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://localhost:5173';
const out = resolve(process.argv[3] || '../design/previews/site');
mkdirSync(out, { recursive: true });
const plan = (process.env.SHOTS || 'replay,live,pages').split(',');
const w = Number(process.env.W || 1440), h = Number(process.env.H || 900);

const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
async function open(path, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${path}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(base + path);
  return { ctx, page };
}
const snap = async (page, name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };

if (plan.includes('replay')) {
  const { ctx, page } = await open('/');
  for (const [ms, name] of [[1200, 'r1-question'], [3200, 'r2-memory'], [5200, 'r3-reading'], [9000, 'r4-writing'], [19500, 'r5-sources']]) {
    await page.waitForTimeout(ms - (page._t || 0));
    page._t = ms;
    await snap(page, name);
  }
  await ctx.close();
}
if (plan.includes('live')) {
  const { ctx, page } = await open('/');
  await page.waitForFunction(() => document.querySelector('#term-status')?.textContent === 'Ready', null, { timeout: 120000 });
  await page.fill('#chat-input', 'What has Trey built?');
  await page.waitForTimeout(700);
  await snap(page, 'l1-typing');
  await page.press('#chat-input', 'Enter');
  await page.waitForTimeout(500);
  await snap(page, 'l2-thinking');
  await page.waitForTimeout(2200);
  await snap(page, 'l3-writing');
  await page.waitForSelector('.done-chip', { timeout: 90000 });
  await page.waitForTimeout(400);
  await snap(page, 'l4-done');
  await page.click('.toggle [data-mode="source"]');
  await snap(page, 'l5-done-source');
  await ctx.close();
}
if (plan.includes('pages')) {
  for (const [path, name] of [['/projects/', 'p1-projects'], ['/projects/trey-lm/', 'p2-project'], ['/resume/', 'p3-resume'], ['/how-it-works/', 'p4-how'], ['/nope/', 'p5-404']]) {
    const { ctx, page } = await open(path);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log('shot', name);
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
