#!/usr/bin/env node
// watch-pr.mjs — the review-loop PR watcher (docs/ai-workflow.md §4).
//
// Polls one PR and prints an event line for every change: new reviews; new, edited, or
// deleted conversation comments; check-state transitions (including a check vanishing
// from the rollup); head pushes; review-decision changes.
// Built to be trusted while unattended, which mostly means being loud about its own
// health — the contract is that this process NEVER goes quiet while alive:
//
//   - ONE `gh pr view` invocation per cycle, interval floored at 45s — far from
//     rate-limit territory, so the watcher cannot rate-limit itself to death. gh itself
//     paginates large list fields under that one invocation (verified at gh 2.93: a
//     669-comment PR arrives whole), so the snapshot is complete; a gh old enough to
//     truncate instead of paginate would narrow detection to the first ~100 items.
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
// Left running, it exits 0 only when the PR merges or closes.
//
// Usage:
//   node scripts/watch-pr.mjs <pr-number> [--interval <seconds>] [--heartbeat <polls>] [--once]
//
//   --interval   seconds between polls (default 60, floor 45 — announced when clamped —
//                max 3600)
//   --heartbeat  full-snapshot line every N polls (default 10, range 1-1000)
//   --once       one poll: print the snapshot and exit (0 ok, 1 poll failed)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

const MIN_INTERVAL = 45;
const NEVER_CONNECTED_LIMIT = 3;

// The --jq projection is applied client-side by gh (full items still cross the wire
// inside the atomic `reviews`/`comments` fields). Review bodies are excerpted here —
// reviews are only ever announced, never edit-tracked — but comment bodies arrive WHOLE
// so poll() can fingerprint the full text (an edit past a display excerpt must still
// flip COMMENT_EDITED), then keeps only excerpt + hash. A running CheckRun carries
// `conclusion: ""`, which jq's // would keep — hence the explicit empty-string fallback.
const FIELDS = 'state,headRefOid,reviewDecision,statusCheckRollup,reviews,comments';
const JQ = `{
  state, headRefOid, reviewDecision,
  checks: [(.statusCheckRollup // [])[] | {type: (.__typename // ""), name: (.name // .context), state: ((.conclusion // "" | if . == "" then null else . end) // .state // .status)}],
  reviews: [(.reviews // [])[] | {id: (.id // ""), author: .author.login, state, at: .submittedAt, body: (.body // "")[0:100]}],
  comments: [(.comments // [])[] | {id, author: .author.login, at: .createdAt, body: (.body // "")}]
}`;
const fingerprint = (s) => createHash('sha256').update(s).digest('hex');

// Usage errors print to STDOUT: the event stream is the channel this file's reader
// watches (FATAL goes there for the same reason), and a watcher that dies mute to its
// own reader is the failure shape this tool exists to end.
const usage = (problem) => {
  if (problem) console.log(`watch-pr: ${problem}`);
  console.log(
    'usage: node scripts/watch-pr.mjs <pr-number> [--interval 45-3600] [--heartbeat 1-1000] [--once]',
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
// Bounded on both ends. The ceiling is a policy cap — an hour is already far past useful
// for a review loop — and it keeps the value comfortably inside setTimeout's 32-bit range
// (past 2^31−1 ms a timer silently fires after 1 ms, a rate-limit-tripping hot loop).
// The floor protects the rate limit; a low request is honored at 45 and says so, because
// a silently adjusted poll period corrupts the caller's timing arithmetic.
const requestedInterval = flags['--interval'] ?? 60;
const interval = Math.max(MIN_INTERVAL, requestedInterval);
if (interval > 3600) usage('--interval max is 3600 seconds');
if (requestedInterval < MIN_INTERVAL) {
  console.log(`watch-pr: --interval ${requestedInterval} raised to the ${MIN_INTERVAL}s floor`);
}
// The heartbeat cannot be disabled or pushed out of sight: it is the liveness signal the
// whole contract rests on.
const heartbeatEvery = flags['--heartbeat'] ?? 10;
if (heartbeatEvery < 1 || heartbeatEvery > 1000) usage('--heartbeat needs an integer 1-1000');

const now = () => new Date().toISOString();
const oneLine = (s) =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// Every event is exactly one line of plain printable text. Interpolated content (check
// names, bodies, states) is attacker-writable on a public repo, and must not forge a
// second event (a newline) or repaint an existing one (ANSI cursor/erase escapes, bidi
// overrides — a terminal obeys both even mid-line). So every control or format character
// (Cc/Cf) becomes a space — ZWJ emoji in an excerpt degrade, a fair price for a log
// line — and then runs of whitespace collapse.
const say = (kind, message) => console.log(`${now()} ${kind} ${oneLine(String(message))}`);

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
  // A POLL_ERROR with no diagnostic would be a bare timestamp — when every normal field
  // is empty or stringifies uselessly, show the error's structure instead.
  if (!tail || tail === '[object Object]') {
    tail = oneLine(inspect(err, { depth: 1 })).slice(0, 200);
  }
  return (`${id}${tail}${more}`.trim() || 'unrecognized failure (no diagnostic)').slice(0, 300);
};

function poll() {
  const raw = execFileSync('gh', ['pr', 'view', prNumber, '--json', FIELDS, '--jq', JQ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: interval * 1000, // a hung call becomes a POLL_ERROR, never a mute freeze
    killSignal: 'SIGKILL',
    // Full comment bodies cross this boundary for fingerprinting, and gh paginates the
    // list fields, so the payload is unbounded — a marathon PR can ship tens of MB, and
    // maxBuffer counts BYTES (JSON escaping and UTF-8 width land here). Node's 1 MiB
    // default would turn such a PR into a permanent POLL_ERROR loop; at 32 MiB an
    // overflow still surfaces as a loud per-cycle POLL_ERROR (ENOBUFS), never silence.
    maxBuffer: 32 * 1024 * 1024,
  });
  const snap = JSON.parse(raw);
  // Anything that is not a full snapshot must be an ERROR, not a skipped iteration or a
  // FATAL: the loop only speaks from its success and failure branches (a value landing in
  // neither would leave it silently alive forever), and a malformed-but-parseable payload
  // is a retryable poll condition, not a bug in the differ.
  const shaped =
    snap !== null &&
    typeof snap === 'object' &&
    !Array.isArray(snap) &&
    typeof snap.state === 'string' &&
    [snap.checks, snap.reviews, snap.comments].every(Array.isArray);
  if (!shaped) {
    throw new Error(`gh returned ${JSON.stringify(raw.slice(0, 60))} instead of a snapshot`);
  }
  // Reduce each comment to what the differ needs — excerpt for display, hash for change
  // detection — so full bodies never outlive the poll that fetched them.
  snap.comments = snap.comments.map((c) => {
    const body = String(c?.body ?? '');
    return {
      id: c?.id,
      author: c?.author,
      at: c?.at,
      excerpt: body.slice(0, 100),
      fp: fingerprint(body),
    };
  });
  return snap;
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
  // STARTUP_FAILURE / ACTION_REQUIRED / STALE / CANCELLED are terminal too — counting a
  // dead check as "pending" is exactly the converging-vs-wedged confusion this summary
  // must not create. CANCELLED is the contested one: a manually-killed run with no
  // replacement wedges the merge while reading as "converging", so it counts as BAD;
  // the price is a short FAILING flicker when concurrency supersedes a run on this same
  // head (the replacement flips it back), and honest alarm beats a converging lie.
  const BAD = new Set([
    'FAILURE',
    'ERROR',
    'TIMED_OUT',
    'STARTUP_FAILURE',
    'ACTION_REQUIRED',
    'STALE',
    'CANCELLED',
  ]);
  const OK = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
  for (const c of snap.checks) {
    const s = String(c.state).toUpperCase();
    if (BAD.has(s)) tally.bad++;
    else if (!OK.has(s)) tally.pending++;
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
  // Key on the review's stable id when the API provides one; the composite fallback
  // (submittedAt has second granularity, and same-second same-author bursts are real)
  // gets an occurrence index, which is positional — an id never is.
  const keyedReviews = (reviews) => {
    const counts = new Map();
    return reviews.map((r) => {
      if (r.id) return { ...r, key: `id:${r.id}` };
      const base = `${r.author}@${r.at}@${r.state}`;
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      return { ...r, key: n === 0 ? base : `${base}#${n}` };
    });
  };
  const seenReviews = new Set(keyedReviews(prev.reviews).map((r) => r.key));
  for (const r of keyedReviews(snap.reviews)) {
    if (!seenReviews.has(r.key)) {
      say('REVIEW', `${r.author} ${r.state} at ${r.at}: ${oneLine(r.body)}`);
    }
  }
  const prevComments = new Map(prev.comments.map((c) => [c.id, c.fp]));
  const snapCommentIds = new Set(snap.comments.map((c) => c.id));
  for (const c of snap.comments) {
    if (!prevComments.has(c.id)) {
      say('COMMENT', `${c.author} at ${c.at}: ${oneLine(c.excerpt)}`);
    } else if (prevComments.get(c.id) !== c.fp) {
      say('COMMENT_EDITED', `${c.author}: ${oneLine(c.excerpt)}`);
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
// stdout pipes are asynchronous on macOS (Node's documented process-I/O behavior), where
// process.exit() discards any still-buffered writes — which would truncate away the
// DONE/FATAL line that a reader behind a pipe needs most. Letting the loop end naturally
// flushes everything. (Small bounded emitters like the pre-push gate — a few lines per
// pushed ref, far inside a pipe buffer — are safe with process.exit; this file streams
// unbounded events, hence the care.)
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
        // Exit 0 only on the KNOWN terminal states — an unrecognized state must never
        // read as "resolved", the one way this watcher could lie by exiting quietly.
        if (snap.state === 'MERGED' || snap.state === 'CLOSED') {
          say('DONE', `PR #${prNumber} is ${snap.state}`);
          return;
        }
        if (snap.state !== 'OPEN') {
          say('POLL_ERROR', `unrecognized PR state ${JSON.stringify(snap.state)}`);
          if (once) {
            process.exitCode = 1; // POLL_ERROR under --once always means exit 1
            return;
          }
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
