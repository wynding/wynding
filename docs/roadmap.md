# Wynding — Roadmap

_The middle of Wynding's planning hierarchy: [vision](vision.md) → **roadmap** →
[PRDs](prd/README.md). The vision says **why** and what-forever; PRDs pin **how**
per feature; this roadmap sets the **sequence** and the **MVP cut** between them. It
names milestone **outcomes and boundaries**, not mechanics, and changes as we learn
— especially once the first slice is in players' hands._

## The cut: ship the thinnest playable slice first

**M1 is the MVP — the first public release.** The fastest path to a real, playable
board, put in front of people to learn one thing: **is the core optimization loop
actually fun?** Everything past M1 is sequenced _after_ that answer — we
deliberately do **not** pre-commit the M2-vs-M3 order until real feedback is in.

This is a Lean bet: validate the soul of the game — the "aha" re-solve, the
optimizer's climb — before investing in the heavier systems (server ladder,
cross-platform, mods).

**A note on the word "MVP."** This roadmap _narrows_ the MVP boundary. Where ADR
0008 says "MVP" for its persistence scope (settings, campaign progress, best-scores
and seeds), that scope lands at **M2** here; M1 is deliberately thinner. The ADRs'
underlying _decisions_ are unchanged — this only sets where each first applies.

## Milestones

### M0 — Foundation ✅ _(done)_

The deterministic core and its CI gate (ADRs 0001–0008 and the design-notes). The
sim is byte-deterministic and gated _before_ any gameplay is built on it.

### M1 — Playable slice _(the MVP / first release)_

One authored board and the maze-building core loop: the player shapes the maze to
route creeps to the exit, and wins or loses a single board. **Web only.**
Optionally a **local** best-score per board (no server). Because it is a public
release, M1 meets the day-one bars the ADRs tie to the first UI: the
**accessibility standard and its release gate (ADR 0003)**, and **externalized
strings for localization (ADR 0004)** — translated locales themselves come later.

- **Goal:** prove the core loop is fun.
- **Not in M1:** campaign, cloud save, leaderboard, other platforms, mods.

### M2 — Single-player game

The full solo experience: multiple boards and campaign progression, plus persistent
progress — the settings, campaign-progress, and best-scores-and-seeds scope that
ADR 0008 calls its "MVP" lands here — with audio and the first translated locales
(ADR 0004 launches English-only).

### M3 — Competitive ladder

Submitted replays re-validated server-side for trusted scores (ADR 0006), with
per-ruleset leaderboards **backed by the official ruleset** — the canonical
competitive spine, stewarded by the maintainer. Community rulesets get their _own_
leaderboard buckets and never move the official ladder. This is where the
determinism investment pays off: trusted scores, anti-cheat by construction.

### M4 — Reach

Mobile and desktop / Steam builds wrapping the one canonical web core (ADR 0001) —
no parallel native codebases.

### M5 — Community & mods

The ruleset format (ADR 0007) opened to community rulesets and mods, with their own
leaderboard buckets and the working agreement's "community proposes → guardrails
screen → owner arbitrates" flow. This is the vision's engine of longevity.

### M6 — Multiplayer _(vision horizon)_

Competitive play beyond the leaderboard. Deliberately far out; the shared
deterministic sim keeps the door open without committing to it now.

## What this roadmap deliberately doesn't do

- **No dates.** Sequence, not schedule — a community-paced open-source project.
- **No pre-committed M2-vs-M3 order.** Decided from M1's feedback.
- **No new mechanics or numbers.** Milestones name outcomes and boundaries; the ADRs
  hold the structural decisions and the PRDs decide the mechanics — starting with
  the Core Gameplay PRD for the M1 slice.
