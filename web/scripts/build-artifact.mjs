// Builds the site as a self-contained bundle with relative links, for previewing it as a private
// claude.ai artifact (or any static host under a sub-path).   node scripts/build-artifact.mjs [outDir]
// The home page loses its document wrapper (the artifact host supplies one); other pages keep theirs.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const out = resolve(process.argv[2] || 'dist-artifact');
execSync(`npx vite build --base ./ --outDir "${out}"`, { stdio: 'inherit', env: { ...process.env, ARTIFACT: '1' } });
rmSync(join(out, 'favicon.svg'), { force: true });
rmSync(join(out, 'sitemap.xml'), { force: true });
rmSync(join(out, 'robots.txt'), { force: true });

function* htmlFiles(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (f.endsWith('.html')) yield p;
  }
}

for (const file of htmlFiles(out)) {
  const rel = relative(out, file).split(sep).join('/');
  const depth = rel.split('/').length - 1;
  const up = depth ? '../'.repeat(depth) : './';
  let html = readFileSync(file, 'utf8');
  // Project pages are copies of projects/index.html one folder deeper: fix their asset paths.
  if (/^projects\/[^/]+\/index\.html$/.test(rel)) html = html.replaceAll('"../assets/', '"../../assets/');
  // Site-absolute links → relative files (a static host here doesn't map folders to index.html).
  html = html.replace(/(href|src)="\/([^"]*)"/g, (_, attr, path) => {
    const target = path === '' ? '' : path.endsWith('/') ? `${path}index.html` : path; // the home page is the folder itself
    return `${attr}="${up}${target}"`;
  });
  html = html.replace(/<link rel="icon"[^>]*>\n?/, '');
  if (rel === 'index.html') {
    // The host wraps this page in its own document: keep the head's title, styles and scripts, then the body.
    const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
      .replace(/<meta charset[^>]*>\n?/, '').replace(/<meta name="viewport"[^>]*>\n?/, '');
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
    html = `${head.trim()}\n${body.trim()}\n`;
  }
  writeFileSync(file, html);
}
console.log(`artifact bundle ready in ${out}`);
