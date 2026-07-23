#!/usr/bin/env node
// i18n-gen.mjs — generate the typed message catalog from the `en` source of truth
// (ADR 0004: "keys + per-key param types generated from en"). Reads
// apps/web/src/i18n/en.json and emits apps/web/src/i18n/catalog.gen.ts with:
//   - `EN`            the runtime message table (frozen)
//   - `MessageKey`    the union of all dotted keys
//   - `MessageParams` per-key ICU placeholder param types (each `string | number`)
// The generated file is committed; `i18n-check.mjs` fails CI if it drifts from en.json,
// so a developer cannot hand-edit one without the other. Placeholders are the ICU
// `{name}` tokens in each message; a key with none gets `Record<string, never>` so
// `t()` forbids stray params.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = join(HERE, '..', 'apps', 'web', 'src', 'i18n');
const EN_PATH = join(I18N_DIR, 'en.json');
const OUT_PATH = join(I18N_DIR, 'catalog.gen.ts');

/** ICU placeholder names in a message, e.g. "Lives: {count}" → ["count"]. */
export function placeholders(message) {
  const names = new Set();
  const re = /\{\s*([a-zA-Z0-9_]+)\s*\}/g;
  let m;
  while ((m = re.exec(message)) !== null) names.add(m[1]);
  return [...names];
}

/** Render the generated TypeScript for a parsed `en` table. Exported for the checker. */
export function renderCatalog(en) {
  const keys = Object.keys(en);
  const enLines = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(en[k])},`).join('\n');
  const paramLines = keys
    .map((k) => {
      const names = placeholders(en[k]);
      // `Record<never, never>` has `keyof === never`, so `t()` requires NO params for
      // this key (unlike `Record<string, never>`, whose keyof is `string`).
      if (names.length === 0) return `  ${JSON.stringify(k)}: Record<never, never>;`;
      const fields = names.map((n) => `${JSON.stringify(n)}: string | number`).join('; ');
      return `  ${JSON.stringify(k)}: { ${fields} };`;
    })
    .join('\n');
  return `// AUTO-GENERATED from i18n/en.json by scripts/i18n-gen.mjs — do not edit by hand.
// Run \`pnpm run i18n:gen\` to regenerate; \`pnpm run i18n:check\` fails if this drifts.
/* eslint-disable */
export const EN = {
${enLines}
} as const;

export type MessageKey = keyof typeof EN;

export interface MessageParams {
${paramLines}
}
`;
}

function main() {
  const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));
  writeFileSync(OUT_PATH, renderCatalog(en));
  console.log(`i18n: generated ${OUT_PATH} (${Object.keys(en).length} keys)`);
}

// Only run when invoked directly (the checker imports the helpers above).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
