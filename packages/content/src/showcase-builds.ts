// showcase-builds.ts — M2 Story 11 P5: shared test-support module, NOT part of this
// package's public API (not re-exported from `./index.ts`) — the `wave-lookup.ts`
// precedent. It exists so WINNER A's input script ("the poisoner", `story-
// showcase.test.ts`'s P4 balance-pass centre) is ONE source of truth rather than two
// copies drifting apart: `story-showcase.test.ts` (the balance-criteria proof) and
// `m2-golden.test.ts` (the P5 close-out determinism golden) both place the SAME towers
// on the SAME cells in the SAME order against the SAME shipped bundle.
//
// Only the SCRIPT moves here — `story-showcase.test.ts`'s `runBuild` (the per-tower
// damage/status attribution harness) stays put; `m2-golden.test.ts` needs none of that
// machinery, only a hash trace and a mid-run boss-damage probe, so duplicating that
// harness here would be scope the golden doesn't use. P5 pins Winner A only (the plan's
// own choice of "one of P4's two winners").
//
// WINNER B and the pinned LOSER joined A here in M3 story 1: the balance checker
// re-expresses all three in its grid format (`reference-builds.ts`), and its calibration
// (`balance-calibration.test.ts`) proves each grid build compiles to exactly the plan
// below and drives the sim to the same final hash. These arrays stay the plans M2's pins
// run; the calibration is what keeps the two forms from drifting apart.

import type { Placement } from './script-runner';

export type { Placement };

// ---------------------------------------------------------------------------------
// WINNER A — "the poisoner". `venom`'s DoT is the only thing in the catalog that
// bypasses the boss's armor 8 without support, so A leans on it: a cheap `basic` wall
// buys the first three waves, `venom` takes over as the ground answer, and `antiair`
// (the catalog's only air-capable damage) is spread along the row-11 flight line so no
// flyer meets fewer than two of them.
// ---------------------------------------------------------------------------------
export const WINNER_A: readonly Placement[] = [
  { col: 2, row: 10, towerId: 'basic' },
  { col: 2, row: 12, towerId: 'basic' },
  { col: 6, row: 10, towerId: 'basic' },
  { col: 6, row: 12, towerId: 'basic' },
  { col: 10, row: 10, towerId: 'basic' },
  { col: 10, row: 12, towerId: 'basic' },
  { col: 4, row: 8, towerId: 'antiair' },
  { col: 8, row: 14, towerId: 'antiair' },
  { col: 14, row: 10, towerId: 'venom' },
  { col: 14, row: 12, towerId: 'venom' },
  { col: 12, row: 8, towerId: 'antiair' },
  { col: 16, row: 14, towerId: 'antiair' },
  { col: 18, row: 10, towerId: 'venom' },
  { col: 18, row: 12, towerId: 'venom' },
  { col: 20, row: 8, towerId: 'antiair' },
  { col: 24, row: 14, towerId: 'antiair' },
  { col: 22, row: 10, towerId: 'venom' },
  { col: 22, row: 12, towerId: 'venom' },
  { col: 24, row: 10, towerId: 'venom' },
  { col: 20, row: 12, towerId: 'venom' },
  { col: 12, row: 14, towerId: 'venom' },
  { col: 16, row: 8, towerId: 'venom' },
  { col: 8, row: 10, towerId: 'venom' },
  { col: 2, row: 8, towerId: 'antiair' },
  { col: 6, row: 14, towerId: 'antiair' },
  { col: 10, row: 8, towerId: 'antiair' },
  { col: 14, row: 14, towerId: 'antiair' },
  { col: 18, row: 8, towerId: 'antiair' },
  { col: 22, row: 14, towerId: 'antiair' },
  { col: 12, row: 12, towerId: 'venom' },
  { col: 20, row: 14, towerId: 'venom' },
  { col: 24, row: 8, towerId: 'venom' },
  { col: 4, row: 12, towerId: 'venom' },
  { col: 8, row: 12, towerId: 'venom' },
  { col: 10, row: 14, towerId: 'venom' },
  { col: 14, row: 8, towerId: 'venom' },
  { col: 18, row: 14, towerId: 'venom' },
  { col: 22, row: 8, towerId: 'venom' },
  { col: 6, row: 8, towerId: 'venom' },
  { col: 2, row: 14, towerId: 'venom' },
];

// ---------------------------------------------------------------------------------
// WINNER B — "the control lattice". No `venom` at all: the boss dies to beacon-buffed
// `basic` (10 x 1.5 = 15 nominal, 15 - 8 = 7 net — the armor-piercing route
// `story-finale.test.ts` pins), and it only gets there because `slow` doubles how long
// everything spends inside the wall.
//
// THE ROW-15 SLOW BAND IS GEOMETRY, NOT DECORATION. `slow` is a BOTH-domain tower, so
// a slow tower near the row-11 flight line would chip air creeps and eat into
// `antiair`'s own damage share. A tower anchored at row 15 fires from y = 16 x 256 =
// 4096 fp; the air line sits at y = 11 x 256 + 128 = 2944 fp, a gap of 1152 fp against
// `slow`'s 1024 fp range — so it is arithmetically incapable of touching a flyer, while
// still covering the row-14 ground corridor 384 fp away. That is what keeps `antiair`
// the sole source of air damage in this build, and `story-showcase.test.ts` asserts it
// rather than asserting about it.
// ---------------------------------------------------------------------------------
export const WINNER_B: readonly Placement[] = [
  { col: 2, row: 10, towerId: 'basic' },
  { col: 4, row: 10, towerId: 'basic' },
  { col: 6, row: 10, towerId: 'basic' },
  { col: 8, row: 10, towerId: 'basic' },
  { col: 2, row: 12, towerId: 'beacon' },
  { col: 10, row: 10, towerId: 'basic' },
  { col: 12, row: 10, towerId: 'basic' },
  { col: 6, row: 12, towerId: 'beacon' },
  { col: 14, row: 10, towerId: 'basic' },
  { col: 16, row: 10, towerId: 'basic' },
  { col: 2, row: 8, towerId: 'antiair' },
  { col: 6, row: 8, towerId: 'antiair' },
  { col: 10, row: 12, towerId: 'beacon' },
  { col: 18, row: 10, towerId: 'basic' },
  { col: 20, row: 10, towerId: 'basic' },
  { col: 2, row: 15, towerId: 'slow' },
  { col: 4, row: 15, towerId: 'slow' },
  { col: 6, row: 15, towerId: 'slow' },
  { col: 8, row: 15, towerId: 'slow' },
  { col: 10, row: 8, towerId: 'antiair' },
  { col: 14, row: 8, towerId: 'antiair' },
  { col: 14, row: 12, towerId: 'beacon' },
  { col: 22, row: 10, towerId: 'basic' },
  { col: 24, row: 10, towerId: 'basic' },
  { col: 10, row: 15, towerId: 'slow' },
  { col: 12, row: 15, towerId: 'slow' },
  { col: 14, row: 15, towerId: 'slow' },
  { col: 16, row: 15, towerId: 'slow' },
  { col: 18, row: 8, towerId: 'antiair' },
  { col: 22, row: 8, towerId: 'antiair' },
  { col: 18, row: 12, towerId: 'beacon' },
  { col: 22, row: 12, towerId: 'beacon' },
  { col: 4, row: 12, towerId: 'basic' },
  { col: 8, row: 12, towerId: 'basic' },
  { col: 12, row: 12, towerId: 'basic' },
  { col: 20, row: 12, towerId: 'basic' },
  { col: 18, row: 15, towerId: 'slow' },
  { col: 20, row: 15, towerId: 'slow' },
  { col: 22, row: 15, towerId: 'slow' },
  { col: 24, row: 15, towerId: 'slow' },
];

// ---------------------------------------------------------------------------------
// THE LOSER — authored AFTER the last tuning change, per ruling 3, so it is measured
// against the FINAL numbers rather than an earlier draft of them. It is a build that
// ENGAGES the arc and loses: a real ground wall (`basic` + `venom`) with `slow` for
// control and no answer whatsoever to the `air` domain, which is what eventually kills
// it — not a build that declines to play.
// ---------------------------------------------------------------------------------
export const LOSER: readonly Placement[] = [
  { col: 2, row: 10, towerId: 'basic' },
  { col: 2, row: 12, towerId: 'basic' },
  { col: 6, row: 10, towerId: 'basic' },
  { col: 6, row: 12, towerId: 'basic' },
  { col: 10, row: 10, towerId: 'basic' },
  { col: 10, row: 12, towerId: 'basic' },
  { col: 14, row: 10, towerId: 'venom' },
  { col: 14, row: 12, towerId: 'venom' },
  { col: 18, row: 10, towerId: 'slow' },
  { col: 18, row: 12, towerId: 'slow' },
  { col: 22, row: 10, towerId: 'venom' },
  { col: 22, row: 12, towerId: 'venom' },
];
