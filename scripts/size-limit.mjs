#!/usr/bin/env node
// size-limit.mjs — the ADR 0005 initial-load budget gate. Story 6 is the first
// meaningful production build, so this is the first size gate: the app's initial-load
// JavaScript (the entry chunk + everything it statically pulls in, e.g. Phaser) must be
// ≤ 3 MB gzipped. Fails (exit 1) over budget so a bundle blow-up (the Phaser bet, a stray
// dependency) is caught in CI, not in production.
//
// It measures ONLY the initial-load graph — the module scripts + modulepreloads the built
// index.html references — NOT every emitted .js. That distinction matters the moment a
// non-initial chunk appears (a deferred service worker, a future lazy/route-split chunk):
// those load on demand, not at first paint, so counting them would false-fail the budget.

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'apps', 'web', 'dist');
const INDEX = join(DIST, 'index.html');
const BUDGET_BYTES = 3 * 1024 * 1024; // 3 MB gzipped (ADR 0005)

if (!existsSync(INDEX)) {
  console.error(
    `❌ size gate: no build found at ${INDEX} — run \`pnpm --filter @wynding/web build\` first.`,
  );
  process.exit(1);
}

// The initial-load JS the browser fetches for first paint: the entry <script type=module>
// plus any <link rel=modulepreload> the entry statically imports (Vite emits both).
const html = readFileSync(INDEX, 'utf8');
const refs = new Set();
// Match each <script>/<link> tag, then read its attributes ORDER-INDEPENDENTLY (HTML
// attribute order isn't guaranteed — a Vite/minifier change emitting `src` before
// `type=module` must not silently break the gate).
const TAG_RE = /<(script|link)\b([^>]*)>/gi;
let m;
while ((m = TAG_RE.exec(html)) !== null) {
  const tag = m[1].toLowerCase();
  const attrs = m[2];
  const js = /\b(?:src|href)=["']([^"']+\.js)["']/i.exec(attrs)?.[1];
  if (js === undefined) continue;
  if (tag === 'script' && /\btype=["']module["']/i.test(attrs)) refs.add(js);
  else if (tag === 'link' && /\brel=["']modulepreload["']/i.test(attrs)) refs.add(js);
}

if (refs.size === 0) {
  console.error(
    '❌ size gate: no module scripts found in index.html — cannot measure initial load.',
  );
  process.exit(1);
}

let totalGzip = 0;
const rows = [];
for (const ref of refs) {
  // Href is root-absolute (e.g. /assets/index-XXX.js) or relative — resolve under dist.
  const rel = ref.replace(/^\//, '');
  const path = join(DIST, rel);
  if (!existsSync(path)) {
    console.error(`❌ size gate: index.html references ${ref} but ${path} is missing.`);
    process.exit(1);
  }
  const gz = gzipSync(readFileSync(path)).length;
  totalGzip += gz;
  rows.push({ name: rel, gz });
}

rows.sort((a, b) => b.gz - a.gz);
for (const r of rows) console.log(`   ${(r.gz / 1024).toFixed(1).padStart(9)} KB gz  ${r.name}`);

const totalMb = (totalGzip / (1024 * 1024)).toFixed(3);
const budgetMb = (BUDGET_BYTES / (1024 * 1024)).toFixed(0);
if (totalGzip > BUDGET_BYTES) {
  console.error(
    `❌ size gate: initial JS ${totalMb} MB gzipped exceeds the ${budgetMb} MB budget (ADR 0005).`,
  );
  process.exit(1);
}
console.log(`✓ size gate: initial JS ${totalMb} MB gzipped ≤ ${budgetMb} MB budget (ADR 0005).`);
