# Working with AI Agents — Wynding's Build Methodology

Wynding is built **AI-first**: most code is written by AI coding agents (Claude Code,
Codex, Cursor, Aider, …) under human direction, review, and judgment. Human-written code
is welcome too. This document is the **tool-agnostic playbook** — the _process_ is the
source of truth; any skills/automation just make it faster.

> New here? Read [../AGENTS.md](../AGENTS.md) (the hard rules) and
> [../CONTRIBUTING.md](../CONTRIBUTING.md) (setup + license) first. For **who decides what**
> — when an agent proceeds autonomously, co-owns, or defers to the owner — see
> [working-agreement.md](working-agreement.md); for the values behind the work, see
> [engineering-principles.md](engineering-principles.md).

## The loop: Plan → Build → Verify → Review → Ship

### 1. Plan — grill-me → PRD

Before non-trivial work, run a **grill-me** interview: have the agent interrogate you one
question at a time — recommending an answer for each, exploring the code when it can answer
itself — until every branch of the decision tree is resolved. Distill the result into a
short **PRD** in `docs/prd/`, and record any genuinely hard-to-reverse decision as an
**ADR** in `docs/adr/` (high bar — not routine choices). Keep terminology consistent with
[CONTEXT.md](CONTEXT.md). This front-loads the ambiguity so the agent builds the right
thing, and makes the spec — not the prompt — the durable artifact. (Grill-me is Matt
Pocock's technique.)

### 2. Build — test-first, small steps

Work in the smallest package that owns the concern. Prefer **TDD / tracer bullets**: write
a failing test, make it pass, refactor — one small deliberate step at a time. In the
deterministic core (`engine`/`sim`/`replay`) a bug almost always has a minimal seeded
reproducer; a failing `sim` test beats a console log.

### 3. Verify — the local gate (identical to CI)

`pnpm run verify` must be green before you push (`format:check` + `typecheck` + `lint` +
`test` with coverage, plus the root guards — i18n, dependabot config, glossary, scripts
lint). Two gates are hard:

- **Determinism** — same `(seed, ruleset, inputs)` → byte-identical state; the
  world-hash / replay tests must pass. Lint bans `Math.random`/`Date`/`performance` in the
  core.
- **Coverage** — `engine`/`sim`/`replay` ≥ 90% lines+branches.

Only deterministic artifacts certify anything — CI, goldens, schema validation, linters. A
quiet review bot is a sample, not a certificate. So a finding class that a script can settle
becomes a script: `check:glossary` greps the docs that carry the game's vocabulary (the glossary,
vision, roadmap, PRDs, milestone specs) for the `_Avoid_:` terms in [CONTEXT.md](CONTEXT.md), so
terminology drift is caught in one local run instead of round-tripping through code review. ADRs
and design-notes are deliberately outside it — engineering prose uses those same words in their
ordinary technical senses. Different senses are real inside the scope too ("hit points",
"flow-field", "core loop"); each is allowed by an entry — with a stated reason — in
`scripts/glossary-lint.config.json`, never by loosening the script.

### 3.5. QC before every push

Verify proves the code runs; it cannot tell you the change is right. Before **every** push to a
PR branch — initial or review-response, any size — run the **adversarial QC loop** over the
push's delta:

1. **Independent adversarial reviewers** examine the delta — for code: code-review,
   test-quality, and silent-failure lenses; for docs-only deltas: a coherence pass checking each
   patched paragraph **upward** against the PRD/ADRs it touches (the higher document wins) and
   **sideways** against its sibling patches. Reviewers are told to find problems, not to approve.
2. **Adjudicate every finding against the code** — fixed, or declined with a stated reason,
   never silently dropped — apply the fixes, and **re-run the loop with fresh eyes** until a
   round yields nothing real.
3. The loop's final act writes the evidence file (below).

The mechanical gate (`pnpm run verify`, e2e where touched) is necessary but is **not** the QC
loop. Review-fix pushes need the loop most, because patching one finding at a time is what
authors contradictions.

**Calibrate depth to the delta, and say so.** Full panel for behavior changes; a single reviewer
is enough for a comment-only or docs-only delta. State the calibration where the owner can see
it — as the note on the `QC:` trailer line (e.g. `QC: <tree-sha> 2 rounds, 3 reviewers, full
panel`) — so a too-shallow loop can be vetoed per-PR rather than discovered per-incident. (The
hook accepts a bare trailer — the note is process, not mechanics; loop pushes carry it so the
depth is visible.)

**If reviewers may mutate the tree** (mutation testing — proving a test can fail): at most ONE
mutation-authorized reviewer per worktree at a time; read-only reviewers experiment on throwaway
copies (`$TMPDIR`), never on the tree; and after every reviewer round, verify the state.
`git diff HEAD --stat` catches an edit left in the working tree only if you know what its output
should be (a same-size swap inside an already-dirty file changes no summary line), and it cannot
see a mutation committed or amended into `HEAD`, or one under a gitignored path — so confirm
`HEAD` is where you left it **and** grep each mutation target for its restored text.

A `pre-push` hook requires a record that the loop happened. It refuses any push whose
destination is a branch other than `main` (deletions and tags excepted) unless both records
exist for exactly the state being pushed:

- the tip commit carries a **QC record** — a `QC:` trailer holding that commit's own tree
  hash (a ≥ 7-char prefix of it is accepted) — and
- **loop evidence** exists at `.claude/qc-evidence/<tree-sha>.json` for that same tree, written
  as the loop's final step with its real tallies:

```json
{
  "treeSha": "<full tree sha>",
  "rounds": 2,
  "findingsRaised": 5,
  "findingsFixed": 4,
  "findingsDeclined": 1,
  "reviewers": ["code-review", "test-quality", "silent-failure"]
}
```

All six fields are required and the tallies must balance — `findingsRaised` equals
`findingsFixed` + `findingsDeclined`, because every finding is fixed or declined, never
dropped; extra keys are ignored. The evidence file stays local (`.claude/` is gitignored — it
describes a working process, not the product); the PR-visible summary is the trailer note. A human pushing a self-reviewed change
records their own pass the same way (`"reviewers": ["<your-name>"], "rounds": 1`).

```bash
git add -A
# ... run the loop; write .claude/qc-evidence/$(git write-tree).json ...
git commit -m "$(printf 'docs(prd): fix the thing\n\nQC: %s 1 round, docs pass\n' "$(git write-tree)")"
```

`git write-tree` prints the hash of the staged tree, which is the tree the commit gets — so an
honest record costs one substitution, and neither record can be recycled: edit anything
afterwards and the hashes stop matching, which is exactly when the pass is stale. Already
committed? Amend it with `git commit --amend --no-edit --trailer "QC=$(git write-tree)"` (git
2.32+). `pnpm install` wires the hook by pointing `core.hooksPath` at the tracked `.githooks/`
directory — unless another tool already owns that setting (reconcile, then run
`git config core.hooksPath .githooks` yourself) **or** hooks already exist in the repo's shared
hooks directory (move them into `.githooks/` first, or chain-load ours from yours — it reads
git's stdin protocol, so invoke it **before** anything else consumes stdin; a wrapper that
drains the pipe would leave the gate announcing "no refs on stdin" and gating nothing). The
install says which case it hit and leaves both alone.

Both records are claims, not proofs — they say the pass and the loop happened, where a reviewer
can see the claim. Their value is the boundary: a step checked at push time gets done; a step
nothing checks gets skipped exactly when attention is consumed by the incident of the day.
**Emergencies only**, and never as a habit (the rationale is required, and must be at least 15
characters — long enough to be a reason rather than a keystroke; it covers both records):

```bash
QC_OVERRIDE="hotfix for the broken deploy; QC follows in the next push" git push
```

It is printed, appended best-effort to a local `.claude/qc-evidence/overrides.log`, and worth
repeating in the PR thread — the commits will not carry it. A rationale under 15 characters is
ignored with a note, and a push the gate passes on its own merits ignores the variable
entirely. If the hook itself cannot run (`node` missing from a GUI client's PATH, a broken
checkout), the last resort is `git push --no-verify` — then fix the hook.

**Push ritual, four inseparable steps:** adversarial QC loop → mechanical gate → `QC:` trailer
(+ evidence file) → push + review trigger (§4).

### 4. Review — two models + owner

Every PR is reviewed independently by **Codex** and **CodeRabbit**, plus the owner.
Reviewers see the diff, not the task description. Address findings; resolve threads.

Findings are graded [**P0–P3**](CONTEXT.md) by impact. **P0–P2 must be fixed, or the
thread resolved with a stated reason** — declining is a legitimate outcome, silence is
not. **P3 is advisory.**

An **automated** review loop gates differently from a human: it blocks on **P0/P1 only**
and reports P2/P3 for a person to triage. Not because P2s are unimportant — they are real
bugs, and the tier most findings land in — but because a loop cannot resolve a thread with
a reason, so gating it on P2 gates it on nearly everything and it never converges. A loop may
**decline** a P1/P2/P3 it judges out of bounds, but only with a reason code and a
citation; a **P0 always escalates to the owner** and is never auto-declined.

**Working the loop.** Codex does not auto-review pushes — it reviews when a PR opens, when a
draft goes ready, or when someone comments `@codex review`. After a push to a non-draft PR,
the `codex-review-request` workflow posts that comment for you (post it yourself if it
didn't — drafts are deliberately excluded, since going ready self-triggers a review), and
the `codex-freshness` status is only green when a Codex verdict — its review (the head it
reviewed is the API-recorded one) or its "no major issues" comment (which prints a
`Reviewed commit:` sha) — covers the **current** head. The status
proves "Codex reviewed this exact commit", no more: "Codex clean" additionally means that
review raised nothing left unaddressed (fixed, or declined in a resolved thread). Neither claim
is ever an interpreted silence — reviewer silence is not approval. If Codex reports an
infrastructure error, re-trigger with a fresh `@codex review`.

Watch the loop with the repo watcher — don't hand-roll a poller:

```bash
node scripts/watch-pr.mjs <pr-number>
```

One `gh` call per cycle, every poll failure is an emitted event, and a periodic heartbeat line
proves the watcher itself is alive. If its output stops entirely, the watcher is dead —
restart it (heartbeats pause during failure streaks; you see POLL_ERROR lines instead); never
read a watcher's silence as "no news".

**Report pace, not just results.** While any gate is pending (CI, a bot review, a QC round): if
~30 minutes pass with no progress visible from the PR side, proactively tell the owner where
things stand — current state, the blocker, the options — instead of grinding silently;
slow-but-converging and wedged look identical from the outside. And on the second consecutive
infrastructure failure of the same sub-task (a reviewer agent, a CI job), stop relaunching and
report the pattern with a recommendation rather than paying a third runtime.

### 5. Ship — gated + staged

**Merge gate:** merge is blocked until **green CI AND a Codex review of the current head (the
`codex-freshness` status, binding once in the branch-protection required contexts — maintainer
setup below) with its findings addressed AND CodeRabbit approved AND owner approval** (all
review threads resolved). **Deploy:** merge to `main`
auto-deploys the web build to a staging URL; a human manually promotes to prod (web on AWS
S3 + CloudFront). Mobile/desktop ship as tagged releases.

## Tooling setup

Your agent-tooling directory (`.claude/`, `.cursor/`, …) is **gitignored** — skills are
_tooling_, not project code, so we don't vendor them. Install what your harness needs
locally.

### Claude Code

- **Pocock's skills** (grill-me, TDD helpers, structured refactor) — MIT, upstream at
  [`mattpocock/skills`](https://github.com/mattpocock/skills); install via the
  `/setup-matt-pocock-skills` skill. **Don't copy them into the repo** — pull them, so you
  get upstream fixes and don't fork someone else's work into our commits.
- **The review/ship gate** is described in steps 4–5 above. If you want it automated as a
  local skill, wrap that process (a thin loop over `gh` + the two reviewers) and keep it in
  your gitignored `.claude/` — not in a commit.

### Codex / Cursor / Aider / other

The same loop applies. This document and [../AGENTS.md](../AGENTS.md) (read natively by most
agents) are the contract — adapt the grill / verify / review steps to your harness.

## Services the full gate depends on (maintainer setup)

- A **GitHub remote** + branch protection on `main` (required checks + reviews).
- `codex-freshness` in the branch-protection **required contexts** — the workflow posts the
  status either way; only the contexts list makes it block merges. Order matters: the
  workflows must be on `main` before the context is required — `pull_request_target` and
  `issue_comment` always run the copy on `main`; `workflow_dispatch` needs the file on
  `main` to be dispatchable but executes the copy at the ref it is aimed at; only
  `pull_request_review` runs the PR merge ref's copy (observed live on PR #71) — and each
  PR already open at wiring time needs one manual dispatch to seed its status.
- The **CodeRabbit** GitHub app installed on the repo.
- **Codex** available for review (and the grill / plan loops).

## The rule that matters most

Whatever tool you use: **you own what you submit.** "The AI wrote it" is not an answer to a
reviewer's question. Disclose heavy AI involvement in the PR description — we're curious
what works.
