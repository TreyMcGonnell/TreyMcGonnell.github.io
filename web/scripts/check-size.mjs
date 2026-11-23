// Test G2 (bundle sizes): the home page's initial JavaScript ≤ 120 KB gzipped, every replay ≤ 300 KB gzipped.
//   node scripts/check-size.mjs [distDir]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve(process.argv[2] || 'dist');
const gz = (file) => gzipSync(readFileSync(file), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const problems = [];

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="\/?([^"]+\.js)"/g)].map((m) => m[1]);
const js = scripts.reduce((sum, s) => sum + gz(join(dist, s)), 0);
console.log(`home initial JS: ${kb(js)} gzipped (${scripts.join(', ')})`);
if (js > 120 * 1024) problems.push(`initial JS ${kb(js)} > 120 KB`);

const rdir = join(dist, 'replays');
for (const f of existsSync(rdir) ? readdirSync(rdir) : []) {
  const size = gz(join(rdir, f));
  console.log(`replay ${f}: ${kb(size)} gzipped`);
  if (size > 300 * 1024) problems.push(`replay ${f} ${kb(size)} > 300 KB`);
}

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Bundle sizes ok.');
