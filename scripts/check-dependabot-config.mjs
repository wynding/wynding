#!/usr/bin/env node
// check-dependabot-config.mjs — CI-adjacent guard (the i18n-check.mjs pattern: no
// workspace owns `.github/`, so the root `verify` script is the only place this gets
// checked). GitHub only fully evaluates dependabot.yml on the default branch, so this
// is a pre-merge shape guard, not a substitute for the post-merge Dependabot tab check
// (ADR 0009).
//
// Deep-equals the parsed document against the complete expected object — rejecting
// missing AND extra fields, not spot-checking individual keys.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONFIG_PATH = join(ROOT, '.github', 'dependabot.yml');

const EXPECTED = {
  version: 2,
  updates: [
    {
      'package-ecosystem': 'github-actions',
      directory: '/',
      schedule: {
        interval: 'weekly',
      },
    },
  ],
};

let doc;
try {
  doc = parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`❌ dependabot config check failed: could not read/parse ${CONFIG_PATH}`);
  console.error(`   - ${err.message}`);
  process.exit(1);
}

if (!isDeepStrictEqual(doc, EXPECTED)) {
  console.error('❌ dependabot config check failed: .github/dependabot.yml does not match the');
  console.error('   expected shape exactly (missing, extra, or differing fields).');
  console.error(`   expected: ${JSON.stringify(EXPECTED)}`);
  console.error(`   actual:   ${JSON.stringify(doc)}`);
  process.exit(1);
}

console.log('✓ dependabot config check passed (.github/dependabot.yml matches expected shape)');
