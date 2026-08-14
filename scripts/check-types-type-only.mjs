#!/usr/bin/env node
// check-types-type-only.mjs — guards @wynding/types' core invariant: the package
// stays TYPE ONLY. Its emitted `dist/index.js` must be nothing but `export {};` —
// the moment a runtime value (a helper function, a const, anything with a value)
// is added, this fails. Nothing else enforces that today: `--passWithNoTests`
// keeps `vitest run` green for a package with zero test files (load-bearing, not
// laxity — `vitest run` with no test files exits 1 on its own — see #113), so a
// runtime addition would otherwise ship with no tests and no coverage gate,
// silently.
//
// Follows the check:artifact-parity precedent (apps/server/scripts/check-artifact-parity.ts):
// a standalone script that builds its target itself rather than trusting turbo's
// task graph. `turbo run typecheck lint test`'s `test` task depends only on
// `^typecheck` (see turbo.json), not `^build` — a turbo-orchestrated version of
// this check would read a stale or absent dist/index.js. Building here, once,
// keeps the check honest without adding a build dependency to the turbo test task.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, 'packages', 'types');
const DIST_INDEX = join(PKG_DIR, 'dist', 'index.js');

function fail(message) {
  console.error(`❌ check:types-type-only failed: ${message}`);
  process.exit(1);
}

// CLEAN FIRST. `tsc -b` does not remove the outputs of a source file that was deleted or
// renamed, so an orphaned `dist/gone.js` survives indefinitely — and this check, which
// scans everything under `dist`, would then fail `verify` over a module whose source no
// longer exists. That is a false positive with no action the developer can take except
// guessing that `dist` is stale (verified by Codex on #113's PR). Removing `dist` and its
// build info makes the scan describe the CURRENT sources and nothing else; the package is
// tiny, so a full rebuild costs nothing.
rmSync(join(PKG_DIR, 'dist'), { recursive: true, force: true });
rmSync(join(PKG_DIR, 'tsconfig.tsbuildinfo'), { force: true });

const build = spawnSync('pnpm', ['-C', PKG_DIR, 'run', 'build'], { stdio: 'inherit' });
if (build.status !== 0) {
  fail(`packages/types build failed (exit ${String(build.status)}) — cannot check its emit.`);
}

if (!existsSync(DIST_INDEX)) {
  fail(`${DIST_INDEX} does not exist after build.`);
}

// EVERY emitted module, not just the entry point. Checking `dist/index.js` alone would
// announce the invariant held while a runtime `dist/sneaky.js` sat beside it — measured,
// that is exactly what an earlier draft of this script did. The package only `exports`
// ".", so such a module is not importable by package name today, but "not reachable
// through the current exports map" is a much weaker promise than "this package emits no
// runtime code", and the latter is what the header claims and what the missing coverage
// gate makes load-bearing.
/** Every file under `dir` whose name matches `re`. One walker: a fix to the traversal
 *  (symlinks, `withFileTypes`, an ignore) then lands once instead of half-landing. */
function filesUnder(dir, re) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, re));
    else if (re.test(entry)) out.push(full);
  }
  return out;
}

// Every JS extension tsc can emit, not just `.js`: a `.mts` source emits `.mjs` and a
// `.cts` emits `.cjs`, and a scan collecting only `.js` reported success while a
// runtime-bearing `.mjs` sat beside it unchecked (Codex, #113's PR).
const EMITTED_JS = /\.(js|mjs|cjs)$/;
const EMITTED_DTS = /\.d\.(ts|mts|cts)$/;

// Strip line comments (tsc preserves the source header and appends the sourcemap
// comment by default) and blank lines — what's left must be exactly the one
// runtime statement a type-only module emits.
function runtimeBody(file) {
  return (
    readFileSync(file, 'utf8')
      // Block comments first: tsc PRESERVES a `/* ... */` header from the source into the
      // emit, and a line filter that only drops `//` would then read it as runtime content
      // and fail a perfectly type-only package (Codex, #113's PR).
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
      .join('\n')
      .trim()
  );
}

// WHAT THIS SCRIPT IS, AND IS NOT. It proves `@wynding/types` ships no runtime code by
// the two routes a consumer can actually reach: emitted JavaScript, and value-space
// declarations in the emitted types. It is a REGRESSION guard, not a proof — like the
// determinism lint zone, the set of ways to occupy value space is open, and successive
// review rounds on #113 each named another (a runtime `export const`, a `.mts` emitting
// `.mjs`, an `export declare const`, an `export declare namespace`). Add arms here as
// they are noticed; a newly-named one is an addition, not a defect in this check.
//
// The property that does NOT depend on enumeration: `dist/index.js` being exactly
// `export {};` means nothing this package emits can execute. Everything else here guards
// the types LYING about that — declarations a consumer can import against and that then
// are not there at runtime.

// The EMITTED JS is only half the invariant. `export declare const x: string` emits
// nothing at all — dist/index.js stays `export {};` — while the .d.ts advertises a value
// in the value space, so a consumer can import and use it and the package stops being
// type-only in the only sense that matters to callers. (Caught by Codex on #113's PR,
// verified: the JS-only form of this check reported success on exactly that input.)
// EXPORTED value-space declarations only, and that is the structural point rather than a
// concession. The invariant is about what a CONSUMER can reach: a non-exported
// `declare const brand: unique symbol` is the idiomatic way to key a branded type, emits
// no JavaScript, and cannot be imported — flagging it would fail a legitimately type-only
// package (Codex, #113's PR; the third false positive this check produced, and the one
// that showed the earlier arms were matching the wrong property). Requiring `export`
// removes that whole class instead of adding another exception for each shape of it.
//
// Known residual, stated rather than papered over: `declare const x; export { x };`
// separates the declaration from its export and would pass. Consistent with this script's
// recorded scope — it is a regression guard, not a proof.
// Type-space declarations — interface, type, and `declare` on a namespace/module without
// an export — are fine and expected.
const VALUE_SPACE =
  /^\s*export\s+declare\s+(?:abstract\s+|async\s+)*(const|let|var|function|class|namespace|module)\b|^\s*export\s+(?:const\s+)?(enum|namespace)\b/m;

const declaring = filesUnder(join(PKG_DIR, 'dist'), EMITTED_DTS)
  .map((file) => ({ file, hit: VALUE_SPACE.exec(readFileSync(file, 'utf8')) }))
  .filter(({ hit }) => hit !== null);

if (declaring.length > 0) {
  fail(
    '@wynding/types declares runtime values in its .d.ts — it is meant to stay type-only.\n' +
      declaring.map(({ file, hit }) => `   ${file}:\n   ${hit[0].trim()}`).join('\n') +
      '\n   (These emit no JS, so the dist/*.js check above cannot see them — but a consumer\n' +
      '   can still import and call them.)',
  );
}

const emitted = filesUnder(join(PKG_DIR, 'dist'), EMITTED_JS);
const offenders = emitted
  .map((file) => ({ file, body: runtimeBody(file) }))
  .filter(({ body }) => body !== 'export {};');

if (offenders.length > 0) {
  fail(
    `@wynding/types emits runtime code — it is meant to stay type-only.\n` +
      offenders.map(({ file, body }) => `   ${file}:\n   ${body}`).join('\n'),
  );
}

console.log(
  `✓ @wynding/types emits nothing but \`export {};\` across all ${String(emitted.length)} emitted module(s) (still type-only).`,
);
