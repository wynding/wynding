// layering.test.ts — a real guard for the layering invariant `index.ts`'s header
// states (QC: this package's dev-only reverse dependency): "nothing shipped may import `@wynding/perf` or
// `@wynding/content/stress`". `apps/web` genuinely DEV-depends on this package now
// (`apps/web/perf/main-perf.ts`, the perf-only browser entry point) — the production
// graph is still clean, but a stated guarantee with nothing checking it is not a
// guarantee, it is a hope. This test reads the SHIPPED app's source tree from disk
// and greps it directly, rather than asserting anything about module resolution or
// bundler output — it is intentionally simple: a grep that would catch an accidental
// `import ... from '@wynding/perf'` (or the stress/catalog subpaths) landing in
// `apps/web/src/**`, the tree that actually ships.
//
// `@wynding/content/catalog` (`packages/content/src/catalog.ts:10-11`) is the same
// must-not-ship class as `./stress`: a synthetic perf bundle, deliberately absent from
// the registry, that must never reach production code.
//
// What this DOES protect: a future edit accidentally wiring the stress/catalog
// scenarios or this package into the production app/controller/scene code. What it
// does NOT protect: `apps/web/perf/**` (the perf-only entry point, which is EXPECTED to
// import all three) or any other workspace package.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// EVERY shipped tree, not just the web app. `apps/server` ships too and already declares
// `@wynding/content` as a production dependency, so a `@wynding/content/catalog` import
// there would have gone undetected by a check scoped to `apps/web/src` (Codex, #111's PR)
// — the same defect class this guard exists for: narrower than the invariant it encodes.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHIPPED_TREES = [
  join(REPO_ROOT, 'apps', 'web', 'src'),
  join(REPO_ROOT, 'apps', 'server', 'src'),
];

describe('the SHIPPED app trees never import this package or the not-shippable content subpaths', () => {
  it('no file under a shipped src/** imports @wynding/perf, @wynding/content/stress, or @wynding/content/catalog', () => {
    const files = SHIPPED_TREES.flatMap(listFilesRecursive);
    expect(files.length).toBeGreaterThan(0); // sanity: the directories actually resolved

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (
        /['"]@wynding\/perf['"]/.test(text) ||
        /['"]@wynding\/content\/stress['"]/.test(text) ||
        /['"]@wynding\/content\/catalog['"]/.test(text)
      ) {
        offenders.push(file);
        continue;
      }
      // A RELATIVE path reaches the same modules while dodging every specifier above:
      // `../../../packages/content/src/catalog` is resolved and bundled by Vite exactly
      // like the package import (Codex, #111's PR). Rather than enumerate the reachable
      // targets a second time, reject the whole shape — shipped code has no business
      // reaching into another package by path when the package graph exists. Test files
      // are excluded because they are not bundled, and one legitimately does this
      // (`apps/server/src/replay-parity.test.ts` imports a showcase fixture).
      if (!file.endsWith('.test.ts') && /(?:from|import)\s*\(?\s*['"][^'"]*packages\//.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
