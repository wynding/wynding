#!/usr/bin/env node
// i18n-check.mjs — the ADR 0004 extraction + cross-locale CI gate. Fails (exit 1) if:
//   (a) a `t('key', …)` used in the app is MISSING from the `en` catalog;
//   (b) an `en` key is UNUSED anywhere in the app (dead catalog entry);
//   (c) the generated catalog (catalog.gen.ts) has DRIFTED from en.json;
//   (d) any additional locale is missing/extra keys, or a key's ICU placeholder
//       signature MISMATCHES `en` (e.g. `{count}` in en but `{n}` in the other locale).
// This is the machine that keeps user-facing text on the catalog rather than in code
// (paired with the no-ui-literals ESLint rule, which bans the raw string literals).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { placeholders, renderCatalog } from './i18n-gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const I18N_DIR = join(ROOT, 'apps', 'web', 'src', 'i18n');
const SRC_DIR = join(ROOT, 'apps', 'web', 'src');
const EN_PATH = join(I18N_DIR, 'en.json');
const GEN_PATH = join(I18N_DIR, 'catalog.gen.ts');

const errors = [];
const fail = (msg) => errors.push(msg);

const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));
const enKeys = new Set(Object.keys(en));

// (a/b) Extract used keys from every source file (excluding the catalog itself).
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    // Production sources only: exclude generated catalogs AND *.test.ts — a key referenced
    // solely from a test fixture is still dead UI copy and must fail the unused-key gate.
    else if (
      /\.(ts|mts)$/.test(entry.name) &&
      !entry.name.endsWith('.gen.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

const used = new Set();
const USE_RE = /\bt\(\s*['"]([^'"]+)['"]/g;
for (const file of walk(SRC_DIR)) {
  const text = readFileSync(file, 'utf8');
  let m;
  while ((m = USE_RE.exec(text)) !== null) used.add(m[1]);
}

for (const key of used) {
  if (!enKeys.has(key)) fail(`used key not in en catalog: '${key}'`);
}
for (const key of enKeys) {
  if (!used.has(key)) fail(`unused en catalog key (dead entry): '${key}'`);
}

// (c) The generated catalog must match what i18n-gen would produce right now.
const expectedGen = renderCatalog(en);
let actualGen = '';
try {
  actualGen = readFileSync(GEN_PATH, 'utf8');
} catch {
  fail(`generated catalog missing: ${GEN_PATH} (run \`pnpm run i18n:gen\`)`);
}
if (actualGen && actualGen !== expectedGen) {
  fail('catalog.gen.ts is out of date with en.json — run `pnpm run i18n:gen`');
}

// (d) Cross-locale: every other <locale>.json must have exactly en's keys and, per key,
// the same ICU placeholder signature.
for (const entry of readdirSync(I18N_DIR)) {
  if (!entry.endsWith('.json') || entry === 'en.json') continue;
  const locale = entry.replace(/\.json$/, '');
  const table = JSON.parse(readFileSync(join(I18N_DIR, entry), 'utf8'));
  const keys = new Set(Object.keys(table));
  for (const k of enKeys) if (!keys.has(k)) fail(`locale '${locale}' missing key '${k}'`);
  for (const k of keys) if (!enKeys.has(k)) fail(`locale '${locale}' has extra key '${k}'`);
  for (const k of enKeys) {
    if (!keys.has(k)) continue;
    const a = [...placeholders(en[k])].sort().join(',');
    const b = [...placeholders(table[k])].sort().join(',');
    if (a !== b) fail(`locale '${locale}' key '${k}' ICU signature mismatch: en{${a}} vs {${b}}`);
  }
}

if (errors.length > 0) {
  console.error('❌ i18n check failed:');
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}
console.log(`✓ i18n check passed (${enKeys.size} keys, all used, catalog in sync)`);
