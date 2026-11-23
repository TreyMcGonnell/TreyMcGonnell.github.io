// Pages, accessibility, geometry and the scene: tests E8, F2, H1–H3, L2, L3, D7, G3, I2.
import { axeIssues, expect, scenario, test } from './helpers';

const PAGES = ['/', '/how-it-works/', '/projects/', '/projects/sample/', '/resume/'];

test('E8 every nav link works, unknown paths show the 404 page, the resume PDF is served', async ({ page }) => {
  await scenario(page);
  for (const path of PAGES) {
    const r = await page.goto(path);
    expect(r?.status(), path).toBe(200);
    const hrefs = await page.locator('nav a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    for (const h of hrefs) expect((await page.request.get(h)).status(), `${path} → ${h}`).toBe(200);
  }
  const missing = await page.goto('/no-such-page/');
  expect(missing?.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText("This page isn't here");
  const pdf = await page.request.get('/resume.pdf');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
});

test('L2 every page has a title, description, Open Graph tags and a canonical URL', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path);
    expect(await page.title(), path).not.toBe('');
    for (const sel of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:image"]']) {
      expect(await page.locator(sel).getAttribute('content'), `${path} ${sel}`).toBeTruthy();
    }
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(`https://treymcgonnell.github.io${path}`);
  }
});

test('L3 "Built with Llama" is shown on Home and How this works', async ({ page }) => {
  for (const path of ['/', '/how-it-works/']) {
    await page.goto(path);
    await expect(page.getByText('Built with Llama').first()).toBeVisible();
  }
});

test('I2 the CSP meta tag is present and the page only talks to itself, the API and Google Fonts', async ({ page }) => {
  await scenario(page);
  const hosts = new Set<string>();
  page.on('request', (r) => hosts.add(new URL(r.url()).host));
  await page.goto('/');
  await page.waitForTimeout(2500);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("connect-src 'self' http://localhost:8787");
  for (const h of hosts) expect(['localhost:4173', 'localhost:8787', 'fonts.googleapis.com', 'fonts.gstatic.com']).toContain(h);
});

test('H1 axe: no serious or critical issues on any page', async ({ page }) => {
  await scenario(page);
  for (const path of [...PAGES, '/404.html']) {
    await page.goto(path);
    await page.waitForTimeout(400);
    expect(await axeIssues(page, path)).toEqual([]);
  }
});

test('H1 axe: no serious or critical issues in the writing and done states', async ({ page }) => {
  await scenario(page, { tokenDelayMs: 300 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#stage-title')).toHaveText('Choosing the next word', { timeout: 8000 });
  expect(await axeIssues(page, 'writing', '.fly-chip')).toEqual([]);
  await expect(page.locator('#stage-title')).toHaveText('How it wrote that answer', { timeout: 15000 });
  expect(await axeIssues(page, 'done')).toEqual([]);
});

test('H2 keyboard: skip link reaches the chat, Enter sends, focus is visible', async ({ page }) => {
  await scenario(page);
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-input')).toBeFocused();
  await page.keyboard.type('What has Trey built?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg-user')).toHaveText('What has Trey built?');
  // every interactive element can be reached and shows a focus ring
  await page.goto('/projects/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
});

test('H3 reduced motion: no autoplay (a Play button instead), no flying word, still background', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await scenario(page);
  await page.goto('/');
  await page.waitForTimeout(1500);
  await expect(page.locator('#replay-bar')).toBeHidden();
  await expect(page.locator('[data-action="play-replay"]')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __scene: { paused: boolean } }).__scene.paused)).toBe(true);
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#stage-title')).toHaveText(/Choosing the next word|How it wrote that answer/, { timeout: 8000 });
  await page.waitForTimeout(500);
  expect(await page.locator('.fly-chip').count()).toBe(0);
  await ctx.close();
});

test('F2 shapes connect: callout leader, notes bracket, no clipped headings or buttons', async ({ page }) => {
  await scenario(page, { tokenDelayMs: 300 });
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#stage-title')).toHaveText('Choosing the next word', { timeout: 8000 });
  const g = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.towers')!;
    const c = canvas.getBoundingClientRect();
    const call = document.querySelector('.callout')!.getBoundingClientRect();
    const scale = c.width / canvas.offsetWidth; // the frame is scaled to the viewport
    const lx = c.left + Number(canvas.dataset.leaderX) * scale;
    const notes = [...document.querySelectorAll<HTMLElement>('.srcbar span[data-src^="note:"]')].map((e) => e.getBoundingClientRect());
    const bracket = document.querySelector('.bracket')?.getBoundingClientRect();
    return { callBottom: call.bottom, canvasTop: c.top, lx, callLeft: call.left, callRight: call.right,
      notesLeft: notes.length ? Math.min(...notes.map((n) => n.left)) : null, notesRight: notes.length ? Math.max(...notes.map((n) => n.right)) : null,
      bracketLeft: bracket?.left ?? null, bracketRight: bracket?.right ?? null };
  });
  expect(Math.abs(g.callBottom - g.canvasTop)).toBeLessThanOrEqual(2);
  expect(g.lx).toBeGreaterThan(g.callLeft + 2);
  expect(g.lx).toBeLessThan(g.callRight - 2);
  expect(g.bracketLeft).not.toBeNull();
  expect(Math.abs(g.bracketLeft! - g.notesLeft!)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.bracketRight! - g.notesRight!)).toBeLessThanOrEqual(1);
  const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('h1, h2, h3, button, .pill, .nav a')]
    .filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent?.trim()));
  expect(clipped).toEqual([]);
});

test('G3 scene frame budget', async ({ page }) => {
  test.skip(!!process.env.CI, 'frame timing depends on the machine: GitHub runners are slower than a laptop, so run G3 locally');
  // CI runners have no GPU, so this measures the software canvas: the "GPU off" case of test G3.
  await scenario(page);
  await page.goto('/');
  await page.waitForTimeout(800);
  const b = await page.evaluate(() => (window as unknown as { __scene: { bench(): { steadyFrameMs: number; bootFrameMs: number } } }).__scene.bench());
  test.info().annotations.push({ type: 'G3', description: JSON.stringify(b) });
  expect(b.steadyFrameMs).toBeLessThanOrEqual(8);
  expect(b.bootFrameMs).toBeLessThanOrEqual(12);
});

test('D7 scene rule: windows change only during boot; stars and water keep moving', async ({ page }) => {
  await scenario(page);
  await page.goto('/');
  const v = await page.evaluate(() => (window as unknown as { __scene: { verify(): Record<string, boolean> } }).__scene.verify());
  expect(v).toEqual({ windowsChangeDuringBoot: true, windowsStaticAfterBoot: true, starsMoveAfterBoot: true, wavesMoveAfterBoot: true });
});

test('M5 phone: one column with no sideways scroll; the chat sheet opens and answers', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await scenario(page);
  await page.goto('/');
  await expect(page.locator('#replay-bar')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator('#term-log')).toBeHidden(); // sheet starts closed
  await expect(page.locator('#term-status')).toHaveText('Ready');
  await page.locator('#chat-input').tap();
  await expect(page.locator('#term-log')).toBeVisible();
  await page.locator('#chat-input').fill('What has Trey built?');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#stage-title')).toHaveText('How it wrote that answer', { timeout: 10000 });
  await expect(page.locator('.msg-bot').last()).toHaveText('Sample answer: Trey built a sample tool.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const path of ['/projects/', '/resume/', '/how-it-works/']) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
  }
  await ctx.close();
});

test('G7 memory: heap under 150 MB after 5 questions, no growth across 10', async ({ page }) => {
  test.setTimeout(150_000);
  await scenario(page);
  await page.goto('/');
  await expect(page.locator('#term-status')).toHaveText('Ready');
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize / 1048576;
  };
  const used: number[] = [];
  for (let i = 1; i <= 10; i++) {
    await page.locator('#chat-input').fill(`What has Trey built? (${i})`);
    await page.locator('#chat-input').press('Enter');
    await expect(page.locator('#stage-title')).toHaveText('How it wrote that answer', { timeout: 15_000 });
    await expect(page.locator('#chat-input')).toBeEnabled();
    if (i === 5 || i === 10) used.push(await heap());
  }
  test.info().annotations.push({ type: 'G7', description: `heap after 5: ${used[0].toFixed(1)} MB, after 10: ${used[1].toFixed(1)} MB` });
  expect(used[0]).toBeLessThan(150);
  expect(used[1] - used[0]).toBeLessThan(5);
});
