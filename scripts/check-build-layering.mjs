#!/usr/bin/env node
// check-build-layering.mjs — the layering invariant decided against BUILD OUTPUT instead of
// source text (#129).
//
// THE INVARIANT. Three modules must never reach the shipped web app: `@wynding/perf` (the
// most-downstream package — AGENTS.md's Hard rules, `packages/perf/src/index.ts`'s header),
// and `@wynding/content`'s `./stress` and `./catalog` subpaths — synthetic perf ceilings
// (1,000,000-hp creeps, 1,000,000 starting lives) deliberately absent from the registry.
//
// WHY THE SUBSTRATE IS THE ARTIFACT AND NOT THE SOURCE. The question is "does the shipped app
// reach a forbidden module through the real module graph?", and the authority on that graph is
// the bundler. #124 spent four rounds proving that text scanning cannot answer it: the guard
// went enumeration -> workspace discovery -> full specifier resolution with each package's
// `exports` map, and a reviewer defeated every version, because all three kept scanning TEXT
// and the set of spellings Vite and tsc accept is strictly larger than any scanner written by
// hand. #129's escape table lists six that got through: a cross-package relative path from an
// app, a sibling relative path between packages, an intra-package re-export, an app-internal
// reach at `../perf/main-perf`, the Vite root-relative `/perf/main-perf`, and test-module
// laundering (a shipped file importing a `.test` helper that imports the forbidden module) —
// plus a seventh, the no-substitution template literal ``import(`@wynding/perf`)``, which
// `layering.test.ts` leaves open deliberately because widening its quote class would start
// reddening documentation. Every one of them is covered here for free, because Vite has
// already resolved the specifier before anything is emitted. So has every spelling nobody has
// thought of yet.
//
// WHY THIS CHECK EXISTS AT ALL, given the lint zones. The determinism lint zone can afford an
// open spelling set because a real backstop catches the CONSEQUENCE: nondeterminism reaching
// the sim moves the determinism golden, CI pairs that with a SIM_VERSION bump (#107), and
// replay byte-identity fails on divergence. The layering invariant had no equivalent. If the
// synthetic catalog bundle shipped, nothing downstream would notice — the `pnpm size` budget
// (3 MB gzipped) is far too loose to register it. This is that backstop.
//
// WHAT THIS CHECK DOES NOT COVER, stated plainly rather than pretended:
//   - `apps/server`. It ships too, and it IS bundled — `esbuild --bundle` emits a single
//     self-contained `dist/handler.mjs` and its tsconfig sets `noEmit` (#109), so tsc is the
//     type checker there and nothing else. An earlier draft of this header said "tsc builds it
//     with no bundler, so there is no emitted graph to interrogate", which was exactly
//     inverted. The honest reason the server is uncovered is narrower and entirely this
//     file's doing: `SHIPPED_DIRS` below scans the WEB app's output only. Extending the same
//     marker sweep to `apps/server/dist/handler.mjs` is open work, not an impossibility.
//     Until then its arm of the invariant is its `package.json` dependency set (which
//     declares neither `@wynding/render` nor `@wynding/perf`, making both undeclared imports
//     that fail to resolve) plus `eslint.config.mjs`'s `apps/server/src` zone. That is a
//     weaker guarantee than this one and is named here so nobody reads this check's green as
//     covering the server.
//   - Anything a forbidden module contributes that is neither a string literal nor an emitted
//     asset. A marker is evidence of reach, not a proof of its absence: minification renames
//     identifiers, so only string-shaped content survives to be matched. The lint zones and
//     `layering.test.ts`'s grep sit upstream of this for exactly that reason — three guards,
//     none of them claiming to be the whole answer.
//
//     CONCRETELY, so the limit is not left abstract: `stress-blast` is the only marker for
//     perf MODULE code, and it lives in `layout.ts`/`scenario.ts`/`gate.ts` alone. Rollup
//     tree-shakes per module, so a shipped file importing only `percentile` pulls in
//     `stats.ts`, which carries no marker — @wynding/perf would genuinely ship and this check
//     would stay green. Spelled as a PATH (`../../../packages/perf/src/stats`) it also evades
//     the two specifier-matching guards, so all three pass. Anything claiming this check
//     catches "every spelling of a reach" is overstating it: Vite resolving the specifier is
//     necessary, not sufficient — a marker must also survive tree-shaking to be seen.
//
// WHY THE MARKERS ARE VALIDATED AGAINST A FORBIDDEN BUILD. A marker check that matches
// nothing in the thing it forbids proves nothing: rename `STRESS_RULESET_ID` and this file
// would go on passing forever, having tested that a string nobody emits is not emitted. So
// every marker below must be found in `dist-perf` — the perf-only build, whose two entry
// points (`apps/web/perf/main-perf.ts`, `main-perf-catalog.ts`) import all three forbidden
// modules on purpose. That build is this check's positive control, and a marker missing from
// it fails the run just as loudly as a marker found in `dist`.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(REPO_ROOT, 'apps', 'web');

/** The shipped artifacts (ADR 0013: two builds from one source — the open-web app and the
 *  Host build). Both are production output; both must be clean. */
const SHIPPED_DIRS = ['dist', 'dist-host'];

/** The positive control: the perf-only build, which reaches all three forbidden modules. */
const FORBIDDEN_DIR = 'dist-perf';

/** The three modules nothing shipped may reach. Every one must still be represented in
 *  `MARKERS` — see `assertMarkerTableIntact`. */
const FORBIDDEN_MODULES = ['@wynding/perf', '@wynding/content/stress', '@wynding/content/catalog'];

// Markers are chosen from what is provably unique to the forbidden artifacts — verified in
// both directions when this check was written: each is present in `dist-perf` (asserted below
// on every run, so it stays true) and absent from `dist`/`dist-host`.
const MARKERS = [
  {
    text: 'stress-40x40',
    module: '@wynding/content/stress',
    why: "the stress bundle's ruleset id and board id (packages/content/src/stress.ts), which is also the `rulesetId` inside stress-40x40.json and the name that file is emitted under",
  },
  {
    text: 'catalog-40x40',
    module: '@wynding/content/catalog',
    why: "the catalog bundle's ruleset id and board id (packages/content/src/catalog.ts), likewise its own `rulesetId` and emitted asset name",
  },
  {
    text: 'stress-blast',
    module: '@wynding/perf',
    why: "a tower id that exists only in the stress bundle and in @wynding/perf's `towerIdAt` placement table (packages/perf/src/layout.ts) — the sentinel for perf MODULE CODE reaching a chunk, since a string literal survives minification where an identifier does not",
  },
  {
    text: 'cat-heavy',
    module: '@wynding/content/catalog',
    why: 'a creep id unique to the catalog bundle — catches the catalog ruleset JSON reaching the shipped output as an emitted or inlined asset even when no id constant ships beside it',
  },
  {
    text: 'wy:window:start',
    module: '@wynding/perf',
    why: "the sampling-window trace mark emitted by the perf-only browser entries (apps/web/perf/**) — the sentinel for #129's probes 4 and 5, an app-internal reach at `../perf/main-perf` or the Vite root-relative `/perf/main-perf`",
  },
];

// FAILURE IS THROWN, NOT `process.exit()`-ed, and that is not style. Measured on Node
// v26.0.0: calling `process.exit()` from this module's top level AFTER the `spawnSync` builds
// below DEADLOCKS — `node::Environment::Exit` -> `DisposePlatform` -> `NodePlatform::Shutdown`
// never returns, so the script hangs at 0% CPU having already printed its verdict (captured
// with `sample`; the passing path exits fine, so only the red path wedged, which is the one
// that must never wedge — in CI it would burn the job's whole timeout instead of failing).
// Unwinding to the bottom of the file and setting `process.exitCode` lets Node shut down its
// own way, and flushes stdio on the way out for free.
class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message);
}

function run(cmd, args, cwd) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    fail(
      `build step failed (exit ${String(result.status)}): ${cmd} ${args.join(' ')}\n` +
        'A failed build means this check has nothing to read — fix the build first. It does ' +
        'NOT mean the layering is clean.',
    );
  }
}

// `withFileTypes` (and therefore `lstat` semantics) rather than `statSync`, which FOLLOWS
// symlinks: a dangling link threw ENOENT — not a CheckFailure, so it escaped as a raw stack
// instead of this script's verdict — and a link cycle recursed to a RangeError. Both failed
// closed, so neither could green a violation, but a guard should fail with its own message.
// Non-regular entries (symlinks, sockets, fifos) are skipped: Vite emits none, and following
// one would scan something outside the artifact.
function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Read as latin1, never utf8: every byte maps to exactly one character, so a PNG or any other
// binary asset is scannable without a decode error and without the replacement characters a
// utf8 read would splice into the middle of a marker.
const readAll = (file) => readFileSync(file, 'latin1');

// Vite INLINES an asset below `assetsInlineLimit` (4 kB) as a base64 `data:` URL rather than
// emitting a file — measured: the stress bundle lands that way in `dist-perf`, the larger
// catalog bundle does not. Base64 hides every marker inside it from a plain scan, so a reach
// that pulled in only `STRESS_RULESET_URL` (and no id constant) would ship the whole synthetic
// ruleset with nothing matching. Decoding the payloads closes that, and costs one pass.
function scannableText(file) {
  const raw = readAll(file);
  const decoded = [];
  for (const match of raw.matchAll(/;base64,([A-Za-z0-9+/]+={0,2})/g)) {
    decoded.push(Buffer.from(match[1], 'base64').toString('latin1'));
  }
  // The path is scanned too: an emitted asset's FILENAME carries the marker
  // (`assets/catalog-40x40-DirSo4sS.json`) even when its bytes are unreadable.
  return [relative(REPO_ROOT, file).split(sep).join('/'), raw, ...decoded].join('\n');
}

// SOURCEMAPS ARE NOT EVIDENCE, and excluding them is what keeps leg 1 honest.
// `vite.perf.config.ts` sets `sourcemap: true`; the production config does not, so `dist` and
// `dist-host` contain no `.map` at all. A `.map` carries `sourcesContent` — the ORIGINAL TS of
// every module — so scanning maps in the forbidden build lets a marker be "found" in a surface
// the shipped build structurally cannot have, and leg 1 would certify a marker that leg 2 could
// never match. Measured: `cat-heavy`'s only other carrier is `catalog-*.js.map`, where it is
// the source text of `oracle-catalog.ts` rather than anything emitted. Rename the creep id in
// the ruleset JSON, leave the identifier in that source file, and the old check stayed green
// forever on text no build can ship. All five markers still pass with maps excluded.
const EMITTED = (file) => !file.endsWith('.map');

/** Every marker found in `dir`, with the emitted files each was found in. */
function markersIn(dir) {
  const found = new Map();
  for (const file of filesUnder(dir).filter(EMITTED)) {
    const text = scannableText(file);
    for (const marker of MARKERS) {
      if (!text.includes(marker.text)) continue;
      const where = found.get(marker.text) ?? [];
      where.push(relative(REPO_ROOT, file).split(sep).join('/'));
      found.set(marker.text, where);
    }
  }
  return found;
}

/** The entry file each build must have produced. Its absence means the build wrote somewhere
 *  else — a changed `outDir`, a `build` script that stopped chaining `build:host` — and a
 *  scan of what is left would be a scan of nothing. */
const ENTRY = { dist: 'index.html', 'dist-host': 'index.html', 'dist-perf': 'perf/index.html' };

// AN EMPTY DIRECTORY IS NOT A CLEAN ONE. `existsSync` alone was the whole check here, so an
// empty or partial `dist` gave `filesUnder -> []`, no offenders, and the green tick — leg 1 is
// defended against vacuity and leg 2 was not. `layering.test.ts` has carried the same sanity
// since it was written (`expect(files.length).toBeGreaterThan(0)`); this is that lesson,
// arriving late. Both conditions are checked: files exist, AND the build's own entry point is
// among them, so a directory left behind by something else cannot stand in for a real build.
function requireBuilt(dir) {
  const full = join(WEB_DIR, dir);
  if (!existsSync(full)) {
    fail(`${relative(REPO_ROOT, full)} does not exist after the build above.`);
  }
  const files = filesUnder(full);
  if (files.length === 0) {
    fail(
      `${relative(REPO_ROOT, full)} is EMPTY after the build above. Scanning it would find no ` +
        'marker and report a pass, which is why this is a failure instead.',
    );
  }
  // `ENTRY` coverage is asserted in `assertMarkerTableIntact`, before either build, so by here
  // the row exists. It is a TABLE invariant, not a per-directory one, and checking it lazily put
  // the diagnosis in the wrong place: a `SHIPPED_DIRS` entry with no `ENTRY` row and no build
  // reported "does not exist after the build above", blaming the build for a table bug.
  const expected = ENTRY[dir];
  const entry = join(full, ...expected.split('/'));
  if (!existsSync(entry)) {
    fail(
      `${relative(REPO_ROOT, full)} has no ${expected} after the build above — the build ` +
        'wrote somewhere this check is not looking, so its output cannot be vouched for.',
    );
  }
  return full;
}

// A GUARD MUST NOT BE EMPTIABLE. With `MARKERS` empty both legs pass trivially and the run
// prints a green tick over zero assertions, so the table's own size is checked, and so is its
// coverage: every forbidden module must still be represented by at least one marker, or the
// module quietly stops being guarded while the check goes on looking busy.
function assertMarkerTableIntact() {
  if (MARKERS.length === 0) {
    fail('the MARKERS table is empty — this check would pass over nothing at all.');
  }
  const covered = new Set(MARKERS.map((marker) => marker.module));
  const missing = FORBIDDEN_MODULES.filter((module) => !covered.has(module));
  if (missing.length > 0) {
    fail(
      `no marker represents ${missing.join(', ')} any more. A forbidden module with no marker ` +
        'is unguarded, and this check would still report a pass.',
    );
  }
  // EVERY DIRECTORY THIS RUN WILL SCAN NEEDS AN `ENTRY` ROW, and this is a table invariant, so
  // it is asserted here — before either build — rather than lazily inside `requireBuilt`, where
  // a missing row surfaced as "does not exist after the build above" and blamed the build for a
  // bug in this file. `Object.hasOwn`, not `=== undefined`: `ENTRY['constructor']` is not
  // undefined, and a guard should not have a spelling that walks past it.
  const unlisted = [...SHIPPED_DIRS, FORBIDDEN_DIR].filter((dir) => !Object.hasOwn(ENTRY, dir));
  if (unlisted.length > 0) {
    fail(
      `no ENTRY row for ${unlisted.join(', ')} — this script cannot say what a finished build of ` +
        'those looks like, so it cannot vouch for the output it would scan. Add the row beside ' +
        'SHIPPED_DIRS.',
    );
  }
}

function check() {
  assertMarkerTableIntact();
  // --- Build both sides ----------------------------------------------------------------
  // Built here rather than trusted from a previous step, following `check:artifact-parity`
  // and `check:types-type-only`: turbo's `test` task depends only on `^typecheck`, so a check
  // that reads build output has to produce that output itself or risk reading a stale or
  // absent one. A stale `dist` was once described here as "the single way this check could
  // report a false GREEN"; an EMPTY one was a second way, and `requireBuilt` now closes it.
  run('pnpm', ['-C', WEB_DIR, 'run', 'build'], REPO_ROOT);
  run(
    'pnpm',
    ['-C', WEB_DIR, 'exec', 'vite', 'build', '--config', 'vite.perf.config.ts'],
    REPO_ROOT,
  );

  // --- Leg 1: the markers must still mark something -------------------------------------
  const forbiddenHits = markersIn(requireBuilt(FORBIDDEN_DIR));
  const vacuous = MARKERS.filter((marker) => !forbiddenHits.has(marker.text));
  if (vacuous.length > 0) {
    fail(
      `these markers were not found anywhere in apps/web/${FORBIDDEN_DIR}, the build that ` +
        'DOES reach the forbidden modules:\n\n' +
        vacuous.map((marker) => `  - ${marker.text}\n      ${marker.why}`).join('\n') +
        '\n\nA marker that matches nothing in the thing it forbids proves nothing, so this is ' +
        'a failure and not a pass. Either the artifact changed (re-choose the marker from what ' +
        'is unique in the current output) or the perf build stopped reaching that module.',
    );
  }
  console.log(
    `\ncheck:build-layering — ${String(MARKERS.length)} markers, all present in the forbidden ` +
      `build (apps/web/${FORBIDDEN_DIR}):`,
  );
  for (const marker of MARKERS) {
    const where = forbiddenHits.get(marker.text) ?? [];
    console.log(`  ${marker.text} — ${String(where.length)} emitted file(s): ${where.join(', ')}`);
  }

  // --- Leg 2: and they must be nowhere in the shipped output -----------------------------
  const offenders = [];
  for (const dir of SHIPPED_DIRS) {
    for (const [text, where] of markersIn(requireBuilt(dir))) {
      offenders.push({ text, where });
    }
  }
  if (offenders.length > 0) {
    fail(
      'a never-shipped module reached the SHIPPED web build:\n\n' +
        offenders
          .map(({ text, where }) => {
            const marker = MARKERS.find((candidate) => candidate.text === text);
            return `  ${text} — in ${where.join(', ')}\n      ${marker?.why ?? ''}`;
          })
          .join('\n') +
        '\n\nSomething under apps/web/src reaches @wynding/perf, @wynding/content/stress or ' +
        '@wynding/content/catalog. The reach may be spelled as a package specifier, a relative ' +
        'path, a re-export, a root-relative specifier or a template literal — Vite resolved it ' +
        'either way, which is why this check sees it and a source grep may not.',
    );
  }

  console.log(
    `\n✅ check:build-layering: no marker of @wynding/perf, @wynding/content/stress or ` +
      `@wynding/content/catalog appears in ${SHIPPED_DIRS.map((d) => `apps/web/${d}`).join(' or ')}.`,
  );
}

try {
  check();
} catch (error) {
  // A CheckFailure is this script's verdict; anything else is a bug in it or a broken
  // environment, and rethrowing keeps the stack rather than laundering it into a tidy
  // "layering violation" that never happened.
  if (!(error instanceof CheckFailure)) throw error;
  console.error(`\n❌ check:build-layering — FAIL\n\n${error.message}\n`);
  process.exitCode = 1;
}
