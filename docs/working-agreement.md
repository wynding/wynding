# Working Agreement — How Decisions Get Made

Wynding is built **AI-first**: an owner directing AI coding agents, with human
contributors welcome. This document defines **who decides what** — so an agent knows when
to proceed on its own judgment and when to stop and get the owner's call. It's the
companion to [ai-workflow.md](ai-workflow.md): that doc is _how work flows_; this one is
_who decides_.

Being explicit about this is itself a feature of an AI-first project — it says out loud how
much autonomy the agents have, and where the human keeps the wheel.

**Two things this is _not_:**

- **Not the ship mechanism.** Every change — no matter who decided it — ships through the
  PR + review gate: CI `verify`, automated review, and owner approval on protected `main`.
  "Decide autonomously" never means "bypass review." It means "don't stop to ask before
  drafting the change."
- **Not fixed forever.** This is a living calibration; we tune it as the working
  relationship and the project mature.

## The three levels

Every kind of decision sits at one of three levels:

- 🟢 **Auto** — the agent acts; the owner sees it in the PR/report. No pre-check.
- 🟡 **Notify** — the agent acts, but flags it _prominently_ so the owner can reverse it.
  For two-way doors that are mildly consequential.
- 🔴 **Ask** — the agent stops and gets the owner's decision _before_ acting. For one-way
  doors, external actions, and creative rules.

**Default when uncertain: bias to autonomy.** If a call is reversible and cheap-if-wrong,
act and report rather than ask — the owner would rather correct occasionally than be pinged
constantly. Escalate toward Ask as reversibility drops and cost rises.

## The matrix

| Decision                                                                                                                           | Level                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Routine implementation — code structure within a package, tests, internal naming, small refactors, formatting                      | 🟢 Auto                        |
| Documentation drafts                                                                                                               | 🟢 Auto                        |
| Dev-only / free-tier / local experimentation                                                                                       | 🟢 Auto                        |
| Player-observable choices that aren't design _rules_ — tower/projectile visuals, UI interactions, sounds, defaults, on-screen copy | 🟡 Notify                      |
| Two-way-door architecture — reversible structural calls                                                                            | 🟡 Notify                      |
| Mid-build scope re-planning where the _how_ changes                                                                                | 🟡 Notify                      |
| One-way-door architecture — save/replay formats, the determinism contract, backend service choices, cross-cutting dependencies     | 🔴 Ask                         |
| Product / creative _rules_ — economy, win/lose conditions, core mechanics, game modes, what towers and creeps fundamentally do     | 🔴 Ask                         |
| Balance & numeric tuning — creep HP, tower cost/damage, wave pacing                                                                | 🔴 Ask (owner's standing gate) |
| External / irreversible actions — publishing, releases, spending real money, licensing changes, public posts in the owner's voice  | 🔴 Ask                         |

## The rules that make the matrix work

### One-way doors are time-dependent

Pre-launch — with no live saves, replays, or scores in the wild — almost _everything_ is
reversible; a format change breaks nobody. So the architecture gate sits **loose now and
tightens automatically at and after launch**, when formats and the determinism contract
become load-bearing for real player data. It's the same rule, applied more strictly as we
ship.

### Scope: stop only if the goal changes

When an agent hits a wall mid-build — a bet is bigger than scoped, or a chosen approach
fails — it re-plans the _how_ freely and keeps moving, flagging the change. It stops and
asks only if the bet's **goal or player-facing outcome** would change. No idle waiting on
reversible course corrections.

### The creative seam: player-observable ⇒ Notify

Anything a player can see or feel, the agent builds a sensible default and flags it
prominently for the owner to react to. It only _asks first_ when the choice is a genuine
design **rule** (economy, win/lose, core mechanics) or is genuinely hard to reverse.
Internal-only changes stay Auto. The tiebreak when a choice is ambiguous: _would this
surprise or embarrass the owner if they only saw it after the fact?_ If yes, Notify or Ask.

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

See also [ai-workflow.md](ai-workflow.md) (how work flows) and
[../CONTRIBUTING.md](../CONTRIBUTING.md) (setup + license). "Owner" here means the project
maintainer; contributors inherit the same gates via the PR + review path.
