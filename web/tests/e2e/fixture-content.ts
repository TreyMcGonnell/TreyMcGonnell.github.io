// Writes a throwaway content folder for the end-to-end tests (tests/.content, gitignored).
// The public repo holds no content, so CI builds the site against this generated sample instead.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { replay } from '../fixtures/frames.ts';

const dir = resolve(import.meta.dirname, '..', '.content');
rmSync(dir, { recursive: true, force: true });
for (const sub of ['projects', 'notes', 'replays']) mkdirSync(join(dir, sub), { recursive: true });

writeFileSync(join(dir, 'trey.md'), '---\nsample: true\n---\nSAMPLE BIO for tests.\n');
writeFileSync(join(dir, 'projects', 'sample.md'), [
  '---', 'title: Sample project', 'summary: A sample project used by the end-to-end tests.', 'role: Tester', 'stack: TypeScript, Playwright',
  'outcome: Tests pass.', 'order: 1', 'links: Example=https://example.com', 'sample: true', '---',
  'SAMPLE: Trey built a sample tool. This text exists only for tests.', '',
].join('\n'));
writeFileSync(join(dir, 'notes', 'sample-clubs.md'), '---\ntitle: Sample clubs\n---\nSAMPLE: clubs.\n');
writeFileSync(join(dir, 'resume.md'), '---\ntitle: Resume\nversion: 2026-11-18 (TEST)\nsample: true\n---\n## Education\n\nSAMPLE school.\n');
// The smallest valid PDF, so /resume.pdf can be checked for status and type (test E8).
writeFileSync(join(dir, 'resume.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
writeFileSync(join(dir, 'replays', '01-sample.json'), JSON.stringify(replay(9)));
console.log('fixture content written to', dir);
