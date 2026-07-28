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
//     The file stays local (`.claude/` is gitignored — it describes a working process, not
//     the product); the PR-visible summary rides as a note on the `QC:` trailer line.
//     A human pushing a self-reviewed change records their own pass the same way:
//     `"reviewers": ["<your-name>"], "rounds": 1`.
//
// Both are attestations, not proofs — they answer "did anyone run the pass / the loop?",
// not "was it any good", and a determined author could fabricate either. Their value is
// making the steps structurally unforgettable at the push boundary: a step the hook checks
// gets done; a step nothing checks gets skipped exactly when attention is somewhere else.
//
// Emergency escape hatch for both legs: QC_OVERRIDE="<rationale>".
//
// Reads git's pre-push stdin protocol: `<local-ref> <local-oid> <remote-ref> <remote-oid>` per
// ref. Deletions and pushes to the default branch are not gated.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BRANCH = 'main';
const TRAILER = 'QC';
const EVIDENCE_DIR = '.claude/qc-evidence';
const MIN_RATIONALE = 15;
const ZERO = /^0+$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const stdin = (() => {
  if (process.stdin.isTTY) return ''; // Run by hand rather than by git — nothing to gate.
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
})();

const pushes = stdin
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .filter((parts) => parts.length === 4)
  .map(([localRef, localOid, remoteRef, remoteOid]) => ({
    localRef,
    localOid,
    remoteRef,
    remoteOid,
  }))
  .filter(({ localOid }) => !ZERO.test(localOid)) // a deletion pushes no content
  // Branches only. A tag names history that already exists — it cannot be re-committed to carry
  // a record, so gating one would refuse a release push with advice that cannot be followed.
  .filter(({ remoteRef }) => remoteRef.startsWith('refs/heads/'))
  .filter(({ remoteRef }) => remoteRef !== `refs/heads/${DEFAULT_BRANCH}`);

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
  process.exit(0);
}

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

const trailerFailures = [];
const loopFailures = [];
for (const { localRef, localOid } of pushes) {
  const branch = localRef.replace(/^refs\/heads\//, '');
  let tree, message;
  try {
    tree = git('rev-parse', `${localOid}^{tree}`);
    message = git('show', '-s', '--format=%B', localOid);
  } catch (err) {
    trailerFailures.push(
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
  if (evidence?.treeSha !== tree) {
    problems.push(
      `treeSha ${String(evidence?.treeSha).slice(0, 8)} is not this push's tree ` +
        `${tree.slice(0, 8)} — evidence from an earlier state`,
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

if (trailerFailures.length + loopFailures.length > 0) {
  console.error('❌ QC gate: push refused — the QC record does not cover what you are pushing.');
  for (const f of [...trailerFailures, ...loopFailures]) console.error(`   - ${f}`);
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
