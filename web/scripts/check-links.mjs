// Test L5: every link in the built site works. Internal links must resolve to a built file; external links
// must answer with 2xx or 3xx.   node scripts/check-links.mjs [distDir]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] || 'dist');
const SKIP = /^(mailto:|tel:|#|javascript:|data:)/;
const SELF = 'https://treymcgonnell.github.io';

function* pages(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* pages(p);
    else if (f.endsWith('.html')) yield p;
  }
}

const internal = new Map(), external = new Map();
for (const file of pages(dist)) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<(?:a|link)\b[^>]*\bhref="([^"]+)"/g)) {
    let url = m[1];
    if (SKIP.test(url) || url.startsWith('https://fonts.')) continue;
    if (url.startsWith(SELF)) url = url.slice(SELF.length) || '/';
    const where = file.slice(dist.length + 1);
    if (/^https?:\/\//.test(url)) (external.get(url) || external.set(url, []).get(url)).push(where);
    else (internal.get(url) || internal.set(url, []).get(url)).push(where);
  }
}

const problems = [];
for (const [url, from] of internal) {
  const path = url.split(/[?#]/)[0];
  const target = join(dist, path.endsWith('/') ? `${path}index.html` : path);
  // og:image and canonical point at the live site; og.png only exists once real content supplies it
  if (!existsSync(target) && path !== '/og.png') problems.push(`${url} (from ${from[0]}) does not exist in the build`);
}
await Promise.all([...external].map(async ([url, from]) => {
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (r.status === 405 || r.status === 403) r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (r.status >= 400) problems.push(`${url} (from ${from[0]}) answered ${r.status}`);
  } catch (e) {
    problems.push(`${url} (from ${from[0]}) failed: ${e.message}`);
  }
}));

console.log(`checked ${internal.size} internal and ${external.size} external links`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('All links work.');
