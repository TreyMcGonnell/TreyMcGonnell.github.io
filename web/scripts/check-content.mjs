// Test L1 (no placeholders) on a site built from the real content: fails on sample or template text.
// Expected to fail until Trey's real content replaces the marked samples.
//   node scripts/check-content.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] || 'dist');
const PATTERNS = [/\[Project/, /\[one line/i, /lorem/i, /\bTODO\b/, /\bSAMPLE\b/, /Sample content:/, /placeholder/i];

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(html|json)$/.test(f) && !p.includes(`${join(dist, 'replays')}`)) yield p;
  }
}

const problems = [];
for (const file of walk(dist)) {
  const text = readFileSync(file, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/placeholder="[^"]*"/g, '');
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) problems.push(`${file.slice(dist.length + 1)}: “${text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}”`);
  }
}
if (problems.length) {
  console.error(`Placeholder text found (${problems.length}):\n  ${problems.slice(0, 30).join('\n  ')}`);
  process.exit(1);
}
console.log('No placeholder text in the built site.');
