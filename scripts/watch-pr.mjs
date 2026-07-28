#!/usr/bin/env node
// watch-pr.mjs — the review-loop PR watcher (docs/ai-workflow.md §4).
//
// Polls one PR and prints an event line for every change: new reviews, new conversation
// comments, check-state transitions, head pushes, review-decision changes. Built to be
// trusted while unattended, which mostly means being loud about its own health:
//
//   - ONE `gh pr view` invocation per cycle (a single GraphQL request), interval floored
//     at 45s — well under secondary-rate-limit territory, so the watcher cannot kill
//     itself the way ad-hoc multi-endpoint pollers have.
//   - Every poll failure prints a POLL_ERROR event and the loop continues. Silence is
//     never load-bearing: a HEARTBEAT line prints every few polls regardless of change,
//     so "no output for N minutes" always means "the watcher itself is dead", not "no
//     news" — treat it that way.
//
// Exits 0 on its own only when the PR merges or closes.
//
// Usage:
//   node scripts/watch-pr.mjs <pr-number> [--interval <seconds>] [--heartbeat <polls>] [--once]
//
//   --interval   seconds between polls (default 60, floor 45)
//   --heartbeat  full-snapshot line every N polls (default 10; 0 disables)
//   --once       one poll: print the snapshot and exit (0 ok, 1 poll failed)

import { execFileSync } from 'node:child_process';

const MIN_INTERVAL = 45;

// Trim response weight in the same single call: review/comment bodies on a busy PR run
// to megabytes, and the watcher only diffs identities and states.
const FIELDS = 'state,headRefOid,reviewDecision,statusCheckRollup,reviews,comments';
const JQ = `{
  state, headRefOid, reviewDecision,
  checks: [(.statusCheckRollup // [])[] | {name: (.name // .context), state: (.conclusion // .state // .status)}],
  reviews: [(.reviews // [])[] | {author: .author.login, state, at: .submittedAt, body: (.body // "")[0:100]}],
  comments: [(.comments // [])[] | {id, author: .author.login, at: .createdAt, body: (.body // "")[0:100]}]
}`;

const args = process.argv.slice(2);
const prNumber = args.find((a) => /^\d+$/.test(a));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};
const once = args.includes('--once');
const interval = Math.max(MIN_INTERVAL, flag('interval', 60));
const heartbeatEvery = Math.max(0, flag('heartbeat', 10));

if (!prNumber) {
  console.error(
    'usage: node scripts/watch-pr.mjs <pr-number> [--interval s] [--heartbeat n] [--once]',
  );
  process.exit(1);
}

const now = () => new Date().toISOString();
const say = (kind, message) => console.log(`${now()} ${kind} ${message}`);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

function poll() {
  const raw = execFileSync('gh', ['pr', 'view', prNumber, '--json', FIELDS, '--jq', JQ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(raw);
}

function summarize(snap) {
  const tally = { total: snap.checks.length, bad: 0, pending: 0 };
  for (const c of snap.checks) {
    const s = String(c.state).toUpperCase();
    if (s === 'FAILURE' || s === 'ERROR' || s === 'TIMED_OUT') tally.bad++;
    else if (s !== 'SUCCESS' && s !== 'SKIPPED' && s !== 'NEUTRAL') tally.pending++;
  }
  return (
    `state=${snap.state} head=${snap.headRefOid.slice(0, 8)} decision=${snap.reviewDecision || '-'} ` +
    `checks=${tally.total - tally.bad - tally.pending}/${tally.total} ok` +
    (tally.bad ? ` ${tally.bad} FAILING` : '') +
    (tally.pending ? ` ${tally.pending} pending` : '') +
    ` reviews=${snap.reviews.length} comments=${snap.comments.length}`
  );
}

function diff(prev, snap) {
  if (prev.headRefOid !== snap.headRefOid) {
    say('HEAD', `${prev.headRefOid.slice(0, 8)} -> ${snap.headRefOid.slice(0, 8)}`);
  }
  const seenReviews = new Set(prev.reviews.map((r) => `${r.author}@${r.at}`));
  for (const r of snap.reviews) {
    if (!seenReviews.has(`${r.author}@${r.at}`)) {
      say('REVIEW', `${r.author} ${r.state} at ${r.at}: ${oneLine(r.body)}`);
    }
  }
  const seenComments = new Set(prev.comments.map((c) => c.id));
  for (const c of snap.comments) {
    if (!seenComments.has(c.id)) say('COMMENT', `${c.author} at ${c.at}: ${oneLine(c.body)}`);
  }
  const prevChecks = new Map(prev.checks.map((c) => [c.name, c.state]));
  for (const c of snap.checks) {
    const before = prevChecks.get(c.name);
    if (before !== c.state) say('CHECK', `${c.name}: ${before ?? '(new)'} -> ${c.state}`);
  }
  if (prev.reviewDecision !== snap.reviewDecision) {
    say('DECISION', `${prev.reviewDecision || '-'} -> ${snap.reviewDecision || '-'}`);
  }
}

const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

let prev = null;
let polls = 0;
for (;;) {
  let snap = null;
  try {
    snap = poll();
  } catch (err) {
    // The whole point: a failed poll is an EVENT, not a silence.
    say('POLL_ERROR', oneLine(String(err.stderr || err.message)).slice(0, 200));
    if (once) process.exit(1);
  }
  if (snap) {
    polls++;
    if (prev === null) say('WATCHING', `PR #${prNumber} — ${summarize(snap)}`);
    else diff(prev, snap);
    if (heartbeatEvery > 0 && polls % heartbeatEvery === 0) say('HEARTBEAT', summarize(snap));
    if (snap.state !== 'OPEN') {
      say('DONE', `PR #${prNumber} is ${snap.state}`);
      process.exit(0);
    }
    prev = snap;
  }
  if (once) process.exit(0);
  await sleep(interval);
}
