#!/usr/bin/env node
// check-determinism-version.mjs — CI guard for the determinism gate.
//
// A runtime test can pin the canonical scenario to a golden world-hash, but it
// cannot enforce that a *change* to that golden is accompanied by a SIM_VERSION
// bump — both live in the working tree and a developer can edit both. This script
// closes that gap: on a pull request it compares the golden hashes and SIM_VERSION
// between the base commit and HEAD, and fails if the golden changed while
// SIM_VERSION did not. See packages/sim/src/determinism.test.ts.
//
// Value-based, not diff-line-based: the first commit that *introduces* the golden
// (no prior value on base) is not a change and does not require a bump.
//
// All git calls are argv-based (execFileSync, no shell), so a ref can never be
// interpolated into a command string.

import { execFileSync } from 'node:child_process';

// Prefer the pull request event's EXACT base commit (immune to `main` advancing
// after the event but before this job runs); fall back to a branch tip locally.
const BASE_SHA = process.env.BASE_SHA;
const BASE_REF = process.env.BASE_REF || 'main';
const TEST_PATH = 'packages/sim/src/determinism.test.ts';
const INDEX_PATH = 'packages/sim/src/index.ts';

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
      // best effort — a later `git show` fails loudly if still unreachable
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

// An absent OR incomplete base golden means "no prior value" (see below). Read it
// first, because a PR that DELETES or renames the test must not slip past the gate.
const baseGolden = parseGolden(fileAt(baseRef, TEST_PATH));
const headTest = fileAt('HEAD', TEST_PATH);

if (!headTest) {
  // Removing or renaming the gate's own test would silently disable the gate. If
  // the base carried a golden, that removal must be deliberate — fail here so it
  // can't happen alongside an unbumped behavior change.
  if (baseGolden) {
    fail(
      `${TEST_PATH} carried the determinism golden on the base but is missing on HEAD.\n` +
        '   Removing or renaming it silently disables the determinism gate. If that is\n' +
        '   intentional, remove the determinism-version CI job too; otherwise restore it.',
    );
  }
  console.log(`✓ ${TEST_PATH} absent on both base and HEAD — nothing to check.`);
  process.exit(0);
}

// The gate can't do its job if it can't read HEAD's golden — fail loudly rather
// than silently pass.
const headGolden = parseGolden(headTest);
if (!headGolden) {
  fail(
    `Could not parse the golden (finalHash + traceDigest) from ${TEST_PATH} on HEAD.\n` +
      '   The determinism guard cannot verify this PR — check the golden format.',
  );
}

// Parsing the literals only proves they exist. Require the golden fields to be
// referenced — a lightweight tripwire against deleting the assertions while leaving
// the GOLDEN object. Deliberately a substring check, not an AST parse: this guards
// a placeholder-sim scaffold, and the runtime test is the real assertion.
if (!headTest.includes('GOLDEN.finalHash') || !headTest.includes('GOLDEN.traceDigest')) {
  fail(
    `${TEST_PATH} defines the golden but no longer references it — GOLDEN.finalHash /\n` +
      '   GOLDEN.traceDigest are gone. The runtime determinism check is disabled;\n' +
      '   restore the golden assertions.',
  );
}

// An absent or incomplete base golden means the golden is being introduced, which
// needs no version bump.
if (!baseGolden) {
  console.log('✓ Determinism golden is newly introduced (no prior value) — no bump required.');
  process.exit(0);
}

if (baseGolden === headGolden) {
  console.log('✓ Determinism golden unchanged.');
  process.exit(0);
}

// The golden changed: SIM_VERSION must be readable on both sides and STRICTLY
// INCREASE (a decrement or reuse is not a bump, and replays key on the version).
const baseVersionRaw = match(fileAt(baseRef, INDEX_PATH), RE_VERSION);
const headVersionRaw = match(fileAt('HEAD', INDEX_PATH), RE_VERSION);

if (baseVersionRaw === null || headVersionRaw === null) {
  fail(
    'Determinism golden changed but SIM_VERSION could not be read as an integer ' +
      `(base=${baseVersionRaw}, head=${headVersionRaw}) from ${INDEX_PATH}.`,
  );
}

const baseVersion = Number(baseVersionRaw);
const headVersion = Number(headVersionRaw);

if (headVersion <= baseVersion) {
  fail(
    'Determinism golden changed but SIM_VERSION did not increase.\n\n' +
      `   golden       ${baseGolden}  →  ${headGolden}\n` +
      `   SIM_VERSION  ${baseVersion}  →  ${headVersion}\n\n` +
      'A change to finalHash/traceDigest is a determinism-affecting behavior change.\n' +
      'Increase SIM_VERSION in packages/sim/src/index.ts in this PR (and note why).',
  );
}

console.log(
  `✓ Determinism golden changed and SIM_VERSION increased (${baseVersion} → ${headVersion}).`,
);
process.exit(0);
