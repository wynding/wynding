#!/usr/bin/env node
// check-determinism-version.mjs — CI guard for the determinism gate.
//
// A runtime test can pin the canonical scenario to a golden world-hash, but it
// cannot enforce that a *change* to that golden is accompanied by a SIM_VERSION
// bump — both live in the working tree and a developer can edit both. This script
// closes that gap: on a pull request it compares the golden hashes and SIM_VERSION
// between the base commit and HEAD, and fails when a golden changed, SIM_VERSION did
// not, AND the diff touches a non-test file that decides the golden (see TEST_PATHS
// and `isDeterminismSourcePath` below for the exact trigger — this comment is not it).
//
// The golden VALUES are read by value, not by diff line: the first commit that
// *introduces* a golden (no prior value on base) is not a change and needs no bump.
// Which FILES changed is necessarily diff-based, and that half fails closed.
//
// All git calls are argv-based (execFileSync, no shell), so a ref can never be
// interpolated into a command string.

import { execFileSync } from 'node:child_process';

// Prefer the pull request event's EXACT base commit (immune to `main` advancing
// after the event but before this job runs); fall back to a branch tip locally.
const BASE_SHA = process.env.BASE_SHA;
const BASE_REF = process.env.BASE_REF || 'main';
// Every file carrying a keyed `GOLDEN = { finalHash, traceDigest }` object — both parse
// with the same two regexes below, so the second costs no new parsing.
// `m2-golden.test.ts` is the M2 close-out golden over the finished ten-wave arc against
// the SHIPPED bundle, where `determinism.test.ts` runs a deliberately narrow synthetic
// one (no stun, no AoE, no burst, no support, no air, no armor) — so the widest
// behavioural pin in the repo was the one this guard did not watch.
//
// The three `story-*.test.ts` files listed in #107 stay out, and that one IS a parser
// limit rather than a preference: they pin hashes as bare inline
// `expect(hashSimState(state)).toBe('hex')` assertions, several per file, with nothing
// distinguishing one from another or from any other `toBe` call. A regex loose enough to
// find them would mis-parse, and a guard that mis-parses is worse than one that is narrow.
const TEST_PATHS = [
  'packages/sim/src/determinism.test.ts',
  'packages/content/src/m2-golden.test.ts',
];
// SIM_VERSION's home moved with M2-S2's single-sourcing (PLAN step 1): it now
// lives on the dependency-free leaf `ruleset-shared.ts`, re-exported from
// `index.ts` for the public API. A candidate list — not a single path — lets this
// guard read EITHER commit correctly across the very PR that moves it: per
// revision, the first candidate whose content matches RE_VERSION wins, so the base
// commit (pre-move) still reads 5 from `index.ts` while HEAD (post-move) reads 6
// from `ruleset-shared.ts`, with no special-casing of the migration commit itself.
const VERSION_PATH_CANDIDATES = ['packages/sim/src/ruleset-shared.ts', 'packages/sim/src/index.ts'];

const RE_FINAL = /finalHash:\s*'([0-9a-f]+)'/;
const RE_TRACE = /traceDigest:\s*'([0-9a-f]+)'/;
const RE_VERSION = /SIM_VERSION\s*=\s*(\d+)/;

/** Run git with argv (no shell). Returns stdout; throws on a non-zero exit. */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Contents of `path` at `ref`, or null if it did not exist there. */
function fileAt(ref, path) {
  try {
    return git(['show', `${ref}:${path}`]);
  } catch {
    return null; // path absent at that ref
  }
}

function match(content, re) {
  const m = content && content.match(re);
  return m ? m[1] : null;
}

/** The golden identity as `finalHash:traceDigest`, or null if EITHER field is absent. */
function parseGolden(content) {
  const final = match(content, RE_FINAL);
  const trace = match(content, RE_TRACE);
  return final && trace ? `${final}:${trace}` : null;
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

if (BASE_SHA && !/^[0-9a-f]{7,64}$/i.test(BASE_SHA)) {
  fail(`BASE_SHA is not a valid git object id: ${JSON.stringify(BASE_SHA)}`);
}

// Resolve the base commit, ensuring it's available locally (CI checkouts are
// often shallow / single-ref).
let baseRef;
if (BASE_SHA) {
  baseRef = BASE_SHA;
  try {
    git(['cat-file', '-e', `${BASE_SHA}^{commit}`]);
  } catch {
    try {
      git(['fetch', '--no-tags', '--depth=1', 'origin', BASE_SHA]);
    } catch {
      // best effort — the resolvability check below fails loudly if still unreachable
    }
  }
} else {
  baseRef = `origin/${BASE_REF}`;
  try {
    git(['rev-parse', '--verify', '--quiet', baseRef]);
  } catch {
    try {
      git([
        'fetch',
        '--no-tags',
        '--depth=1',
        'origin',
        `${BASE_REF}:refs/remotes/origin/${BASE_REF}`,
      ]);
    } catch {
      baseRef = BASE_REF; // fall back to a local branch of that name
    }
  }
}

// FAIL CLOSED if the base still doesn't resolve to a real commit. `fileAt` returns
// null for BOTH "the path didn't exist at this ref" and "this ref doesn't exist at
// all" — collapsing those is fine once we know the ref itself is good, but if we
// skipped this check a shallow or unreachable base would read as "the golden is
// newly introduced" below and exit 0, which is exactly the fail-OPEN posture
// `ci.yml`'s perf R0 alarm forbids ("it FAILS CLOSED… Do not revert this to a
// grep"). Checking this ONCE here, before any `fileAt(baseRef, …)` call, is what
// lets every null those calls return further down be trusted as "genuinely absent
// at a resolvable base" rather than "we don't know."
try {
  git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
} catch {
  fail(
    `Could not resolve the base ref to a commit (tried ${JSON.stringify(baseRef)}, from ` +
      `${BASE_SHA ? `BASE_SHA=${JSON.stringify(BASE_SHA)}` : `BASE_REF=${JSON.stringify(BASE_REF)}`}), ` +
      'even after a shallow fetch attempt.\n' +
      '   An unresolvable base is NOT the same as "the golden is newly introduced" — the\n' +
      '   guard cannot tell whether the golden moved without a readable base, so it fails\n' +
      '   here rather than silently pass (same posture as the perf R0 alarm in ci.yml).',
  );
}

// An absent OR incomplete base golden means "no prior value" (see below). Read it
// first, because a PR that DELETES or renames the test must not slip past the gate.
/** Per watched file: its golden identity on base and HEAD, plus HEAD's raw text. */
const watched = TEST_PATHS.map((path) => ({
  path,
  baseGolden: parseGolden(fileAt(baseRef, path)),
  headTest: fileAt('HEAD', path),
}));

// Each watched file is checked on its own terms; the results fold together below. A file
// present on neither side is simply not this repo's concern yet.
const moved = [];
for (const { path, baseGolden, headTest } of watched) {
  if (!headTest) {
    // Removing or renaming a watched test would silently disable that half of the gate.
    // If the base carried a golden, the removal must be deliberate — fail here so it
    // cannot happen alongside an unbumped behavior change.
    if (baseGolden) {
      fail(
        `${path} carried a determinism golden on the base but is missing on HEAD.\n` +
          '   Removing or renaming it silently disables that half of the determinism gate.\n' +
          '   If that is intentional, drop it from TEST_PATHS too; otherwise restore it.',
      );
    }
    continue; // absent on both sides — nothing to check for this one
  }

  // The gate cannot do its job if it cannot read HEAD's golden — fail loudly rather
  // than silently pass.
  const headGolden = parseGolden(headTest);
  if (!headGolden) {
    fail(
      `Could not parse the golden (finalHash + traceDigest) from ${path} on HEAD.\n` +
        '   The determinism guard cannot verify this PR — check the golden format.',
    );
  }

  // Parsing the literals only proves they exist. Require the golden fields to be
  // referenced — a lightweight tripwire against deleting the assertions while leaving the
  // GOLDEN object. Deliberately a substring check, not an AST parse: the runtime test is
  // the real assertion.
  if (!headTest.includes('GOLDEN.finalHash') || !headTest.includes('GOLDEN.traceDigest')) {
    fail(
      `${path} defines a golden but no longer references it — GOLDEN.finalHash /\n` +
        '   GOLDEN.traceDigest are gone. The runtime determinism check is disabled;\n' +
        '   restore the golden assertions.',
    );
  }

  // An absent or incomplete base golden means this golden is being introduced, which
  // needs no version bump.
  if (baseGolden && baseGolden !== headGolden) moved.push(path);
}

if (moved.length === 0) {
  console.log('✓ Determinism goldens unchanged (or newly introduced) — no bump required.');
  process.exit(0);
}

// The golden changed. Requiring a bump for EVERY such change was checked against
// #107's rejected exemption from the other direction first: "…or rulesets/*.json
// changed" looked like the fix, but every recent sim-behavior commit ALSO touches
// `wynding-core.json` in the same diff, so that exemption would be open on
// essentially every substantive PR — a false-negative rate near 100% for the class
// it exists to catch. The axis that actually holds is the inverse: only require
// the bump when the golden move is accompanied by a change to the sim's OWN
// source, not a coincidental ruleset or content-only edit. `*.test.ts` is excluded
// — a test-only edit can't move runtime behavior — but `test-support.ts` is
// DELIBERATELY NOT exempted: it builds the canonical scenario's bundle
// (`extraTowers`/`extraCreeps`/`testBundle`) that `determinism.test.ts` runs, so a
// change there can move the golden exactly like a change to `index.ts` can.
//
// Known residual (stated, not silently accepted): a golden hand-edited alone,
// with no accompanying packages/sim/src/ change, still reads as "no bump
// required" below. Closing that would mean treating EVERY golden edit as
// suspicious regardless of cause, which is the fail-open-vs-fail-noisy trade this
// axis was chosen to avoid — see #107.
// BOTH packages, and `engine` is not an afterthought — it is where the two most
// determinism-critical files in the repo live. The golden IS `hashSimState`, which
// bottoms out in `packages/engine/src/hash.ts`'s `fnv1a`, and every draw the sim makes
// comes from `packages/engine/src/rng.ts`, whose own header calls itself normative for
// byte-identity. Scoped to `packages/sim/src/` alone, a rewritten `nextInt` mapping could
// re-pin both golden values with no bump and pass clean — measured during review, before
// this said `engine`. That would have made this "hardening" strictly WEAKER than the rule
// it replaces, which caught every golden edit whatever its cause. Neither package carries
// a version of its own, so SIM_VERSION is the only thing a stored replay binds to for
// either.
function isDeterminismSourcePath(path) {
  if (path.endsWith('.test.ts')) return false;
  return path.startsWith('packages/sim/src/') || path.startsWith('packages/engine/src/');
}

function changedPaths(base, head) {
  try {
    // TWO-DOT, not three. `base...head` needs a merge base, and this script's own
    // recovery path (the shallow `git fetch --depth=1` above) lands the base commit with
    // NO ancestry — so on exactly the runs that fetch exists to rescue, a three-dot diff
    // dies with "no merge base" and reds a correct PR that no author action can fix.
    // Measured during review on both a depth-1 clone and a force-pushed base. Two-dot
    // compares the trees directly and needs no ancestry; where the two differ, the
    // superset two-dot reports is the safe direction for a guard.
    //
    // `-z` because git quotes non-ASCII paths by default (leading quote included), which
    // would slip such a file past the prefix test above.
    return git(['diff', '--name-only', '-z', base, head]).split('\0').filter(Boolean);
  } catch (e) {
    fail(
      `Could not diff ${base}..${head} to find changed files — the determinism-source\n` +
        `   trigger can't be evaluated. ${e && e.message ? e.message : e}`,
    );
    return []; // unreachable — fail() exits; explicit for readers, not a real fallback
  }
}

const determinismSourceChanged = changedPaths(baseRef, 'HEAD').some(isDeterminismSourcePath);

if (!determinismSourceChanged) {
  console.log(
    '✓ Determinism golden changed, but no non-test file under packages/sim/src/ or\n' +
      '   packages/engine/src/ changed in this diff — nothing that decides the golden\n' +
      '   moved, so no SIM_VERSION bump is required.',
  );
  process.exit(0);
}

// The golden changed AND the sim's own source changed: SIM_VERSION must be
// readable on both sides and STRICTLY INCREASE (a decrement or reuse is not a
// bump, and replays key on the version).
// Per revision, try each candidate path in order and use the first that matches —
// so a revision where SIM_VERSION still lives at the old path (base) and one where
// it has moved to the new leaf (HEAD) are both read correctly, with no special
// case for the migration commit itself.
function versionAt(ref) {
  for (const path of VERSION_PATH_CANDIDATES) {
    const raw = match(fileAt(ref, path), RE_VERSION);
    if (raw !== null) return { raw, path };
  }
  return { raw: null, path: null };
}

const base = versionAt(baseRef);
const head = versionAt('HEAD');

if (base.raw === null || head.raw === null) {
  fail(
    'A determinism golden changed but SIM_VERSION could not be read as an integer ' +
      `(base=${base.raw}, head=${head.raw}) from any of: ${VERSION_PATH_CANDIDATES.join(', ')}.`,
  );
}

const baseVersion = Number(base.raw);
const headVersion = Number(head.raw);

if (headVersion <= baseVersion) {
  fail(
    'A determinism golden changed but SIM_VERSION did not increase.\n\n' +
      `   moved        ${moved.join(', ')}\n` +
      `   SIM_VERSION  ${baseVersion} (${base.path})  →  ${headVersion} (${head.path})\n\n` +
      'A change to finalHash/traceDigest is a determinism-affecting behavior change.\n' +
      'Increase SIM_VERSION in packages/sim/src/ruleset-shared.ts in this PR (and note why).',
  );
}

console.log(
  `✓ Determinism golden changed (${moved.join(', ')}) and SIM_VERSION increased ` +
    `(${baseVersion} → ${headVersion}).`,
);
process.exit(0);
