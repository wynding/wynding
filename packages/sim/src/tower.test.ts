// tower.test.ts — Story 3: build/sell commands, the two-stage placement
// validation (structural → buildable → unoccupied → affordable → maze
// invariant), commit-to-next re-pathing through step(), and tower-state
// totality across corrupt/forged restored states.

import { describe, it, expect } from 'vitest';
import { createInitialState, step, hashSimState, type SimInput, type SimState } from './index';
import { findValidTowerIndex, materializeTowerMask, refundFor } from './tower';
import { deriveValidCreepPosition } from './movement';
import { testRuleset, pushCreep } from './test-support';

/** The M1 tower cost (was an exported const; now ruleset content). */
const TOWER_COST = 5;

/** Fixed-point centre of a cell coordinate. */
const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

/** The cell a creep row currently occupies (derived), or null if its state is corrupt. */
function occ(s: SimState, k: number, grid: Parameters<typeof deriveValidCreepPosition>[5]) {
  return deriveValidCreepPosition(
    s.creeps.fromX[k],
    s.creeps.fromY[k],
    s.creeps.headCol[k],
    s.creeps.headRow[k],
    s.creeps.progress[k],
    grid,
  )?.occupancyCell;
}

// A 9×6 lane board: entrance (0,2) → exit (8,2). A 2×2 tower at (3,1) walls rows
// 1-2 at cols 3-4 (creeps detour via rows 3-4); adding (3,3) seals the corridor.
const RULESET_LANE = testRuleset({
  widthTiles: 9,
  heightTiles: 6,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
});
const LANE_GRID = RULESET_LANE.board.grid;

// A 9×7 board with the entrance at (0,1), leaving a bottom-left pocket that two
// legal towers can seal WITHOUT cutting entrance→exit.
const RULESET_POCKET = testRuleset({
  widthTiles: 9,
  heightTiles: 7,
  entrance: { col: 0, row: 1 },
  exit: { col: 8, row: 2 },
});

const place = (col: number, row: number): SimInput => ({
  kind: 'placeTower',
  anchor: { col, row },
});
const sell = (tower: number): SimInput => ({ kind: 'sellTower', tower });
const callEarly: SimInput = { kind: 'callWaveEarly' };

/** A creep row at rest (sentinel head) injected straight into the SoA. */
function restingCreep(state: SimState, id: number, col: number, row: number, hp = 5): void {
  state.creeps.id.push(id);
  state.creeps.hp.push(hp);
  state.creeps.bounty.push(1);
  state.creeps.speed.push(26);
  state.creeps.fromX.push(cx(col));
  state.creeps.fromY.push(cy(row));
  state.creeps.headCol.push(col);
  state.creeps.headRow.push(row);
  state.creeps.progress.push(0);
}

/** A mid-edge creep row: at the (col,row) centre, committed toward (headCol,headRow). */
function committedCreep(
  state: SimState,
  id: number,
  col: number,
  row: number,
  headCol: number,
  headRow: number,
  progress: number,
  hp = 5,
): void {
  state.creeps.id.push(id);
  state.creeps.hp.push(hp);
  state.creeps.bounty.push(1);
  state.creeps.speed.push(26);
  state.creeps.fromX.push(cx(col));
  state.creeps.fromY.push(cy(row));
  state.creeps.headCol.push(headCol);
  state.creeps.headRow.push(headRow);
  state.creeps.progress.push(progress);
}

describe('placeTower / sellTower — accept path and economy', () => {
  it('builds a 2×2 wall, spending TOWER_COST from the starting bounty', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]);
    expect(s.towers.id).toEqual([1]);
    expect(s.towers.col).toEqual([3]);
    expect(s.towers.row).toEqual([1]);
    expect(s.towers.spend).toEqual([TOWER_COST]);
    expect(s.bounty).toBe(80 - TOWER_COST); // 75
    expect(s.nextEntityId).toBe(2); // towers share the creep entity-id space
  });

  it('sells by entity id, refunding floor(spend·3/4) and freeing the cells', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]);
    step(s, RULESET_LANE, [sell(1)]);
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(78); // 75 + 3
    expect(materializeTowerMask(LANE_GRID, s.towers, TOWER_COST).every((b) => b === 0)).toBe(true);
  });

  it('computes the refund with quotient/remainder integer arithmetic', () => {
    expect(refundFor(5, 3, 4)).toBe(3); // the only valid M1 spend
    expect(refundFor(4, 3, 4)).toBe(3);
    expect(refundFor(7, 3, 4)).toBe(5);
    // No unsafe intermediate multiply even for an absurd spend.
    expect(Number.isSafeInteger(refundFor(Number.MAX_SAFE_INTEGER, 3, 4))).toBe(true);
  });
});

describe('placeTower — every rejection is a deterministic no-op (never a throw)', () => {
  /** Step `inputs` on a fresh LANE state; assert no tower landed and no bounty moved. */
  function expectRejected(inputs: readonly SimInput[], mutate?: (s: SimState) => void): SimState {
    const s = createInitialState(1, RULESET_LANE);
    mutate?.(s);
    const bountyBefore = s.bounty;
    expect(() => step(s, RULESET_LANE, inputs)).not.toThrow();
    expect(s.towers.id).toHaveLength(0);
    expect(Object.is(s.bounty, bountyBefore)).toBe(true);
    return s;
  }

  it('no-ops a structurally malformed anchor', () => {
    const malformed = [
      { kind: 'placeTower', anchor: null },
      { kind: 'placeTower', anchor: 'x' },
      { kind: 'placeTower', anchor: { col: 0.5, row: 2 } },
      { kind: 'placeTower', anchor: { row: 2 } },
      { kind: 'placeTower' },
    ] as unknown as SimInput[];
    expectRejected(malformed);
  });

  it('no-ops malformed input elements and unknown kinds via the entry guard', () => {
    const junk = [
      null,
      42,
      'spawnCreep',
      { kind: 'hack' },
      {},
      { kind: null },
    ] as unknown as SimInput[];
    const s = expectRejected(junk);
    expect(s.tick).toBe(1); // the tick itself still advanced
  });

  it('no-ops a footprint that leaves the board or touches non-buildable terrain', () => {
    expectRejected([place(0, 0)]); // border ring
    expectRejected([place(8, 2)]); // runs out of bounds past the exit column
    expectRejected([place(7, 4)]); // bottom-right footprint reaches the border
    expectRejected([place(-1, 2)]);
  });

  it('no-ops a footprint overlapping an existing tower', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]);
    step(s, RULESET_LANE, [place(4, 2)]); // shares (4,2) with the first footprint
    expect(s.towers.id).toEqual([1]);
    expect(s.bounty).toBe(75);
  });

  it('no-ops when bounty is insufficient or not a nonnegative safe integer', () => {
    expectRejected([place(3, 1)], (s) => (s.bounty = TOWER_COST - 1));
    expectRejected([place(3, 1)], (s) => (s.bounty = -5));
    expectRejected([place(3, 1)], (s) => (s.bounty = 2 ** 53)); // not a safe integer
    expectRejected([place(3, 1)], (s) => (s.bounty = Infinity));
    const s = createInitialState(1, RULESET_LANE);
    s.bounty = NaN;
    step(s, RULESET_LANE, [place(3, 1)]);
    expect(s.towers.id).toHaveLength(0);
    expect(Number.isNaN(s.bounty)).toBe(true);
  });

  it('no-ops a build that would cut the entrance off from the exit', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]); // walls rows 1-2 at cols 3-4 — legal
    step(s, RULESET_LANE, [place(3, 3)]); // would wall rows 3-4 too, sealing the corridor
    expect(s.towers.id).toEqual([1]);
    expect(s.bounty).toBe(75);
  });

  it('no-ops a footprint on a resting creep, and accepts one elsewhere', () => {
    const s = createInitialState(1, RULESET_LANE);
    restingCreep(s, 9, 2, 2);
    step(s, RULESET_LANE, [place(2, 2)]); // anchor on the creep
    step(s, RULESET_LANE, [place(1, 1)]); // footprint (1,1)-(2,2) contains the creep
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(80);
    step(s, RULESET_LANE, [place(5, 3)]); // clear of the creep — accepted
    expect(s.towers.id).toHaveLength(1);
  });

  it('accepts a build on the cell a near-side creep is heading toward (it re-routes, never steps on the tower)', () => {
    // PRD 0001 §3: you may build on the cell a creep is heading toward until it
    // crosses in. The creep at (1,2) heading to (2,2) is on the near side of the
    // boundary (progress 4 < half), so it occupies (1,2); a build covering (2,2)
    // is legal and the creep re-routes off the new field.
    const s = createInitialState(1, RULESET_LANE);
    committedCreep(s, 9, 1, 2, 2, 2, 4);
    step(s, RULESET_LANE, [place(2, 1)]); // footprint (2,1)-(3,2) covers the head (2,2), not (1,2)
    expect(s.towers.id).toHaveLength(1); // allowed — build-on-the-heading-cell is legal
    expect(s.creeps.id).toEqual([9]); // creep survived the same-tick build
    expect(s.lives).toBe(10);
    const o = occ(s, 0, LANE_GRID);
    const onTower = o !== undefined && o.col >= 2 && o.col <= 3 && o.row >= 1 && o.row <= 2;
    expect(onTower).toBe(false); // it re-routed rather than entering the wall
  });

  it('no-ops a build on the cell a far-side creep occupies (its head, past the boundary)', () => {
    // Past the midpoint the creep's point is in the head cell, so that head is its
    // occupied cell and a build covering it is rejected.
    const s = createInitialState(1, RULESET_LANE);
    committedCreep(s, 9, 1, 2, 2, 2, 200); // progress 200 ≥ half(128) → occupies (2,2)
    step(s, RULESET_LANE, [place(2, 2)]); // anchor (2,2) is the occupied cell
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(80);
  });

  it('ignores a corrupt far-away head (not one step away) when validating a build', () => {
    // A row with edgeProgress > 0 but a head 4 cells away is illegal: advanceCreep
    // drops it this same tick. canPlaceTower must not let that bogus head veto an
    // otherwise-legal build — the "committed" test mirrors advanceCreep's adjacency
    // rule, so the row is treated as resting at its (col,row) instead.
    const s = createInitialState(1, RULESET_LANE);
    committedCreep(s, 9, 1, 2, 5, 3, 4); // bogus: head (5,3) is 4 cols from (1,2)
    step(s, RULESET_LANE, [place(4, 3)]); // footprint (4,3)-(5,4) contains the bogus head (5,3)
    expect(s.towers.id).toHaveLength(1); // built — the far head did not veto it
    expect(s.creeps.id).toHaveLength(0); // and movement dropped the corrupt row
    expect(s.lives).toBe(10); // dropped, not leaked
  });

  it("accepts a build on a diagonal creep's corner cell (corners are not reserved)", () => {
    // Only the occupied cell is protected; a diagonal step's corner cells are not.
    const s = createInitialState(1, RULESET_LANE);
    committedCreep(s, 9, 2, 2, 3, 3, 5); // diagonal SE (2,2)→(3,3), near side ⇒ occupies (2,2)
    step(s, RULESET_LANE, [place(3, 1)]); // footprint (3,1)-(4,2) covers corner (3,2), not (2,2)
    expect(s.towers.id).toHaveLength(1); // corner not reserved → allowed
    expect(s.creeps.id).toEqual([9]); // survives and re-routes, never on the tower
    expect(s.lives).toBe(10);
    const oc = occ(s, 0, LANE_GRID);
    const onTower = oc !== undefined && oc.col >= 3 && oc.col <= 4 && oc.row >= 1 && oc.row <= 2;
    expect(onTower).toBe(false);
  });

  it('no-ops a build that would strand a live creep even though the entrance stays connected', () => {
    // On POCKET, towers at (2,4) and (1,2) seal the bottom-left pocket {(1,4),(1,5)}
    // while entrance (0,1) → exit (8,2) remains open along the top rows.
    const withCreep = createInitialState(1, RULESET_POCKET);
    restingCreep(withCreep, 9, 1, 5);
    step(withCreep, RULESET_POCKET, [place(2, 4)]);
    expect(withCreep.towers.id).toHaveLength(1); // creep still routes out via (1,3)
    step(withCreep, RULESET_POCKET, [place(1, 2)]);
    expect(withCreep.towers.id).toHaveLength(1); // rejected: would strand the creep
    expect(withCreep.bounty).toBe(75);

    // Control: with no creep in the pocket the same second build is legal.
    const empty = createInitialState(1, RULESET_POCKET);
    step(empty, RULESET_POCKET, [place(2, 4)]);
    step(empty, RULESET_POCKET, [place(1, 2)]);
    expect(empty.towers.id).toHaveLength(2);
    expect(empty.bounty).toBe(70);
  });
});

describe('sellTower — validation no-ops', () => {
  it('no-ops an unknown or malformed tower id', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]);
    const before = JSON.stringify({ towers: s.towers, bounty: s.bounty });
    const bad = [
      sell(99),
      { kind: 'sellTower', tower: 'x' },
      { kind: 'sellTower', tower: 1.5 },
      { kind: 'sellTower' },
    ] as unknown as SimInput[];
    step(s, RULESET_LANE, bad);
    expect(JSON.stringify({ towers: s.towers, bounty: s.bounty })).toBe(before);
  });

  it('no-ops a sell whose refund would leave the safe-integer range', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]);
    s.bounty = Number.MAX_SAFE_INTEGER; // forged-huge restored bounty
    step(s, RULESET_LANE, [sell(1)]);
    expect(s.towers.id).toEqual([1]); // tower kept, refund refused
    expect(s.bounty).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('dynamic re-path (commit-to-next through step)', () => {
  it('re-routes a live mid-edge creep the tick a wall lands, without dropping it', () => {
    const s = createInitialState(1, RULESET_LANE);
    pushCreep(s, { id: 1, hp: 100, col: 0, row: 2 }); // high hp — the new tower can't kill it mid-detour
    step(s, RULESET_LANE, []); // move one edge (matches the old spawn+move tick)
    for (let t = 1; t < 10; t++) step(s, RULESET_LANE, []);
    // 10 ticks × 26 = 260: one full edge crossed — from-cell (1,2), committed to (2,2).
    const fromCell = [
      Math.floor((s.creeps.fromX[0] as number) / 256),
      Math.floor((s.creeps.fromY[0] as number) / 256),
    ];
    expect(fromCell).toEqual([1, 2]);
    expect([s.creeps.headCol[0], s.creeps.headRow[0]]).toEqual([2, 2]);
    expect(s.creeps.progress[0]).toBe(4);

    step(s, RULESET_LANE, [place(3, 1)]); // wall the straight lane ahead of it
    expect(s.towers.id).toHaveLength(1);

    const rows = new Set<number>();
    let dropped = false;
    for (let t = 0; t < 250 && s.lives === 10; t++) {
      if (s.creeps.id.length === 0) dropped = true;
      const o = occ(s, 0, LANE_GRID);
      if (o !== undefined) rows.add(o.row);
      step(s, RULESET_LANE, []);
    }
    expect(dropped).toBe(false); // never vanished before leaking
    expect(s.lives).toBe(9); // it still reached the exit...
    expect(rows.has(3)).toBe(true); // ...by detouring off the straight row
  });

  it('re-opens the lane on sell: a later creep runs the straight row untouched', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]);
    step(s, RULESET_LANE, [sell(1)]);
    pushCreep(s, { id: 10, hp: 10, col: 0, row: 2 });
    step(s, RULESET_LANE, []);
    const rows = new Set<number>();
    for (let t = 0; t < 150 && s.lives === 10; t++) {
      const o = occ(s, 0, LANE_GRID);
      if (o !== undefined) rows.add(o.row);
      step(s, RULESET_LANE, []);
    }
    expect(s.lives).toBe(9);
    expect([...rows]).toEqual([2]); // never left the straight lane
  });

  it('a warm field cache yields a byte-identical trace (build → reuse → sell → reuse)', () => {
    // The effective field is cached per grid and reused while the tower mask is
    // unchanged. Re-running the same scenario on the SAME board object (so the
    // second run hits a warm cache) must reproduce the trace exactly — a stale or
    // colliding cache entry would diverge here. Exercises a mask-changing build (a
    // miss), empty towered ticks (hits), a mask-changing sell (a miss), then
    // no-tower ticks (the board.field path).
    const runOnce = (): { trace: string[]; hash: string } => {
      const s = createInitialState(9, RULESET_LANE);
      const trace: string[] = [];
      // Launch the wave and build on the same tick (creeps then trickle from the
      // schedule); a mask-changing build (miss), towered ticks (hits), sell (miss),
      // no-tower ticks (board.field path).
      step(s, RULESET_LANE, [callEarly, place(3, 1)]);
      for (let t = 0; t < 80; t++) {
        step(s, RULESET_LANE, []);
        trace.push(hashSimState(s));
      }
      step(s, RULESET_LANE, [sell(1)]);
      for (let t = 0; t < 80; t++) {
        step(s, RULESET_LANE, []);
        trace.push(hashSimState(s));
      }
      return { trace, hash: hashSimState(s) };
    };
    const cold = runOnce(); // populates the LANE field cache
    const warm = runOnce(); // hits it
    expect(warm.trace).toEqual(cold.trace);
    expect(warm.hash).toBe(cold.hash);
  });

  it('a wave creep spawned on the launch tick heads off a same-tick build', () => {
    // Spawns run in the WAVE phase, AFTER inputs — so a creep spawned on the launch
    // tick always heads off the post-build geometry, and never steps onto the tower.
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [callEarly, place(2, 1)]); // footprint (2,1)-(3,2)
    expect(s.towers.id).toHaveLength(1);
    expect(s.creeps.id).toHaveLength(1); // the launch-tick creep survived
    const o = occ(s, 0, LANE_GRID);
    const onTower = o !== undefined && o.col >= 2 && o.col <= 3 && o.row >= 1 && o.row <= 2;
    expect(onTower).toBe(false);
  });
});

describe('tower-state totality (canonical row rule; cold-restore consistent)', () => {
  type Corruptor = (s: SimState) => void;
  const pushTowerRow = (s: SimState, id: number, col: number, row: number, spend: number): void => {
    s.towers.id.push(id);
    s.towers.col.push(col);
    s.towers.row.push(row);
    s.towers.spend.push(spend);
    s.towers.targetId.push(0);
    s.towers.nextFireTick.push(0);
  };

  const invisibleRows: ReadonlyArray<[string, Corruptor]> = [
    ['a non-integer id', (s) => pushTowerRow(s, 0.5, 3, 1, TOWER_COST)],
    ['an out-of-bounds anchor', (s) => pushTowerRow(s, 7, 8, 2, TOWER_COST)],
    ['a non-buildable anchor', (s) => pushTowerRow(s, 7, 0, 0, TOWER_COST)],
    ['a spend that is not exactly TOWER_COST', (s) => pushTowerRow(s, 7, 3, 1, 4)],
    [
      'unequal column lengths',
      (s) => {
        pushTowerRow(s, 7, 3, 1, TOWER_COST);
        s.towers.spend = []; // ragged SoA
      },
    ],
  ];

  for (const [label, corrupt] of invisibleRows) {
    it(`skips a row with ${label}: invisible in the mask and not sellable`, () => {
      const s = createInitialState(1, RULESET_LANE);
      corrupt(s);
      expect(materializeTowerMask(LANE_GRID, s.towers, TOWER_COST).every((b) => b === 0)).toBe(
        true,
      );
      expect(findValidTowerIndex(LANE_GRID, s.towers, 7, TOWER_COST)).toBe(-1);
      const bountyBefore = s.bounty;
      expect(() => step(s, RULESET_LANE, [sell(7)])).not.toThrow();
      expect(s.bounty).toBe(bountyBefore);
    });
  }

  it('a duplicate id resolves to the first valid row (mask, sell, and compaction agree)', () => {
    const s = createInitialState(1, RULESET_LANE);
    pushTowerRow(s, 7, 2, 1, TOWER_COST);
    pushTowerRow(s, 7, 5, 3, TOWER_COST); // same id, disjoint footprint — shadowed
    const mask = materializeTowerMask(LANE_GRID, s.towers, TOWER_COST);
    expect(mask[1 * 9 + 2]).toBe(1); // first row's footprint is real
    expect(mask[3 * 9 + 5]).toBe(0); // shadowed duplicate is invisible
    step(s, RULESET_LANE, [sell(7)]);
    expect(s.towers.id).toHaveLength(0); // sold + shadowed row compacted away
    expect(s.bounty).toBe(83); // refunded exactly once
  });

  it('an overlapping row is invisible and unsellable; the earlier row wins', () => {
    const s = createInitialState(1, RULESET_LANE);
    pushTowerRow(s, 7, 2, 1, TOWER_COST);
    pushTowerRow(s, 8, 3, 2, TOWER_COST); // overlaps (3,2) with row 7
    const mask = materializeTowerMask(LANE_GRID, s.towers, TOWER_COST);
    expect(mask[2 * 9 + 3]).toBe(1); // row 7's cell
    expect(mask[3 * 9 + 4]).toBe(0); // row 8 contributed nothing
    const bountyBefore = s.bounty;
    step(s, RULESET_LANE, [sell(8)]);
    expect(s.bounty).toBe(bountyBefore); // overlapping row is not sellable
  });

  it('a forged non-safe bounty makes place AND sell no-op', () => {
    const s = createInitialState(1, RULESET_LANE);
    step(s, RULESET_LANE, [place(3, 1)]);
    s.bounty = 2 ** 53;
    step(s, RULESET_LANE, [place(5, 3)]);
    step(s, RULESET_LANE, [sell(1)]);
    expect(s.towers.id).toEqual([1]);
    expect(s.bounty).toBe(2 ** 53);
  });

  it('stays total on a restored state missing whole SoA containers/columns (e.g. a pre-v4 snapshot)', () => {
    // A pre-v4 snapshot carries the OLD creep shape (`col/row/edgeProgress`, no
    // `fromX/fromY/progress`) and no `towers` object. step() must coerce the missing
    // point columns to the empty/drop path rather than dereference `undefined` and
    // throw (ADR 0006 §4 totality). A v3→v4 snapshot is rejected upstream by the
    // replay version check; this is the crash-safety backstop, not a migration.
    const legacy = {
      tick: 3,
      rngState: 7,
      lives: 10,
      bounty: 80,
      nextEntityId: 3,
      // pre-v4 creeps: cell-relative columns, no fromX/fromY/progress point columns.
      creeps: { id: [1, 2], hp: [5, 5], col: [1, 2], row: [2, 2], edgeProgress: [4, 0] },
      // no `towers` key at all
    } as unknown as SimState;
    expect(() => step(legacy, RULESET_LANE, [place(4, 3)])).not.toThrow();
    expect(legacy.towers.id).toHaveLength(1); // the build still lands
    expect(legacy.creeps.id).toHaveLength(0); // point-less legacy creeps drop (ragged policy)
    expect(legacy.lives).toBe(10); // dropped, not leaked

    // A null container and a non-array column are coerced the same way.
    const nulled = { ...createInitialState(1, RULESET_LANE), towers: null } as unknown as SimState;
    expect(() => step(nulled, RULESET_LANE, [])).not.toThrow();
    const raggedCol = createInitialState(1, RULESET_LANE);
    pushCreep(raggedCol, { id: 1, hp: 10, col: 1, row: 2 });
    (raggedCol.creeps as unknown as { headRow: unknown }).headRow = undefined;
    expect(() => step(raggedCol, RULESET_LANE, [])).not.toThrow();
    expect(raggedCol.creeps.id).toHaveLength(0); // the head-less row dropped
  });

  it('each malformed tower/economy state steps identically after a cold serialize/restore', () => {
    const scenarios: ReadonlyArray<Corruptor> = [
      ...invisibleRows.map(([, corrupt]) => corrupt),
      (s) => {
        pushTowerRow(s, 7, 2, 1, TOWER_COST);
        pushTowerRow(s, 7, 5, 3, TOWER_COST);
      },
      (s) => {
        pushTowerRow(s, 7, 2, 1, TOWER_COST);
        pushTowerRow(s, 8, 3, 2, TOWER_COST);
      },
      (s) => (s.bounty = Number.MAX_SAFE_INTEGER),
    ];
    for (const corrupt of scenarios) {
      const live = createInitialState(1, RULESET_LANE);
      pushCreep(live, { id: 1, hp: 10, col: 1, row: 2 });
      corrupt(live);
      const restored = JSON.parse(JSON.stringify(live)) as SimState;
      for (let t = 0; t < 5; t++) {
        step(live, RULESET_LANE, [place(5, 3), sell(7)]);
        step(restored, RULESET_LANE, [place(5, 3), sell(7)]);
      }
      expect(JSON.stringify(restored)).toBe(JSON.stringify(live));
    }
  });
});
