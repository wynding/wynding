// reference-builds.ts — M3 story 1: the balance checker's REGISTERED reference builds, in
// the grid format `reference-build.ts` defines. Test/tooling support, NOT part of this
// package's public API — the `showcase-builds.ts` precedent. The balance report
// (`balance-cli.ts`) runs every set in `REFERENCE_SETS`.
//
// The first set is M2's showcase, the checker's calibration: Winner A, Winner B and the
// pinned loser, drawn from the plans in `showcase-builds.ts`. `balance-calibration.test.ts`
// proves each compiles to exactly that plan and reproduces M2's pinned outcome.
//
// Every grid below is the whole 28 × 24 board, so a cell's column is its position in the
// line and its row is the line's (both from 0):
//
//   tens   0         1         2
//   units  0123456789012345678901234567

import type { ReferenceBuild, ReferenceSet } from './reference-build';

export const M2_WINNER_A: ReferenceBuild = {
  id: 'm2-winner-a',
  summary:
    'M2 Winner A, "the poisoner": a basic wall, venom for the ground, antiair along the flight line',
  grid: `
    ############################
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #.aaaavv..aaaavvvvaaaavvvv.#
    #.aaaavv..aaaavvvvaaaavvvv.#
    #.bb..bbvvbb..vv..vv..vvvv.#
    +.bb..bbvvbb..vv..vv..vvvv.+
    #.bbvvbbvvbbvvvv..vvvvvv...#
    #.bbvvbbvvbbvvvv..vvvvvv...#
    #.vv..aaaavvvvaaaavvvvaaaa.#
    #.vv..aaaavvvvaaaavvvvaaaa.#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    ############################
  `,
  order: `
    b2,10 b2,12 b6,10 b6,12 b10,10 b10,12 a4,8 a8,14 v14,10 v14,12 a12,8
    a16,14 v18,10 v18,12 a20,8 a24,14 v22,10 v22,12 v24,10 v20,12 v12,14
    v16,8 v8,10 a2,8 a6,14 a10,8 a14,14 a18,8 a22,14 v12,12 v20,14 v24,8
    v4,12 v8,12 v10,14 v14,8 v18,14 v22,8 v6,8 v2,14
  `,
};

export const M2_WINNER_B: ReferenceBuild = {
  id: 'm2-winner-b',
  summary: 'M2 Winner B, "the control lattice": a beacon-buffed basic wall, a slow band, antiair',
  grid: `
    ############################
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #.aa..aa..aa..aa..aa..aa...#
    #.aa..aa..aa..aa..aa..aa...#
    #.bbbbbbbbbbbbbbbbbbbbbbbb.#
    +.bbbbbbbbbbbbbbbbbbbbbbbb.+
    #.ccbbccbbccbbcc..ccbbcc...#
    #.ccbbccbbccbbcc..ccbbcc...#
    #..........................#
    #.ssssssssssssssssssssssss.#
    #.ssssssssssssssssssssssss.#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    ############################
  `,
  order: `
    b2,10 b4,10 b6,10 b8,10 c2,12 b10,10 b12,10 c6,12 b14,10 b16,10 a2,8
    a6,8 c10,12 b18,10 b20,10 s2,15 s4,15 s6,15 s8,15 a10,8 a14,8 c14,12
    b22,10 b24,10 s10,15 s12,15 s14,15 s16,15 a18,8 a22,8 c18,12 c22,12
    b4,12 b8,12 b12,12 b20,12 s18,15 s20,15 s22,15 s24,15
  `,
};

export const M2_PINNED_LOSER: ReferenceBuild = {
  id: 'm2-pinned-loser',
  summary: 'M2 pinned loser: a basic and venom ground wall with slow, and no anti-air',
  grid: `
    ############################
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #.bb..bb..bb..vv..ss..vv...#
    +.bb..bb..bb..vv..ss..vv...+
    #.bb..bb..bb..vv..ss..vv...#
    #.bb..bb..bb..vv..ss..vv...#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    ############################
  `,
  order: `
    b2,10 b2,12 b6,10 b6,12 b10,10 b10,12 v14,10 v14,12 s18,10 s18,12 v22,10
    v22,12
  `,
};

/** M2's showcase on its own board — the calibration set. */
export const M2_SHOWCASE: ReferenceSet = {
  id: 'm2-showcase',
  rulesetId: 'wynding-core',
  boardId: 'field-01',
  seed: 0x5eed,
  builds: [M2_WINNER_A, M2_WINNER_B, M2_PINNED_LOSER],
};

/** Every set the balance report runs. */
export const REFERENCE_SETS: readonly ReferenceSet[] = [M2_SHOWCASE];
