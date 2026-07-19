# Wynding — Roadmap

_The middle of Wynding's planning hierarchy: [vision](vision.md) → **roadmap** →
[PRDs](prd/README.md). The vision says **why** and what-forever; PRDs pin **how**
per feature; this roadmap sets the **sequence** and the **MVP cut** between them.
It changes as we learn — especially once the first slice is in players' hands._

## The cut: ship the thinnest playable slice first

**M1 is the MVP — the first public release.** The fastest path to a real, playable
board, put in front of people to learn one thing: **is the core optimization loop
actually fun?** Everything past M1 is sequenced _after_ that answer — we
deliberately do **not** pre-commit the M2-vs-M3 ordering until real feedback is in.

This is a Lean bet: validate the soul of the game — the "aha" re-solve, the
optimizer's climb — before investing in the heavier systems (server ladder,
cross-platform, mods).

## Milestones

### M0 — Foundation ✅ _(done)_

Monorepo and stack (ADR 0001); the determinism engine (seeded RNG, fixed-point,
fixed 20 Hz tick, world-hash); ADRs 0001–0008; design-notes; and the determinism
CI gate. The sim is byte-deterministic and gated _before_ any gameplay is built on
it.

### M1 — Playable slice _(the MVP / first release)_

One authored board. The maze-building loop: towers _are_ the walls; creeps take
the shortest remaining path to the exit; the player places, sells, and upgrades
towers to shape the maze. Waves and balance come from a ruleset (ADR 0007);
economy (bounty, lives); win and loss. **Web only.** Optionally a **local**
best-score per board (no server).

- **Goal:** prove the core loop is fun.
- **Not in M1:** campaign, cloud save, leaderboard, other platforms, mods.

### M2 — Single-player game

Multiple boards; campaign progression; save of meta-progress (ADR 0008); settings
(accessibility per ADR 0003, audio, controls, locale per ADR 0004). A complete
solo experience.

### M3 — Competitive ladder

The `apps/server` re-sim validator; replay recording and submission (ADR 0006);
per-ruleset leaderboards **backed by the official ruleset** — the canonical
competitive spine, stewarded by the maintainer. Community rulesets get their _own_
leaderboard buckets; they never move the official ladder's goalposts. This is where
the determinism investment pays off: trusted, re-simulated scores; anti-cheat by
construction.

### M4 — Reach

Mobile (Capacitor) and desktop / Steam (Tauri) wrapping the canonical web core
(ADR 0001) — no parallel native codebases.

### M5 — Community & mods

Expose the ruleset format (ADR 0007) for community rulesets and mods; mod
leaderboard buckets; the working agreement's "community proposes → guardrails
screen → owner arbitrates" flow. This is the vision's engine of longevity.

### M6 — Multiplayer _(vision horizon)_

Real-time or async competitive play. Deliberately far out; the shared deterministic
sim keeps the door open without committing to it now.

## What this roadmap deliberately doesn't do

- **No dates.** Sequence, not schedule — a community-paced open-source project.
- **No pre-committed M2-vs-M3 order.** Decided from M1's feedback.
- **No mechanics or numbers.** That's the PRDs' job — starting with the Core
  Gameplay PRD for the M1 slice.
