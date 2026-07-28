#!/usr/bin/env node
// check-qc-record.mjs — the pre-push QC gate (see docs/ai-workflow.md §3.5).
//
// Refuses to push a branch unless BOTH records exist for exactly the state being pushed:
//
//  1. A `QC: <tree-sha>` trailer on the tip commit, whose hash is that commit's own tree.
//     `git write-tree` prints that hash from the staged index, so recording an honest pass
//     costs one substitution in the commit command — and the record cannot be recycled,
//     because any later edit changes the tree.
//  2. Loop evidence: `.claude/qc-evidence/<tree-sha>.json` (full tree sha in both the
//     filename and the `treeSha` field), written as the adversarial QC loop's final act,
//     tallying its rounds, findings, and reviewers for that same tree. All six fields are
//     required (extra keys are ignored), and the tallies must balance: every raised
//     finding was fixed or declined, never dropped. The file stays local (`.claude/` is
//     gitignored — it describes a working process, not the product); the PR-visible
//     summary rides as a note on the `QC:` trailer line. A human pushing a self-reviewed
//     change records their own pass the same way: `"reviewers": ["<your-name>"],
//     "rounds": 1`.
//
// Both are attestations, not proofs — they answer "did anyone run the pass / the loop?",
// not "was it any good", and a determined author could fabricate either. Their value is
// making the steps structurally unforgettable at the push boundary: a step the hook checks
// gets done; a step nothing checks gets skipped exactly when attention is somewhere else.
//
// Emergency escape hatch, honored wherever the gate would otherwise refuse — including on
// input it cannot read: QC_OVERRIDE="<rationale>", at least 15 characters. A shorter
// rationale is ignored with a note, and a push the gate passes on its own merits ignores
// the variable entirely (no bypass is recorded that was never needed). Each real bypass
// appends best-effort to `.claude/qc-evidence/overrides.log` so it leaves a trace a
// postmortem can find. If the hook itself cannot run at all (`node` missing from a GUI
// client's PATH), the last resort is `git push --no-verify` — then fix the hook.
//
// Reads git's pre-push stdin protocol: `<local-ref> <local-oid> <remote-ref> <remote-oid>`
// per ref. Deletions, non-branch destinations (tags included), and pushes whose
// destination is `main` are not gated — each ungated outcome says so on stderr. Stdin the
// gate cannot read — or any line of it that does not parse as the protocol — REFUSES the
// push. Genuinely empty stdin is the one pass-through (git hands over nothing on an
// up-to-date push), and it too is announced, so a chain-loading wrapper that swallowed
// stdin is visible instead of silently ungated: a wrapper MUST hand this checker git's
// stdin unconsumed — run it before anything else reads the pipe.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BRANCH = 'main';
const TRAILER = 'QC';
const EVIDENCE_DIR = '.claude/qc-evidence';
const MIN_RATIONALE = 15;
const ZERO = /^0+$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

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
const overrideValid = override.length >= MIN_RATIONALE;

const noteShortOverride = () => {
  if (override.length > 0 && !overrideValid) {
    console.error(
      `   (QC_OVERRIDE was set but its rationale is under ${MIN_RATIONALE} characters — ignored.)`,
    );
  }
};

/** Emergency bypass: warn loudly, leave a best-effort local trace, allow the push. */
function applyOverride(refsLabel) {
  console.error(
    '⚠️  QC gate overridden — no QC record or loop evidence was required for this push.',
  );
  console.error(`   rationale: ${override}`);
  console.error('   Say the same thing in the PR thread; the commits carry no record of it.');
  if (toplevel === null) {
    console.error('   (could not resolve the worktree root — this override was NOT logged;');
    console.error('   record the bypass in the PR thread — nothing else will.)');
    process.exit(0);
  }
  try {
    mkdirSync(join(toplevel, EVIDENCE_DIR), { recursive: true });
    // One log line per bypass: collapse whitespace so a crafted rationale cannot forge
    // extra entries.
    appendFileSync(
      join(toplevel, EVIDENCE_DIR, 'overrides.log'),
      `${new Date().toISOString()} ${refsLabel} — ${override.replace(/\s+/g, ' ')}\n`,
    );
    console.error(`   (logged to ${EVIDENCE_DIR}/overrides.log)`);
  } catch (err) {
    // Never block an emergency push over bookkeeping — but never fail silently either.
    console.error(
      `   (could not log the override to ${EVIDENCE_DIR}/overrides.log: ` +
        `${String(err?.message ?? err).split('\n')[0]})`,
    );
    console.error('   Record this bypass in the PR thread — nothing else will.');
  }
  process.exit(0);
}

if (process.stdin.isTTY) {
  console.error('QC gate: stdin is a terminal — not invoked by git, nothing gated.');
  process.exit(0);
}

let stdinError = null;
const stdin = (() => {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    stdinError = err;
    return '';
  }
})();

if (stdinError) {
  if (overrideValid) applyOverride('(refs unknown — stdin unreadable)');
  console.error('❌ QC gate: could not read the ref list git passes on stdin — refusing to');
  console.error(`   guess what is being pushed (${stdinError.message.split('\n')[0]}).`);
  noteShortOverride();
  console.error('   Re-run the push. Emergency only: QC_OVERRIDE="why this push cannot wait".');
  process.exit(1);
}

const rawLines = stdin
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

// Git hands over zero bytes on an up-to-date push, so empty stdin is legitimate — but a
// chain-loading wrapper that drained the pipe looks identical, so say what happened.
if (rawLines.length === 0) {
  console.error('QC gate: no refs on stdin — nothing gated.');
  process.exit(0);
}

// A protocol line is `<local-ref> <local-oid> <remote-ref> <remote-oid>`: token count
// alone is not enough (any four words match), so the oids must look like object ids and
// the destination like a ref. ANY line that fails refuses the whole push — a ref the gate
// cannot parse is a ref it cannot gate.
const looksLikeOid = (s) => /^[0-9a-f]{40,64}$/i.test(s);
const parsedLines = rawLines.map((line) => {
  const parts = line.split(/\s+/);
  const ok =
    parts.length === 4 &&
    looksLikeOid(parts[1]) &&
    looksLikeOid(parts[3]) &&
    parts[2].startsWith('refs/');
  return ok
    ? { localRef: parts[0], localOid: parts[1], remoteRef: parts[2], remoteOid: parts[3] }
    : { badLine: line };
});
const badLines = parsedLines.filter((p) => p.badLine !== undefined);
if (badLines.length > 0) {
  if (overrideValid) applyOverride(`(unparsed input: ${badLines.length} line(s))`);
  console.error("❌ QC gate: the pre-push input did not fully parse as git's ref protocol —");
  for (const { badLine } of badLines) console.error(`   - ${badLine.slice(0, 100)}`);
  noteShortOverride();
  console.error('   Re-run the push. Emergency only: QC_OVERRIDE="why this push cannot wait".');
  process.exit(1);
}

const pushes = parsedLines
  .filter(({ localOid }) => !ZERO.test(localOid)) // a deletion pushes no content
  // Branches only. A tag names history that already exists — it cannot be re-committed to carry
  // a record, so gating one would refuse a release push with advice that cannot be followed.
  .filter(({ remoteRef }) => remoteRef.startsWith('refs/heads/'))
  .filter(({ remoteRef }) => remoteRef !== `refs/heads/${DEFAULT_BRANCH}`);

if (pushes.length === 0) {
  console.error(
    `QC gate: only ungated destinations in this push (${DEFAULT_BRANCH}, tags, deletions) — ` +
      'nothing to check.',
  );
  process.exit(0);
}

const readFailures = [];
const trailerFailures = [];
const loopFailures = [];
for (const { localOid, remoteRef } of pushes) {
  // Name each problem by the DESTINATION branch — that is what the gate decisions key on,
  // and what a source ref like `HEAD` would mislabel.
  const branch = remoteRef.replace(/^refs\/heads\//, '');
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
    .map((line) => line.match(new RegExp(`^${TRAILER}:\\s*([0-9a-f]{7,64})\\b`, 'i')))
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
  } catch (err) {
    loopFailures.push(
      err?.code === 'ENOENT'
        ? `${branch}: no loop evidence for tree ${tree.slice(0, 8)} (${shortPath})`
        : `${branch}: ${shortPath} could not be read — ${err?.code ?? String(err?.message ?? err).split('\n')[0]}`,
    );
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
  } else {
    const fileSha = evidence.treeSha.toLowerCase();
    if (fileSha !== tree) {
      // The trailer leg documents prefixes as legal, so a truncated evidence sha is a
      // plausible mistake deserving its own diagnosis — not "re-run the loop".
      problems.push(
        tree.startsWith(fileSha)
          ? `treeSha ${evidence.treeSha.slice(0, 8)}… is truncated — the evidence file needs the full tree sha`
          : `treeSha ${evidence.treeSha.slice(0, 8)} is not this push's tree ${tree.slice(0, 8)} — evidence from an earlier state`,
      );
    }
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
  if (overrideValid) {
    applyOverride(
      pushes
        .map((p) => `${p.remoteRef.replace(/^refs\/heads\//, '')}@${p.localOid.slice(0, 8)}`)
        .join(' '),
    );
  }
  console.error('❌ QC gate: push refused — the QC record does not cover what you are pushing.');
  for (const f of [...readFailures, ...trailerFailures, ...loopFailures]) {
    console.error(`   - ${f}`);
  }
  noteShortOverride();
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
