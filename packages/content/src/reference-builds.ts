// reference-builds.ts — M3 story 1: the balance checker's REGISTERED reference builds, in
// the grid format `reference-build.ts` defines. Test/tooling support, NOT part of this
// package's public API — the `showcase-builds.ts` precedent. The balance report
// (`balance-cli.ts`) runs every set in `REFERENCE_SETS`.
//
// The first set is M2's showcase, the checker's calibration: Winner A, Winner B and the
// pinned loser, drawn from the plans in `showcase-builds.ts`. `balance-calibration.test.ts`
// proves each compiles to exactly that plan and reproduces M2's pinned outcome.
//
// The second is M3's, on the shipped crossing board (M3 stories 5–7): three winners of the
// whole run — one maze both routes walk, one maze per route, one straight channel both routes
// walk — and the five losers section A names. The first winner fills the board, so it is
// also the set's capacity drawing. `balance-crossing.test.ts` pins their outcomes.
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

// --- M3: the crossing board (M3 stories 5–7, the whole run) --------------------------------
//
// THE SERPENTINE merges both routes into one maze. A wall down the west side (columns 2–3)
// turns west creeps up to row 1, where the north route starts; both then wind east and back
// between the horizontal walls, and a wall down the east side (columns 24–25) keeps west
// creeps from cutting across to their exit until the maze is behind them. Block 1 affords
// the first two horizontal walls; the antiair over the west lane stands where the third and
// fourth will, its first two placed before the west wall's lower half, so they stand by the
// first flyers even when towers cost more. Splash at the entrance for the swarm, venom along
// the corridors for armor and the bosses. Block 2 builds the other five walls, down to the
// bottom border, all but the last tower, which goes down in wave 21; the finished maze fills
// the board: no 2 × 2 is left clear of both routes' paths. The three walls along the west
// lane (rows 8, 11 and 14) carry its antiair for block 3's armored flyers: row 11 alternates
// antiair and beacons, row 8 sets a beacon among its antiair, rows 8 and 14 each have a slow
// at the west end to hold the flyers in range, and row 17 sets a beacon between two antiair
// across the north lane. The rest is basic and splash, level by spend, splash along every
// corridor both routes walk; by spend the whole build is a basic and splash build.
//
// TWO MAZES defends the routes separately. Three vertical walls (columns 3–4 and 10–11 from
// the top border, 7–8 from the bottom) wind the west route; two horizontal walls east of
// the third (rows 3–4 against it, rows 7–8 against the east border) wind the north route.
// The routes cross once, where north creeps come down column 14. Block 2 adds no basic and
// moves no wall: venom fills the pockets the routes pass (south of the west route's long
// run, over its top turn, beside the north route's east turn), and antiair rings both lanes
// — a block beside the north lane's south half, a row along the west lane's east half around
// a beacon, three more at the crossing; its first two antiair stand before the north maze's
// last walls, so they are up for the first flyers even when towers cost more. Six more,
// placed late in block 2 against block 3's air, stand down the north lane above the crossing
// (two antiair and a beacon) and over the west lane east of it, with a venom beside the west
// route's last run. It still
// lets a few of block 3's armored flyers and its north boss through, so it wins on fewer
// lives. By spend it is a venom and antiair build.
//
// THE CHANNEL sends both routes down one straight channel. A wall from the top border
// (columns 3–4) turns west creeps down at the entrance; a block three towers wide from the
// bottom border (columns 7–12) sends them up and over into the channel (columns 13–14), the
// north route's own line from entrance to exit; a second block from the top (columns 15–20)
// sends them out under it, and a wall from the bottom (columns 23–24) up and over to the east
// exit's column. North creeps walk the channel straight down; west creeps walk it too, beside
// them, after winding the west half. Each block's middle column is beacons and slows, so the
// beacons buff the venom, splash and antiair beside them and every creep in the channel is
// slowed; where the west lane crosses the blocks (rows 9–14) they are antiair around beacons.
// By spend it is a slow and beacon build.
//
// The three winners share no top-two tower id (m3.md, A1).

export const M3_SERPENTINE: ReferenceBuild = {
  id: 'm3-serpentine',
  summary:
    'one maze both routes walk: west creeps are walled up onto the north route’s corridors; splash along them, venom, and antiair, beacons and slows across both lanes',
  grid: `
    #############+##############
    #.......................bb.#
    #...bbbbbbvvbbvvbbvvbb..bb.#
    #.bbbbbbbbvvbbvvbbvvbb..bb.#
    #.bb....................bb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp....................bb.#
    #.ppssppppaaaaaaccaaaa..bb.#
    #.ppssppppaaaaaaccaaaa..ss.#
    #.pp....................ss.#
    +.bb..aaccaaccaaccaaccaass.+
    #.bb..aaccaaccaaccaaccaass.#
    #.bb....................bb.#
    #.bbssppppaaaaaabbppbb..bb.#
    #.bbssppppaaaaaabbppbb..bb.#
    #.bb....................bb.#
    #.bb..bbppaaccaabbppbbbbbb.#
    #.bb..bbppaaccaabbppbbbbbb.#
    #.bb....................bb.#
    #.bbbbppbbppaappppbbbb..bb.#
    #.bbbbppbbppaappppbbbb.....#
    #.bb.......................#
    #############+##############
  `,
  order: `
    b2,11 b2,13 p2,9 p2,7 p2,5 b2,3 b12,2 v14,2 v10,2 b16,2 b8,2 v18,2 b6,2 b20,2 b4,2 a10,11
    a14,11 b2,15 b2,17 b2,19 b2,21 a6,11 s24,11 s24,9 b24,13 b24,7 b24,15 b24,5 b24,17 b24,3
    b24,19 b24,1 a18,11 b22,5 v20,5 b18,5 p16,5 b14,5 v12,5 a22,11 a12,8 a20,8 b10,5 v8,5 b6,5
    s4,8 p6,8 p8,8 a10,8 a14,8 c16,8 a18,8 c8,11 c12,11 c16,11 c20,11 s4,14 p6,14 p8,14 a10,14
    a12,14 a14,14 b16,14 p18,14 b20,14 b6,17 p8,17 a10,17 c12,17 a14,17 b16,17 p18,17 b20,17
    b22,17 b4,20 p6,20 b8,20 p10,20 a12,20 p14,20 p16,20 b18,20 b20,20
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
    #..bb.....bbaa...........vv#
    #..bb.....bbaa...........vv#
    #..vv..bb.vvaa.vvaabbaabbbb#
    #..vv..bb.vvaa.vvaabbaabbbb#
    #..bb..pp.bbcc.vvaaaaccaaaa#
    #..bb..pp.bbcc.vvaaaaccaaaa#
    +..bb..aa.aaaa.aaaa........+
    #..bb..aa.aaaa.aaaaaa...aa.#
    #..pp..vv.vvvv.aavvaa.aaaa.#
    #..pp..vv.vvvv.aavv...aaaa.#
    #..bb..bb.bbbb..pp......aa.#
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
    b3,11 b3,9 b3,15 v7,13 b7,15 p3,13 p7,9 v3,7 b10,1 b10,3 b12,3 p14,3 b16,3 v18,3 a7,11
    a10,11 b20,3 b22,3 b10,5 v10,7 b10,9 v10,13 b10,15 a12,11 b3,5 b3,3 b3,1 b7,17 b7,19 b7,21
    b7,7 v15,7 a17,7 b19,7 a21,7 b23,7 b25,7 a19,12 a24,12 v15,9 v12,13 p16,15 b12,15 v1,18
    v3,18 v5,18 v11,18 a11,20 a9,18 a15,18 v17,18 a17,9 a19,9 c21,9 a23,9 v25,1 v25,3 v25,5 v5,3
    v7,3 a9,20 a15,20 v1,20 v3,20 a25,9 v19,18 a15,11 a17,11 a15,13
    a12,5 a12,7 c12,9 v17,13 a22,13 a24,14
  `,
};

export const M3_CHANNEL: ReferenceBuild = {
  id: 'm3-channel',
  summary:
    'one straight channel both routes walk, the north route’s own line: slows and beacons three towers deep along it, buffing venom and antiair',
  grid: `
    #############+##############
    #..bb..........aassss......#
    #..bb..........aassss......#
    #..bb..bbssvv..vvccss..ss..#
    #..bb..bbssvv..vvccss..ss..#
    #..bb..ssccpp..ppssbb..ss..#
    #..bb..ssccpp..ppssbb..ss..#
    #..ss..vvssvv..vvccss..bb..#
    #..ss..vvssvv..vvccss..bb..#
    #..bb..aaccaa..aaaaaa..aa..#
    #..bb..aaccaa..aaaaaa..aa..#
    +..pp..ccaacc..ccaacc..cc..+
    #..pp..ccaacc..ccaacc..cc..#
    #..bb..aaccaa..aaccaa..aa..#
    #..bb..aaccaa..aaccaa..aa..#
    #..vv..ssssvv..vvssss..ss..#
    #..vv..ssssvv..vvssss..ss..#
    #..ss..bbccpp..ppccbb..ss..#
    #..ss..bbccpp..ppccbb..ss..#
    #..bb..ssssvv..vvssss..ss..#
    #..bb..ssssvv..vvssss..ss..#
    #......bbssaa..........ss..#
    #......bbssaa..........ss..#
    #############+##############
  `,
  order: `
    b3,9 p3,11 b3,13 s3,7 b3,5 b3,3 b3,1 v3,15 s3,17 b3,19 v11,3 v15,3 a7,9 a7,13 p11,5 p15,5
    v11,7 v15,7 b7,21 s7,19 b7,17 s7,15 c7,11 v7,7 s7,5 b7,3 a11,9 a15,9 c11,11 a11,13 c15,11
    c9,9 a17,9 a15,13 a15,1 v11,15 v15,15 p11,17 p15,17 v11,19 v15,19 a11,21 a9,11 c9,13 s9,3
    c9,5 s9,7 s9,15 c9,17 s9,19 s9,21 a17,11 c17,13 s17,1 c17,3 s17,5 c17,7 s17,15 c17,17 s17,19
    a19,9 c19,11 a19,13 s19,1 s19,3 b19,5 s19,7 s19,15 b19,17 s19,19 a23,9 c23,11 a23,13 s23,21
    s23,19 s23,17 s23,15 b23,7 s23,5 s23,3
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

/** The serpentine for the ground alone: tower for tower its plan, with a venom wherever it
 *  places an antiair and a basic wherever it places a slow or a beacon, so no tower it places
 *  can hit a flyer (only `antiair` and `slow` reach the air) or lift one that can. */
export const M3_NO_ANTI_AIR: ReferenceBuild = {
  id: 'm3-no-anti-air',
  summary:
    'the serpentine with nothing that can hit a flyer: venom where its antiair stands, basic where its slows and beacons do',
  grid: `
    #############+##############
    #.......................bb.#
    #...bbbbbbvvbbvvbbvvbb..bb.#
    #.bbbbbbbbvvbbvvbbvvbb..bb.#
    #.bb....................bb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp..bbvvbbvvbbppbbvvbbbb.#
    #.pp....................bb.#
    #.ppbbppppvvvvvvbbvvvv..bb.#
    #.ppbbppppvvvvvvbbvvvv..bb.#
    #.pp....................bb.#
    +.bb..vvbbvvbbvvbbvvbbvvbb.+
    #.bb..vvbbvvbbvvbbvvbbvvbb.#
    #.bb....................bb.#
    #.bbbbppppvvvvvvbbppbb..bb.#
    #.bbbbppppvvvvvvbbppbb..bb.#
    #.bb....................bb.#
    #.bb..bbppvvbbvvbbppbbbbbb.#
    #.bb..bbppvvbbvvbbppbbbbbb.#
    #.bb....................bb.#
    #.bbbbppbbppvvppppbbbb..bb.#
    #.bbbbppbbppvvppppbbbb.....#
    #.bb.......................#
    #############+##############
  `,
  order: `
    b2,11 b2,13 p2,9 p2,7 p2,5 b2,3 b12,2 v14,2 v10,2 b16,2 b8,2 v18,2 b6,2 b20,2 b4,2 v10,11
    v14,11 b2,15 b2,17 b2,19 b2,21 v6,11 b24,11 b24,9 b24,13 b24,7 b24,15 b24,5 b24,17 b24,3
    b24,19 b24,1 v18,11 b22,5 v20,5 b18,5 p16,5 b14,5 v12,5 v22,11 v12,8 v20,8 b10,5 v8,5 b6,5
    b4,8 p6,8 p8,8 v10,8 v14,8 b16,8 v18,8 b8,11 b12,11 b16,11 b20,11 b4,14 p6,14 p8,14 v10,14
    v12,14 v14,14 b16,14 p18,14 b20,14 b6,17 p8,17 v10,17 b12,17 v14,17 b16,17 p18,17 b20,17
    b22,17 b4,20 p6,20 b8,20 p10,20 v12,20 p14,20 p16,20 b18,20 b20,20
  `,
};

/** The serpentine with damage alone (m3.md, A2: `basic`, `splash`, `mine` and `antiair`):
 *  tower for tower its plan, with a basic wherever it places a venom or a slow and an antiair
 *  wherever it places a beacon, so nothing it places slows, poisons or buffs. */
export const M3_DAMAGE_ONLY: ReferenceBuild = {
  id: 'm3-damage-only',
  summary:
    'the serpentine with damage alone: basic where its venom and slows stand, antiair where its beacons do',
  grid: `
    #############+##############
    #.......................bb.#
    #...bbbbbbbbbbbbbbbbbb..bb.#
    #.bbbbbbbbbbbbbbbbbbbb..bb.#
    #.bb....................bb.#
    #.pp..bbbbbbbbbbppbbbbbbbb.#
    #.pp..bbbbbbbbbbppbbbbbbbb.#
    #.pp....................bb.#
    #.ppbbppppaaaaaaaaaaaa..bb.#
    #.ppbbppppaaaaaaaaaaaa..bb.#
    #.pp....................bb.#
    +.bb..aaaaaaaaaaaaaaaaaabb.+
    #.bb..aaaaaaaaaaaaaaaaaabb.#
    #.bb....................bb.#
    #.bbbbppppaaaaaabbppbb..bb.#
    #.bbbbppppaaaaaabbppbb..bb.#
    #.bb....................bb.#
    #.bb..bbppaaaaaabbppbbbbbb.#
    #.bb..bbppaaaaaabbppbbbbbb.#
    #.bb....................bb.#
    #.bbbbppbbppaappppbbbb..bb.#
    #.bbbbppbbppaappppbbbb.....#
    #.bb.......................#
    #############+##############
  `,
  order: `
    b2,11 b2,13 p2,9 p2,7 p2,5 b2,3 b12,2 b14,2 b10,2 b16,2 b8,2 b18,2 b6,2 b20,2 b4,2 a10,11
    a14,11 b2,15 b2,17 b2,19 b2,21 a6,11 b24,11 b24,9 b24,13 b24,7 b24,15 b24,5 b24,17 b24,3
    b24,19 b24,1 a18,11 b22,5 b20,5 b18,5 p16,5 b14,5 b12,5 a22,11 a12,8 a20,8 b10,5 b8,5 b6,5
    b4,8 p6,8 p8,8 a10,8 a14,8 a16,8 a18,8 a8,11 a12,11 a16,11 a20,11 b4,14 p6,14 p8,14 a10,14
    a12,14 a14,14 b16,14 p18,14 b20,14 b6,17 p8,17 a10,17 a12,17 a14,17 b16,17 p18,17 b20,17
    b22,17 b4,20 p6,20 b8,20 p10,20 a12,20 p14,20 p16,20 b18,20 b20,20
  `,
};

/** M2's winning shape on this board (m3.md, A2's competent corridor): no maze, each route's
 *  straight empty-board lane lined on both sides — a wall above and below the west lane
 *  (rows 7–10 and 12–15), one left and right of the north lane (columns 9–12 and 14–17) —
 *  with M2's mix along them: venom and basic for the ground, splash, slows and two beacons, and
 *  antiair over both lanes. It places every tower that reaches a lane, by wave 18. */
export const M3_CORRIDOR: ReferenceBuild = {
  id: 'm3-corridor',
  summary:
    'a competent corridor: no maze, each route’s straight lane lined on both sides — M2’s winning shape, one per route',
  grid: `
    #############+##############
    #........bbbb.bbbb.........#
    #........bbbb.bbbb.........#
    #........aavv.ppaa.........#
    #........aavv.ppaa.........#
    #........vvbb.bbvv.........#
    #........vvbb.bbvv.........#
    #aaccaaaassbb.vvssccaavvbb.#
    #aaccaaaassbb.vvssccaavvbb.#
    #bbppbbaappaa.vvbbaappbbvv.#
    #bbppbbaappaa.vvbbaappbbvv.#
    +..........................+
    #bbvvbbvvvvss.aavvbbvvaabb.#
    #bbvvbbvvvvss.aavvbbvvaabb.#
    #vvaabbvvssvv.bbssaavvbbaa.#
    #vvaabbvvssvv.bbssaavvbbaa.#
    #........vvpp.vvvv.........#
    #........vvpp.vvvv.........#
    #........aabb.vvaa.........#
    #........aabb.vvaa.........#
    #........bbbb.bbbb.........#
    #........bbbb.bbbb.........#
    #..........................#
    #############+##############
  `,
  order: `
    b1,9 b1,12 p3,9 v3,12 b5,9 b5,12 a7,9 v7,12 b11,1 b14,1 v11,3 p14,3 b11,5 b14,5 p9,9 v9,12
    a11,9 s11,12 v14,9 a14,12 b11,7 v14,7 v11,14 b14,14 p11,16 v14,16 b16,9 v16,12 a18,9 b18,12
    p20,9 v20,12 b22,9 a22,12 v24,9 b24,12 c3,7 a1,7 a5,7 b11,18 v14,18 b11,20 b14,20 s9,7 s16,7
    v1,14 a3,14 b5,14 v7,14 s9,14 s16,14 a18,14 v20,14 b22,14 a24,14 a7,7 c18,7 a20,7 v22,7
    b24,7 a9,3 a16,3 v9,5 v16,5 b9,1 b16,1 v9,16 v16,16 a9,18 a16,18 b9,20 b16,20
  `,
};

/** M3's set on the shipped crossing board: the three winners of the whole run, then the five
 *  losers. The serpentine is the strongest — the only winner on all 20 lives — and it fills
 *  the board, so it is its own capacity drawing. */
export const M3_CROSSING: ReferenceSet = {
  id: 'm3-crossing',
  rulesetId: 'wynding-core',
  boardId: 'crossing-medium',
  seed: 0x5eed,
  builds: [
    M3_SERPENTINE,
    M3_TWO_MAZES,
    M3_CHANNEL,
    M3_UNDEFENDED,
    M3_WEST_ONLY,
    M3_NO_ANTI_AIR,
    M3_DAMAGE_ONLY,
    M3_CORRIDOR,
  ],
  fullBoard: M3_SERPENTINE,
};

/** Every set the balance report runs. */
export const REFERENCE_SETS: readonly ReferenceSet[] = [M2_SHOWCASE, M3_CROSSING];
