// layering.test.ts — a real guard for the layering invariant `index.ts`'s header
// states (QC: this package's dev-only reverse dependency): "nothing shipped may import `@wynding/perf` or
// `@wynding/content/stress`". `apps/web` genuinely DEV-depends on this package now
// (`apps/web/perf/main-perf.ts`, the perf-only browser entry point) — the production
// graph is still clean, but a stated guarantee with nothing checking it is not a
// guarantee, it is a hope.
//
// `@wynding/content/catalog` (`packages/content/src/catalog.ts:10-11`) is the same
// must-not-ship class as `./stress`: a synthetic perf bundle, deliberately absent from
// the registry, that must never reach production code.
//
// HOW IT CHECKS, and why it changed shape. This guard used to grep for the two SPELLINGS a
// forbidden import might use — the package specifier, then relative paths containing a
// literal `packages/` segment. Chasing spellings is what kept it narrower than the
// invariant: successive reviews found it blind to `apps/server`, then to every
// `packages/*/src`, then — once those trees were in scope — to `../../content/src/stress`,
// the sibling reach that never contains `packages/` at all, and finally to a re-export
// (`export { X } from './catalog'` inside `packages/content/src/index.ts`), one line that
// pulls a synthetic 1,000,000-hp bundle into the graph of every consumer while matching no
// spelling at all.
//
// So it no longer reads spellings. It RESOLVES every import specifier in every shipped file
// to an absolute path and asks one question of the result: is that path not-shippable? All
// four reaches above collapse into that single question, and so does the next spelling
// nobody has thought of.
//
// Residuals, stated rather than left for the next reviewer to find: this reads source text,
// so a comment quoting an import of a forbidden module counts as one (it fails the guard
// CLOSED — a one-line diagnosis, and the safe direction). It does not model conditional
// exports, `require`, or a bundler alias, none of which this repo uses. And it says nothing
// about `apps/web/perf/**` importing what it likes — that tree is BUILT BY A SEPARATE CONFIG
// (`vite.perf.config.ts`, whose input is `perf/index.html`) and is itself on the
// not-shippable list, so it is a forbidden target here, never a scanned source.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const asRepoPath = (abs: string): string => relative(REPO_ROOT, abs).split(sep).join('/');

// The modules that must never enter a shipped graph, as absolute paths — a directory entry
// covers everything beneath it. This ONE list does all the exempting: a file that is itself
// not-shippable is skipped as a source (this package's own modules import the synthetic
// bundles constantly, and must), and every scanned import is judged by whether it lands
// here. There is no second notion of "excluded" to keep in sync with this one.
const NOT_SHIPPABLE = [
  join(REPO_ROOT, 'packages', 'perf'), // the dev-only package itself
  join(REPO_ROOT, 'packages', 'content', 'src', 'stress.ts'), // synthetic perf bundles, kept
  join(REPO_ROOT, 'packages', 'content', 'src', 'catalog.ts'), // out of the registry on purpose
  join(REPO_ROOT, 'apps', 'web', 'perf'), // the perf-only browser entry point
  join(REPO_ROOT, 'apps', 'web', 'e2e-perf'), // and the perf-only Playwright specs
];

const isNotShippable = (abs: string): boolean =>
  NOT_SHIPPABLE.some((target) => abs === target || abs.startsWith(target + sep));

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

// Every shipped source tree, DISCOVERED — deliberately not a literal list. Enumerating the
// trees is what left `apps/server` and then every `packages/*/src` unscanned, so the scope
// is now whatever the workspace holds: every `apps/<member>/src` and `packages/<member>/src`
// on disk. A new workspace member is covered the day it is created, by nobody remembering
// anything. `packages/perf` is NOT special-cased here — its files are skipped by the
// not-shippable list, like every other forbidden module.
//
// Why `src/` is the boundary: `apps/web/index.html` loads `/src/boot-entry.ts` and
// `apps/server`'s tsconfig compiles `src`, so those trees ARE what ships, and each package's
// `exports` map points into its own `src`.
function shippedSrcTrees(): string[] {
  const trees: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(REPO_ROOT, group);
    for (const entry of readdirSync(groupDir).sort()) {
      const memberDir = join(groupDir, entry);
      if (!statSync(memberDir).isDirectory()) continue;
      const srcDir = join(memberDir, 'src');
      if (existsSync(srcDir) && statSync(srcDir).isDirectory()) trees.push(srcDir);
    }
  }
  return trees;
}

// `from '...'` / `import '...'` / `import('...')` / `export ... from '...'` — one shape, because
// every one of them puts the module into the importing file's graph.
const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const WORKSPACE_SCOPE = '@wynding/';

// A relative specifier omits its extension; the resolved path has to name the real file for
// the not-shippable comparison to mean anything (`./catalog` must become `catalog.ts`).
function withExtension(path: string): string {
  for (const candidate of [path, `${path}.ts`, join(path, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return path;
}

const exportsCache = new Map<string, Record<string, unknown>>();
function packageExports(packageDir: string): Record<string, unknown> {
  let map = exportsCache.get(packageDir);
  if (!map) {
    const manifest = join(packageDir, 'package.json');
    map = existsSync(manifest)
      ? ((JSON.parse(readFileSync(manifest, 'utf8')).exports ?? {}) as Record<string, unknown>)
      : {};
    exportsCache.set(packageDir, map);
  }
  return map;
}

/** The absolute module a specifier names, or `null` for anything outside this workspace. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return withExtension(resolve(dirname(fromFile), specifier));
  if (!specifier.startsWith(WORKSPACE_SCOPE)) return null; // third-party: not this rule's business
  const [member, ...subpath] = specifier.slice(WORKSPACE_SCOPE.length).split('/');
  if (member === undefined || member === '') return null; // a bare `@wynding/` names nothing
  const packageDir = join(REPO_ROOT, 'packages', member);
  // The `exports` map is the authority on what a subpath means — reading it is what keeps
  // `@wynding/content/stress` and `./stress` resolving to the same file.
  const target = packageExports(packageDir)[subpath.length ? `./${subpath.join('/')}` : '.'];
  return typeof target === 'string' ? join(packageDir, target) : null;
}

describe('nothing shipped reaches a not-shippable module', () => {
  it('every not-shippable path exists — a stale entry would exempt nothing and pass silently', () => {
    // The whole guard is a comparison against this list. A typo here does not fail loudly,
    // it makes the check vacuous, which is the exact failure mode this file exists to catch.
    const missing = NOT_SHIPPABLE.filter((target) => !existsSync(target)).map(asRepoPath);
    expect(missing).toEqual([]);
  });

  it('discovery includes the trees earlier scopes missed', () => {
    const trees = shippedSrcTrees().map(asRepoPath);
    // The scopes this guard has had, pinned so a regression to any narrower one is red
    // rather than silent: `apps/web/src` was the original, the other three are what
    // successive reviews found missing. Witnesses, not the scan scope — the scan is
    // whatever is on disk.
    expect(trees).toContain('apps/web/src');
    expect(trees).toContain('apps/server/src');
    expect(trees).toContain('packages/render/src');
    expect(trees).toContain('packages/content/src');
  });

  it('no shipped file imports @wynding/perf, the synthetic bundles, or the perf-only entry — by any spelling', () => {
    const files = shippedSrcTrees().flatMap(listFilesRecursive);
    expect(files.length).toBeGreaterThan(0); // sanity: the directories actually resolved

    const offenders: string[] = [];
    for (const file of files) {
      // Tests are not bundled, so they are not shipped code — and one legitimately reaches
      // for a fixture by path (`apps/server/src/replay-parity.test.ts`) while the content
      // package's own tests import the very bundles under guard.
      if (file.endsWith('.test.ts') || isNotShippable(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SPECIFIER)) {
        const specifier = match[1];
        if (specifier === undefined) continue; // unreachable: the group is not optional
        const target = resolveSpecifier(file, specifier);
        if (target !== null && isNotShippable(target)) {
          offenders.push(`${asRepoPath(file)} -> ${specifier} (${asRepoPath(target)})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
