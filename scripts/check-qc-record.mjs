#!/usr/bin/env node
// check-qc-record.mjs — the pre-push QC gate (see docs/ai-workflow.md §3.5).
//
// Refuses to push a branch unless BOTH records exist for exactly the state being pushed:
//
//  1. A `QC: <tree-sha>` trailer on the tip commit, whose hash is that commit's own tree.
//     `git write-tree` prints that hash from the staged index, so recording an honest pass
//     costs one substitution in the commit command — and the record cannot be recycled,
//     because any later edit changes the tree.
//  2. Loop evidence: `.claude/qc-evidence/<tree-sha>.json`, written as the adversarial QC
//     loop's final act, tallying its rounds, findings, and reviewers for that same tree.
//     All six fields are required (extra keys are ignored), and the tallies must balance:
//     every raised finding was fixed or declined, never dropped. The file stays local
//     (`.claude/` is gitignored — it describes a working process, not the product); the
//     PR-visible summary rides as a note on the `QC:` trailer line. A human pushing a
//     self-reviewed change records their own pass the same way:
//     `"reviewers": ["<your-name>"], "rounds": 1`.
//
// Both are attestations, not proofs — they answer "did anyone run the pass / the loop?",
// not "was it any good", and a determined author could fabricate either. Their value is
// making the steps structurally unforgettable at the push boundary: a step the hook checks
// gets done; a step nothing checks gets skipped exactly when attention is somewhere else.
//
// Emergency escape hatch for both legs: QC_OVERRIDE="<rationale>". Each overridden push is
// appended to `.claude/qc-evidence/overrides.log` (local, best-effort) so the bypass
// leaves a trace a postmortem can find.
//
// Reads git's pre-push stdin protocol: `<local-ref> <local-oid> <remote-ref> <remote-oid>`
// per ref. Deletions and pushes whose destination is the default branch are not gated.
// Stdin the gate cannot read or parse REFUSES the push — a gate that shrugs at its own
// input failure is silently disabled exactly when something is wrong.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BRANCH = 'main';
const TRAILER = 'QC';
const EVIDENCE_DIR = '.claude/qc-evidence';
const MIN_RATIONALE = 15;
const ZERO = /^0+$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let stdinError = null;
const stdin = (() => {
  if (process.stdin.isTTY) return ''; // Run by hand rather than by git — nothing to gate.
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    stdinError = err;
    return '';
  }
})();

if (stdinError) {
  console.error('❌ QC gate: could not read the ref list git passes on stdin — refusing to');
  console.error(`   guess what is being pushed (${stdinError.message.split('\n')[0]}).`);
  console.error('   Re-run the push. Emergency only: QC_OVERRIDE="why this push cannot wait".');
  process.exit(1);
}

const rawLines = stdin
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

// A protocol line is `<local-ref> <local-oid> <remote-ref> <remote-oid>`: token count
// alone is not enough (any four words match), so the oids must look like object ids and
// the destination like a ref.
const looksLikeOid = (s) => /^[0-9a-f]{40,64}$/i.test(s);
const entries = rawLines
  .map((line) => line.split(/\s+/))
  .filter((parts) => parts.length === 4)
  .map(([localRef, localOid, remoteRef, remoteOid]) => ({
    localRef,
    localOid,
    remoteRef,
    remoteOid,
  }))
  .filter(
    ({ localOid, remoteRef, remoteOid }) =>
      looksLikeOid(localOid) && looksLikeOid(remoteOid) && remoteRef.startsWith('refs/'),
  );

// Non-empty stdin that parses to zero protocol lines is a malformed handoff from git,
// not an empty push — fail closed rather than silently gating nothing.
if (rawLines.length > 0 && entries.length === 0) {
  console.error("❌ QC gate: the pre-push input did not parse as git's ref protocol —");
  console.error(`   got ${rawLines.length} line(s), none of the form "<ref> <oid> <ref> <oid>".`);
  console.error('   Re-run the push. Emergency only: QC_OVERRIDE="why this push cannot wait".');
  process.exit(1);
}

const pushes = entries
  .filter(({ localOid }) => !ZERO.test(localOid)) // a deletion pushes no content
  // Branches only. A tag names history that already exists — it cannot be re-committed to carry
  // a record, so gating one would refuse a release push with advice that cannot be followed.
  .filter(({ remoteRef }) => remoteRef.startsWith('refs/heads/'))
  .filter(({ remoteRef }) => remoteRef !== `refs/heads/${DEFAULT_BRANCH}`);

// The evidence directory lives at the top of the working tree (each worktree has its own).
// A gate whose own failure mode is a stack trace is worse than no gate, here and below:
// whatever git cannot answer, say so as a QC failure with the way out.
const toplevel = (() => {
  try {
    return git('rev-parse', '--show-toplevel');
  } catch {
    return null;
  }
})();

const override = (process.env.QC_OVERRIDE ?? '').trim();
if (pushes.length > 0 && override.length > 0) {
  if (override.length < MIN_RATIONALE) {
    console.error(
      `❌ QC gate: QC_OVERRIDE needs a real rationale (at least ${MIN_RATIONALE} characters).`,
    );
    process.exit(1);
  }
  console.error(
    '⚠️  QC gate overridden — no QC record or loop evidence was required for this push.',
  );
  console.error(`   rationale: ${override}`);
  console.error('   Say the same thing in the PR thread; the commits carry no record of it.');
  if (toplevel !== null) {
    try {
      mkdirSync(join(toplevel, EVIDENCE_DIR), { recursive: true });
      const refs = pushes
        .map((p) => `${p.localRef.replace(/^refs\/heads\//, '')}@${p.localOid.slice(0, 8)}`)
        .join(' ');
      appendFileSync(
        join(toplevel, EVIDENCE_DIR, 'overrides.log'),
        `${new Date().toISOString()} ${refs} — ${override}\n`,
      );
      console.error(`   (logged to ${EVIDENCE_DIR}/overrides.log)`);
    } catch {
      // Logging must never block an emergency push; the printed rationale above stands.
    }
  }
  process.exit(0);
}

const readFailures = [];
const trailerFailures = [];
const loopFailures = [];
for (const { localRef, localOid } of pushes) {
  const branch = localRef.replace(/^refs\/heads\//, '');
  let tree, message;
  try {
    tree = git('rev-parse', `${localOid}^{tree}`);
    message = git('show', '-s', '--format=%B', localOid);
  } catch (err) {
    readFailures.push(
      `${branch}: could not read ${localOid.slice(0, 8)} — ${err.message.split('\n')[0]}`,
    );
    continue;
  }
  // Any `QC: <tree-sha> [note]` line in the message counts — deliberately more forgiving than
  // git's own trailer-block rules, since the point is the record, not its placement.
  const recorded = message
    .split('\n')
    .map((line) => line.match(new RegExp(`^${TRAILER}:\\s*([0-9a-f]{7,40})\\b`, 'i')))
    .filter(Boolean)
    .map((m) => m[1].toLowerCase());

  if (recorded.length === 0) {
    trailerFailures.push(
      `${branch}: tip commit ${localOid.slice(0, 8)} has no \`${TRAILER}:\` trailer`,
    );
  } else if (!recorded.some((hash) => tree.startsWith(hash))) {
    const records = recorded.map((hash) => hash.slice(0, 8)).join(', ');
    trailerFailures.push(
      `${branch}: the \`${TRAILER}:\` trailer on ${localOid.slice(0, 8)} records ${records}, ` +
        `but that commit's tree is ${tree.slice(0, 8)} — the change moved after the QC pass`,
    );
  }

  // Loop evidence for the same tree.
  const shortPath = `${EVIDENCE_DIR}/${tree.slice(0, 8)}….json`;
  if (toplevel === null) {
    loopFailures.push(`${branch}: could not resolve the worktree root to look for ${shortPath}`);
    continue;
  }
  let raw;
  try {
    raw = readFileSync(join(toplevel, EVIDENCE_DIR, `${tree}.json`), 'utf8');
  } catch {
    loopFailures.push(`${branch}: no loop evidence for tree ${tree.slice(0, 8)} (${shortPath})`);
    continue;
  }
  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch {
    loopFailures.push(`${branch}: ${shortPath} is not valid JSON`);
    continue;
  }
  const problems = [];
  if (typeof evidence?.treeSha !== 'string') {
    problems.push('treeSha is missing or not a string');
  } else if (evidence.treeSha !== tree) {
    problems.push(
      `treeSha ${evidence.treeSha.slice(0, 8)} is not this push's tree ${tree.slice(0, 8)} — ` +
        'evidence from an earlier state',
    );
  }
  if (!Number.isInteger(evidence?.rounds) || evidence.rounds < 1) {
    problems.push('rounds must be an integer ≥ 1');
  }
  for (const k of ['findingsRaised', 'findingsFixed', 'findingsDeclined']) {
    if (!Number.isInteger(evidence?.[k]) || evidence[k] < 0) {
      problems.push(`${k} must be a non-negative integer`);
    }
  }
  const { findingsRaised, findingsFixed, findingsDeclined } = evidence ?? {};
  if (
    [findingsRaised, findingsFixed, findingsDeclined].every(Number.isInteger) &&
    findingsRaised !== findingsFixed + findingsDeclined
  ) {
    problems.push(
      `findingsRaised (${findingsRaised}) must equal findingsFixed + findingsDeclined ` +
        `(${findingsFixed} + ${findingsDeclined}) — every finding is fixed or declined, never dropped`,
    );
  }
  const reviewers = evidence?.reviewers;
  if (
    !Array.isArray(reviewers) ||
    reviewers.length === 0 ||
    !reviewers.every((r) => typeof r === 'string' && r.trim().length > 0)
  ) {
    problems.push('reviewers must be a non-empty array of names');
  }
  if (problems.length > 0) {
    loopFailures.push(`${branch}: ${shortPath} — ${problems.join('; ')}`);
  }
}

if (readFailures.length + trailerFailures.length + loopFailures.length > 0) {
  console.error('❌ QC gate: push refused — the QC record does not cover what you are pushing.');
  for (const f of [...readFailures, ...trailerFailures, ...loopFailures]) {
    console.error(`   - ${f}`);
  }
  if (readFailures.length > 0) {
    console.error('');
    console.error(
      '   A ref could not be read, so the gate cannot verify it. Repair the object store',
    );
    console.error('   (git fsck, re-fetch the branch) and retry — no QC record can fix this.');
  }
  if (trailerFailures.length > 0) {
    console.error('');
    console.error(
      '   Run the QC pass over the staged change (docs/ai-workflow.md §3.5), then record it:',
    );
    console.error('');
    console.error('     git add -A');
    console.error(
      '     git commit -m "$(printf \'type(scope): subject\\n\\nQC: %s\\n\' "$(git write-tree)")"',
    );
    console.error('');
    console.error(
      '   Already committed? Amend it (git 2.32+):' +
        ' git commit --amend --no-edit --trailer "QC=$(git write-tree)"',
    );
  }
  if (loopFailures.length > 0) {
    console.error('');
    console.error(
      "   Run the adversarial QC loop over this push's delta (docs/ai-workflow.md §3.5);",
    );
    console.error('   its final act records the evidence for the tree you are pushing:');
    console.error('');
    console.error('     tree=$(git rev-parse "HEAD^{tree}")');
    console.error(`     mkdir -p ${EVIDENCE_DIR}`);
    console.error(
      '     printf \'{ "treeSha": "%s", "rounds": 1, "findingsRaised": 0, "findingsFixed": 0,' +
        ` "findingsDeclined": 0, "reviewers": ["<who>"] }\\n' "$tree" > ${EVIDENCE_DIR}/$tree.json`,
    );
    console.error('');
    console.error(
      '   The tallies are the loop’s real ones — the file is an attestation, not a formality.',
    );
  }
  console.error('');
  console.error(`   Emergency only: QC_OVERRIDE="why this push cannot wait" git push`);
  process.exit(1);
}

process.exit(0);
