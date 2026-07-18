# Working with AI Agents — Wynding's Build Methodology

Wynding is built **AI-first**: most code is written by AI coding agents (Claude Code,
Codex, Cursor, Aider, …) under human direction, review, and judgment. Human-written code
is welcome too. This document is the **tool-agnostic playbook** — the _process_ is the
source of truth; any skills/automation just make it faster.

> New here? Read [../AGENTS.md](../AGENTS.md) (the hard rules) and
> [../CONTRIBUTING.md](../CONTRIBUTING.md) (setup + license) first.

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
`test` with coverage). Two gates are hard:

- **Determinism** — same `(seed, ruleset, inputs)` → byte-identical state; the
  world-hash / replay tests must pass. Lint bans `Math.random`/`Date`/`performance` in the
  core.
- **Coverage** — `engine`/`sim`/`replay` ≥ 90% lines+branches.

### 4. Review — two models + owner

Every PR is reviewed independently by **Codex** and **CodeRabbit**, plus the owner.
Reviewers see the diff, not the task description. Address findings; resolve threads.

### 5. Ship — gated + staged

**Merge gate:** merge is blocked until **green CI AND Codex clean AND CodeRabbit approved
AND owner approval** (all review threads resolved). **Deploy:** merge to `main`
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
- The **CodeRabbit** GitHub app installed on the repo.
- **Codex** available for review (and the grill / plan loops).

## The rule that matters most

Whatever tool you use: **you own what you submit.** "The AI wrote it" is not an answer to a
reviewer's question. Disclose heavy AI involvement in the PR description — we're curious
what works.
