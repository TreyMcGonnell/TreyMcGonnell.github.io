// Reads the private content (gitignored `content/` locally, the trey-lm-content repo in CI) at build time.
// Nothing here ships secrets; the content itself is only ever copied into the built site.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

export interface ProjectLink { label: string; url: string }
export interface Project {
  slug: string; title: string; summary: string; role: string; stack: string[]; outcome: string;
  links: ProjectLink[]; order: number; sample: boolean; html: string;
}
export interface SiteContent {
  projects: Project[];
  resume: { title: string; version: string; html: string; sample: boolean; pdf: boolean } | null;
  replays: string[];
  sample: boolean;
}

function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!text.startsWith('---')) return { meta, body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta, body: text.trim() };
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return { meta, body: text.slice(end + 4).trim() };
}

function links(raw: string | undefined): ProjectLink[] {
  if (!raw) return [];
  return raw.split(/\s*;\s*/).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return { label: pair.slice(0, i).trim(), url: pair.slice(i + 1).trim() };
  }).filter((l) => /^https?:\/\//.test(l.url));
}

export function loadContent(dir: string): SiteContent {
  const projects: Project[] = [];
  const pdir = join(dir, 'projects');
  if (existsSync(pdir)) {
    for (const file of readdirSync(pdir).filter((f) => f.endsWith('.md')).sort()) {
      const { meta, body } = frontmatter(readFileSync(join(pdir, file), 'utf8'));
      projects.push({
        slug: file.replace(/\.md$/, ''),
        title: meta.title || file.replace(/\.md$/, ''),
        summary: meta.summary || '',
        role: meta.role || '',
        stack: (meta.stack || '').split(',').map((s) => s.trim()).filter(Boolean),
        outcome: meta.outcome || '',
        links: links(meta.links),
        order: Number(meta.order || 99),
        sample: meta.sample === 'true',
        html: marked.parse(body, { async: false }) as string,
      });
    }
  }
  projects.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  let resume: SiteContent['resume'] = null;
  if (existsSync(join(dir, 'resume.md'))) {
    const { meta, body } = frontmatter(readFileSync(join(dir, 'resume.md'), 'utf8'));
    resume = { title: meta.title || 'Resume', version: meta.version || '', html: marked.parse(body, { async: false }) as string,
      sample: meta.sample === 'true', pdf: existsSync(join(dir, 'resume.pdf')) };
  }
  const rdir = join(dir, 'replays');
  const replays = existsSync(rdir) ? readdirSync(rdir).filter((f) => f.endsWith('.json')).sort() : [];
  const sample = projects.some((p) => p.sample) || !!resume?.sample;
  return { projects, resume, replays, sample };
}

// ---------------------------------------------------------------- build-time page bodies
// Content pages are rendered into static HTML at build (and in dev), so they work without JavaScript
// and search engines see the real text.
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAMPLE_NOTE = '<p class="sample-note" role="note">Sample content: this page shows placeholder text until the real content is added.</p>';

export function renderProjectList(c: SiteContent): string {
  if (!c.projects.length) return '<h1>Projects</h1><p class="lede">Project write-ups are on their way.</p>';
  const cards = c.projects.map((p) => `
    <li class="card-link">
      <h2><a href="/projects/${escHtml(p.slug)}/">${escHtml(p.title)}</a></h2>
      <p>${escHtml(p.summary)}</p>
      ${p.stack.length ? `<ul class="stack" aria-label="Built with">${p.stack.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ul>` : ''}
    </li>`).join('');
  return `${c.projects.some((p) => p.sample) ? SAMPLE_NOTE : ''}
    <h1>Projects</h1>
    <p class="lede">Things Trey has built. The model on the home page reads these same write-ups when you ask about his work.</p>
    <ul class="cards-list">${cards}</ul>`;
}

export function renderProject(p: Project): string {
  const facts = [['Role', p.role], ['Built with', p.stack.join(', ')], ['Outcome', p.outcome]].filter(([, v]) => v);
  return `${p.sample ? SAMPLE_NOTE : ''}
    <p class="crumb"><a href="/projects/">← All projects</a></p>
    <h1>${escHtml(p.title)}</h1>
    <p class="lede">${escHtml(p.summary)}</p>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${escHtml(v)}</dd></div>`).join('')}</dl>` : ''}
    <div class="prose">${p.html}</div>
    ${p.links.length ? `<p class="links">${p.links.map((l) => `<a class="pill" href="${escHtml(l.url)}">${escHtml(l.label)}</a>`).join(' ')}</p>` : ''}`;
}

export function renderResume(c: SiteContent): string {
  const r = c.resume;
  if (!r) return '<h1>Resume</h1><p class="lede">The resume is on its way.</p>';
  return `${r.sample ? SAMPLE_NOTE : ''}
    <div class="resume-head"><h1>Trey McGonnell</h1>
      ${r.pdf ? '<a class="pill pill-primary" href="/resume.pdf" download>Download PDF</a>' : ''}</div>
    ${r.version ? `<p class="version">Version ${escHtml(r.version)}</p>` : ''}
    <div class="prose resume">${r.html}</div>`;
}

/** Replace everything between the content markers of a page template. */
export function fillContent(html: string, body: string): string {
  return html.replace(/<!--content-->[\s\S]*?<!--\/content-->/, `<!--content-->${body}<!--/content-->`);
}
