#!/usr/bin/env node
// check-determinism-version.mjs — CI guard for the determinism gate.
//
// A runtime test can pin the canonical scenario to a golden world-hash, but it
// cannot enforce that a *change* to that golden is accompanied by a SIM_VERSION
// bump — both live in the working tree and a developer can edit both. This script
// closes that gap: on a pull request it compares the golden hashes and SIM_VERSION
// between the base branch and HEAD, and fails if the golden changed while
// SIM_VERSION did not. See packages/sim/src/determinism.test.ts.
//
// Value-based, not diff-line-based: the first commit that *introduces* the golden
// (no prior value on base) is not a change and does not require a bump.

import { execSync } from 'node:child_process';

const BASE_REF = process.env.BASE_REF || 'main';
const TEST_PATH = 'packages/sim/src/determinism.test.ts';
const INDEX_PATH = 'packages/sim/src/index.ts';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Contents of `path` at `ref`, or null if it did not exist there. */
function fileAt(ref, path) {
  try {
    return sh(`git show ${ref}:${path}`);
  } catch {
    return null;
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

// Ensure the base branch is available as a local ref (CI checkouts are often
// shallow / single-ref).
let baseRef = `origin/${BASE_REF}`;
try {
  sh(`git rev-parse --verify --quiet ${baseRef}`);
} catch {
  try {
    sh(`git fetch --no-tags --depth=1 origin ${BASE_REF}:refs/remotes/origin/${BASE_REF}`);
  } catch {
    baseRef = BASE_REF; // fall back to a local branch of that name
  }
}

const RE_FINAL = /finalHash:\s*'([0-9a-f]+)'/;
const RE_TRACE = /traceDigest:\s*'([0-9a-f]+)'/;
const RE_VERSION = /SIM_VERSION\s*=\s*(\d+)/;

// An absent OR incomplete base golden means "no prior value" (see below). Read it
// first, because a PR that DELETES or renames the test must not be able to slip
// past the gate.
const baseGolden = parseGolden(fileAt(baseRef, TEST_PATH));
const headTest = fileAt('HEAD', TEST_PATH);

if (!headTest) {
  // Removing or renaming the gate's own test would silently disable the gate. If
  // the base branch carried a golden, that removal must be deliberate — fail here
  // so it can't happen alongside an unbumped behavior change.
  if (baseGolden) {
    fail(
      `${TEST_PATH} carried the determinism golden on ${baseRef} but is missing on HEAD.\n` +
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
