# Wynding — Roadmap

_The middle of Wynding's planning hierarchy: [vision](vision.md) → **roadmap** →
[PRDs](prd/README.md). The vision says why and what-forever; PRDs pin how per
feature; this roadmap sets the **phase sequence** and the **release cut** between
them. It names outcomes and boundaries, not mechanics, and changes as we learn._

## How we plan & ship

Two axes — one for how we build, one for what we ship (canonical definitions live
in the glossary, [CONTEXT.md](CONTEXT.md)):

- **Build ladder — Phase ▸ Milestone ▸ Story.** A **phase** is a coherent stage,
  "what the game _is_" then; **milestones** are feature-sized capabilities that
  roll up into a phase; a **story** is one focused, reviewable unit of work (≈ one
  PR ▸ commits).
- **Release axis.** A **release** is a public build, tagged by maturity — **alpha**
  (rough, expect breakage) → **beta** (stabilizing) → **stable**. The major number
  tracks the phase (Phase 1 → the **R1.x** line; R1.0 first stable, R1.1 a bugfix);
  early milestones ship as **alpha** builds ahead of the stable release.

**Every milestone is public and held to the day-one bars** the ADRs tie to the
first UI — the full accessibility gate (ADR 0003) and externalized strings for
localization (ADR 0004). We do not defer those to a later phase.

## Phase 1 — a solid, complete, fun single-player game → R1

One default board (a two-path board) taken from nothing to a game worth playing.
Milestones, in rough build order (each a public **alpha**):

- **M1 — first vertical slice:** one board, one tower, one wave, one creep type —
  playable end to end. The first thing we show people.
- **M2 — breadth:** more tower types, more creep types, more waves.
- **M3 — a full wave progression:** multiple waves of basic creeps — a complete run
  you can win or lose.
- **M4 — depth:** tower leveling and creep leveling.
- **M5 — economy:** tuned to the content. (A minimal economy exists from M1 — you
  need bounty to place a tower — and is _tuned_ across the phase, not bolted on at
  the end.)

**Release 1 (R1.0) is "done" when** there's a full winnable-and-loseable wave arc on
the default board, enough tower and creep variety that optimizing is genuinely
interesting, both leveling systems in, and an economy that forces real decisions —
solid, complete, and fun.

**Not in Phase 1:** persistence, leaderboard, additional or custom boards, mods,
native builds, multiplayer.

## Phase 2 — persistence & more boards → R2

Saved progress (ADR 0008 — settings, campaign progress, best-scores and seeds; this
is where that persistence scope actually lands) plus additional **official** boards.
Custom, player-made boards come with mods (Phase 4).

## Phase 3 — the competitive ladder → R3

Submitted runs re-validated server-side so scores can't be faked (ADR 0006), with
leaderboards **backed by the official ruleset** — the canonical competitive spine,
stewarded by the maintainer. It's the biggest system in the game, and it's
deliberately after single-player is solid. Community rulesets, once Phase 4 opens
them, get their _own_ buckets and never move the official ladder.

## Phase 4 — community & mods → R4

The ruleset format (ADR 0007) opened to community rulesets and mods — new towers,
creep types, economies, custom waves, and custom boards — with their own leaderboard
buckets and the working agreement's "community proposes → guardrails screen → owner
arbitrates" flow. This is the vision's engine of longevity.

## Phase 5 — distribution → R5

Mobile and desktop / Steam builds, all from the one web core — no parallel native
ports (ADR 0001).

## Phase 6 — multiplayer _(horizon)_ → R6

Competitive play beyond the leaderboard. Deliberately far out; the shared
deterministic sim keeps the door open without committing to it now.

## Architect now, build later

The ladder (ADR 0006), mods and custom content (ADR 0007's data-driven ruleset), and
persistence (ADR 0008) are **architected from the start** — the ADRs already decided
their shapes — so building each in its phase is wiring, not a redesign. We don't
build them early; we don't wall ourselves off from them either.

## What this roadmap deliberately doesn't do

- **No dates.** Sequence, not schedule — a community-paced open-source project.
- **No new mechanics or numbers.** Phases and milestones name outcomes and
  boundaries; the ADRs hold the structural decisions and the PRDs decide the
  mechanics — starting with the Core Gameplay PRD for M1.
