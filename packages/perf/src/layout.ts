// layout.ts — the scripted stress maze (PLAN step 17, HANDOFF-M2-S4B.md "Specific to
// S4b"). Every anchor and constant in this file is a MEASURED result, verified
// end-to-end against the real sim before being written down — not re-derived here, not
// re-tuned. If a test in `layout.test.ts` disagrees with a number below, that is a
// reproduction failure to report, not a cue to adjust either side.
//
// The maze is two layers:
//   1. Eight vertical bands (144 anchors) — the structural skeleton. Each band is a
//      column of towers with exactly one 2-cell gap, and consecutive bands put that gap
//      at opposite ends of the board, so a creep crossing from one band to the next must
//      travel the board's full height. This is what turns a 40×40 board into a long
//      route instead of a short one.
//   2. Six tail baffles (the last 6 anchors) — NOT part of the structural pattern above.
//      They were found by a greedy search over every remaining legal anchor, each step
//      picking whichever single placement grew the route length the most. They look
//      arbitrary because they are: a hand-drawn shape could not have found them, and
//      re-deriving "why col 25, row 36" from first principles is not possible — they are
//      the output of a search, not a design. They buy the route from 307 → 329 cells.

import {
  materializeTowerMask,
  computeDistanceField,
  shortestPath,
  DIAG_LEN,
  type CompiledRuleset,
  type TowerValidityView,
} from '@wynding/sim';

/** The eight vertical band columns (anchor col, i.e. the band's left edge). */
export const BAND_COLS = [2, 5, 8, 11, 14, 17, 20, 23] as const;

/** Candidate anchor rows within a band, before that band's one dropped row. Rows
 *  1..37 odd, i.e. every other row from the top of the buildable interior (row 1) to
 *  near its bottom (row 38) — 19 candidates, each anchor's 2×2 footprint stacking
 *  cleanly against its neighbours with no overlap. */
function bandCandidateRows(): readonly number[] {
  const rows: number[] = [];
  for (let row = 1; row <= 37; row += 2) {
    rows.push(row);
  }
  return rows;
}

/** The six tail baffles, appended after the eight bands, in this exact order — see the
 *  header comment above for what they are and why they cannot be re-derived. */
export const TAIL_BAFFLES = [
  { col: 25, row: 36 },
  { col: 37, row: 21 },
  { col: 35, row: 19 },
  { col: 33, row: 17 },
  { col: 31, row: 15 },
  { col: 29, row: 13 },
] as const;

/** The full 150-anchor stress layout: eight bands (144 anchors, top-to-bottom within
 *  each band, band by band in `BAND_COLS` order), then the six tail baffles. Each
 *  anchor is a 2×2 footprint's top-left corner — the footprint also covers (col+1,row),
 *  (col,row+1), (col+1,row+1), matching the sim's own `FOOTPRINT_DELTAS`
 *  (`packages/sim/src/tower.ts`). */
export function stressAnchors(): readonly { col: number; row: number }[] {
  const candidateRows = bandCandidateRows();
  const anchors: { col: number; row: number }[] = [];
  BAND_COLS.forEach((col, b) => {
    // Each band drops exactly one row to leave a 2-cell gap for creeps to pass
    // through. Even bands drop the first row, odd bands drop the last, so consecutive
    // bands' gaps sit at opposite ends of the board and a creep must cross the full
    // board height to get from one band's gap to the next.
    const rows = b % 2 === 0 ? candidateRows.slice(1) : candidateRows.slice(0, -1);
    for (const row of rows) {
      anchors.push({ col, row });
    }
  });
  for (const baffle of TAIL_BAFFLES) {
    anchors.push({ col: baffle.col, row: baffle.row });
  }
  return anchors;
}

/** The three tower ids the stress layout places. A literal union rather than `string`
 *  because two call sites COMPARE the result against a string LITERAL — `scenario.ts`'s
 *  `buildControlReplay` (against `'stress-chill'` and `'stress-venom'`) and
 *  `buildDotFreeReplay` (against `'stress-chill'`) — where against `string` a typo
 *  compiles and silently takes the `else`, swapping a tower's arm with no test failing.
 *
 *  `main-perf.ts`'s arm guard also consumes `towerIdAt`, but compares it to `uiState().armed`
 *  (a runtime value, typed `ArmedTower | null` = `string | null`), so it has no literal to
 *  typo and this narrowing buys it nothing. Named here so a reader does not go looking for
 *  a third protected site. */
export type StressTowerId = 'stress-blast' | 'stress-venom' | 'stress-chill';

/** The tower catalog id to place at a given index in `stressAnchors()`'s order. A
 *  three-way split over the 150 anchors: index % 3 === 2 is `stress-chill`, index % 3
 *  === 1 is `stress-venom`, and everything else (index % 3 === 0) is `stress-blast` —
 *  50 chill + 50 venom + 50 blast. All three towers cost 12, so 150 × 12 = 1800 exactly
 *  matches the bundle's `startingBounty` (`stress-40x40.json`'s `balance.startingBounty`).
 *  That equality is a second, independent oracle beyond "the compiler accepted the
 *  bundle": if the leftover bounty after all 150 placements is exactly 0, every single
 *  placement was accepted (an insufficient-bounty or illegal-anchor placement is a
 *  deterministic no-op per PLAN step 18 — it would silently leave bounty unspent
 *  instead of throwing), so a non-zero leftover would be the tell. */
export function towerIdAt(index: number): StressTowerId {
  if (index % 3 === 2) return 'stress-chill';
  if (index % 3 === 1) return 'stress-venom';
  return 'stress-blast';
}

/**
 * The scripted stress maze's route length against `compiled`'s grid — entrance to
 * exit, built on the sim's OWN `materializeTowerMask` (`@wynding/sim`, `tower.ts`), the
 * exact function `step()` itself uses to derive the tower-blocked mask. QC: `run.ts`
 * and `layout.test.ts`'s route-length check used to each hand-copy `tower.ts`'s
 * PRIVATE `FOOTPRINT_DELTAS` constant into a local mask-building loop — byte-identical
 * copies that could therefore only ever be wrong TOGETHER, which defeats the stated
 * point of having two independent computations. Routing both call sites through this
 * one function, built on the exported `materializeTowerMask`, makes THAT drift
 * (route length specifically) structurally impossible instead of merely unlikely.
 * `layout.test.ts` separately keeps its OWN small `FOOTPRINT_DELTAS` copy for an
 * unrelated non-overlap check that this function does not perform — see that file's
 * comment for why that one still exists.
 *
 * Computed from the INTENDED layout (`stressAnchors()`/`towerIdAt()`), not from a run's
 * realized `state.towers` — see `oracle.ts`'s `OracleInput` doc for what that means
 * this can and cannot detect. The synthetic `TowerValidityView` below is built directly
 * from the anchors and `towerIdAt`, with no live sim state involved.
 */
export function stressRouteLength(compiled: CompiledRuleset): number {
  const grid = compiled.board.grid;
  const anchors = stressAnchors();
  const towers: TowerValidityView = {
    id: anchors.map((_, i) => i + 1),
    col: anchors.map((a) => a.col),
    row: anchors.map((a) => a.row),
    spend: anchors.map((_, i) => {
      const def = compiled.towerById[towerIdAt(i)];
      if (def === undefined) {
        throw new Error(`stressRouteLength: unknown tower id at index ${i}`);
      }
      return def.cost;
    }),
    towerId: anchors.map((_, i) => towerIdAt(i)),
  };
  const mask = materializeTowerMask(grid, towers, compiled.towerById);
  const field = computeDistanceField(grid, mask);
  const path = shortestPath(grid, field, grid.entrance);
  return path === null ? 0 : path.length;
}

// ── The catalog scene (M2-S11 P7, `catalog-40x40`) ──────────────────────────────
//
// Everything below is ADDITIVE. The catalog scene REUSES `stressAnchors()` verbatim —
// same board shape, same entrance/exit, the same 150 anchors in the same order — so the
// as-built maze route is pre-committed at 329 cells rather than measured at authoring.
// The scene changes WHICH towers stand on the anchors, never where the anchors are; the
// stress-side exports above are untouched by design (P8 depends on their byte-identity).
//
// THE SCENE PLACES 165 TOWERS, NOT 150: the 150 anchors carry beacons and the seven
// attacking kinds, and the 15 `mine`s stand on 15 SEPARATE authored PADS
// (`CATALOG_MINE_PADS`) chosen so that placing them — and detonating them — leaves the
// route's cell SEQUENCE byte-identical. That split is the applied AMENDMENT, forced by
// three measured impossibilities on this geometry; see `CATALOG_MINE_PADS`'s doc for all
// three, with the numbers, and `layout-catalog.test.ts` for the machine checks that pin
// them.

/** The nine real `wynding-core` catalog tower ids the catalog scene places. A literal
 *  union, not `string`, for the same reason `StressTowerId` is one: the constraint tests
 *  and the pad tables below compare against these spellings as LITERALS, where a typo
 *  against `string` would compile and silently take a wrong branch. */
export type CatalogTowerId =
  'basic' | 'slow' | 'splash' | 'venom' | 'stun' | 'antiair' | 'beacon' | 'mine' | 'frost-splash';

/**
 * The anchor → tower mapping for the catalog scene's 150 ANCHORS, as a COMMITTED LITERAL
 * TABLE. (The 15 mines are not here — they stand on `CATALOG_MINE_PADS`.)
 *
 * A literal, not a rule evaluated at run time, and that is the whole point: "authored
 * before the first run" alone would leave the assignment selectable after observation.
 * The table below was generated ONCE by the pinned deterministic rule stated here and
 * committed with the packet; every positional constraint it claims is enforced by a
 * dedicated unit test (`layout-catalog.test.ts`), never by review.
 *
 * THE PINNED DERIVATION RULE, in the order it was applied:
 *
 *  1. BEACONS (15) — anchors 10, 12, 14, …, 38, i.e. every second anchor from 10 through
 *     38. Chosen lowest-anchor-index-first over the anchors that CAN satisfy the beacon
 *     constraint ("edge-adjacent to ≥ 1 attacking-tower anchor whose own compiled
 *     `attack.rangeFp` covers ≥ 1 cell of a path its compiled `attack.domain` can
 *     actually engage"), which for a self-referential constraint means: skip an anchor
 *     edge-adjacent to an already-chosen beacon (two beacons never buff each other —
 *     `support.ts`: support towers never fire), since every anchor that is not a beacon
 *     becomes an attacker and is therefore an attacking neighbour by construction. The
 *     FINAL table is machine-checked against the real compiled bundle, per assigned
 *     tower, in `layout-catalog.test.ts`.
 *  2. THE SEVEN ATTACKING KINDS, round-robin by anchor index over EVERY remaining anchor:
 *     walk the 135 non-beacon anchors in ascending index order, cycling the ordered kind
 *     list `basic → slow → splash → venom → stun → antiair → frost-splash`, with NO
 *     exhaustion cap. 135 = 19 × 7 + 2, so the rotation lands basic 20, slow 20, and 19
 *     each of splash, venom, stun, antiair, frost-splash.
 *
 * The no-cap rotation is the amendment's "continue the same rotation" made literal: the
 * packet's original per-kind counts (20/20/20/20/15/15/10) totalled 120 and cannot fill
 * 135 slots, so a capped rotation has no meaning here. One uncapped pass over all 135
 * anchors keeps the whole assignment a single deterministic rule application, provable by
 * re-running it — which `layout-catalog.test.ts` does.
 *
 * Placement cost (see `CATALOG_TOTAL_SPEND`): attackers 1,286 + beacons 225 + mines 90 =
 * **1,601**, which IS the bundle's `startingBounty`. That equality is the scene's
 * zero-leftover oracle: the stress scene's equal-cost assumption (150 × 12) does not
 * survive a real catalog, so the bounty is derived from the table instead of assumed.
 */
// prettier-ignore
export const CATALOG_TOWER_ID_AT: readonly CatalogTowerId[] = [
  // Laid out five per line, indexed in the trailing comment, and held that way by the
  // `prettier-ignore` above: this is a COMMITTED TABLE a reader must be able to check
  // against an anchor index by eye, not a 150-line list.
  'basic', 'slow', 'splash', 'venom', 'stun',               //   0–  4
  'antiair', 'frost-splash', 'basic', 'slow', 'splash',     //   5–  9
  'beacon', 'venom', 'beacon', 'stun', 'beacon',            //  10– 14
  'antiair', 'beacon', 'frost-splash', 'beacon', 'basic',   //  15– 19
  'beacon', 'slow', 'beacon', 'splash', 'beacon',           //  20– 24
  'venom', 'beacon', 'stun', 'beacon', 'antiair',           //  25– 29
  'beacon', 'frost-splash', 'beacon', 'basic', 'beacon',    //  30– 34
  'slow', 'beacon', 'splash', 'beacon', 'venom',            //  35– 39
  'stun', 'antiair', 'frost-splash', 'basic', 'slow',       //  40– 44
  'splash', 'venom', 'stun', 'antiair', 'frost-splash',     //  45– 49
  'basic', 'slow', 'splash', 'venom', 'stun',               //  50– 54
  'antiair', 'frost-splash', 'basic', 'slow', 'splash',     //  55– 59
  'venom', 'stun', 'antiair', 'frost-splash', 'basic',      //  60– 64
  'slow', 'splash', 'venom', 'stun', 'antiair',             //  65– 69
  'frost-splash', 'basic', 'slow', 'splash', 'venom',       //  70– 74
  'stun', 'antiair', 'frost-splash', 'basic', 'slow',       //  75– 79
  'splash', 'venom', 'stun', 'antiair', 'frost-splash',     //  80– 84
  'basic', 'slow', 'splash', 'venom', 'stun',               //  85– 89
  'antiair', 'frost-splash', 'basic', 'slow', 'splash',     //  90– 94
  'venom', 'stun', 'antiair', 'frost-splash', 'basic',      //  95– 99
  'slow', 'splash', 'venom', 'stun', 'antiair',             // 100–104
  'frost-splash', 'basic', 'slow', 'splash', 'venom',       // 105–109
  'stun', 'antiair', 'frost-splash', 'basic', 'slow',       // 110–114
  'splash', 'venom', 'stun', 'antiair', 'frost-splash',     // 115–119
  'basic', 'slow', 'splash', 'venom', 'stun',               // 120–124
  'antiair', 'frost-splash', 'basic', 'slow', 'splash',     // 125–129
  'venom', 'stun', 'antiair', 'frost-splash', 'basic',      // 130–134
  'slow', 'splash', 'venom', 'stun', 'antiair',             // 135–139
  'frost-splash', 'basic', 'slow', 'splash', 'venom',       // 140–144
  'stun', 'antiair', 'frost-splash', 'basic', 'slow',       // 145–149
];

/**
 * The 15 `mine` PADS — 2×2 placements that are NOT `stressAnchors()` members.
 *
 * WHY THE MINES LEFT THE ANCHOR SET (three measured impossibilities, all pinned as tests
 * in `layout-catalog.test.ts` so they can never quietly stop being true):
 *
 *  1. NO ANCHOR IS OUT OF TRIGGER RANGE OF EVERY ROUTE CELL. Measured against the real
 *     329-cell route with the `mine`'s own 2.25-tile `attack.rangeFp`: **0 of 150**. The
 *     maze is 150 towers on a 40×40 board and its route threads every corridor.
 *  2. NO ANCHOR IS NON-LOAD-BEARING. Removing ANY single one of the 150 anchors changes
 *     the route's cell sequence — **0 of 150** survive the check. The stress maze is eight
 *     single-gap bands plus six greedy tail baffles; every anchor is structural by
 *     construction. So a mine ON an anchor can never satisfy the packet's "not
 *     load-bearing" requirement, whatever else is true of it.
 *  3. NO ROUTE-NEUTRAL PAD EXISTS NEAR THE EARLY ROUTE. Of the 460 legal free 2×2 pads,
 *     359 are route-neutral, but only 3 — (1,1), (2,1), (3,1) — sit within 2.25 tiles of
 *     route cells 1–28, and NONE of those 3 is route-neutral. Sweeping the cutoff K
 *     (pads route-neutral AND within trigger range of route cells 1..K) gives 0 at
 *     K = 28, 40, 50, 59, 60, 80 and 120, and the EARLIEST first-in-range route index
 *     over all route-neutral pads is **290**. Detonating during warm-up is therefore
 *     impossible on this geometry at any cutoff: route cells 1–28 run up the one-cell-wide
 *     col-1 corridor, east along row 2, then down col 4, and a 2×2 pad within trigger
 *     range of those cells has nowhere to stand but inside a one-wide corridor, which
 *     reroutes.
 *
 * THE APPLIED AMENDMENT, and the pad rule it pins. Scan every legal 2×2 placement in
 * ROW-MAJOR order (row, then col). A pad qualifies when it (a) meets its role's trigger
 * predicate, (b) is ROUTE-NEUTRAL — adding it leaves the route's cell sequence
 * byte-identical, AND removing its tower alone from the full 165 leaves it byte-identical,
 * (c) overlaps no anchor footprint and no already-selected pad, and (d) leaves the maze
 * passable (implied by (b): an identical route is a non-empty one). DETONATORS take the
 * first 10 whose trigger predicate is "within 2.25 tiles of ≥ 1 route cell"; SURVIVORS
 * take the next 5 whose predicate is "out of trigger range of EVERY route cell".
 *
 * WHAT THIS BUYS AND WHAT IT COSTS. It buys the packet's headline requirement outright:
 * the route's cell sequence is identical as-built and after all ten detonations, so the
 * maze the scene measures never changes and every population equality holds. It costs the
 * detonation TIMING: the earliest detonator sits at route index 310, whose cumulative
 * route cost is 79,466 fp, so the lead un-slowed ground creep (spawn tick 100, 23 fp/tick)
 * cannot reach it before tick 3,555 — one tick after the sample window closes at 3,554.
 * Detonation is therefore witnessed in the untimed LEAK-PROBE EXTENSION, not during
 * warm-up, and the live-tower count is a flat 165 across every sampled tick. See
 * `CATALOG_DETONATOR_LOWER_BOUND_TICKS`.
 */
export const CATALOG_MINE_PADS: readonly { readonly col: number; readonly row: number }[] = [
  // The ten DETONATORS, in row-major selection order.
  { col: 26, row: 10 },
  { col: 28, row: 10 },
  { col: 30, row: 10 },
  { col: 32, row: 10 },
  { col: 25, row: 12 },
  { col: 34, row: 12 },
  { col: 25, row: 14 },
  { col: 36, row: 14 },
  { col: 28, row: 15 },
  { col: 25, row: 16 },
  // The five SURVIVORS, in row-major selection order — out of trigger range of EVERY
  // route cell, so no ground creep ever trips them and they stand for the whole run.
  { col: 25, row: 1 },
  { col: 27, row: 1 },
  { col: 29, row: 1 },
  { col: 31, row: 1 },
  { col: 33, row: 1 },
];

/** How many of {@link CATALOG_MINE_PADS} are detonators — the leading 10. */
export const CATALOG_DETONATOR_PAD_COUNT = 10;

/** Placement indices (into {@link catalogPlacements}) of the ten detonating mines —
 *  150..159, i.e. the pads immediately after the 150 anchors. */
export const CATALOG_DETONATING_MINE_INDICES: readonly number[] = [
  150, 151, 152, 153, 154, 155, 156, 157, 158, 159,
];

/** Placement indices of the five surviving mines — 160..164. */
export const CATALOG_SURVIVING_MINE_INDICES: readonly number[] = [160, 161, 162, 163, 164];

/** Each detonator pad's FIRST in-trigger-range route index, index-parallel to the leading
 *  ten of {@link CATALOG_MINE_PADS}. Re-derived from the committed route in
 *  `layout-catalog.test.ts` rather than trusted. */
export const CATALOG_DETONATOR_ROUTE_INDICES: readonly number[] = [
  316, 316, 317, 319, 314, 321, 312, 323, 311, 310,
];

/**
 * The earliest tick each detonator can possibly fire, index-parallel to the leading ten of
 * {@link CATALOG_MINE_PADS} — the committed output of
 * {@link catalogDetonatorLowerBoundTicks}, which `layout-catalog.test.ts` re-derives from
 * the real route rather than trusting.
 *
 * MEASURED AGAINST THE CONTINUOUS PATH, not the route's cell centres, and that distinction
 * is load-bearing rather than pedantic. A creep's position is a point travelling ALONG the
 * segments between cell centres (`movement.ts` is point-authoritative), so it enters a
 * mine's trigger circle partway down the segment BEFORE the first cell centre that sits
 * inside it. A bound built on cell-centre distances is therefore too LATE — it claims a
 * detonation cannot happen for several more ticks than the geometry actually allows, and
 * a real run beats it. The first draft of this table did exactly that and four of the ten
 * observed detonations landed 2–4 ticks "early" against it; the fix was the arithmetic
 * here, not the scene.
 *
 * Sorted, these are 3,553 / 3,564 / 3,575 / 3,597 / 3,618 / 3,618 / 3,635 / 3,657 / 3,682
 * / 3,714.
 *
 * THE THIN MARGIN, STATED RATHER THAN GLOSSED. The smallest bound, 3,553, is TWO TICKS
 * BEFORE the sample window's last tick (3,554). So "no detonation inside the window" is
 * NOT proven by this arithmetic — it is an OBSERVED result (the earliest detonation the
 * scene actually produces is tick 3,559, a 5-tick margin), and `oracle-catalog.ts` asserts
 * it as such: from the observed detonation count at or below the window's end and from the
 * minimum live-tower count across the window, never from this table. The bound is
 * deliberately loose in the creep's favour — it floors, it grants the full un-slowed
 * 23 fp/tick budget, and it ignores that a mine also has to SELECT that creep as its
 * target — so the true earliest is later than 3,553; how much later is not something this
 * derivation can state, which is exactly why the assertion is observational. A schedule or
 * geometry edit that moves the window or the tail of the route should re-check this gap
 * first.
 */
export const CATALOG_DETONATOR_LOWER_BOUND_TICKS: readonly number[] = [
  3618, 3618, 3635, 3657, 3597, 3682, 3575, 3714, 3564, 3553,
];

/**
 * The earliest tick each detonator pad can possibly fire, derived from the committed
 * route: `100 + ⌊s* / 23⌋`, where 100 is the earliest ground spawn tick (countdown 100,
 * stream offset 0), 23 fp/tick is an un-slowed creep's FULL travel budget, and `s*` is the
 * smallest arc length along the route polyline at which a creep's point lies within the
 * `mine`'s trigger radius of the pad's footprint centre.
 *
 * A lower bound in the strict sense: no ground creep can be further along than
 * `23 × (tick − 100)` fp, statuses only slow it, and air creeps never trip a `mine` at all
 * (its attack domain is ground). Floats are legal here — this file is perf tooling outside
 * the determinism boundary, and the result is floored to an integer tick.
 */
export function catalogDetonatorLowerBoundTicks(compiled: CompiledRuleset): readonly number[] {
  const route = catalogRoutePath(compiled);
  const cum = catalogRouteCumulativeFp(compiled);
  const trigger = compiled.towerById['mine']?.attack?.rangeFp;
  if (trigger === undefined) {
    throw new Error('catalogDetonatorLowerBoundTicks: the bundle has no `mine` attack block');
  }
  const centreX = (c: { col: number; row: number }) => c.col * 256 + 128;
  const centreY = (c: { col: number; row: number }) => c.row * 256 + 128;

  return CATALOG_MINE_PADS.slice(0, CATALOG_DETONATOR_PAD_COUNT).map((pad) => {
    const px = (pad.col + 1) * 256;
    const py = (pad.row + 1) * 256;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 1; k < route.length && best === Number.POSITIVE_INFINITY; k++) {
      const ax = centreX(route[k - 1]!);
      const ay = centreY(route[k - 1]!);
      const bx = centreX(route[k]!);
      const by = centreY(route[k]!);
      const dx = bx - ax;
      const dy = by - ay;
      // Smallest t in [0,1] with |A + t·(B−A) − P|² ≤ trigger². Quadratic in t.
      const a = dx * dx + dy * dy;
      const b = 2 * (dx * (ax - px) + dy * (ay - py));
      const c = (ax - px) ** 2 + (ay - py) ** 2 - trigger * trigger;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const root = (-b - Math.sqrt(disc)) / (2 * a);
      // `root > 1` means the circle is entered beyond this segment's end — not here.
      if (root > 1) continue;
      // Both roots negative means the intersection interval lies entirely BEHIND the
      // segment start (the backward line extension crosses the circle, the segment never
      // does) — clamping to t = 0 would claim entry at a point that is outside the
      // circle (c > 0 there). Reject the segment instead. Inert on the committed
      // geometry (independently brute-force verified), guarded for future edits.
      if ((-b + Math.sqrt(disc)) / (2 * a) < 0) continue;
      const t = Math.max(0, Math.min(1, root));
      // `c <= 0` means the segment START is already inside, so t collapses to 0.
      best = cum[k - 1]! + t * Math.sqrt(a);
    }
    if (best === Number.POSITIVE_INFINITY) {
      throw new Error(
        `catalogDetonatorLowerBoundTicks: pad (${pad.col},${pad.row}) never enters trigger range`,
      );
    }
    return 100 + Math.floor(best / 23);
  });
}

/** Total placements — 150 anchors + 15 mine pads. */
export const CATALOG_TOWER_COUNT = 165;

/** Total placement cost, and therefore the bundle's `startingBounty`: attackers 1,286 +
 *  beacons 225 + mines 90. Pinned here and re-derived from the compiled catalog in
 *  `layout-catalog.test.ts`, so a cost edit anywhere fails at author time. */
export const CATALOG_TOTAL_SPEND = 1601;

/** One placement the catalog scene makes, in commit order. */
export interface CatalogPlacement {
  readonly anchor: { readonly col: number; readonly row: number };
  readonly towerId: CatalogTowerId;
}

/**
 * The catalog scene's 165 placements in COMMIT ORDER — the 150 anchors first (in
 * `stressAnchors()` order, carrying `CATALOG_TOWER_ID_AT`), then the 15 mine pads.
 *
 * The single source both drivers read: `scenario.ts`'s `buildCatalogReplay` (Node) and
 * `apps/web/perf/main-perf-catalog.ts` (browser). Anchors before pads is deliberate — the
 * maze must be whole before a mine is dropped beside it, so no intermediate build state
 * can route a creep somewhere the final maze would not (no creep exists during the build
 * either way, but a driver that replays the prefix should still never see a different
 * maze than the one it finishes with).
 */
export function catalogPlacements(): readonly CatalogPlacement[] {
  const out: CatalogPlacement[] = stressAnchors().map((anchor, i) => ({
    anchor,
    towerId: catalogTowerIdAt(i),
  }));
  for (const pad of CATALOG_MINE_PADS) {
    out.push({ anchor: { col: pad.col, row: pad.row }, towerId: 'mine' });
  }
  return out;
}

/** The tower catalog id at a given PLACEMENT index (0..164) — anchors 0..149 from
 *  {@link CATALOG_TOWER_ID_AT}, pads 150..164 always `mine`. Shared by the Node and browser
 *  drivers so the two can never place different mazes. Throws rather than returning a
 *  fallback: a silent fallback would place a legal-but-wrong tower and quietly change the
 *  scene. */
export function catalogTowerIdAt(index: number): CatalogTowerId {
  if (Number.isSafeInteger(index) && index >= 150 && index < CATALOG_TOWER_COUNT) return 'mine';
  const id = CATALOG_TOWER_ID_AT[index];
  if (id === undefined) {
    throw new Error(
      `catalogTowerIdAt: index ${index} is outside the ${CATALOG_TOWER_COUNT}-placement table`,
    );
  }
  return id;
}

/** The catalog scene's route, entrance to exit, as a CELL SEQUENCE — built exactly like
 *  `stressRouteLength` (the sim's own `materializeTowerMask` → `computeDistanceField` →
 *  `shortestPath`), from the INTENDED layout, over all 165 placements. Returns the
 *  sequence rather than only its length because the scene's route oracle asserts SEQUENCE
 *  equality as-built vs post-detonation: equal length alone would admit a different
 *  329-cell path with a different diagonal mix, different coverage, and different
 *  mine-trigger geometry, which is exactly what "the detonating mines are not load-bearing
 *  for the maze" has to rule out. */
export function catalogRoutePath(
  compiled: CompiledRuleset,
): readonly { col: number; row: number }[] {
  const grid = compiled.board.grid;
  const placements = catalogPlacements();
  const towers: TowerValidityView = {
    id: placements.map((_, i) => i + 1),
    col: placements.map((p) => p.anchor.col),
    row: placements.map((p) => p.anchor.row),
    spend: placements.map((p) => {
      const def = compiled.towerById[p.towerId];
      if (def === undefined) {
        throw new Error(`catalogRoutePath: unknown tower id '${p.towerId}'`);
      }
      return def.cost;
    }),
    towerId: placements.map((p) => p.towerId),
  };
  const mask = materializeTowerMask(grid, towers, compiled.towerById);
  const field = computeDistanceField(grid, mask);
  const path = shortestPath(grid, field, grid.entrance);
  return path === null ? [] : path;
}

/** The catalog scene's route length — {@link catalogRoutePath}'s cell count. Identical to
 *  the stress scene's committed 329, because the geometry is identical and every mine pad
 *  is route-neutral by selection. */
export function catalogRouteLength(compiled: CompiledRuleset): number {
  return catalogRoutePath(compiled).length;
}

/** Cumulative fixed-point route cost to reach each index of {@link catalogRoutePath} —
 *  256 per orthogonal step, `DIAG_LEN` (362) per diagonal one, the same costs `movement.ts`
 *  charges. The basis for every "earliest a ground creep can be here" bound in this scene
 *  (`CATALOG_DETONATOR_LOWER_BOUND_TICKS`, and the leak probe's own arithmetic). */
export function catalogRouteCumulativeFp(compiled: CompiledRuleset): readonly number[] {
  const route = catalogRoutePath(compiled);
  const cum: number[] = [0];
  for (let k = 1; k < route.length; k++) {
    const a = route[k - 1]!;
    const b = route[k]!;
    cum.push(cum[k - 1]! + (a.col !== b.col && a.row !== b.row ? DIAG_LEN : 256));
  }
  return cum;
}
