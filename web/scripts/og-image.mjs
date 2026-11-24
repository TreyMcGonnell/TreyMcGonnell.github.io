// Renders the social-preview image (1200 x 630) from the live skyline with the name over it.
// Run against a running preview: node scripts/og-image.mjs [baseUrl] [out]   (default out: ../content/og.png)
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://localhost:5173';
const out = resolve(process.argv[3] || '../content/og.png');
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`${base}/how-it-works/`, { waitUntil: 'networkidle' }); // a content page draws the still, fully lit city
await page.evaluate(async () => {
  await document.fonts.ready;
  document.querySelector('.page')?.remove();
  const card = document.createElement('div'); // placed in the open sky right of the towers
  card.style.cssText = 'position:fixed;left:560px;top:92px;z-index:5;color:#F3F6FD;font-family:Archivo,sans-serif;'
    + 'text-shadow:0 2px 28px rgba(8,12,30,0.7)';
  card.innerHTML = '<div style="font-size:104px;font-weight:800;font-stretch:62%;line-height:0.86">Trey<br>McGonnell</div>'
    + '<div style="margin-top:24px;font-size:28px;font-weight:600">Data science · Northern Kentucky University</div>'
    + '<div style="margin-top:12px;font-size:24px;color:#C9D2E8">Ask my AI anything, and watch how it picks every word.</div>';
  document.body.appendChild(card);
  await document.fonts.ready;
});
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
