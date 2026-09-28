#!/usr/bin/env node
// check-build-layering.mjs — the layering invariant decided against BUILD OUTPUT instead of
// source text (#129).
//
// THE INVARIANT. Four modules must never reach the shipped web app: `@wynding/perf` (the
// most-downstream package — AGENTS.md's Hard rules, `packages/perf/src/index.ts`'s header),
// `@wynding/content`'s `./stress` and `./catalog` subpaths — synthetic perf ceilings
// (1,000,000-hp creeps, 1,000,000 starting lives) deliberately absent from the registry — and
// the e2e survey harness, `apps/web/e2e-harness/` (#158), whose entry boots the real app with a
// FAKE survey transport that any script on the page could drive.
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
//   - Anything a forbidden module contributes that is neither a string literal, an unmangled
//     property name nor an emitted asset. A marker is evidence of reach, not a proof of its
//     absence: minification renames identifiers, so only string-shaped content survives to be
//     matched. For the three PACKAGE arms, the lint zones and `layering.test.ts`'s grep sit
//     upstream of this for exactly that reason — three guards, none of them claiming to be the
//     whole answer.
//
//     CONCRETELY, so the limit is not left abstract: `stress-blast` is the only marker for
//     perf MODULE code, and it lives in `layout.ts`/`scenario.ts`/`gate.ts` alone. Rollup
//     tree-shakes per module, so a shipped file importing only `percentile` pulls in
//     `stats.ts`, which carries no marker — @wynding/perf would genuinely ship and this check
//     would stay green. Spelled as a PATH (`../../../packages/perf/src/stats`) it also evades
//     the two specifier-matching guards, so all three pass. Anything claiming this check
//     catches "every spelling of a reach" is overstating it: Vite resolving the specifier is
//     necessary, not sufficient — a marker must also survive tree-shaking to be seen.
//   - The e2e survey harness has NO upstream guard. No lint zone and no grep names
//     `apps/web/e2e-harness/`, and `apps/web/tsconfig.json` compiles it in the same program as
//     `src`, so apart from the structural separation `vite.e2e.config.ts` describes, this check is
//     the harness arm's only automated defence. What it can see is narrower than "the harness":
//     every regular script file in that directory (the .js/.ts family, `.d.ts` excepted) must emit
//     a bound marker of its own (`assertMarkerTableIntact`). Other files are not asked to. The HTML
//     page runs only if a shipped build names it as an input; imported as data (`?raw`, `?url`) it
//     would ship unseen, and so would any JSON or other non-script file shipped code imported —
//     none is imported today, and data carries no behaviour, but it is a gap, not a guarantee. The
//     markers are reached from the module's top-level side effects, so any graph that imports the
//     module keeps them. A refactor that moves a marker behind a call shipped code never makes lets
//     Rollup drop it, and the module could then ship unseen — the same limit as `stats.ts` above.
//     `__wySurvey` is a PROPERTY name, which survives only because the build does not mangle
//     properties; the harness's second marker is an ordinary string literal.
//
// WHY THE MARKERS ARE VALIDATED AGAINST A FORBIDDEN BUILD. A marker check that matches
// nothing in the thing it forbids proves nothing: rename `STRESS_RULESET_ID` and this file
// would go on passing forever, having tested that a string nobody emits is not emitted. So
// every marker below must be found in its module's POSITIVE CONTROL — a build that reaches
// that module on purpose. There are two: `dist-perf`, the perf-only build, whose two entry
// points (`apps/web/perf/main-perf.ts`, `main-perf-catalog.ts`) import the three package
// modules; and `dist-e2e`, the e2e build, whose one entry (`apps/web/e2e-harness/survey.html`)
// loads the survey harness. A marker missing from its control fails the run just as loudly as
// a marker found in `dist`. Presence alone is not the whole control, though: a marker must
// also be EMITTED BY the module it is bound to, read off the control build's sourcemaps
// (`emittedBy` in the table below, #168), or a string with a second carrier keeps leg 1 green
// after the control has stopped reaching the module at all.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isWithin,
  MalformedSourcemap,
  originsOf as attributeOrigins,
} from './build-layering-attribution.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(REPO_ROOT, 'apps', 'web');

/** The shipped artifacts (ADR 0013: two builds from one source — the open-web app and the
 *  Host build). Both are production output; both must be clean. */
const SHIPPED_DIRS = ['dist', 'dist-host'];

/** The positive controls, each the output directory of its own Vite config: builds that reach
 *  forbidden modules ON PURPOSE, so every marker can be shown to match something before its
 *  absence from the shipped output is believed. */
const CONTROLS = { 'dist-perf': 'vite.perf.config.ts', 'dist-e2e': 'vite.e2e.config.ts' };

/** The modules nothing shipped may reach, each with the control that reaches it. Every one must
 *  still be represented in `MARKERS` — see `assertMarkerTableIntact`. A module is a `@wynding/*`
 *  specifier or a repo path; a path ending in '/' is a directory, and a DIRECTORY of app code (the
 *  harness, #158) is held to more than a package is: every regular script file in it must emit a
 *  bound marker of its own, so a script added there later cannot ship unwatched. */
const FORBIDDEN_MODULES = [
  { module: '@wynding/perf', control: 'dist-perf' },
  { module: '@wynding/content/stress', control: 'dist-perf' },
  { module: '@wynding/content/catalog', control: 'dist-perf' },
  { module: 'apps/web/e2e-harness/', control: 'dist-e2e' },
];

/** The control a marker is validated against: its module's. `assertMarkerTableIntact` has
 *  already required every marker's module to be in `FORBIDDEN_MODULES`, exactly once. */
const controlOf = (marker) =>
  FORBIDDEN_MODULES.find((forbidden) => forbidden.module === marker.module)?.control;

/** The forbidden modules as one phrase for a verdict: `a, b or c`. */
function forbiddenNames() {
  const names = FORBIDDEN_MODULES.map((forbidden) => forbidden.module);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

// Markers are chosen from what is provably unique to the forbidden artifacts — verified in
// both directions when this check was written: each is present in its control (asserted below
// on every run, so it stays true) and absent from `dist`/`dist-host`.
//
// `emittedBy` BINDS A MARKER TO THE MODULE THAT MUST EMIT IT (#168), and presence alone was
// not enough. Leg 1 used to ask only "is this string somewhere in `dist-perf`?", and both of
// the perf arm's markers had a second carrier: `wy:window:start` is emitted by the
// perf ENTRIES (`apps/web/perf/**`), not by `@wynding/perf`, and `stress-blast` is also a tower
// id inside the stress ruleset JSON that `@wynding/content/stress` inlines. So if both perf
// entries stopped importing `@wynding/perf`, every marker would still be found and leg 1 would
// go on certifying a positive control that no longer reached the module it controls for —
// while `module` sat in the table feeding only the coverage count. Now a marker with an
// `emittedBy` passes leg 1 only if at least one occurrence of it in its control's emitted
// JavaScript MAPS BACK, through that chunk's sourcemap, to a source file under `emittedBy`.
// `assertMarkerTableIntact` also requires every forbidden module to own at least one marker
// whose `emittedBy` lies inside that module (its package directory, for a subpath the exact
// file its `exports` entry names, for a repo path that path), so removing the `@wynding/perf`
// import from the perf entries fails leg 1: `stress-blast` then survives only in the base64
// ruleset, which maps to nothing, and `packages/perf/src/layout.ts` emits nothing.
//
// `emittedBy: null` is a marker that cannot be bound this way, and says why in `unbound`:
// `cat-heavy` lives only in the emitted ruleset ASSET, which has no sourcemap. It is still
// required to be present (leg 1) and absent (leg 2) — it simply cannot carry the binding.
const MARKERS = [
  {
    text: 'stress-40x40',
    module: '@wynding/content/stress',
    emittedBy: 'packages/content/src/stress.ts',
    why: "the stress bundle's ruleset id and board id (packages/content/src/stress.ts), which is also the `rulesetId` inside stress-40x40.json and the name that file is emitted under",
  },
  {
    text: 'catalog-40x40',
    module: '@wynding/content/catalog',
    emittedBy: 'packages/content/src/catalog.ts',
    why: "the catalog bundle's ruleset id and board id (packages/content/src/catalog.ts), likewise its own `rulesetId` and emitted asset name",
  },
  {
    text: 'stress-blast',
    module: '@wynding/perf',
    emittedBy: 'packages/perf/src/layout.ts',
    why: "a tower id that exists only in the stress bundle and in @wynding/perf's `towerIdAt` placement table (packages/perf/src/layout.ts) — the sentinel for perf MODULE CODE reaching a chunk, since a string literal survives minification where an identifier does not",
  },
  {
    text: 'cat-heavy',
    module: '@wynding/content/catalog',
    emittedBy: null,
    unbound:
      'found only in the emitted catalog ruleset asset (a .json with no sourcemap), so no emitted position can be attributed to a source module',
    why: 'a creep id unique to the catalog bundle — catches the catalog ruleset JSON reaching the shipped output as an emitted or inlined asset even when no id constant ships beside it',
  },
  {
    text: 'wy:window:start',
    module: '@wynding/perf',
    // The perf ENTRIES, not the package: the mark is a `performance.mark` call in both
    // `main-perf.ts` and `main-perf-catalog.ts`. That is exactly why it cannot be the
    // `@wynding/perf` arm's binding — `stress-blast` is.
    emittedBy: 'apps/web/perf/',
    why: "the sampling-window trace mark emitted by the perf-only browser entries (apps/web/perf/**) — the sentinel for #129's probes 4 and 5, an app-internal reach at `../perf/main-perf` or the Vite root-relative `/perf/main-perf`",
  },
  {
    text: '__wySurvey',
    module: 'apps/web/e2e-harness/',
    emittedBy: 'apps/web/e2e-harness/survey-entry.ts',
    why: "the window hook through which e2e specs drive the survey harness's fake transport (apps/web/e2e-harness/survey-entry.ts, #158) — a property name, which the build does not mangle, assigned at the module's top level, so no graph that imports the module can tree-shake it away",
  },
  {
    text: 'survey harness failed to boot',
    module: 'apps/web/e2e-harness/',
    emittedBy: 'apps/web/e2e-harness/survey-entry.ts',
    why: "the survey harness entry's boot-failure message (apps/web/e2e-harness/survey-entry.ts, #158) — an ordinary string literal, independent of the hook's name, so the harness arm does not rest on one spelling",
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

const BUILD_TIMEOUT_MS = 10 * 60_000;

function run(cmd, args, cwd) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  // A TIMEOUT, to bound each build: one Vite build takes well under a minute, while CI's job sets
  // no `timeout-minutes` and the default job cap is six hours. It signals only the direct child, so
  // a build process beneath it can outlive it; locally, make sure none is still running before
  // rerunning.
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS });
  // `error` is part of the verdict, not just the message: a child that traps the timeout's
  // SIGTERM and exits 0 returns status 0 WITH `ETIMEDOUT`, and its half-written output must not
  // be scanned as a finished build.
  if (result.status !== 0 || result.error !== undefined) {
    let how = `exit ${String(result.status)}`;
    if (result.error?.code === 'ETIMEDOUT') {
      how =
        `timed out after ${String(BUILD_TIMEOUT_MS / 60_000)} min, ` +
        `${result.signal ?? `exit ${String(result.status)}`}`;
    } else if (result.error !== undefined) {
      how = result.error.message;
    } else if (result.signal !== null) {
      how = `killed by ${result.signal}`;
    }
    fail(
      `build step failed (${how}): ${cmd} ${args.join(' ')}\n` +
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

// SOURCEMAPS ARE NOT EVIDENCE, and excluding them is what keeps leg 1 honest. The control builds
// below run with `--sourcemap`; the production build does not, so `dist` and `dist-host` contain no
// `.map` at all. A `.map` carries `sourcesContent` — the ORIGINAL TS of every module — so scanning
// maps in a control build lets a marker be "found" in a surface the shipped build structurally
// cannot have, and leg 1 would certify a marker that leg 2 could never match. Measured:
// `cat-heavy`'s only other carrier is `catalog-*.js.map`, where it is the source text of
// `oracle-catalog.ts` rather than anything emitted. Rename the creep id in the ruleset JSON, leave
// the identifier in that source file, and the old check stayed green forever on text no build can
// ship. All seven markers still pass with maps excluded. (The `emittedBy` binding below does open
// the control builds' maps, but only to ATTRIBUTE an occurrence already found in emitted code — it
// reads `mappings` and `sources`, never `sourcesContent`, so a map still cannot make a marker count
// as present.)
const EMITTED = (file) => !file.endsWith('.map');

/** Every one of `markers` found in `dir`, with the emitted files each was found in. */
function markersIn(dir, markers) {
  const found = new Map();
  for (const file of filesUnder(dir).filter(EMITTED)) {
    const text = scannableText(file);
    for (const marker of markers) {
      if (!text.includes(marker.text)) continue;
      const where = found.get(marker.text) ?? [];
      where.push(relative(REPO_ROOT, file).split(sep).join('/'));
      found.set(marker.text, where);
    }
  }
  return found;
}

// --- Sourcemap attribution (leg 1's `emittedBy` binding) ---------------------------------
// The reader lives in `build-layering-attribution.mjs` so it can be unit-tested without the check's
// Vite builds. It decodes each chunk as UTF-8, NOT through `readAll`'s latin1: a sourcemap's
// generated column is a UTF-16 code-unit offset, and a latin1 index is a BYTE offset, so any
// non-ASCII character before a marker on a minified line would shift it onto another source's
// segment. (`scannableText` keeps latin1 — presence scanning needs every byte, not positions.)
function originsOf(file, text) {
  try {
    return attributeOrigins(file, text, REPO_ROOT);
  } catch (error) {
    if (error instanceof MalformedSourcemap) fail(error.message);
    throw error;
  }
}

/** Where a forbidden module LIVES in the repo, derived from its package's `exports` map so the
 *  binding below cannot name a file the package does not actually export. A bare package name
 *  owns its whole package directory (its code is spread across many files, and tree-shaking
 *  decides which ship); a subpath owns exactly the file its `exports` entry points at. A repo
 *  path (the e2e harness, which no package exports) is its own home, and must exist as what it
 *  claims to be: a trailing '/' is a directory, anything else a file. */
function moduleHome(specifier) {
  if (!specifier.startsWith('@')) {
    const full = join(REPO_ROOT, ...specifier.split('/'));
    if (!existsSync(full)) {
      fail(
        `${specifier} is in FORBIDDEN_MODULES but no such path exists in the repo — the table ` +
          'names a module that does not exist.',
      );
    }
    // `isWithin` reads a trailing '/' as "directory", so a directory spelled without one would
    // own only a file of that exact name — nothing — and surface as a baffling "no marker bound
    // to its own source". Say what is actually wrong instead.
    if (statSync(full).isDirectory() !== specifier.endsWith('/')) {
      fail(
        `${specifier} is in FORBIDDEN_MODULES but is a ` +
          `${specifier.endsWith('/') ? 'file spelled as a directory' : 'directory spelled without its trailing /'}` +
          ' — a directory module must end in /, a file module must not.',
      );
    }
    return specifier;
  }
  const [scope, name, ...rest] = specifier.split('/');
  if (scope !== '@wynding' || name === undefined || name === '') {
    fail(
      `cannot place ${specifier}: FORBIDDEN_MODULES may name only @wynding/* packages and repo ` +
        'paths.',
    );
  }
  // Placed by convention at `packages/<name>/`, and the convention is VERIFIED: the manifest
  // there must exist and declare this very name, so an app (`@wynding/web` lives under `apps/`)
  // or a renamed package cannot be placed at a directory that is not it.
  const packageDir = `packages/${name}`;
  const manifestPath = join(REPO_ROOT, packageDir, 'package.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  if (manifest.name !== `@wynding/${name}`) {
    fail(
      `${specifier} is in FORBIDDEN_MODULES but ${packageDir}/package.json does not declare ` +
        `@wynding/${name}. A @wynding/* module must be a package under packages/; name app code ` +
        'by its repo path.',
    );
  }
  if (rest.length === 0) return `${packageDir}/`;
  const target = manifest.exports?.[`./${rest.join('/')}`];
  if (typeof target !== 'string') {
    fail(
      `${specifier} is in FORBIDDEN_MODULES but ${packageDir}/package.json exports no ` +
        `'./${rest.join('/')}' string entry — the table names a module that does not exist.`,
    );
  }
  return `${packageDir}/${target.replace(/^\.\//, '')}`;
}

/** The entry file each build must have produced. Its absence means the build wrote somewhere
 *  else — a changed `outDir`, a `build` script that stopped chaining `build:host` — and a
 *  scan of what is left would be a scan of nothing. */
const ENTRY = {
  dist: 'index.html',
  'dist-host': 'index.html',
  'dist-perf': 'perf/index.html',
  'dist-e2e': 'e2e-harness/survey.html',
};

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
  // `ENTRY` coverage is asserted in `assertMarkerTableIntact`, before any build, so by here
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
  const scanned = [...SHIPPED_DIRS, ...Object.keys(CONTROLS)];
  // `check()` DELETES every directory it scans before building, so each must be a BUILD-OUTPUT
  // name — `dist` or `dist-<name>`, the shape of all four web outputs (`dist`, `dist-host`,
  // `dist-perf`, `dist-e2e`) — never a path out of apps/web and never one of its source
  // directories: a table slip naming `src` or `e2e-harness` would otherwise erase that
  // directory, uncommitted work included, before any build could fail. Judged FIRST, so such a
  // slip is reported as itself rather than as whichever table rule it also breaks.
  const unsafe = scanned.filter((dir) => !/^dist(?:-[a-z0-9]+)*$/.test(dir));
  if (unsafe.length > 0) {
    fail(
      `${unsafe.join(', ')} is not a build-output directory name (dist or dist-<name>). This ` +
        'script deletes each scanned directory under apps/web before rebuilding it, so it ' +
        'refuses any other name.',
    );
  }
  if (MARKERS.length === 0) {
    fail('the MARKERS table is empty — this check would pass over nothing at all.');
  }
  if (SHIPPED_DIRS.length === 0) {
    fail('SHIPPED_DIRS is empty — leg 2 would scan nothing and report a pass.');
  }
  // THE MODULE TABLE IS WELL-FORMED BEFORE ANYTHING READS IT: one row per module, each naming a
  // control this run builds. Checked before any rule that reads FORBIDDEN_MODULES, so a malformed
  // row is reported as itself rather than as a symptom somewhere later, and a duplicate row cannot
  // name a second control that `controlOf` would never consult.
  const malformed = FORBIDDEN_MODULES.filter(
    ({ module, control }) =>
      typeof module !== 'string' ||
      module === '' ||
      typeof control !== 'string' ||
      !Object.hasOwn(CONTROLS, control),
  );
  if (malformed.length > 0) {
    fail(
      `FORBIDDEN_MODULES row(s) ${malformed.map((row) => JSON.stringify(row)).join(', ')} need a ` +
        '`module` and a `control` that CONTROLS builds. Add the CONTROLS row (its output ' +
        'directory and Vite config) or correct the control.',
    );
  }
  const modules = FORBIDDEN_MODULES.map(({ module }) => module);
  const duplicated = modules.filter((module, index) => modules.indexOf(module) !== index);
  if (duplicated.length > 0) {
    fail(
      `FORBIDDEN_MODULES lists ${[...new Set(duplicated)].join(', ')} more than once — only the ` +
        'first row would ever be consulted. Keep one row per module.',
    );
  }
  // A CONTROL IS NEVER A SHIPPED BUILD, and always reaches something. A control that is also a
  // shipped directory would put `--sourcemap` maps into the output leg 2 vouches for; a control
  // no module names is built, scanned for zero markers and then listed as validated.
  const overlapping = Object.keys(CONTROLS).filter((dir) => SHIPPED_DIRS.includes(dir));
  if (overlapping.length > 0) {
    fail(
      `${overlapping.join(', ')} is both a shipped directory and a positive control. A control ` +
        'reaches the forbidden modules on purpose; the shipped output must not.',
    );
  }
  const idle = Object.keys(CONTROLS).filter(
    (dir) => !FORBIDDEN_MODULES.some(({ control }) => control === dir),
  );
  if (idle.length > 0) {
    fail(
      `CONTROLS builds ${idle.join(', ')} but no FORBIDDEN_MODULES row names it, so it would be ` +
        'reported as a positive control having validated nothing. Remove it or give it a module.',
    );
  }
  const covered = new Set(MARKERS.map((marker) => marker.module));
  const missing = modules.filter((module) => !covered.has(module));
  if (missing.length > 0) {
    fail(
      `no marker represents ${missing.join(', ')} any more. A forbidden module with no marker ` +
        'is unguarded, and this check would still report a pass.',
    );
  }
  // EVERY MARKER HAS A CONTROL TO BE VALIDATED AGAINST. A marker guarding a module outside
  // `FORBIDDEN_MODULES` would otherwise have nowhere for leg 1 to look — and a marker leg 1
  // never looks for is exactly the unvalidated string this check exists to refuse.
  const homeless = MARKERS.filter((marker) => !modules.includes(marker.module));
  if (homeless.length > 0) {
    fail(
      `marker(s) ${homeless.map((marker) => `${marker.text} (guarding ${marker.module})`).join(', ')} ` +
        'name a module that is not in FORBIDDEN_MODULES, so no positive control reaches it. Add ' +
        'the module, with the control that reaches it, or correct the marker.',
    );
  }
  // EVERY BINDING IS DECLARED, AND EVERY FORBIDDEN MODULE OWNS ONE (#168). A marker must either
  // name the source that emits it or say why it cannot, so a new row cannot silently opt out of
  // the binding by omission. And coverage is counted over BOUND markers inside each module's own
  // home: a module represented only by markers another module emits (the perf arm, before this)
  // is one whose positive control can go vacuous with every string still present.
  const undeclared = MARKERS.filter(
    (marker) =>
      !(typeof marker.emittedBy === 'string' && marker.emittedBy !== '') &&
      !(marker.emittedBy === null && typeof marker.unbound === 'string'),
  );
  if (undeclared.length > 0) {
    fail(
      `marker(s) ${undeclared.map((marker) => marker.text).join(', ')} declare neither an ` +
        '`emittedBy` source nor `emittedBy: null` with an `unbound` reason. Bind each marker to ' +
        'the module that must emit it, or say why it cannot be bound.',
    );
  }
  const unowned = modules.filter((module) => {
    const home = moduleHome(module);
    return !MARKERS.some(
      (marker) =>
        marker.module === module &&
        typeof marker.emittedBy === 'string' &&
        isWithin(marker.emittedBy, home),
    );
  });
  if (unowned.length > 0) {
    fail(
      `${unowned.join(', ')} has no marker bound to its own source (${unowned.map(moduleHome).join(', ')}). ` +
        "Leg 1 would then prove only that SOMETHING emits that module's markers, which is how " +
        'the perf arm went vacuous-capable (#168). Give it a marker whose `emittedBy` lies inside it.',
    );
  }
  // A DIRECTORY OF APP CODE IS GUARDED FILE BY FILE. A package arm accepts that tree-shaking can
  // ship a marker-less file (`stats.ts`, in the header); the harness is small and every file in
  // it exists to fake something, so each script module under a forbidden repo-path directory
  // must emit a bound marker of its own. A transport split out of the entry later then fails
  // here until it has one, instead of shipping unwatched on a directory the table calls covered.
  // Only regular script files are asked: a declaration file emits nothing, and a page or a JSON
  // file carries no sourcemap position a binding could read. A page runs only if a shipped build
  // names it as an input; imported as data (`?raw`, `?url`), it would ship unseen, like any JSON
  // file shipped code imported (the header's harness bullet says so).
  const unmarked = modules
    .filter((module) => !module.startsWith('@') && module.endsWith('/'))
    .flatMap((module) =>
      filesUnder(join(REPO_ROOT, ...module.split('/')))
        .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
        .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file))
        .filter(
          (file) =>
            !MARKERS.some((marker) => marker.module === module && marker.emittedBy === file),
        ),
    );
  if (unmarked.length > 0) {
    fail(
      `${unmarked.join(', ')} ${unmarked.length === 1 ? 'is a module' : 'are modules'} of a ` +
        'forbidden app directory with no marker bound to it, so it could reach the shipped ' +
        'build unseen. Add a MARKERS row whose `emittedBy` is the file: a string unique to it, ' +
        "reached from the module's top-level side effects. A file that emits no code (types " +
        'only) belongs in a .d.ts, which is exempt; a file the harness page never loads cannot ' +
        'be found in its control and does not belong in the directory.',
    );
  }
  // EVERY DIRECTORY THIS RUN WILL SCAN NEEDS AN `ENTRY` ROW, and this is a table invariant, so
  // it is asserted here — before any build — rather than lazily inside `requireBuilt`, where
  // a missing row surfaced as "does not exist after the build above" and blamed the build for a
  // bug in this file. `Object.hasOwn`, not `=== undefined`: `ENTRY['constructor']` is not
  // undefined, and a guard should not have a spelling that walks past it.
  const unlisted = scanned.filter((dir) => !Object.hasOwn(ENTRY, dir));
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
  // --- Build every side -----------------------------------------------------------------
  // Built here rather than trusted from a previous step, following `check:artifact-parity`
  // and `check:types-type-only`: turbo's `test` task depends only on `^typecheck`, so a check
  // that reads build output has to produce that output itself or risk reading a stale or
  // absent one. A stale `dist` was once described here as "the single way this check could
  // report a false GREEN"; an EMPTY one was a second way, and `requireBuilt` now closes it.
  // (In CI the e2e job's Playwright servers have already built `dist-e2e`; it is rebuilt here
  // anyway, for the same reason and because leg 1's binding needs maps that build omits.)
  //
  // Every directory is DELETED first. Building alone did not make the output fresh: a build
  // whose outDir had moved wrote elsewhere, and `requireBuilt` then vouched for whatever an
  // earlier run had left behind — entry file, maps and all. With the directory gone, drift
  // between these tables and a config's outDir fails as "does not exist after the build above".
  //
  // Every control is built with `--sourcemap` whatever its config says: leg 1's binding reads
  // the maps, so the check supplies the flag it depends on rather than trusting each config to
  // keep it. The flag reaches only the control builds — never `dist` or `dist-host`, which
  // `assertMarkerTableIntact` forbids CONTROLS to name.
  for (const dir of [...SHIPPED_DIRS, ...Object.keys(CONTROLS)]) {
    rmSync(join(WEB_DIR, dir), { recursive: true, force: true });
  }
  run('pnpm', ['-C', WEB_DIR, 'run', 'build'], REPO_ROOT);
  for (const config of Object.values(CONTROLS)) {
    run(
      'pnpm',
      ['-C', WEB_DIR, 'exec', 'vite', 'build', '--config', config, '--sourcemap'],
      REPO_ROOT,
    );
  }

  // --- Leg 1: the markers must still mark something -------------------------------------
  // Each marker is looked for in ITS module's control only — the perf markers have no business
  // in the harness build, nor `__wySurvey` in the perf one. Hits are keyed by marker, not by
  // text, so two controls can never overwrite each other's findings.
  const controlHits = new Map();
  for (const dir of Object.keys(CONTROLS)) {
    const own = MARKERS.filter((marker) => controlOf(marker) === dir);
    const found = markersIn(requireBuilt(dir), own);
    for (const marker of own) controlHits.set(marker, found.get(marker.text) ?? []);
  }
  const vacuous = MARKERS.filter((marker) => controlHits.get(marker).length === 0);
  if (vacuous.length > 0) {
    fail(
      'these markers were not found anywhere in their positive control, the build that DOES ' +
        'reach the module they guard:\n\n' +
        vacuous
          .map(
            (marker) =>
              `  - ${marker.text} (guarding ${marker.module}, control apps/web/${controlOf(marker)})\n` +
              `      ${marker.why}`,
          )
          .join('\n') +
        '\n\nA marker that matches nothing in the thing it forbids proves nothing, so this is ' +
        'a failure and not a pass. Either the artifact changed (re-choose the marker from what ' +
        'is unique in the current output) or the control build stopped reaching that module.',
    );
  }
  // --- Leg 1, bound: and each must be emitted by the module it is bound to (#168) ----------
  // Presence above proves a string is in the control build; this proves WHO put it there.
  // Only emitted JavaScript can be attributed (assets carry no sourcemap), so a bound marker
  // needs at least one occurrence in a `.js` chunk whose sourcemap maps it under `emittedBy`.
  const bindings = new Map();
  const misbound = [];
  for (const marker of MARKERS.filter((candidate) => candidate.emittedBy !== null)) {
    const origins = [];
    const unmapped = [];
    for (const where of controlHits.get(marker)) {
      if (!where.endsWith('.js')) continue;
      const found = originsOf(join(REPO_ROOT, ...where.split('/')), marker.text);
      if (found === null) unmapped.push(where);
      else origins.push(...found.map((origin) => origin ?? '(no source)'));
    }
    // A directory binding (trailing '/') owns everything under it; a file binding is exact,
    // so `stress.ts` does not also claim `stress.tsx` — the same `isWithin` the table
    // invariant uses, so the two ownership sites cannot disagree.
    const bound = origins.filter((origin) => isWithin(origin, marker.emittedBy));
    if (bound.length > 0) bindings.set(marker, [...new Set(bound)]);
    else misbound.push({ marker, origins: [...new Set(origins)], unmapped });
  }
  if (misbound.length > 0) {
    fail(
      'these markers are present in their positive control but NOT emitted by the module ' +
        'they are bound to:\n\n' +
        misbound
          .map(
            ({ marker, origins, unmapped }) =>
              `  - ${marker.text} (bound to ${marker.emittedBy}, guarding ${marker.module}, ` +
              `control apps/web/${controlOf(marker)})\n` +
              `      emitted by: ${origins.length > 0 ? origins.join(', ') : 'no attributable JS occurrence'}` +
              (unmapped.length > 0 ? `\n      no sourcemap for: ${unmapped.join(', ')}` : ''),
          )
          .join('\n') +
        '\n\nThe string survives from some OTHER carrier, so this positive control no longer ' +
        'proves its build reaches the module it guards — most likely an entry of that ' +
        "control's Vite config (see CONTROLS) stopped importing it. Restore the import, or " +
        're-bind the marker to the module that genuinely emits it now. (If "no sourcemap" is ' +
        'listed, the chunk was emitted without the map the `--sourcemap` build above should ' +
        'have written beside it, and the binding cannot read one.)',
    );
  }
  console.log(
    `\ncheck:build-layering — ${String(MARKERS.length)} markers, all present in their ` +
      `positive control (${Object.keys(CONTROLS)
        .map((dir) => `apps/web/${dir}`)
        .join(', ')}):`,
  );
  for (const marker of MARKERS) {
    const where = controlHits.get(marker);
    const binding =
      marker.emittedBy === null
        ? `unbound (${marker.unbound})`
        : `emitted by ${(bindings.get(marker) ?? []).join(', ')}`;
    console.log(
      `  ${marker.text} — ${String(where.length)} emitted file(s): ${where.join(', ')}\n` +
        `      ${binding}`,
    );
  }

  // --- Leg 2: and they must be nowhere in the shipped output -----------------------------
  const offenders = [];
  for (const dir of SHIPPED_DIRS) {
    for (const [text, where] of markersIn(requireBuilt(dir), MARKERS)) {
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
        `\n\nSomething in the shipped build's graph (apps/web/src, index.html, or an input ` +
        `added to vite.config.ts) reaches ${forbiddenNames()}. ` +
        'The reach may be spelled as a package specifier, a relative ' +
        'path, a re-export, a root-relative specifier or a template literal — Vite resolved it ' +
        'either way, which is why this check sees it and a source grep may not.',
    );
  }

  console.log(
    `\n✅ check:build-layering: no marker of ${forbiddenNames()} appears in ` +
      `${SHIPPED_DIRS.map((d) => `apps/web/${d}`).join(' or ')}.`,
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
