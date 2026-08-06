// story-flying-wave.test.ts — the M2-S7 P6 pinned wave-5 measurement (PLAN.md §P6).
//
// LOCATION NOTE, same reasoning as `story-armored-wave.test.ts`'s own header: this file
// lives beside `parity.test.ts` (not in `packages/sim`, which cannot import
// `@wynding/content`) so every scenario below runs the REAL shipped `wynding-core`
// bundle through `compileRuleset` → `step()`, not a hand-assembled replica of wave 5.
//
// PURPOSE: closing the gap this story exists to close (an independent review's P2
// finding) — the catalog carried the `flying` creep and the `antiair` tower, but no
// wave spawned `flying`, so the whole air mechanic was unreachable in the shipped
// product. This file witnesses S7's own done-criteria (m2.md Story 7) against the
// bundle now that wave index 5 (8 × `flying`, appended by this packet) actually spawns
// it:
//   - flyers cross a full maze untouched by ground towers;
//   - flyers die to `antiair`;
//   - flyers are slowed by `slow` (now both-domain);
//   - placement over a flyer's occupied cell succeeds.
//
// Every scenario below shares one baseline: a small `basic` wall (waves 0-2) plus a
// `venom` pair built ahead of wave 3 (armored) — the IDENTICAL geometry
// `story-armored-wave.test.ts` proved clears waves 0-4 with zero leaks and all ten
// starting lives intact. Reusing a proven wall keeps each scenario's own build (the
// part that's actually under test) isolated to wave 5 alone, rather than re-deriving
// "does this survive the first five waves" in every `it`.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run story-flying-wave
// after temporarily logging the values (see parity.test.ts's header for the harness
// pattern) — never hand-compute a golden.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  compileRuleset,
  deriveScore,
  deriveStars,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';

/** Fixed seed — same convention as parity.test.ts / story-armored-wave.test.ts. */
const SCENARIO_SEED = 0x5eed;

/** Fixed-point cell size (`FP_ONE`, `@wynding/engine`), inlined rather than imported
 *  for the same reason `parity.test.ts` inlines `fnv1a`: pulling in the engine package
 *  for one constant would add a runtime dependency edge this file doesn't otherwise
 *  need. Used only to derive a live flyer's occupied CELL from its raw fixed-point
 *  `fromX`/`fromY` columns — see the last `it` below, the only place that needs it. */
const FP_ONE = 256;

// The proven `basic` wall (waves 0-2) — byte-identical anchors to
// `story-armored-wave.test.ts`'s `basicAnchors`: a `basic` pair at columns 2, 6 and 10
// (rows 10 and 12, flanking the row-11 lane), six towers total, cost 30 of the
// starting 80 bounty.
const basicAnchors: { col: number; row: number }[] = [
  { col: 2, row: 10 },
  { col: 2, row: 12 },
  { col: 6, row: 10 },
  { col: 6, row: 12 },
  { col: 10, row: 10 },
  { col: 10, row: 12 },
];

// The `venom` pair built ahead of wave 3 (`armored`) — column 16, rows 10 and 12, the
// same flanking geometry one lane further back, byte-identical to
// `story-armored-wave.test.ts`'s `column16Anchors`.
const column16Anchors: { col: number; row: number }[] = [
  { col: 16, row: 10 },
  { col: 16, row: 12 },
];

/** One tower of `towerId` placed every `spacingTicks` ticks (default 10), in
 *  `anchors` order, starting at `startTick` (default 0) — same idiom as
 *  `story-armored-wave.test.ts`'s `anchorWallInputs`, redefined here rather than
 *  imported (each story-golden file is a self-contained script, per this repo's
 *  convention — see that file's own header). */
function anchorWallInputs(
  anchors: readonly { col: number; row: number }[],
  towerId: string,
  startTick = 0,
  spacingTicks = 10,
): (tick: number) => SimInput[] {
  let next = 0;
  return (tick: number): SimInput[] => {
    const out: SimInput[] = [];
    if (tick >= startTick && (tick - startTick) % spacingTicks === 0 && next < anchors.length) {
      out.push({ kind: 'placeTower', anchor: anchors[next]!, towerId });
      next++;
    }
    return out;
  };
}

/** The shared baseline build: the `basic` wall plus the `venom` pair at ticks
 *  1300/1310 — exactly `story-armored-wave.test.ts`'s first scripted build, proven
 *  there to clear waves 0-4 with zero leaks and all ten lives intact. Each scenario
 *  below layers its OWN wave-5-scoped towers on top via `extra`. */
function baselineInputs(extra: (tick: number) => SimInput[]): (tick: number) => SimInput[] {
  const basicWall = anchorWallInputs(basicAnchors, 'basic');
  return (tick: number): SimInput[] => {
    const out = basicWall(tick);
    if (tick === 1300) {
      out.push({ kind: 'placeTower', anchor: column16Anchors[0]!, towerId: 'venom' });
    }
    if (tick === 1310) {
      out.push({ kind: 'placeTower', anchor: column16Anchors[1]!, towerId: 'venom' });
    }
    out.push(...extra(tick));
    return out;
  };
}

describe('wave 5 (the appended `flying` wave) — S7 done-criteria, each measured', () => {
  it('a ground-only wall (the proven wave-0-4 build, no `antiair`) leaves wave 5 untouched — it crosses the whole maze and leaks in full', () => {
    const inputs = baselineInputs(() => []);

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const flyingDef = ruleset.creepById['flying'];
    if (!flyingDef) throw new Error("expected a compiled 'flying' creep");

    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    // PROOF THE FEATURE ENGAGED, before any terminal measurement: every `flying`
    // creep observed, on every tick it exists, sits at exactly its spawn HP — no
    // ground tower in this build (`basic`, `venom`) attacks the `air` domain, so
    // nothing should ever land a hit. This is the literal witness for "untouched",
    // not just an inference from the leak count below.
    let sawAnyFlyer = false;
    for (let t = 0; t < 2400; t++) {
      state = step(state, ruleset, inputs(t));
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'flying') {
          sawAnyFlyer = true;
          expect(state.creeps.hp[i]).toBe(flyingDef.hp);
        }
      }
    }
    expect(sawAnyFlyer).toBe(true);

    // --- THE MEASUREMENT — measured, not invented. The build stays exactly the
    // proven waves-0-4 wall (no new towers), so the terminal figures below are
    // `story-armored-wave.test.ts`'s own wave-5-inclusive re-pin (its first test),
    // reproduced independently here because THIS file's charter is to witness it as
    // an S7 done-criterion, not as a side effect of an armored-wave regression.
    console.log(
      `[story-flying-wave #1] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
        `leaked=${state.leakedCount} bounty=${state.bounty} hash=${hashSimState(state)} ` +
        `score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)}`,
    );
    expect(state.phase).toBe('won');
    expect(state.tick).toBe(2336);
    expect(state.lives).toBe(2);
    expect(state.leakedCount).toBe(8);
    expect(state.waveResolved).toEqual([true, true, true, true, true, true]);
    // Wave index 5 leaked — every one of its 8 `flying` creeps reached the exit,
    // never having taken a single hit (the per-tick HP proof above).
    expect(state.waveLeaked).toEqual([false, false, false, false, false, true]);
    expect(state.waveCursor).toBe(6);
    // cumulativeKillBounty UNCHANGED at 84 from the pre-wave-5 figure (waves 0-4
    // contribute 84; wave index 5 contributes 0 kills, only 8 leaks).
    expect(state.cumulativeKillBounty).toBe(84);
    expect(state.bounty).toBe(141);
    expect(hashSimState(state)).toBe('5c4dd782');
    expect(deriveScore(state, ruleset)).toBe(154);
    expect(deriveStars(state, ruleset)).toBe(1);
  });

  it('an `antiair` wall built ahead of wave 5 kills every `flying` creep — zero leaks', () => {
    // Four `antiair` towers, columns 20 and 24, rows 10 and 12 — the same flanking
    // geometry as the `basic`/`venom` walls, one lane further back still, built at
    // ticks 1900-1930 (well ahead of wave 5's natural launch at prefix 2000, so
    // every tower has established its fire cadence before the first `flying` spawn).
    const antiairAnchors: { col: number; row: number }[] = [
      { col: 20, row: 10 },
      { col: 20, row: 12 },
      { col: 24, row: 10 },
      { col: 24, row: 12 },
    ];
    const antiairWall = anchorWallInputs(antiairAnchors, 'antiair', 1900, 10);
    const inputs = baselineInputs(antiairWall);

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    for (let t = 0; t < 2400; t++) {
      state = step(state, ruleset, inputs(t));
    }

    // PROOF THE FEATURE ENGAGED: all four placements accepted (tower count AND spend
    // both match the compiled catalog's cost — proving none silently no-op'd).
    expect(state.towers.towerId.filter((id) => id === 'antiair')).toHaveLength(4);
    const antiairCost = ruleset.towerById['antiair']?.cost;
    if (antiairCost === undefined) throw new Error("expected 'antiair' in the compiled catalog");
    const antiairSpend = state.towers.towerId.reduce(
      (sum, id, i) => (id === 'antiair' ? sum + state.towers.spend[i]! : sum),
      0,
    );
    expect(antiairSpend).toBe(4 * antiairCost);

    // --- THE MEASUREMENT — measured, not invented.
    console.log(
      `[story-flying-wave #2] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
        `leaked=${state.leakedCount} bounty=${state.bounty} hash=${hashSimState(state)} ` +
        `score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)}`,
    );
    expect(state.phase).toBe('won');
    expect(state.tick).toBe(2296);
    // All ten starting lives intact — wave 5 dies to `antiair` before a single
    // `flying` creep reaches the exit.
    expect(state.lives).toBe(10);
    expect(state.leakedCount).toBe(0);
    expect(state.waveResolved).toEqual([true, true, true, true, true, true]);
    expect(state.waveLeaked).toEqual([false, false, false, false, false, false]);
    expect(state.waveCursor).toBe(6);
    // cumulativeKillBounty 84 -> 100 (+16 = 8 x `flying`'s bounty 2): every one of
    // wave 5's 8 creeps was KILLED, not leaked — the load-bearing proof this
    // scenario exists for. `bounty` also reflects it plus wave 5's clearBonus 6
    // (unlike the leak scenario above, this wave earns its clear bonus).
    expect(state.cumulativeKillBounty).toBe(100);
    expect(state.bounty).toBe(135);
    expect(hashSimState(state)).toBe('c19a1062');
    expect(deriveScore(state, ruleset)).toBe(450);
    expect(deriveStars(state, ruleset)).toBe(3);
  });

  it('`slow` towers (now both-domain) land a slow status on a `flying` creep', () => {
    // Two `slow` towers, columns 20, rows 9 and 13 — off-lane, within the 4-cell
    // range of the row-11 flight line, built at ticks 1900/1910 (ahead of wave 5's
    // launch, same reasoning as the `antiair` wall above).
    const slowAnchors: { col: number; row: number }[] = [
      { col: 20, row: 9 },
      { col: 20, row: 13 },
    ];
    const slowWall = anchorWallInputs(slowAnchors, 'slow', 1900, 10);
    const inputs = baselineInputs(slowWall);

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    // Mid-trace probe (same idiom as parity.test.ts's Codex R2-3 proof), narrowed to
    // `flying` specifically — a self-consistent golden alone cannot certify the
    // `slow` commands actually landed on an AIR creep (as opposed to a ground one
    // elsewhere in the same run), so this asserts a `flying` creep really carried a
    // nonzero `slowMulFp` at some tick.
    let sawSlowedFlyer = false;
    for (let t = 0; t < 2400; t++) {
      state = step(state, ruleset, inputs(t));
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'flying' && state.creeps.slowMulFp[i] !== 0) {
          sawSlowedFlyer = true;
        }
      }
    }
    expect(sawSlowedFlyer).toBe(true);

    // Terminal proof the `slow` placements survived (not silently no-op'd): both
    // still stand.
    expect(state.towers.towerId.filter((id) => id === 'slow')).toHaveLength(2);

    // --- THE MEASUREMENT — measured, not invented. `slow` also carries a small
    // direct hit (2 damage, per the catalog), so — unlike the ground-only scenario
    // above — this build does chip some `flying` HP; it is not a kill build (2
    // damage every 30 ticks against 18 HP is nowhere near enough before a flyer
    // clears the board), so the terminal shape is closer to the ground-only run
    // than to the `antiair` one.
    console.log(
      `[story-flying-wave #3] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
        `leaked=${state.leakedCount} bounty=${state.bounty} hash=${hashSimState(state)} ` +
        `score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)}`,
    );
    expect(state.phase).toBe('won');
    expect(state.tick).toBe(2356);
    expect(state.lives).toBe(3);
    expect(state.leakedCount).toBe(7);
    expect(state.waveResolved).toEqual([true, true, true, true, true, true]);
    expect(state.waveLeaked).toEqual([false, false, false, false, false, true]);
    expect(state.waveCursor).toBe(6);
    // cumulativeKillBounty 84 -> 86 (+2 = one `flying` kill: the two `slow` towers'
    // small direct hits happened to finish one off before the exit; the other seven
    // still leak).
    expect(state.cumulativeKillBounty).toBe(86);
    expect(state.bounty).toBe(127);
    expect(hashSimState(state)).toBe('ce6836e5');
    expect(deriveScore(state, ruleset)).toBe(191);
    expect(deriveStars(state, ruleset)).toBe(1);
  });

  it("placement over a live `flying` creep's occupied cell succeeds", () => {
    const inputs = baselineInputs(() => []);

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);

    // Find a live `flying` creep's OCCUPIED cell (PRD 0001 §3's "the cell containing
    // its point"), derived the same way `tower.ts`'s `creepOccupiedCell` does, over
    // this board's specific geometry: entrance and exit are both row 11
    // (`registry.test.ts`'s own board-geometry pin), so `airLineFollowNeighbor`'s
    // zero-cross-product straight step keeps every flight segment a pure horizontal
    // edge, `headRow === fromRow === 11` throughout. For a horizontal `edgeLen`-256
    // step, `deriveValidCreepPosition`'s floor interpolation never crosses a cell
    // boundary until the segment snaps (`px = fromX + progress`, and `progress <
    // 256`), so the occupied cell is simply `floor(fromX/256)`, `floor(fromY/256)` —
    // i.e., `fromCol`/`fromRow` themselves. Column 13+ is chosen deliberately, not
    // arbitrarily: `registry.test.ts`'s board-geometry test shows the entrance cell
    // `(0,11)`'s ONLY passable neighbor is `(1,11)` (its row-10/row-12 neighbors are
    // `blocked` border), so anchoring a 2×2 footprint at columns 1-2 would fail
    // canPlaceTower's OWN maze-invariant clause (5) by sealing the entrance — a
    // structural fact about this board, not about flyers. Column 13 sits well past
    // that bottleneck, in the wide-open interior where the invariant can route
    // around any single 2×2 footprint.
    let flyerCell: { col: number; row: number } | null = null;
    for (let t = 0; t < 2400 && flyerCell === null; t++) {
      state = step(state, ruleset, inputs(t));
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'flying') {
          const col = Math.floor(state.creeps.fromX[i]! / FP_ONE);
          const row = Math.floor(state.creeps.fromY[i]! / FP_ONE);
          if (col >= 13) {
            flyerCell = { col, row };
            break;
          }
        }
      }
    }
    if (flyerCell === null) {
      throw new Error('expected to observe a live flying creep past column 13 before tick 2400');
    }
    expect(flyerCell.row).toBe(11); // the straight row-11 flight line, confirmed live

    const towersBefore = state.towers.towerId.length;
    const bountyBefore = state.bounty;
    const antiairCost = ruleset.towerById['antiair']?.cost;
    if (antiairCost === undefined) throw new Error("expected 'antiair' in the compiled catalog");

    // Build directly on the flyer's own occupied cell, the very next tick (the
    // flyer's speed — 30 fp/tick against a 256-wide cell — leaves it resident there
    // for several more ticks, so this remains a same-cell placement).
    state = step(state, ruleset, [{ kind: 'placeTower', anchor: flyerCell, towerId: 'antiair' }]);

    // THE ASSERTION: the placement was ACCEPTED, not a silent no-op — a ground
    // creep on this exact cell would have failed `canPlaceTower`'s clause 3
    // (PRD 0001 §3); a `flying` creep does not, because air never occupies a cell
    // for placement purposes (M2-S7 P4).
    expect(state.towers.towerId.length).toBe(towersBefore + 1);
    expect(state.towers.towerId[state.towers.towerId.length - 1]).toBe('antiair');
    expect(state.bounty).toBe(bountyBefore - antiairCost);
  });
});
