#!/usr/bin/env node
// check-qc-record.mjs — the pre-push QC gate (see docs/ai-workflow.md §3.5).
//
// Refuses to push a branch unless its tip commit carries a QC record for exactly the state
// being pushed: a `QC: <tree-sha>` trailer whose hash is that commit's own tree. `git write-tree`
// prints that hash from the staged index, so recording an honest pass costs one substitution in
// the commit command — and the record cannot be recycled, because any later edit changes the tree.
//
// It answers "did anyone QC this?", not "was the QC any good": the record is a claim, made in the
// commit message, where a reviewer can see it. Emergency escape hatch: QC_OVERRIDE="<rationale>".
//
// Reads git's pre-push stdin protocol: `<local-ref> <local-oid> <remote-ref> <remote-oid>` per
// ref. Deletions and pushes to the default branch are not gated.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_BRANCH = 'main';
const TRAILER = 'QC';
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
  console.error('⚠️  QC gate overridden — no QC record was required for this push.');
  console.error(`   rationale: ${override}`);
  console.error('   Say the same thing in the PR thread; the commits carry no record of it.');
  process.exit(0);
}

const failures = [];
for (const { localRef, localOid } of pushes) {
  // A gate whose own failure mode is a stack trace is worse than no gate: whatever git cannot
  // answer here (shallow clone, missing object), say so as a QC failure with the way out.
  const branch = localRef.replace(/^refs\/heads\//, '');
  let tree, message;
  try {
    tree = git('rev-parse', `${localOid}^{tree}`);
    message = git('show', '-s', '--format=%B', localOid);
  } catch (err) {
    failures.push(
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
    failures.push(`${branch}: tip commit ${localOid.slice(0, 8)} has no \`${TRAILER}:\` trailer`);
  } else if (!recorded.some((hash) => tree.startsWith(hash))) {
    const records = recorded.map((hash) => hash.slice(0, 8)).join(', ');
    failures.push(
      `${branch}: the \`${TRAILER}:\` trailer on ${localOid.slice(0, 8)} records ${records}, ` +
        `but that commit's tree is ${tree.slice(0, 8)} — the change moved after the QC pass`,
    );
  }
}

if (failures.length > 0) {
  console.error('❌ QC gate: push refused — no QC record covers what you are pushing.');
  for (const f of failures) console.error(`   - ${f}`);
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
  console.error(`   Emergency only: QC_OVERRIDE="why this push cannot wait" git push`);
  process.exit(1);
}

process.exit(0);
