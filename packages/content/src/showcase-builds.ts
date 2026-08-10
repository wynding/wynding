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
// harness here would be scope the golden doesn't use. WINNER B and the LOSER build stay
// local to `story-showcase.test.ts` too — P5 pins Winner A only (the plan's own choice
// of "one of P4's two winners").

/** One scripted tower placement: a build script is a plan of these, in play order. */
export interface Placement {
  readonly col: number;
  readonly row: number;
  readonly towerId: string;
}

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
