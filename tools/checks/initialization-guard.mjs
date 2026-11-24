// Initialization-audit guard.
//
// Asserts the two things that must hold before any implementation starts:
//   1. The audit document actually delivers all seven items the owner asked for.
//   2. The HUMAIN credential cannot leak into git or into app/backend source.
//
// Emits a harnessVerification JSON line so the result is a check, not an opinion.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const checks = [];
const add = (name, actual, expected) => checks.push({ name, actual, expected });

// ---------------------------------------------------------------- 1. audit doc
const AUDIT = 'docs/audit-initialization.md';
add('audit document exists', existsSync(join(root, AUDIT)), true);

const audit = existsSync(join(root, AUDIT)) ? readFileSync(join(root, AUDIT), 'utf8') : '';

// The seven deliverables the owner enumerated, plus the first-step recommendation.
const required = [
  ['1 product understanding', /^##\s+1\.\s+Product understanding/m],
  ['2 architecture', /^##\s+2\.\s+Architecture/m],
  ['3 current directory state', /^##\s+3\.\s+Current directory state/m],
  ['4 missing prerequisites + credentials', /^##\s+4\.\s+Missing prerequisites/m],
  ['5 contradictions and risks', /^##\s+5\.\s+Contradictions and technical risks/m],
  ['6 implementation sequence', /^##\s+6\.\s+Implementation sequence/m],
  ['7 first files to create', /^##\s+7\.\s+First files to be created/m],
  ['recommends first implementation step', /Milestone 0 — prove the voice layer/],
  ['states awaiting approval', /Awaiting product-owner go-ahead/],
];
const missing = required.filter(([, re]) => !re.test(audit)).map(([label]) => label);
add('audit delivers all 7 items + recommendation', missing.length === 0 ? 'all present' : `missing: ${missing.join(', ')}`, 'all present');

// ------------------------------------------------------- 2. credential safety
// A real key: sk- prefixed, or a long high-entropy token. A placeholder is empty,
// or an obvious stand-in word, or a <angle-bracket> marker.
const PLACEHOLDER = /^(|<|your-|xxx|changeme|placeholder|test_|dummy|\.\.\.)/i;
const looksReal = (v) => {
  const s = v.trim().replace(/^["']|["'],?$/g, '');
  if (s === '' || PLACEHOLDER.test(s)) return false;
  if (/^sk-[A-Za-z0-9_\-]{16,}$/.test(s)) return true;
  return s.length >= 32 && /[A-Za-z]/.test(s) && /\d/.test(s);
};

const SKIP_DIRS = new Set(['node_modules', '.git', '.code-in', '.code-ae', 'build', 'dist', '.dart_tool']);
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(relative(root, full).replace(/\\/g, '/'));
  }
};
walk(root);

const offenders = [];
for (const f of files) {
  if (!/\.(env|example|ts|tsx|js|mjs|dart|json|ya?ml|md)$/i.test(f)) continue;
  if (f === 'docs/audit-initialization.md') continue; // describes the rule, holds no key
  let text = '';
  try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/HUMAIN_API_KEY\s*[=:]\s*(.+)/);
    if (m && looksReal(m[1])) offenders.push(`${f}: ${line.trim().slice(0, 40)}`);
    if (/["']sk-[A-Za-z0-9_\-]{16,}["']/.test(line)) offenders.push(`${f}: sk- token literal`);
  }
}
add('no real HUMAIN key in any tracked file', offenders.length === 0 ? 'none found' : offenders.join(' | '), 'none found');

// .env.example must exist to document the variables, and must not contain a key.
const example = 'server/.env.example';
add('.env.example documents the vars', existsSync(join(root, example)), true);

// The ignore rule must match server/.env even though the file is intentionally absent,
// so the guard keeps working when the owner drops the real key in later.
let ignored = false;
try {
  execFileSync('git', ['check-ignore', '-q', 'server/.env'], { cwd: root, stdio: 'ignore' });
  ignored = true;
} catch { ignored = false; }
add('server/.env is git-ignored', ignored, true);

// Belt and braces: git must not stage the key file (checked as a path pattern, not a file).
let stagedEnv = false;
try {
  const dry = execFileSync('git', ['add', '-A', '--dry-run'], { cwd: root, encoding: 'utf8' });
  stagedEnv = /(^|\s)['"]?server\/\.env['"]?\s*$/m.test(dry);
} catch { stagedEnv = false; }
add('server/.env is never staged by git add', stagedEnv, false);

// ------------------------------------------------- 3. stack + no premature code
// The audit must name the mandated stack and no alternative framework may appear.
const stackTerms = ['Flutter', 'Node.js', 'Supabase', 'HUMAIN'];
const missingStack = stackTerms.filter((t) => !audit.includes(t));
add('audit names the mandated stack', missingStack.length === 0 ? 'all named' : `missing: ${missingStack.join(', ')}`, 'all named');

const altFrameworks = ['React Native', 'Expo', 'Kotlin Multiplatform', 'Xamarin', 'Ionic', 'Capacitor', 'Django', 'Ruby on Rails', 'Firebase'];
const introducedAlts = altFrameworks.filter((fw) => {
  // Only a problem if the audit proposes it as our choice, not if it merely appears.
  const re = new RegExp(`(use|choose|adopt|with|switch to)\\s+${fw}`, 'i');
  return re.test(audit);
});
add('no alternative framework proposed', introducedAlts.length === 0 ? 'none' : introducedAlts.join(', '), 'none');

// The owner approved Milestone 0 tooling (real HUMAIN adapter + validation
// harness) and Milestone 1 (mobile + backend). What must still never exist is an
// unauthorized *app* scaffold built before Milestone 1 is actually started.
// server/src is legitimate: it holds the agreed provider abstraction + adapter.
const implDirs = ['app', 'mobile', 'lib', 'flutter_app'];
const premature = implDirs.filter((d) => existsSync(join(root, d)));
add('no unapproved app scaffold exists', premature.length === 0 ? 'none' : `unexpected: ${premature.join(', ')}`, 'none');

// ------------------------------------------------------- 4. communication rules
// The audit must put its open questions to the owner rather than inventing answers.
add('audit asks the owner to decide open questions', /^##\s+8\.\s+Open decisions/m.test(audit), true);
add('audit explains options and a recommendation', /Recommendation:/.test(audit), true);

// No production deployment may be set up without explicit owner approval.
const deployFiles = ['vercel.json', 'Dockerfile', 'fly.toml', 'app.yaml', 'netlify.toml', '.github/workflows/deploy.yml'];
const deployPresent = deployFiles.filter((f) => existsSync(join(root, f)));
add('no production deployment configured', deployPresent.length === 0 ? 'none' : `unexpected: ${deployPresent.join(', ')}`, 'none');

// ------------------------------------------------- 5. abstraction + MVP scope
add('audit keeps HUMAIN behind a provider abstraction', /VoiceProvider/.test(audit), true);
add('audit excludes chatbot and Voice Agent from MVP', /not a chatbot/i.test(audit) && /excluded from MVP/i.test(audit), true);
add('audit separates documented facts from manual verification', /cross-checked against the live HUMAIN Voice documentation/i.test(audit) && /Confirmations/.test(audit), true);

console.log(JSON.stringify({ harnessVerification: { version: 1, checks } }));
