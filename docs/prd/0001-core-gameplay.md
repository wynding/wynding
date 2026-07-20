# PRD 0001 — Core Gameplay

- **Status:** Draft
- **Date:** 2026-07-19
- **Relates to:** [vision](../vision.md) · [roadmap](../roadmap.md) · [glossary](../CONTEXT.md) ·
  ADRs [0001](../adr/0001-monorepo-and-stack.md), [0003](../adr/0003-accessibility-standard.md),
  [0004](../adr/0004-localization-and-i18n.md), [0006](../adr/0006-input-command-and-replay-schema.md),
  [0007](../adr/0007-level-and-content-data-format.md), [0008](../adr/0008-save-format-and-versioning.md)

## Problem & goals

Wynding has a vision, a roadmap, and the technical decisions (ADRs) — but no defined
**gameplay**. This PRD pins the **shapes and invariants** of the core loop for **Phase 1**
(the single-player game that culminates in **Release 1**), with **M1** — the first public
alpha: one board, one tower, one wave, one creep — as the first concrete slice.

It decides **rules and shapes, not balance numbers.** Every quantity (hit points, damage,
costs, ranges, spawn timing, starting lives and bounty, the difficulty curves) is **tuned
per milestone (M1→M5)**; this document names _what varies and how it interacts_, so tuning
has a frame and the systems are born in their final shape.

**Goal:** a solid, complete, fun single-player maze-building tower defense — the player
shapes a route out of towers, defends an escalating wave arc, and earns a score worth
chasing. **Success** is the roadmap's R1 done-criteria: a winnable-and-loseable wave arc on
the default board, tower and creep variety that makes optimizing genuinely interesting, both
leveling systems in, and an economy that forces real decisions.

## Scope

### In — the Phase-1 core loop (this PRD)

The board and grid model and the maze invariant; the real-time loop rhythm; building,
selling, and dynamic re-pathing; combat; creeps and the damage model; the economy; win,
loss, and scoring; difficulty tiers; speed and pause; the accessibility posture.

### Out — later phases (architected here, built later)

Persistence and additional **official** boards (Phase 2, ADR 0008), the competitive ladder and
leaderboard (Phase 3, ADR 0006), **custom** boards and mods (Phase 4, ADR 0007), native builds
(Phase 5), and multiplayer (Phase 6). Also out: the specific **tower and creep rosters** and
**all balance numbers** — those are per-milestone content and tuning, not core-loop shape.

The systems below are deliberately shaped so those later features are **wiring, not
redesign**: the data-driven ruleset (ADR 0007) already expresses every tower/creep/economy
knob; scoring is computed sim-side so the ladder can re-derive it; persistence attaches to a
pure sim.

## Design

Terminology is the glossary's ([CONTEXT.md](../CONTEXT.md)) — **board, creep, tower, maze,
path, wave, lives, bounty, tick**. New canonical terms introduced here (**armor, domain,
difficulty tier, score, star grade**) are added to the glossary in this change.

### 1. Board, grid & the maze invariant

- The **board** is a fine grid of cells with one or more creep **entrances** and a single
  **exit**. It starts empty; the player shapes the route by building.
- Cells fall into three classes: **buildable-open** (a tower may be placed),
  **walkable-unbuildable** (creeps cross, towers cannot go — reserved for entrances/exit
  aprons and future scenery), and **blocked** (no tower may be placed and no **ground** creep may
  cross; flyers, which ignore board geometry, pass over).
- A **tower occupies a 2×2 block** of cells. A **creep is 1×1** and needs a single open cell
  to pass. Towers are also **walls** — placement and firepower are the same decision.
- **Movement is 8-connected with no corner-cutting:** creeps may step diagonally, but when
  two towers touch at a corner, that diagonal is **closed** — a creep cannot slip through the
  pinch. (Diagonal steps cost more path-distance than orthogonal ones; see Determinism.)
- **The maze invariant (hard rule):** the exit must remain reachable **from every entrance
  and from every live ground creep's current cell.** A build action that would violate this —
  sealing the exit, walling off an entrance, or trapping a creep in a pocket — is **rejected**
  before it applies. The player can lengthen the path arbitrarily but can never eliminate it.

### 2. Loop rhythm — continuous real-time

- The game runs in **real time**. The player may **build, sell, and re-maze at any moment,
  including mid-wave** — there is no separate build phase.
- Each **wave** arrives on a visible **countdown**. The player may **call the next wave
  early** to press an advantage; calling early pays a bonus (see Economy) and is a
  risk/reward tempo lever — the reward is real, but the board faces the new wave sooner.
- Waves may **overlap** on the field (an early call sends the next wave while the current one
  is still alive).

### 3. Building, selling & dynamic re-pathing

- **Placement** consumes bounty and drops a 2×2 tower onto buildable-open cells. A placement
  is legal only if it (a) covers no cell a **ground** creep currently occupies — _you may build
  adjacent to a ground creep, never on it_ — and (b) satisfies the maze invariant.
- **Dynamic re-pathing:** the instant the maze changes (a placement or a sell), **every ground
  creep re-routes** toward the exit along the new shortest path. This is the signature skill —
  the player herds and redirects the live wave by building and selling.
- **Selling** is always legal and instant: removing a tower only opens space, so it can never
  violate the maze invariant. The freed bounty is immediately spendable and creeps re-path that
  tick. Selling refunds a **partial haircut of the tower's cumulative investment** (base plus
  any upgrades); the haircut keeps placement a real economic decision. _(Haircut fraction:
  tuning.)_
- **There is no "move" action.** Relocating a tower is sell + rebuild (from base level). This
  preserves an emergent technique — **juggling**: dropping a cheap tower to redirect the wave,
  then selling it — and it means the player mazes with cheap towers and parks upgraded firepower
  in stable spots. _(A quality-of-life relocate may be revisited in a later phase; it is not a
  Phase-1 mechanic.)_
- **Tower leveling** (upgrading a tower in place) is a Phase-1 system that **activates at M4**;
  its shape is per-tower upgrade tracks, per-run only, with no permanent meta-progression.

### 4. Combat — scheduled impact events

- The sim never simulates a moving projectile. When a tower fires, it **schedules an impact
  event** at `fire_tick + travel_ticks`; the renderer draws a cosmetic projectile over the
  delay. The sim runs **no per-tick projectile physics** — cost doesn't scale with projectiles
  in flight (each shot is one scheduled event, not an integrated moving entity) — and combat is
  deterministic by construction (see Determinism).
- A scheduled impact carries a **fire-time snapshot** of its damage and effects — selling,
  upgrading, or re-buffing the source tower before the shot lands does not alter an impact
  already in flight.
- **Single-target** attacks are **target-locked**: the scheduled hit lands on that specific
  creep. If the creep **dies or leaks** before impact, the shot is **wasted** — no re-target ("you can't
  re-target a bullet").
- **Area (AoE)** attacks are **point-locked**: the impact is scheduled to a fixed board point,
  and on the impact tick it resolves against **whatever creeps are within the radius then**.
  Creeps can walk out of a blast (dodge) or into it (caught). **Aim leads the target** — the
  impact point is the target's position extrapolated forward **along its current route** (around
  corners, not a straight velocity vector); if the lead would run past the exit (the creep leaks
  before the shot lands), the impact point is **clamped to the exit** at the route's end. Long
  shots are less reliable _by design_: only a
  state change in flight (re-path, slow, stun, death) makes a lead miss, and that is the
  counterplay, not a bug.
- **Range is a circular radius** measured in fixed-point from the tower's 2×2 footprint **center**
  to the creep's point (Euclidean). A creep is _in range_ when that distance is within the tower's
  range and _leaves range_ by the same test. An AoE blast radius uses the same Euclidean
  point-distance test, measured from its fixed impact point. (Exact boundary rounding is a
  determinism-gated detail fixed with the combat sim.)
- **Targeting is sticky.** A tower acquires the creep that is **"first"** — the fewest steps
  from the exit (the smallest remaining path-distance, the creep most about to leak; ties break
  to the lower creep id) — and **holds that target until it dies or leaves range**, then
  re-acquires. It never swaps to a
  higher-priority creep mid-life. _(Player-selectable targeting priority — first/last/strong/
  weak — is a depth feature deferred to M4.)_
- **Effects compose.** A tower is a bundle of **effect primitives**, not a fixed archetype;
  any tower may carry any mix of:
  - **direct damage** (single-target or AoE),
  - **slow** (reduce creep speed for a duration),
  - **stun / freeze** (halt a creep; may be chance-based),
  - **damage-over-time (DoT)** (a lingering effect),
  - **support / buff** (boosts adjacent towers; no attack of its own),
  - **burst / single-use** (one high-impact discharge, then the tower consumes itself).

  So "an AoE tower that also slows," "a single-target slow," and "an AoE DoT" are all just
  data. This composability is the same machinery ADR 0007 opens to mods in Phase 4. _(Support
  and burst are the most optional of the set — droppable if a leaner roster identity is wanted.)_

- **Effect stacking rules** (shape, so combined effects read predictably):
  - Same effect from multiple sources → the **strongest magnitude wins**, and a new application
    refreshes the duration only when it is **at least as strong** as the active effect — a weaker
    hit neither extends nor overrides a stronger one, so cheap weak hits can't sustain a strong
    effect indefinitely.
  - **Stun overrides slow** while active.
  - Each **DoT source is independent** (two DoT towers apply two DoTs).

### 5. Creeps

- A creep walks from an entrance toward the exit. Creeps are **fine-grid points that may
  overlap freely** — there is no creep-creep collision, which is what makes splash and juggling
  read correctly. A creep "occupies" the cell containing its point (this is what the
  never-build-on-a-creep rule tests against).
- **Creeps vary along axes** (content picks specific creeps per milestone):
  - **speed** (e.g. normal / fast),
  - **durability** — hit points plus optional **armor**,
  - **domain** — **ground** or **flying**,
  - **effect-immunity flags** (e.g. immune to slow, immune to stun),
  - **role** — e.g. a **boss** (high durability; may cost more than one life on a leak).
- **Flying creeps ignore board geometry:** they travel in a **straight line** from entrance to
  exit, passing over towers, walls, **and blocked cells alike** — no ground cell class affects
  them. Air is the deliberate counter to over-investing in geometry, answered only by air
  coverage (below).
- **Damage & defense model — armor + immunity flags, no elements:**
  - Damage is a single kind; there are **no damage types / elemental matrix.**
  - **Armor is a flat per-hit reduction** — it favors few-big-hits over many-small-hits, a
    legible trade-off ("show the math"). A direct hit is **floored at zero**: armor **fully
    negates** a hit whose damage it meets or exceeds — which is precisely why an armor-ignoring
    answer exists (next).
  - **DoT bypasses armor.** Armor reduces **direct hits only**, so DoT is the specialist answer
    to heavily-armored creeps.
  - **Resistances are boolean immunity flags,** consistent with the domain model below.
  - _(An elemental damage-type system remains a possible future **additive** extension — existing
    content stays untyped, creeps default to no resistance — so the door is open without a
    redesign. It is not built.)_
- **Domain engagement:** each **tower targets ground, air, or both**; each creep is ground or
  flying. A tower can only hit creeps in a domain it targets — so some creeps are simply ignored
  by some towers. Debuffs obey the same rule (an air-targeting slow can slow flyers). Which
  towers and creeps sit where is content/tuning; a **dedicated anti-air** tower is just the
  air-only case.

### 6. Economy

- **Bounty** is the single, **per-run** currency (no persistence, no meta-progression, ever).
  It is spent on building and upgrading towers.
- **Three income sources:**
  - **per-kill bounty** (base income),
  - a **wave-clear bonus** (paid when the last creep of a wave dies; **forfeited if any creep
    of that wave leaked**),
  - an **early-call bonus** (the tempo lever from §2).
- These force real decisions: spend now for safety vs. hold to build bigger, and how
  aggressively to rush waves.
- **Interest on unspent bounty** is an income source the ruleset is **architected to support
  but ships off**; it may be switched on during M5 economy tuning if the decisions feel shallow.

### 7. Win, loss & scoring

- **Lives** are the failure budget. Each creep that reaches the exit (a **leak**) costs **at
  least one life** (a boss may cost more — a content knob). The run **ends in a loss when lives
  reach zero or below** — a multi-life boss leak may overshoot past zero.
- **Win** = **all scheduled waves are exhausted and no creep remains alive on the board**, with
  at least one life remaining. (Because waves can overlap via an early call, the run is not won
  while any wave's creeps are still on the field, even if the last wave has spawned out.)
- **Scoring — two readouts:**
  - A deterministic **numeric score** computed **from sim state** (so it is server-re-derivable
    — this is the ladder's measure, built now per ADR 0006). It rewards kills, efficiency,
    upgrade value, and aggressive early wave-sends; these inputs come online as their systems do
    (kills with combat, early-sends at M2, upgrade value at M4). _(Point weights: tuning; the
    current scorer is a placeholder that grows into this contract.)_
  - A derived **star grade** (from lives remaining — a near-flawless run is the top grade) as
    the casual-legible "how'd I do."
- **Neither is a currency and neither gates content.** Score and stars are a badge and a
  leaderboard input only. Best-score persistence is Phase 2; leaderboard submission is Phase 3.

### 8. Difficulty

- Phase 1 ships **Easy / Medium / Hard** difficulty tiers. Tiers are **data in the ruleset**
  (ADR 0007); each **board × tier is a distinct content entry**, selected by the replay
  identity's content id (the `levelId` field in ADR 0006). The replay envelope is unchanged, and
  **best-score is tracked per board × tier.**
- Tiers are an **R1 deliverable, tuned at M5** (three curves cannot be tuned before the content
  exists). **M1–M4 develop on the Medium tier as the single reference curve** (Easy and Hard are
  tuned alongside it at M5); there is no separate "Normal" fourth tier.
- **Difficulty modifiers / mutators** are later-phase replay content, explicitly out of Phase 1.

### 9. Speed & pause

- Speed controls are **pause / 1× / 2×** for Phase 1, extensible to 3×/4× later. Speed is a
  **playback multiplier** — the sim always steps at a fixed rate, so **replaying a fixed input
  log at any speed yields identical results** (speed is cosmetic to re-simulation). During _live_
  play, speed does affect **which tick a command lands on** — the same real-time action taken at
  2× lands later in sim-time than at 1× — which is part of the risk of playing faster and is
  captured in the recorded `tickInputs` (ADR 0006).
- **Building is allowed while paused.** Pause halts the sim but the player may build, sell, and
  plan — a significant accessibility affordance. Because scoring rewards speed and aggressive
  early-sends, pause-planning is an **aid, not a dominant strategy**. _(Whether a competitive
  ladder run permits pause-building or flags it as an assist is a Phase-3 decision.)_

### 10. Accessibility

Every milestone is public and held to the ADR 0003 gate and ADR 0004 string externalization
from **M1**. Several core-loop choices are deliberate accessibility affordances: **pause with
build-while-paused**, **speed controls**, and the vision's "strategic, not twitch" stance (the
base experience never _requires_ time pressure to succeed).

**One conscious, recorded gate deviation:** ADR 0003 §2 commits "selectable difficulty" day-one,
but the tiers are not tuned until M5. **M1–M4 ship on the Medium tier only under an explicit ADR 0003 §3
waiver**, mitigated by pause/build-while-paused/speed; **selectable difficulty is a hard R1
criterion.** The waiver is recorded in the accessibility checklist and each player-facing PR
once the first UI lands.

## The M1 slice (first public alpha)

M1 is the whole loop above, instantiated at its thinnest — playable end to end. The default
**two-path board** named by the roadmap is the R1 target that M2–M5 build toward; M1 starts on a
simpler single-path board to keep the first slice minimal.

**On at M1:** a **minimal single-path board** (one entrance, one exit, open buildable field) ·
**one single-target ground tower** (single level, no upgrades) · **one ground creep** (plain
hit points, no armor/immunities) · **one wave** · dynamic re-pathing, the maze invariant, the
place-adjacent-not-on rule, sell-at-haircut (no move, juggling possible) · win = survive the
wave, loss = lives to 0 · numeric score + star grade · speed pause (build-while-paused) / 1× /
2× · **the full accessibility gate and externalized strings** (with the selectable-difficulty
waiver above).

**Off at M1** (shape decided; activates later): AoE/slow/stun/DoT/support/burst effects · air
and anti-air · tower leveling · multiple waves. The **economy runs thin** — **starting bounty +
per-kill only**; the wave-clear and early-call bonuses need a _next_ wave, so they switch on at
**M2** (when more waves first appear). Difficulty runs on the single **Medium** reference curve.

## Milestone activation (Phase 1)

| Milestone | Core-loop capability that comes online                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| **M1**    | The vertical slice above: 1 board / 1 tower / 1 creep / 1 wave, full loop mechanics, thin economy.              |
| **M2**    | Breadth — more tower/creep types (incl. air + anti-air) and more waves; wave-clear + early-call bonuses active. |
| **M3**    | A full, tuned wave progression — the complete run you can win or lose.                                          |
| **M4**    | Depth — tower leveling and creep leveling; optionally player-selectable targeting priority.                     |
| **M5**    | Economy tuned to the content; the three difficulty tiers tuned; interest-on-savings decided.                    |

## Determinism impact

This PRD is almost entirely **`packages/sim` / `packages/engine`** surface, and it is written to
keep the determinism gate intact (ADR 0001, ADR 0006).

- **Purity preserved.** All gameplay is a pure function of `(seed, ruleset, levelId, tick inputs)`.
  Creep spawns come from the ruleset's wave schedule, not the input log (ADR 0006). No I/O, floats,
  `Math.random`, or wall-clock in the sim.
- **Scheduled combat** is a small deterministic event queue keyed to an `impact_tick` and either a
  target-id (single-target) or a fixed impact point (AoE); no per-tick projectile integration.
  Events sharing an `impact_tick` resolve in a **deterministic total order** (a stable scheduling
  key), and within an AoE, effects apply over creeps in a **deterministic order** (by creep id) —
  so ordering-sensitive effects (e.g. chance-based stun drawing from the sim RNG) are reproducible.
  The exact cross-effect ordering (direct damage, debuffs, deaths, RNG draws) is a
  determinism-gated detail fixed when the combat sim is built.
- **Pathfinding** is a flow-field + A* with a deterministic tie-break. Movement is
  8-connected; the **diagonal step cost uses a fixed-point approximation of √2** (no
  transcendentals). "Fewest steps to exit" and the predictive lead both read remaining
  path-distance along the creep's current route — flow-field for ground, straight line for air —
  so both-domain towers compare like with like.
- **Re-pathing** recomputes routes on every maze change within the tick it happens; the maze
  invariant is enforced _before_ a build applies, so the sim is never in a no-path state.
- **Speed and pause are cosmetic on replay:** speed multiplies ticks-per-second, pause runs
  zero ticks; for a **fixed input log**, the tick sequence — and therefore the world-hash and
  score — is identical at any playback speed (ADR 0006). During live play, speed only changes
  which tick a live command is stamped with (recorded in `tickInputs`), not how a given log
  re-simulates.
- **Command bounds.** Build-while-paused legitimately lands many commands on a single tick, and
  because pause advances no ticks a player can sell and rebuild the same cells repeatedly — so a
  legitimate paused burst can exceed board capacity. The anti-DoS per-tick command cap (design
  note [`replay-and-commands.md`](../design-notes/replay-and-commands.md)) must admit a full
  legitimate paused re-maze rather than cap to "plausible real-time input." The exact mechanism —
  a generous per-tick command budget, or a batching / tick-boundary rule — is a determinism-gated
  detail fixed when the command-processing pipeline is built.
- Any change to the shapes above is a determinism-affecting change and **bumps `simVersion`**;
  content/tuning changes bump `rulesetHash` (ADR 0006/0007).

## Open questions

Genuinely open (edges for reviewers), plus the small defaults chosen while drafting:

- **Balance numbers** — every quantity (HP, damage, costs, ranges, spawn spacing, starting
  lives/bounty, refund haircut, difficulty curves, score weights). Deliberately deferred to
  per-milestone tuning; not a gap.
- **Roster composition** — which tower effect primitives and creep axes ship at each milestone,
  and the air-vs-mixed wave composition. Per-milestone content, not core-loop shape.
- **Support & burst effects** — kept in the vocabulary but flagged droppable if a leaner roster
  identity is preferred; decide as their content lands.
- **Tower placement granularity** — default taken here: 2×2 towers are placeable at any fine-grid
  offset (1-cell offsets allowed) to enable tight interlocking mazes, rather than snapping to a
  coarse 2×2 lattice. Confirm when the build UX is designed.
- **Creep leveling shape (M4)** — named as wave-indexed stat scaling in the wave schedule;
  its curve is M4 tuning.
- **Vocabulary sweep** — this PRD uses `board`/`wave`; the queued `level`→`board`/`wave` rename
  across the ADRs and code (including `levelId`→`boardId`) lands as its own focused change.
