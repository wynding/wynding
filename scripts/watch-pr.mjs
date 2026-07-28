#!/usr/bin/env node
// watch-pr.mjs — the review-loop PR watcher (docs/ai-workflow.md §4).
//
// Polls one PR and prints an event line for every change: new reviews, new or edited
// conversation comments, check-state transitions, head pushes, review-decision changes.
// Built to be trusted while unattended, which mostly means being loud about its own
// health — the contract is that this process NEVER goes quiet while alive:
//
//   - ONE `gh pr view` invocation per cycle (gh may paginate a PR that grows past ~100
//     reviews or comments), interval floored at 45s — far from rate-limit territory, so
//     the watcher cannot rate-limit itself to death.
//   - The call carries a hard timeout of one interval, so a hung network path surfaces
//     as a POLL_ERROR event instead of freezing the loop alive and mute.
//   - Every poll failure prints a POLL_ERROR event and the loop continues — except when
//     the very first polls all fail (never reached the PR: wrong number, dead auth),
//     which prints FATAL and exits 1 rather than emitting errors forever.
//   - Any other internal failure prints FATAL on stdout (the event stream) and exits 1.
//   - A HEARTBEAT line prints every few polls regardless of change, so "no output for
//     N minutes" always means the watcher is gone — restart it; never read its silence
//     as "no news". (Heartbeats count successful polls, so a failure streak shows
//     POLL_ERROR lines instead.)
//
// Exits 0 on its own only when the PR merges or closes.
//
// Usage:
//   node scripts/watch-pr.mjs <pr-number> [--interval <seconds>] [--heartbeat <polls>] [--once]
//
//   --interval   seconds between polls (default 60, floor 45)
//   --heartbeat  full-snapshot line every N polls (default 10, minimum 1)
//   --once       one poll: print the snapshot and exit (0 ok, 1 poll failed)

import { execFileSync } from 'node:child_process';

const MIN_INTERVAL = 45;
const NEVER_CONNECTED_LIMIT = 3;

// The --jq projection is applied client-side by gh (review/comment bodies still cross the
// wire inside the atomic `reviews`/`comments` fields); it trims what is printed AND what
// is diffed. Comment-edit detection compares the 100-char excerpt plus the full length,
// so only an edit that preserves both escapes notice. A running CheckRun carries
// `conclusion: ""`, which jq's // would keep — hence the explicit empty-string fallback.
const FIELDS = 'state,headRefOid,reviewDecision,statusCheckRollup,reviews,comments';
const JQ = `{
  state, headRefOid, reviewDecision,
  checks: [(.statusCheckRollup // [])[] | {type: (.__typename // ""), name: (.name // .context), state: ((.conclusion // "" | if . == "" then null else . end) // .state // .status)}],
  reviews: [(.reviews // [])[] | {author: .author.login, state, at: .submittedAt, body: (.body // "")[0:100]}],
  comments: [(.comments // [])[] | {id, author: .author.login, at: .createdAt, body: (.body // "")[0:100], len: ((.body // "") | length)}]
}`;

const usage = (problem) => {
  if (problem) console.error(`watch-pr: ${problem}`);
  console.error(
    'usage: node scripts/watch-pr.mjs <pr-number> [--interval s] [--heartbeat n>=1] [--once]',
  );
  process.exit(1);
};

// Flags consume their values here so a numeric flag value can never be mistaken for the
// PR number (`--heartbeat 5 68` watches #68, not #5).
const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--interval', '--heartbeat']);
const flags = {};
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) {
    const v = Number(args[i + 1]);
    if (!Number.isInteger(v) || v < 0) usage(`${a} needs a non-negative integer`);
    flags[a] = v;
    i++;
  } else if (a === '--once') {
    flags[a] = true;
  } else {
    positionals.push(a);
  }
}
if (positionals.length !== 1 || !/^\d+$/.test(positionals[0])) {
  usage(positionals.length > 1 ? `unexpected argument: ${positionals[1]}` : undefined);
}
const prNumber = positionals[0];
const once = flags['--once'] === true;
const interval = Math.max(MIN_INTERVAL, flags['--interval'] ?? 60);
// The heartbeat cannot be disabled: it is the liveness signal the whole contract rests on.
const heartbeatEvery = flags['--heartbeat'] ?? 10;
if (heartbeatEvery < 1) usage('--heartbeat needs an integer >= 1');

const now = () => new Date().toISOString();
const say = (kind, message) => console.log(`${now()} ${kind} ${message}`);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

// Lead with the transport-level identity — execFileSync spreads it across three fields
// (`code` for spawn-level failures, `signal` for kills, `status` for exits), and stderr
// may hold only a pre-kill advisory. Then gh's stderr TAIL, where its diagnostics land;
// when stderr is empty, err.message is the reconstructed argv (its last line is the JQ
// program's closing brace), so take its FIRST line instead.
const pollErrorMessage = (err) => {
  const identity = [
    err?.code,
    err?.signal,
    err?.status != null && err?.status !== 0 ? `exit ${err.status}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const id = identity ? `${identity}: ` : '';
  const stderrText = String(err?.stderr || '').trim();
  let tail;
  let more = '';
  if (stderrText) {
    const lines = stderrText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    tail = oneLine(lines.at(-1) ?? '');
    if (lines.length > 1) more = ` [+${lines.length - 1} earlier line(s)]`;
  } else {
    tail = oneLine(String(err?.message ?? err).split('\n')[0]);
  }
  return `${id}${tail}${more}`.slice(0, 300);
};

function poll() {
  const raw = execFileSync('gh', ['pr', 'view', prNumber, '--json', FIELDS, '--jq', JQ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: interval * 1000, // a hung call becomes a POLL_ERROR, never a mute freeze
    killSignal: 'SIGKILL',
  });
  return JSON.parse(raw);
}

// Rollup entries are check-runs AND status contexts in one list; two producers may share
// a display name, so diff keys carry the type (and an index for exact duplicates).
function keyedChecks(checks) {
  const counts = new Map();
  return checks.map((c) => {
    const base = `${c.type}:${c.name}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return { ...c, key: n === 0 ? base : `${base}#${n}` };
  });
}

const checkLabel = (c) => (c.type === 'StatusContext' ? `${c.name} (status)` : c.name);

function summarize(snap) {
  const tally = { total: snap.checks.length, bad: 0, pending: 0 };
  for (const c of snap.checks) {
    const s = String(c.state).toUpperCase();
    if (s === 'FAILURE' || s === 'ERROR' || s === 'TIMED_OUT') tally.bad++;
    else if (s !== 'SUCCESS' && s !== 'SKIPPED' && s !== 'NEUTRAL') tally.pending++;
  }
  return (
    `state=${snap.state} head=${String(snap.headRefOid).slice(0, 8)} decision=${snap.reviewDecision || '-'} ` +
    `checks=${tally.total - tally.bad - tally.pending}/${tally.total} ok` +
    (tally.bad ? ` ${tally.bad} FAILING` : '') +
    (tally.pending ? ` ${tally.pending} pending` : '') +
    ` reviews=${snap.reviews.length} comments=${snap.comments.length}`
  );
}

function diff(prev, snap) {
  if (prev.headRefOid !== snap.headRefOid) {
    say('HEAD', `${String(prev.headRefOid).slice(0, 8)} -> ${String(snap.headRefOid).slice(0, 8)}`);
  }
  const seenReviews = new Set(prev.reviews.map((r) => `${r.author}@${r.at}@${r.state}`));
  for (const r of snap.reviews) {
    if (!seenReviews.has(`${r.author}@${r.at}@${r.state}`)) {
      say('REVIEW', `${r.author} ${r.state} at ${r.at}: ${oneLine(r.body)}`);
    }
  }
  const prevComments = new Map(prev.comments.map((c) => [c.id, `${c.len}:${c.body}`]));
  const snapCommentIds = new Set(snap.comments.map((c) => c.id));
  for (const c of snap.comments) {
    if (!prevComments.has(c.id)) {
      say('COMMENT', `${c.author} at ${c.at}: ${oneLine(c.body)}`);
    } else if (prevComments.get(c.id) !== `${c.len}:${c.body}`) {
      say('COMMENT_EDITED', `${c.author}: ${oneLine(c.body)}`);
    }
  }
  for (const c of prev.comments) {
    if (!snapCommentIds.has(c.id)) say('COMMENT_DELETED', `${c.author}'s comment at ${c.at}`);
  }
  const prevKeyed = keyedChecks(prev.checks);
  const snapKeyed = keyedChecks(snap.checks);
  const prevChecks = new Map(prevKeyed.map((c) => [c.key, c.state]));
  const snapCheckKeys = new Set(snapKeyed.map((c) => c.key));
  for (const c of snapKeyed) {
    const before = prevChecks.get(c.key);
    if (before !== c.state) say('CHECK', `${checkLabel(c)}: ${before ?? '(new)'} -> ${c.state}`);
  }
  // Disappearances are events too — a status vanishing from the rollup is exactly the
  // kind of change this watcher exists to surface.
  for (const c of prevKeyed) {
    if (!snapCheckKeys.has(c.key)) say('CHECK', `${checkLabel(c)}: ${c.state} -> (gone)`);
  }
  if (prev.reviewDecision !== snap.reviewDecision) {
    say('DECISION', `${prev.reviewDecision || '-'} -> ${snap.reviewDecision || '-'}`);
  }
}

const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

// Terminal events set process.exitCode and RETURN instead of calling process.exit():
// pipes are asynchronous on this platform, and process.exit() discards any still-buffered
// stdout — which would truncate away the DONE/FATAL line that a reader behind a pipe
// needs most. Letting the loop end naturally flushes everything.
async function main() {
  let prev = null;
  let polls = 0;
  let consecutiveFailures = 0;
  let everSucceeded = false;
  for (;;) {
    try {
      let snap = null;
      try {
        snap = poll();
      } catch (err) {
        // The whole point: a failed poll is an EVENT, not a silence.
        say('POLL_ERROR', pollErrorMessage(err));
        if (once) {
          process.exitCode = 1;
          return;
        }
        consecutiveFailures++;
        if (!everSucceeded && consecutiveFailures >= NEVER_CONNECTED_LIMIT) {
          say(
            'FATAL',
            `never reached PR #${prNumber} after ${consecutiveFailures} attempts — ` +
              'check the PR number and gh auth',
          );
          process.exitCode = 1;
          return;
        }
      }
      if (snap) {
        everSucceeded = true;
        consecutiveFailures = 0;
        polls++;
        if (prev === null) say('WATCHING', `PR #${prNumber} — ${summarize(snap)}`);
        else diff(prev, snap);
        if (polls % heartbeatEvery === 0) say('HEARTBEAT', summarize(snap));
        if (snap.state !== 'OPEN') {
          say('DONE', `PR #${prNumber} is ${snap.state}`);
          return;
        }
        prev = snap;
      }
      if (once) return;
    } catch (err) {
      // A processing bug must die LOUDLY on the event stream, not vanish onto stderr.
      say('FATAL', oneLine(String(err?.stack ?? err)).slice(0, 300));
      process.exitCode = 1;
      return;
    }
    await sleep(interval);
  }
}

await main();
