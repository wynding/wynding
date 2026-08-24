// layering.test.ts — the cheap, belt-and-suspenders arm of the layering invariant `index.ts`'s
// header states (QC: this package's dev-only reverse dependency): "nothing shipped may import
// `@wynding/perf` or `@wynding/content/stress`". `apps/web` genuinely DEV-depends on this
// package now (`apps/web/perf/main-perf.ts`, the perf-only browser entry point) — the
// production graph is still clean, but a stated guarantee with nothing checking it is not a
// guarantee, it is a hope.
//
// IT IS NO LONGER THE PRIMARY GUARD, AND NO LONGER THE ONLY ONE. Two now sit in front of it,
// and this file was kept rather than deleted (#112/#129) because it costs milliseconds, runs
// in the unit-test path, where neither of them does, and fails differently from both:
//
//   1. `eslint.config.mjs`'s LAYERING ZONES — ADR 0001's graph compiled into per-zone
//      `no-restricted-imports`. They catch a DECLARED back-edge at the point of writing, with
//      a message naming the rule, which is the earliest and most useful moment. They match
//      package specifiers only, and not inside a dynamic `import()`.
//   2. `pnpm run check:build-layering` — the reachability check over BUILD OUTPUT (e2e job).
//      It asks Vite, so it sees reaches spelled as paths: all six in #129's escape table, and
//      the template literal below. It is the authoritative one for the web app; it is also the
//      slow one, needing three real builds, and it reads STRING-SHAPED markers, so a reach
//      that drags in no marker-bearing string can still pass it.
//
// This file's own contribution, stated exactly: it is the only one of the three that reads
// EVERY shipped `src` tree as text, so it still fires for `apps/server` (which guard 2 does
// not scan — esbuild bundles it, but that check reads the web app's output only) and for a
// dynamic or comment-interrupted `import()` of the three never-shipped specifiers (which
// guard 1 cannot see). Where all three overlap it is the cheapest, and a failure here is a
// one-line fix rather than a build to read.
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
// resolve paths at all: `../../../packages/content/src/stress` from an app,
// `../../content/src/stress` from a sibling package, `./catalog` re-exported inside
// `packages/content`, `../perf/main-perf` or the Vite root-relative `/perf/main-perf` from the
// web app, or a shipped module importing a `.test.ts` helper that imports one of them. All six
// were measured green here and RED under `check:build-layering`, which is the check that owns
// them.
//
// One SPECIFIER-shaped escape is also left open, deliberately, and saying so is the point of
// this paragraph — an earlier draft claimed the specifier side was airtight, and it was not.
// A no-substitution template literal — import(`@wynding/perf`) with backticks — is resolved
// statically by Vite and matches nothing here, because backtick is not in the quote class.
// Adding it would cost more than it buys: three existing header comments legitimately name
// these packages in backticked prose (`packages/content/src/stress.ts`, `catalog.ts`,
// `stress.test.ts`), and every future comment would owe the same tax, so the guard would start
// reddening documentation. A template-literal import specifier is not the accident this file
// exists to catch; a comment mentioning a package name is an everyday act.
//
// This file is deliberately NOT grown to cover them, and that decision is now settled rather
// than merely deferred. An earlier revision chased those spellings through enumeration, then
// workspace discovery, then full specifier resolution with each package's `exports` map, and a
// reviewer defeated every version — because all three kept scanning TEXT, and the set of
// spellings Vite and tsc accept is strictly larger than any scanner written by hand. #129
// asked the bundler instead, which is both complete and less code than the resolver it
// replaces. Do not re-grow this file toward it; add to the marker table there.
//
// The caveat this header used to end on is DISCHARGED, and the note is kept because the
// reasoning still governs. Unlike the determinism lint zone — which can afford an open
// spelling set because the determinism golden and replay byte-identity catch the CONSEQUENCE —
// this invariant had no structural backstop: `pnpm size`'s 3 MB budget is far too loose to
// notice a shipped synthetic bundle, so this grep was the only line of defence and it was a
// grep. `check:build-layering` is that backstop, and it catches the consequence the same way:
// it reads the artifact, not the intent.

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

// The `(?:\/…)?` tail covers SUBPATHS. `@wynding/perf/harness` slipped past a pattern that
// demanded the closing quote immediately after `perf` — latent today, since perf's `exports` map
// offers only ".", but live the day anyone adds a subpath export (adversarial review, #111's PR).
const FORBIDDEN_SPECIFIER = /['"]@wynding\/(?:perf|content\/(?:stress|catalog))(?:\/[^'"]*)?['"]/;

// EVERY module extension a bundler will follow, not just the two this repo happens to contain.
// A `.mts` or `.cts` module under a shipped tree was collected by nobody, so it could import
// `@wynding/perf` and reach the bundle with this guard green (Codex, #111's PR — verified, and
// `.js`/`.cjs`/`.mjs` were equally unscanned). The extensions in use today are 160 `.ts` files
// and nothing else, which is exactly why the narrow filter looked correct for so long.
//
// Provenance worth keeping, because it is the same lesson twice: `check-types-type-only.mjs` in
// this very PR already carries `EMITTED_JS = /\.(js|mjs|cjs)$/` with a comment recording that a
// scan collecting only `.js` reported success while a runtime-bearing `.mjs` sat beside it
// unchecked. That fix was made in one file and never carried to its sibling.
const MODULE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (MODULE_FILE.test(entry)) {
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
