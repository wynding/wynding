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

const baseTest = fileAt(baseRef, TEST_PATH);
const headTest = fileAt('HEAD', TEST_PATH);

if (!headTest) {
  console.log(`✓ ${TEST_PATH} not present on HEAD — nothing to check.`);
  process.exit(0);
}

const baseGolden = baseTest && `${match(baseTest, RE_FINAL)}:${match(baseTest, RE_TRACE)}`;
const headGolden = `${match(headTest, RE_FINAL)}:${match(headTest, RE_TRACE)}`;

if (!baseGolden) {
  console.log('✓ Determinism golden is newly introduced (no prior value) — no bump required.');
  process.exit(0);
}

if (baseGolden === headGolden) {
  console.log('✓ Determinism golden unchanged.');
  process.exit(0);
}

const baseVersion = match(fileAt(baseRef, INDEX_PATH), RE_VERSION);
const headVersion = match(fileAt('HEAD', INDEX_PATH), RE_VERSION);

if (baseVersion === headVersion) {
  console.error(
    '❌ Determinism golden changed but SIM_VERSION did not.\n\n' +
      `   golden  ${baseGolden}  →  ${headGolden}\n` +
      `   SIM_VERSION stayed at ${headVersion}\n\n` +
      'A change to finalHash/traceDigest is a determinism-affecting behavior change.\n' +
      'Bump SIM_VERSION in packages/sim/src/index.ts in this PR (and note why).',
  );
  process.exit(1);
}

console.log(
  `✓ Determinism golden changed and SIM_VERSION was bumped (${baseVersion} → ${headVersion}).`,
);
process.exit(0);
