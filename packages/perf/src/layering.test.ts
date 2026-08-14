// layering.test.ts — a cheap regression catch for the layering invariant `index.ts`'s
// header states (QC: this package's dev-only reverse dependency): "nothing shipped may import `@wynding/perf` or
// `@wynding/content/stress`". `apps/web` genuinely DEV-depends on this package now
// (`apps/web/perf/main-perf.ts`, the perf-only browser entry point) — the production
// graph is still clean, but a stated guarantee with nothing checking it is not a
// guarantee, it is a hope.
//
// `@wynding/content/catalog` (`packages/content/src/catalog.ts:10-11`) is the same
// must-not-ship class as `./stress`: a synthetic perf bundle, deliberately absent from
// the registry, that must never reach production code.
//
// WHAT THIS IS, AND WHAT IT IS NOT — stated plainly, because the honest scope is the whole
// point of this file's shape. It greps shipped source for the PACKAGE-SPECIFIER spelling of
// a forbidden import, which is the realistic accident: a habit import, an autocomplete, a
// copied snippet. The match is deliberately context-free — it looks for the quoted specifier
// itself, not for a `from`/`import` keyword before it — so it is indifferent to import
// syntax, and catches the static form, `await import(...)`, a re-export, and even a comment
// interrupting the call, all the same.
//
// What it does NOT catch is every PATH-shaped reach at the same modules, because it does not
// resolve paths at all: `../../content/src/stress` from a sibling package, `./catalog`
// re-exported inside `packages/content`, `../perf/main-perf` or the Vite root-relative
// `/perf/main-perf` from the web app, or a shipped module importing a `.test.ts` helper that
// imports one of them. Those are demonstrated with probes in #129, which owns the real check.
//
// This file is deliberately NOT grown to cover them. An earlier revision chased those
// spellings through enumeration, then workspace discovery, then full specifier resolution
// with each package's `exports` map, and a reviewer defeated every version — because all
// three kept scanning TEXT, and the set of spellings Vite and tsc accept is strictly larger
// than any scanner written by hand. #129 proposes asking the bundler instead, which is both
// complete and less code than the resolver it would replace.
//
// One honest caveat, so nobody mistakes this for sufficient: unlike the determinism lint
// zone — which can afford an open spelling set because the determinism golden and replay
// byte-identity catch the CONSEQUENCE — this invariant has no structural backstop today.
// The `pnpm size` budget is far too loose to notice a shipped synthetic bundle. This test is
// the only line of defence, and it is a grep. That gap is the reason #129 exists.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

// This package's own tree, derived from this file's location so it can never name the wrong
// directory: it is the thing nothing else may import, and its modules use the synthetic
// bundles constantly.
const PERF_PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PERF_PACKAGE_DIR, '..', '..');
const asRepoPath = (abs: string): string => relative(REPO_ROOT, abs).split(sep).join('/');

const FORBIDDEN_SPECIFIER = /['"]@wynding\/(?:perf|content\/(?:stress|catalog))['"]/;

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

// The shipped trees are DISCOVERED rather than listed. Two successive reviews found a
// written-down list too narrow — first missing `apps/server`, then every `packages/*/src`,
// and `packages/render` is bundled straight into the web app just as the apps are. That is
// twelve lines and it retires the whole class, so it stays even though the rest of the
// chase-the-spelling machinery did not. `src/` is the boundary because
// `apps/web/index.html` loads `/src/boot-entry.ts`, `apps/server`'s tsconfig compiles `src`,
// and each package's `exports` map points into its own `src`. `apps/web/perf/**` falls
// outside it by construction — a separate Vite config (`vite.perf.config.ts`) builds that
// entry, so it never enters the production bundle.
function shippedSrcTrees(): string[] {
  const trees: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(REPO_ROOT, group);
    for (const entry of readdirSync(groupDir).sort()) {
      const memberDir = join(groupDir, entry);
      if (!statSync(memberDir).isDirectory() || memberDir === PERF_PACKAGE_DIR) continue;
      const srcDir = join(memberDir, 'src');
      if (statSync(srcDir, { throwIfNoEntry: false })?.isDirectory() === true) trees.push(srcDir);
    }
  }
  return trees;
}

describe('no shipped tree names this package or the not-shippable content subpaths', () => {
  it('covers every shipped src tree, including the ones earlier scopes missed', () => {
    const trees = shippedSrcTrees().map(asRepoPath);
    // Witnesses, not the scan scope — the scan is whatever is on disk. `apps/web/src` was
    // this guard's original scope; the other two are what successive reviews found missing,
    // pinned so a regression to a narrower list is red rather than silent.
    expect(trees).toContain('apps/web/src');
    expect(trees).toContain('apps/server/src');
    expect(trees).toContain('packages/render/src');
    expect(trees).not.toContain('packages/perf/src');
  });

  it('no file under a shipped src/** names @wynding/perf, @wynding/content/stress, or @wynding/content/catalog', () => {
    const files = shippedSrcTrees().flatMap(listFilesRecursive);
    expect(files.length).toBeGreaterThan(0); // sanity: the directories actually resolved

    const offenders = files
      .filter((file) => FORBIDDEN_SPECIFIER.test(readFileSync(file, 'utf8')))
      .map(asRepoPath);
    expect(offenders).toEqual([]);
  });
});
