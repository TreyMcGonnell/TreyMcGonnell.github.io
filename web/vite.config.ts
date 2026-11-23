/// <reference types="vitest" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { fillContent, loadContent, renderProject, renderProjectList, renderResume, type Project } from './content.config';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://treymcgonnell.github.io';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The tab icon is drawn here (a lit window over night blue), so no image file is needed in the repo.
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0F1630"/>'
  + '<rect x="9" y="6" width="14" height="22" rx="1.5" fill="#1A2148" stroke="#4CA6E8" stroke-width="1.2"/>'
  + '<rect x="12" y="9" width="3" height="3" fill="#FFB547"/><rect x="17" y="9" width="3" height="3" fill="#74547A"/>'
  + '<rect x="12" y="14" width="3" height="3" fill="#74547A"/><rect x="17" y="14" width="3" height="3" fill="#FFF0C8"/>'
  + '<rect x="12" y="19" width="3" height="3" fill="#FFB547"/><rect x="17" y="19" width="3" height="3" fill="#222C52"/></svg>';
const PAGES = ['/', '/how-it-works/', '/projects/', '/resume/'];

/** Serves content/ in dev; at build, emits content.json, replays and resume.pdf and writes one page per project. */
function contentPlugin(contentDir: string, apiBase: string): Plugin {
  let outDir = '';
  return {
    name: 'trey-lm-content',
    configResolved(cfg) { outDir = resolve(cfg.root, cfg.build.outDir); },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const project = url.match(/^\/projects\/([\w-]+)\/?$/);
        if (project && loadContent(contentDir).projects.some((p) => p.slug === project[1])) {
          const html = await server.transformIndexHtml(url, readFileSync(join(here, 'projects', 'index.html'), 'utf8'));
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
          return;
        }
        if (url === '/favicon.svg') {
          res.setHeader('Content-Type', 'image/svg+xml');
          res.end(FAVICON);
          return;
        }
        if (url === '/content.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(loadContent(contentDir)));
          return;
        }
        const replay = url.match(/^\/replays\/([\w.-]+\.json)$/);
        const file = replay ? join(contentDir, 'replays', replay[1]) : url === '/resume.pdf' ? join(contentDir, 'resume.pdf')
          : url === '/og.png' ? join(contentDir, 'og.png') : null;
        if (file && existsSync(file)) {
          res.setHeader('Content-Type', file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.png') ? 'image/png' : 'application/json');
          res.end(readFileSync(file));
          return;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      // Like GitHub Pages: unknown paths get the 404 page with a 404 status (test E8).
      return () => {
        server.middlewares.use((req, res, next) => {
          const page = join(outDir, '404.html');
          const file = join(outDir, decodeURIComponent((req.url || '/').split('?')[0]));
          if (req.method !== 'GET' || !existsSync(page) || (existsSync(file) && !file.endsWith('/'))) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html');
          res.end(readFileSync(page));
        });
      };
    },
    generateBundle() {
      const content = loadContent(contentDir);
      this.emitFile({ type: 'asset', fileName: 'content.json', source: JSON.stringify(content) });
      for (const name of content.replays) {
        this.emitFile({ type: 'asset', fileName: `replays/${name}`, source: readFileSync(join(contentDir, 'replays', name)) });
      }
      if (content.resume?.pdf) this.emitFile({ type: 'asset', fileName: 'resume.pdf', source: readFileSync(join(contentDir, 'resume.pdf')) });
      if (existsSync(join(contentDir, 'og.png'))) this.emitFile({ type: 'asset', fileName: 'og.png', source: readFileSync(join(contentDir, 'og.png')) });
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: FAVICON });
      const urls = [...PAGES, ...content.projects.map((p) => `/projects/${p.slug}/`)];
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
        + urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join('\n') + '\n</urlset>\n';
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n` });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        html = fillPage(html, ctx.path);
        if (!ctx.bundle) return html; // dev server: Vite's own scripts need no CSP
        if (process.env.ARTIFACT === '1') return html; // standalone-page build: the host page sets its own policy
        // Inline the (small) stylesheets: one fewer round trip before the first paint on slow phones (test G1).
        const bundle = ctx.bundle;
        html = html.replace(/<link rel="stylesheet"(?: crossorigin)? href="\/(assets\/[^"]+\.css)">/g, (tag, file: string) => {
          const asset = bundle[file];
          return asset && asset.type === 'asset' ? `<style>${String(asset.source)}</style>` : tag;
        });
        const connect = ["'self'", apiBase && new URL(apiBase).origin].filter(Boolean).join(' ');
        const csp = [
          "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src https://fonts.gstatic.com", "img-src 'self' data:", `connect-src ${connect}`,
          "base-uri 'self'", "form-action 'none'", "object-src 'none'",
        ].join('; ');
        return html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
      },
    },
    closeBundle() {
      // One static page per project: same template, its own title, description and canonical URL (test L2).
      const template = join(outDir, 'projects', 'index.html');
      if (!existsSync(template)) return;
      const html = readFileSync(template, 'utf8');
      for (const p of loadContent(contentDir).projects) writeProjectPage(html, p);
    },
  };

  /** Fill the content pages' bodies from content/ (projects list, a single project in dev, the resume). */
  function fillPage(html: string, path: string): string {
    if (!html.includes('<!--content-->')) return html;
    const c = loadContent(contentDir);
    const slug = path.match(/^\/projects\/([\w-]+)\/?$/)?.[1];
    const project = slug ? c.projects.find((p) => p.slug === slug) : undefined;
    if (project) return projectHead(fillContent(html, renderProject(project)), project);
    if (path.startsWith('/projects')) return fillContent(html, renderProjectList(c));
    if (path.startsWith('/resume')) return fillContent(html, renderResume(c));
    return html;
  }

  function projectHead(html: string, p: Project): string {
    const url = `${SITE}/projects/${p.slug}/`;
    const title = `${p.title} · Trey McGonnell`;
    return html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(p.summary)}"`)
      .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${esc(title)}"`)
      .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${esc(p.summary)}"`)
      .replace(/(<meta property="og:url" content=")[^"]*"/, `$1${url}"`)
      .replace(/(<link rel="canonical" href=")[^"]*"/, `$1${url}"`)
      .replace('<body', `<body data-project="${esc(p.slug)}"`);
  }

  function writeProjectPage(template: string, p: Project) {
    const page = projectHead(fillContent(template, renderProject(p)), p);
    const dir = join(outDir, 'projects', p.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), page);
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, 'VITE_');
  const contentDir = resolve(here, process.env.CONTENT_DIR || '../content');
  const apiBase = env.VITE_API_BASE || 'http://localhost:8000';
  return {
    root: here,
    base: '/',
    appType: 'mpa',
    define: { __API_BASE__: JSON.stringify(apiBase) },
    plugins: [contentPlugin(contentDir, apiBase)],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2020',
      rollupOptions: {
        input: {
          home: resolve(here, 'index.html'),
          how: resolve(here, 'how-it-works/index.html'),
          projects: resolve(here, 'projects/index.html'),
          resume: resolve(here, 'resume/index.html'),
          notfound: resolve(here, '404.html'),
        },
      },
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 5173, strictPort: true },
    test: {
      environment: 'happy-dom',
      include: ['tests/unit/**/*.test.ts'],
    },
  };
});
