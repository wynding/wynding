# Wynding — Roadmap

_The middle of Wynding's planning hierarchy: [vision](vision.md) → **roadmap** →
[PRDs](prd/README.md). The vision says **why** and what-forever; PRDs pin **how**
per feature; this roadmap sets the **sequence** and the **MVP cut** between them. It
names milestone **outcomes and boundaries**, not mechanics, and changes as we learn
— especially once the first slice is in players' hands._

## The cut: ship the thinnest playable slice first

**M1 is the MVP — the first public release.** The fastest path to a real, playable
board, put in front of people to learn one thing: **is the core optimization loop
actually fun?** What comes after M1 is sequenced _from that answer_ — the two
milestones that follow are an **unordered pair** (below), and M1's feedback picks
which ships first.

This is a Lean bet: validate the soul of the game — the "aha" re-solve, the
optimizer's climb — before investing in the heavier systems (server ladder,
cross-platform, mods).

**A note on the word "MVP."** This roadmap _sets_ the MVP cut (its job in the
hierarchy): **M1 is the MVP.** ADR 0008 predates it and used "MVP" for its
persistence scope (settings, campaign progress, best-scores and seeds); that scope
lands with the **Single-player game** milestone below, and ADR 0008 has been
reconciled to say so. M1 is deliberately thinner; the ADRs' underlying _decisions_
are unchanged.

## Milestones

### M0 — Foundation

The deterministic core and its CI gate (ADRs 0001–0008 and the design-notes) —
**done**: the sim is byte-deterministic and gated before any gameplay builds on it.
**Still open:** the ADR 0005 performance spike — validating the performance bet on
the low-end target and wiring the performance gate — which rides with M1's first
real production build.

### M1 — Playable slice _(the MVP / first release)_

One authored board and the maze-building core loop: the player shapes the maze to
route creeps to the exit, and wins or loses a single board. **Web only.** Because it
is a public release, M1 meets the day-one bars the ADRs tie to the first UI: the
**accessibility standard and its release gate (ADR 0003)**, and **externalized
strings for localization (ADR 0004)** — translated locales themselves come later.
(Whether M1 persists anything at all — e.g. a local best-score — is a Core Gameplay
PRD call; any real persistence uses the ADR 0008 envelope and lands with
Single-player.)

- **Goal:** prove the core loop is fun.
- **Not in M1:** campaign, cloud save, leaderboard, other platforms, mods.

## After M1 — an unordered pair _(M1's feedback picks the order)_

### Single-player game

The full solo experience: multiple boards and campaign progression, plus persistent
progress — the settings, campaign-progress, and best-scores-and-seeds scope that ADR
0008 calls its "MVP" lands here — with audio and the first translated locales (ADR
0004 launches English-only).

### Competitive ladder

A competitive leaderboard whose scores can't be faked, **backed by the official
ruleset** — the canonical competitive spine, stewarded by the maintainer (ADR 0006
holds the anti-cheat how). Community rulesets, once the **Community & mods**
milestone opens them, get their _own_ leaderboard buckets and never move the
official ladder. This is where the determinism investment pays off.

## Later

### Reach

Mobile and desktop / Steam builds, all from the one web core — no parallel native
ports (ADR 0001).

### Community & mods

The ruleset format (ADR 0007) opened to community rulesets and mods, delivering
their own leaderboard buckets and the working agreement's "community proposes →
guardrails screen → owner arbitrates" flow. This is the vision's engine of
longevity.

### Multiplayer _(vision horizon)_

Competitive play beyond the leaderboard. Deliberately far out; the shared
deterministic sim keeps the door open without committing to it now.

## What this roadmap deliberately doesn't do

- **No dates.** Sequence, not schedule — a community-paced open-source project.
- **No forced order on the post-slice pair.** The single-player game and the
  competitive ladder are siblings; M1's feedback picks which ships first, so they
  are named rather than numbered.
- **No new mechanics or numbers.** Milestones name outcomes and boundaries; the ADRs
  hold the structural decisions and the PRDs decide the mechanics — starting with
  the Core Gameplay PRD for the M1 slice.
