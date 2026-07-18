# Working Agreement — How Decisions Get Made

Wynding is built **AI-first**: an owner directing AI coding agents, with human
contributors welcome. This document defines **who decides what** — so an agent knows when
to proceed on its own judgment, when to decide _together_ with the owner, and when to stop
and defer. It's the companion to [ai-workflow.md](ai-workflow.md): that doc is _how work
flows_; this one is _who decides_. The project's engineering values live in
[engineering-principles.md](engineering-principles.md).

Being explicit about this is itself a feature of an AI-first project — it says out loud how
much autonomy the agents have, and where the human keeps the wheel.

**Two things this is _not_:**

- **Not the ship mechanism.** Every change — no matter who decided it — ships through the
  PR + review gate: CI `verify`, automated review, and owner approval on protected `main`.
  Deciding autonomously never means bypassing review; it means not stopping to ask before
  drafting the change.
- **Not fixed forever.** This is a living calibration; we tune it as the working
  relationship and the project mature.

## The four levels

Every kind of decision sits at one of four levels, from most agent autonomy to least:

- 🟢 **Auto — my call.** The agent decides and acts; the owner sees it in the PR/report.
  **Technical implementation lives here** — the owner never gets asked about it.
- 🟡 **Notify — my call, reversible.** The agent acts, but flags it _prominently_ so the
  owner can reverse it. For low-stakes, reversible player-facing choices.
- 🔵 **Co-own — our call.** The agent and owner decide _together_: the agent brings options
  and a plain-language recommendation, they weigh the product-level tradeoffs, and agree the
  path before committing. **Architecture lives here.**
- 🔴 **Owner — the owner's call.** The owner decides. The agent informs and recommends but
  doesn't act until the owner calls it.

**Default when uncertain: bias to autonomy.** If a call is reversible and cheap-if-wrong,
act and report rather than ask — the owner would rather correct occasionally than be pinged
constantly. Escalate up the ladder as reversibility drops and cost rises.

## The matrix

| Decision                                                                                                                                        | Level                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Technical implementation — data structures, patterns, file layout, "singleton or not," refactors, tests, formatting                             | 🟢 Auto                  |
| Documentation drafts                                                                                                                            | 🟢 Auto                  |
| Dev-only / free-tier / local experimentation                                                                                                    | 🟢 Auto                  |
| Low-stakes, reversible player-facing choices — UX micro-decisions, visual defaults, on-screen copy                                              | 🟡 Notify                |
| Mid-build scope re-planning where only the _how_ changes                                                                                        | 🟡 Notify                |
| Architecture — system structure, seams, the determinism/replay contract, save/data formats, backend service choices, cross-cutting dependencies | 🔵 Co-own                |
| Vision & feature prioritization                                                                                                                 | 🔴 Owner                 |
| Product / creative _rules_ — economy, win/lose conditions, core mechanics, game modes, what towers and creeps fundamentally do                  | 🔴 Owner                 |
| Balance & numeric tuning — creep HP, tower cost/damage, wave pacing                                                                             | 🔴 Owner (standing gate) |
| External / irreversible actions — publishing, releases, spending real money, licensing changes, public posts in the owner's voice               | 🔴 Owner                 |

## The rules that make the matrix work

### Architecture is co-owned, not audited

Co-own doesn't mean the owner reviews pointer arithmetic. It means the agent surfaces
architecture as **product-legible tradeoffs** — cost, lock-in, longevity, moddability,
platform reach — with a clear recommendation, and the two agree the path. The owner owns the
product; the agent owns the technical depth. Routine structural mechanics that _don't_ shape
those tradeoffs are just implementation (🟢 Auto).

### One-way doors are time-dependent

Pre-launch — with no live saves, replays, or scores in the wild — almost _everything_ is
reversible; a format change breaks nobody. So the architecture bar sits **loose now and
tightens automatically at and after launch**, when formats and the determinism contract
become load-bearing for real player data. Same rule, applied more strictly as we ship.

### Scope: stop only if the goal changes

When an agent hits a wall mid-build — a bet is bigger than scoped, or a chosen approach
fails — it re-plans the _how_ freely and keeps moving, flagging the change. It stops and
defers only if the bet's **goal or player-facing outcome** would change. No idle waiting on
reversible course corrections.

### The creative seam: player-facing is generally the owner's

Player-facing choices generally belong to the owner (🔴). The exception: **low-stakes,
reversible** ones (UX micro-decisions, visual defaults, copy) — the agent picks a sensible
default and follows up after (🟡 Notify), because the owner isn't a UX specialist and would
rather the agent move. The tiebreak when a choice is ambiguous: _would this surprise or
embarrass the owner if they only saw it after the fact?_ If yes, raise it.

### Balance is the owner's standing gate

Balance is the heart of the game, so it **never merges without the owner's sign-off** —
indefinitely, community or not. One accountable arbiter is what keeps balance coherent and
protects "fairly tuned, never pay-to-win" from capture. This reconciles with the
community-tuned vision in three moves:

- **The community proposes** — issues, play data, and balance PRs are welcome and
  encouraged.
- **Automated guardrails screen** — regression sims and balance invariants (no unwinnable
  wave, no dominant-strategy collapse) give fast signal on every proposal.
- **The owner arbitrates** — the final sign-off is always the owner's.

The guardrails exist to make the owner's review _cheap_, not to bypass it. The deliberate
tradeoff: balance throughput is bounded by the owner's availability — velocity traded for
coherence, on the thing that matters most.

---

See also [ai-workflow.md](ai-workflow.md) (how work flows),
[engineering-principles.md](engineering-principles.md) (the values behind the work), and the
per-maintainer operating profiles in [operators/](operators/). "Owner" means the project
maintainer; contributors inherit the same gates via the PR + review path.
