#!/usr/bin/env node
// check-codex-freshness.mjs — CI guard: the merge gate's Codex leg must mean "Codex
// reviewed THIS head".
//
// Codex does not auto-review pushes — it reviews when a PR opens, when a draft goes
// ready, or when someone comments `@codex review`. Between a push and the next trigger
// there is a window where a PR can look reviewed while Codex has only seen an older
// commit. This check turns that window into a red status instead of a silent misread
// (docs/ai-workflow.md §4).
//
// A Codex verdict, in this repo's observed shapes, is either:
//   - a PR review by `chatgpt-codex-connector[bot]` (findings shape), or
//   - an issue comment by that account ("Didn't find any major issues" — the clean shape
//     posts no review object),
// and BOTH open a line with `**Reviewed commit:** \`<sha>\``. FRESH iff any non-dismissed
// verdict's recorded sha prefix-matches the current PR head. Codex artifacts without a
// parseable verdict line (e.g. its infrastructure-error comments) never count.
// If Codex is ever renamed or changes that line, every PR presents as "permanently red
// status + one @codex review comment per push" — that symptom means: update CODEX_LOGIN
// and RE_REVIEWED below.
//
// Exit codes: 0 = fresh, 1 = stale or no verdict (actionable: trigger a review),
// 2 = could not determine (API/config failure). Automation reacting to this script must
// treat 2 as "do not react", so a flaky API call never causes a spurious re-trigger —
// which is also why ANY unexpected failure here is converted to exit 2 (Node's default
// exit 1 would read as "stale").
//
// With POST_STATUS=1 (exactly '1'; the codex-freshness workflow), the verdict is ALSO
// posted as a `codex-freshness` commit status on the evaluated head — the
// branch-protection contexts list matches statuses as well as job check-runs, and a
// status can be (re)posted from any event, including the `issue_comment` the clean shape
// arrives as. In that mode a stale verdict exits 0: the red status IS the report, and
// the job stays green so the workflow only fails when the check itself could not run.
//
// Local use (read-only, exit code is the report):
//   PR_NUMBER=68 [HEAD_SHA=<sha>] [GITHUB_TOKEN=…] node scripts/check-codex-freshness.mjs

// Any escape from the normal flow means "could not determine", never "stale" — exit 1
// triggers automation (a review request), and a crash must not.
const indeterminate = (err) => {
  console.error(`❌ codex-freshness: could not determine freshness — ${err?.message ?? err}`);
  console.error('   (API or configuration failure, not a verdict. Re-run once it is resolved.)');
  process.exit(2);
};
process.on('uncaughtException', indeterminate);
process.on('unhandledRejection', indeterminate);

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const STATUS_CONTEXT = 'codex-freshness';
// Anchored to a line start so a verdict line QUOTED inside some other Codex-authored
// text (a blockquote, an error report citing a doc example) cannot count as a verdict.
const RE_REVIEWED = /^\s*\*{0,2}Reviewed commit:\s*\*{0,2}\s*`?([0-9a-f]{7,40})/im;
const MAX_PAGES = 50; // 5 000 items — far beyond any real PR; a runaway guard, not a limit

const REPO = process.env.GITHUB_REPOSITORY ?? 'wynding/wynding';
const API = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
const POSTING = process.env.POST_STATUS === '1';

const short = (sha) => String(sha).slice(0, 10);

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'wynding-codex-freshness',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { headers, ...init });
  if (!res.ok) {
    // The body carries the actionable half of a GitHub error (rate-limited vs not
    // accessible vs not found) — exit 2 hands this to a human, so keep it.
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`GitHub API ${res.status} for ${path}: ${body || '(no body)'}`);
  }
  return res.json();
}

async function paged(path) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await api(`${path}?per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) return out;
  }
  throw new Error(`more than ${MAX_PAGES * 100} items from ${path} — refusing to truncate`);
}

/** Post the verdict as a commit status on the evaluated head (CI reporting mode). */
async function postStatus(sha, state, description) {
  const { GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  await api(`/repos/${REPO}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({
      state,
      context: STATUS_CONTEXT,
      description: description.slice(0, 140),
      ...(GITHUB_SERVER_URL && GITHUB_RUN_ID
        ? { target_url: `${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}` }
        : {}),
    }),
  });
}

// ---- resolve the PR and its current head -------------------------------------------------

let prNumber = process.env.PR_NUMBER;
let headSha = process.env.HEAD_SHA;
if (!prNumber && process.env.GITHUB_EVENT_PATH) {
  try {
    const { readFileSync } = await import('node:fs');
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    // `pull_request` / `pull_request_review` payloads carry .pull_request; the clean shape
    // arrives as `issue_comment`, which carries .issue instead.
    prNumber = event.pull_request?.number ?? event.issue?.number;
  } catch (err) {
    indeterminate(new Error(`could not read the event payload — ${err?.message ?? err}`));
  }
}
if (!/^\d+$/.test(String(prNumber ?? ''))) {
  indeterminate(new Error('no PR number (set PR_NUMBER or run from a PR event)'));
}

try {
  // Always evaluate the PR's CURRENT head — a payload head can be stale by the time this
  // runs, and the status must describe the commit someone would actually merge.
  if (!headSha) headSha = (await api(`/repos/${REPO}/pulls/${prNumber}`)).head.sha;
  headSha = headSha.toLowerCase();

  const reviews = await paged(`/repos/${REPO}/pulls/${prNumber}/reviews`);
  const comments = await paged(`/repos/${REPO}/issues/${prNumber}/comments`);

  const verdicts = [];
  for (const r of reviews) {
    if (r.user?.login !== CODEX_LOGIN || r.state === 'DISMISSED') continue;
    const sha = r.body?.match(RE_REVIEWED)?.[1];
    if (sha) verdicts.push({ sha: sha.toLowerCase(), kind: 'review', when: r.submitted_at });
  }
  for (const c of comments) {
    if (c.user?.login !== CODEX_LOGIN) continue;
    const sha = c.body?.match(RE_REVIEWED)?.[1];
    if (sha) verdicts.push({ sha: sha.toLowerCase(), kind: 'comment', when: c.created_at });
  }

  const fresh = verdicts.find((v) => headSha.startsWith(v.sha));
  const latest = verdicts.reduce((a, b) => (!a || (b.when ?? '') > (a.when ?? '') ? b : a), null);

  if (fresh) {
    const message = `Codex reviewed head ${short(headSha)} (${fresh.kind} at ${fresh.when ?? 'unknown time'})`;
    console.log(`✓ ${message}`);
    if (POSTING) await postStatus(headSha, 'success', message);
    process.exit(0);
  }

  console.error(`❌ codex-freshness: no Codex verdict covers the current head ${short(headSha)}.`);
  console.error(
    latest
      ? `   Latest verdict is a ${latest.kind} for ${short(latest.sha)} at ${latest.when ?? 'unknown time'}.`
      : `   No Codex verdict found on PR #${prNumber} at all.`,
  );
  console.error('   Comment "@codex review" on the PR; the status refreshes when Codex answers.');
  if (POSTING) {
    await postStatus(
      headSha,
      'failure',
      `No Codex verdict for head ${short(headSha)} — comment "@codex review"`,
    );
    process.exit(0); // the red status is the report; the job itself ran fine
  }
  process.exit(1);
} catch (err) {
  indeterminate(err);
}
