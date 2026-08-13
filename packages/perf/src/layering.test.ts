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

describe('apps/web/src (the SHIPPED app) never imports this package or the stress subpath', () => {
  const webSrcDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'apps',
    'web',
    'src',
  );

  it('no file under apps/web/src/** imports @wynding/perf, @wynding/content/stress, or @wynding/content/catalog', () => {
    const files = listFilesRecursive(webSrcDir);
    expect(files.length).toBeGreaterThan(0); // sanity: the directory actually resolved

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (
        /['"]@wynding\/perf['"]/.test(text) ||
        /['"]@wynding\/content\/stress['"]/.test(text) ||
        /['"]@wynding\/content\/catalog['"]/.test(text)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
