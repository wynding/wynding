// reference-builds.ts — M3 story 1: the balance checker's REGISTERED reference builds, in
// the grid format `reference-build.ts` defines. Test/tooling support, NOT part of this
// package's public API — the `showcase-builds.ts` precedent. The balance report
// (`balance-cli.ts`) runs every set in `REFERENCE_SETS`.
//
// The first set is M2's showcase, the checker's calibration: Winner A, Winner B and the
// pinned loser, drawn from the plans in `showcase-builds.ts`. `balance-calibration.test.ts`
// proves each compiles to exactly that plan and reproduces M2's pinned outcome.
//
// The second is M3's, on the shipped crossing board (M3 stories 5–6): two winners of blocks
// 1–2 — one maze both routes walk, one maze per route — and the three losers blocks 1–2 can
// already show. The first winner fills the board, so it is also the set's capacity drawing.
// `balance-crossing.test.ts` pins their outcomes.
//
// Every grid below is the whole 28 × 24 board, so a cell's column is its position in the
// line and its row is the line's (both from 0):
//
//   tens   0         1         2
//   units  0123456789012345678901234567

import type { ReferenceBuild, ReferenceSet } from './reference-build';
import { M2_BOARD_ID, M2_FIXTURE_KEY } from './m2-fixture-key';

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

/** M2's showcase on its own board — the calibration set. Since M3 story 4 M2's board and
 *  waves are no longer shipped: the set runs on the frozen M2 bundle, by its own key. */
export const M2_SHOWCASE: ReferenceSet = {
  id: 'm2-showcase',
  rulesetId: M2_FIXTURE_KEY,
  boardId: M2_BOARD_ID,
  seed: 0x5eed,
  builds: [M2_WINNER_A, M2_WINNER_B, M2_PINNED_LOSER],
};

// --- M3: the crossing board (M3 stories 5–6, blocks 1–2) ---------------------------------
//
// THE SERPENTINE merges both routes into one maze. A wall down the west side (columns 2–3)
// turns west creeps up to row 1, where the north route starts; both then wind east and back
// between the horizontal walls, and a wall down the east side (columns 24–25) keeps west
// creeps from cutting across to their exit until the maze is behind them. Block 1 affords
// the first two horizontal walls; the antiair over the west lane stands where the third and
// fourth will. Splash at the entrance for the swarm, venom along the corridors for armor and
// the boss. Block 2 builds the other five walls, down to the bottom border, which fills the
// board: no 2 × 2 is left clear of both routes' paths. Their towers are mostly splash,
// because both routes walk every corridor, with venom down the middle for armor and the two
// bosses, antiair down column 12 under the north lane, and two beacons in the row-11
// antiair line for wave 19's armored flyers. By spend it is a basic and splash build.
//
// TWO MAZES defends the routes separately. Three vertical walls (columns 3–4 and 10–11 from
// the top border, 7–8 from the bottom) wind the west route; two horizontal walls east of
// the third (rows 3–4 against it, rows 7–8 against the east border) wind the north route.
// The routes cross once, where north creeps come down column 14. Block 2 adds no basic and
// moves no wall: venom fills the pockets the routes pass (south of the west route's long
// run, over its top turn, beside the north route's east turn), and antiair rings both lanes
// — a block beside the north lane's south half, a row along the west lane's east half around
// a beacon, three more at the crossing. By spend it is a venom and antiair build, so the
// two winners share neither of their top two tower ids (m3.md, A1).

export const M3_SERPENTINE: ReferenceBuild = {
  id: 'm3-serpentine',
  summary:
    'one maze both routes walk: west creeps are walled up onto the north route’s corridors; splash along them, venom, antiair over both lanes',
  grid: `
    #############+##############
    #.......................bb.#
    #...bbbbbbvvbbvvbbvvbb..bb.#
    #.bbbbbbbbvvbbvvbbvvbb..bb.#
    #.bb....................bb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp....................bb.#
    #.ppbbppbbppaavvbbppaa..bb.#
    #.ppbbppbbppaavvbbppaa..ss.#
    #.pp....................ss.#
    +.bb..aappaaccaavvaaccaass.+
    #.bb..aappaaccaavvaaccaass.#
    #.bb....................bb.#
    #.bbbbppbbppaavvbbppbb..bb.#
    #.bbbbppbbppaavvbbppbb..bb.#
    #.bb....................bb.#
    #.bb..bbppbbaappbbppbbbbbb.#
    #.bb..bbppbbaappbbppbbbbbb.#
    #.bb....................bb.#
    #.bbbbppbbppaavvbbbbbb..bb.#
    #.bbbbppbbppaavvbbbbbb.....#
    #.bb.......................#
    #############+##############
  `,
  order: `
    b2,11 b2,13 p2,9 p2,7 p2,5 b2,3 b12,2 v14,2 v10,2 b16,2 b8,2 v18,2 b6,2 b20,2 b4,2 b2,15
    b2,17 b2,19 b2,21 a10,11 a14,11 a6,11 s24,11 s24,9 b24,13 b24,7 b24,15 b24,5 b24,17
    b24,3 b24,19 b24,1 a18,11 b22,5 v20,5 b18,5 p16,5 b14,5 v12,5 a22,11 a12,8 a20,8 b10,5
    v8,5 b6,5
    b4,8 p6,8 b8,8 p10,8 v14,8 b16,8 p18,8 p8,11 c12,11 v16,11 c20,11 b4,14 p6,14 b8,14 p10,14
    a12,14 v14,14 b16,14 p18,14 b20,14 b6,17 p8,17 b10,17 a12,17 p14,17 b16,17 p18,17 b20,17
    b22,17 b4,20 p6,20 b8,20 p10,20 a12,20 v14,20 b16,20 b18,20 b20,20
  `,
};

export const M3_TWO_MAZES: ReferenceBuild = {
  id: 'm3-two-mazes',
  summary:
    'a maze per route: vertical walls wind the west route, horizontal walls the north; venom beside both, antiair around both lanes',
  grid: `
    #############+##############
    #..bb.....bb.............vv#
    #..bb.....bb.............vv#
    #..bbvvvv.bbbbppbbvvbbbb.vv#
    #..bbvvvv.bbbbppbbvvbbbb.vv#
    #..bb.....bb.............vv#
    #..bb.....bb.............vv#
    #..vv..bb.vv...vvaabbaabbbb#
    #..vv..bb.vv...vvaabbaabbbb#
    #..bb..pp.bb...vvaaaaccaaaa#
    #..bb..pp.bb...vvaaaaccaaaa#
    +..bb..aa.aaaa.aaaa........+
    #..bb..aa.aaaa.aaaaaa...aa.#
    #..pp..vv.vvvv.aa..aa...aa.#
    #..pp..vv.vvvv.aa..........#
    #..bb..bb.bbbb..pp.........#
    #..bb..bb.bbbb..pp.........#
    #......bb..................#
    #vvvvvvbbaavv..aavvvv......#
    #vvvvvvbbaavv..aavvvv......#
    #vvvv..bbaaaa..aa..........#
    #vvvv..bbaaaa..aa..........#
    #......bb..................#
    #############+##############
  `,
  order: `
    b3,11 b3,9 b3,15 v7,13 b7,15 p3,13 p7,9 v3,7 b10,1 b10,3 b12,3 p14,3 b16,3 v18,3 b20,3
    b22,3 b10,5 v10,7 b10,9 v10,13 b10,15 a7,11 a10,11 a12,11 b3,5 b3,3 b3,1 b7,17 b7,19
    b7,21 b7,7 v15,7 a17,7 b19,7 a21,7 b23,7 b25,7 a19,12 a24,12 v15,9 v12,13 p16,15 b12,15
    v1,18 v3,18 v5,18 v11,18 a11,20 a9,18 a15,18 v17,18 a17,9 a19,9 c21,9 a23,9 v25,1 v25,3
    v25,5 v5,3 v7,3 a9,20 a15,20 v1,20 v3,20 a25,9 v19,18 a15,11 a17,11 a15,13
  `,
};

export const M3_UNDEFENDED: ReferenceBuild = {
  id: 'm3-undefended',
  summary: 'no towers at all',
  grid: `
    #############+##############
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    +..........................+
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #..........................#
    #############+##############
  `,
  order: '',
};

export const M3_WEST_ONLY: ReferenceBuild = {
  id: 'm3-west-only',
  summary:
    'a maze for the west route alone: two vertical walls, every tower in columns 1–8, out of the north route’s reach',
  grid: `
    #############+##############
    #..bbvv....................#
    #..bbvv....................#
    #..bb......................#
    #..bb......................#
    #..bb......................#
    #..bb......................#
    #..vv..bb..................#
    #..vv..bb..................#
    #..bb..pp..................#
    #..bb..pp..................#
    +..bb..aa..................+
    #..bb..aa..................#
    #..pp..vv..................#
    #..pp..vv..................#
    #..bb..bb..................#
    #..bb..bb..................#
    #......bb..................#
    #......bb..................#
    #bb....bb..................#
    #bb....bb..................#
    #....bbbb..................#
    #....bbbb..................#
    #############+##############
  `,
  order: `
    b3,11 b3,9 b3,15 v7,13 b7,15 p3,13 p7,9 v3,7 b3,5 b3,3 b3,1 b7,17 b7,19 b7,21 b7,7 a7,11
    v5,1 b1,19 b5,21
  `,
};

/** The serpentine's maze for the ground alone: every antiair it holds a venom, every slow a
 *  basic, so no tower it places can hit a flyer (only `antiair` and `slow` reach the air). */
export const M3_NO_ANTI_AIR: ReferenceBuild = {
  id: 'm3-no-anti-air',
  summary:
    'the serpentine’s maze with nothing that can hit a flyer: venom where its antiair stands, basic where its slow does',
  grid: `
    #############+##############
    #.......................bb.#
    #...bbbbbbvvbbvvbbvvbb..bb.#
    #.bbbbbbbbvvbbvvbbvvbb..bb.#
    #.bb....................bb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp....................bb.#
    #.ppbbvvbbppvvvvbbvvvv..bb.#
    #.ppbbvvbbppvvvvbbvvvv..bb.#
    #.pp....................bb.#
    +.bb..vvvvvvbbvvvvvvbbvvbb.+
    #.bb..vvvvvvbbvvvvvvbbvvbb.#
    #.bb....................bb.#
    #.bbbbvvbbppvvvvbbvvbb..bb.#
    #.bbbbvvbbppvvvvbbvvbb..bb.#
    #.bb....................bb.#
    #.bb..bbvvbbvvppbbvvbbbbbb.#
    #.bb..bbvvbbvvppbbvvbbbbbb.#
    #.bb....................bb.#
    #.bbbbvvbbppvvvvbbbbbb..bb.#
    #.bbbbvvbbppvvvvbbbbbb.....#
    #.bb.......................#
    #############+##############
  `,
  order: `
    b2,11 b2,13 p2,9 p2,7 p2,5 b2,3 b12,2 v14,2 v10,2 b16,2 b8,2 v18,2 b6,2 b20,2 b4,2 b2,15
    b2,17 b2,19 b2,21 v10,11 v14,11 v6,11 b24,11 b24,9 b24,13 b24,7 b24,15 b24,5 b24,17
    b24,3 b24,19 b24,1 v18,11 b22,5 v20,5 b18,5 p16,5 b14,5 v12,5 v22,11 v12,8 v20,8 b10,5
    v8,5 b6,5
    b4,8 v6,8 b8,8 p10,8 v14,8 b16,8 v18,8 v8,11 b12,11 v16,11 b20,11 b4,14 v6,14 b8,14 p10,14
    v12,14 v14,14 b16,14 v18,14 b20,14 b6,17 v8,17 b10,17 v12,17 p14,17 b16,17 v18,17 b20,17
    b22,17 b4,20 v6,20 b8,20 p10,20 v12,20 v14,20 b16,20 b18,20 b20,20
  `,
};

/** M3's set on the shipped crossing board: the two winners of blocks 1–2, then their three
 *  losers. The serpentine fills the board by wave 20, so it is its own capacity drawing. */
export const M3_CROSSING: ReferenceSet = {
  id: 'm3-crossing',
  rulesetId: 'wynding-core',
  boardId: 'crossing-medium',
  seed: 0x5eed,
  builds: [M3_SERPENTINE, M3_TWO_MAZES, M3_UNDEFENDED, M3_WEST_ONLY, M3_NO_ANTI_AIR],
  fullBoard: M3_SERPENTINE,
};

/** Every set the balance report runs. */
export const REFERENCE_SETS: readonly ReferenceSet[] = [M2_SHOWCASE, M3_CROSSING];
