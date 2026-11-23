// Prints the built /resume/ page to content/resume.pdf, so the PDF and the HTML resume always carry the
// same text and version date (test L4). Run against a running preview: node scripts/resume-pdf.mjs [baseUrl] [out]
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://localhost:5173';
const out = resolve(process.argv[3] || '../content/resume.pdf');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto(`${base}/resume/`, { waitUntil: 'networkidle' });
await page.emulateMedia({ media: 'print' });
await page.pdf({ path: out, format: 'Letter', printBackground: false });
await browser.close();
console.log('wrote', out);
