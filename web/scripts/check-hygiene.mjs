// Test I8 (repo hygiene): the public repo may only contain code. Lists every file git would publish
// (tracked plus untracked-but-not-ignored) and fails on anything that is not code, or that looks like a secret.
//   node scripts/check-hygiene.mjs
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const files = execSync('git ls-files --cached --others --exclude-standard', { cwd: root, encoding: 'utf8' })
  .split('\n').map((f) => f.trim()).filter(Boolean);

const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|py|css|html|json|toml|ya?ml|sh)$/;
const CODE_NAMES = new Set(['README.md', '.gitignore', '.npmrc', 'requirements.txt', 'requirements-model.txt', '.env.example', '.gitattributes', '.editorconfig']);
const BLOCKED_DIRS = /^(content|docs|design\/canvas|design\/previews|design\/skyline\/out|design\/background\/site|api\/data|\.data)\//;
const SECRETS = [
  /AKIA[0-9A-Z]{16}/, // AWS
  /ghp_[A-Za-z0-9]{36}/, /github_pat_[A-Za-z0-9_]{40,}/, // GitHub
  /hf_[A-Za-z0-9]{30,}/, // Hugging Face
  /sk-[A-Za-z0-9_-]{32,}/, // generic API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:as|ak|wk)-[A-Za-z0-9]{20,}/, // Modal token shapes
];

const problems = [];
for (const f of files) {
  const name = f.split('/').pop();
  if (BLOCKED_DIRS.test(f)) problems.push(`${f}: lives in a private-only folder`);
  else if (!CODE_EXT.test(f) && !CODE_NAMES.has(name)) problems.push(`${f}: not a code file`);
  const size = statSync(join(root, f), { throwIfNoEntry: false })?.size ?? 0;
  if (size > 1_000_000 && !f.endsWith('package-lock.json')) problems.push(`${f}: ${Math.round(size / 1024)} KB is too big for source`);
  if (size && size < 2_000_000) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const re of SECRETS) if (re.test(text)) problems.push(`${f}: looks like it contains a secret (${re.source.slice(0, 18)}…)`);
  }
}

if (problems.length) {
  console.error(`Repo hygiene failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Repo hygiene ok: ${files.length} files, all code, no secrets found.`);
