// tower.test.ts — Story 3: build/sell commands, the two-stage placement
// validation (structural → buildable → unoccupied → affordable → maze
// invariant), commit-to-next re-pathing through step(), and tower-state
// totality across corrupt/forged restored states.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  loadBoard,
  TOWER_COST,
  type BoardContext,
  type SimInput,
  type SimState,
} from './index';
import { findValidTowerIndex, materializeTowerMask, refundFor } from './tower';

// A 9×6 lane board: entrance (0,2) → exit (8,2); interior rows 1-4, cols 1-7. A
// 2×2 tower at (3,1) walls rows 1-2 at cols 3-4 (creeps detour via rows 3-4);
// adding (3,3) would wall the whole corridor — the invariant-rejection fixture.
const LANE: BoardContext = loadBoard({
  widthTiles: 9,
  heightTiles: 6,
  entrance: { col: 0, row: 2 },
  exit: { col: 8, row: 2 },
});

// A 9×7 board with the entrance moved to (0,1), leaving a bottom-left pocket
// {(1,4),(1,5)} that two legal towers can seal WITHOUT cutting entrance→exit —
// isolates the per-creep half of the maze invariant.
const POCKET: BoardContext = loadBoard({
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
const spawn = (hp = 10): SimInput => ({ kind: 'spawnCreep', hp });

/** A creep row at rest (sentinel head) injected straight into the SoA. */
function restingCreep(state: SimState, id: number, col: number, row: number): void {
  state.creeps.id.push(id);
  state.creeps.hp.push(5);
  state.creeps.col.push(col);
  state.creeps.row.push(row);
  state.creeps.headCol.push(col);
  state.creeps.headRow.push(row);
  state.creeps.edgeProgress.push(0);
}

/** A mid-edge creep row committed toward (headCol,headRow). */
function committedCreep(
  state: SimState,
  id: number,
  col: number,
  row: number,
  headCol: number,
  headRow: number,
  edgeProgress: number,
): void {
  state.creeps.id.push(id);
  state.creeps.hp.push(5);
  state.creeps.col.push(col);
  state.creeps.row.push(row);
  state.creeps.headCol.push(headCol);
  state.creeps.headRow.push(headRow);
  state.creeps.edgeProgress.push(edgeProgress);
}

describe('placeTower / sellTower — accept path and economy', () => {
  it('builds a 2×2 wall, spending TOWER_COST from the starting bounty', () => {
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE);
    expect(s.towers.id).toEqual([1]);
    expect(s.towers.col).toEqual([3]);
    expect(s.towers.row).toEqual([1]);
    expect(s.towers.spend).toEqual([TOWER_COST]);
    expect(s.bounty).toBe(80 - TOWER_COST); // 75
    expect(s.nextEntityId).toBe(2); // towers share the creep entity-id space
  });

  it('sells by entity id, refunding floor(spend·3/4) and freeing the cells', () => {
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE);
    step(s, [sell(1)], LANE);
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(78); // 75 + 3
    expect(materializeTowerMask(LANE.grid, s.towers).every((b) => b === 0)).toBe(true);
  });

  it('computes the refund with quotient/remainder integer arithmetic', () => {
    expect(refundFor(5)).toBe(3); // the only valid M1 spend
    expect(refundFor(4)).toBe(3);
    expect(refundFor(7)).toBe(5);
    // No unsafe intermediate multiply even for an absurd spend.
    expect(Number.isSafeInteger(refundFor(Number.MAX_SAFE_INTEGER))).toBe(true);
  });
});

describe('placeTower — every rejection is a deterministic no-op (never a throw)', () => {
  /** Step `inputs` on a fresh LANE state; assert no tower landed and no bounty moved. */
  function expectRejected(inputs: readonly SimInput[], mutate?: (s: SimState) => void): SimState {
    const s = createInitialState(1);
    mutate?.(s);
    const bountyBefore = s.bounty;
    expect(() => step(s, inputs, LANE)).not.toThrow();
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
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE);
    step(s, [place(4, 2)], LANE); // shares (4,2) with the first footprint
    expect(s.towers.id).toEqual([1]);
    expect(s.bounty).toBe(75);
  });

  it('no-ops when bounty is insufficient or not a nonnegative safe integer', () => {
    expectRejected([place(3, 1)], (s) => (s.bounty = TOWER_COST - 1));
    expectRejected([place(3, 1)], (s) => (s.bounty = -5));
    expectRejected([place(3, 1)], (s) => (s.bounty = 2 ** 53)); // not a safe integer
    expectRejected([place(3, 1)], (s) => (s.bounty = Infinity));
    const s = createInitialState(1);
    s.bounty = NaN;
    step(s, [place(3, 1)], LANE);
    expect(s.towers.id).toHaveLength(0);
    expect(Number.isNaN(s.bounty)).toBe(true);
  });

  it('no-ops a build that would cut the entrance off from the exit', () => {
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE); // walls rows 1-2 at cols 3-4 — legal
    step(s, [place(3, 3)], LANE); // would wall rows 3-4 too, sealing the corridor
    expect(s.towers.id).toEqual([1]);
    expect(s.bounty).toBe(75);
  });

  it('no-ops a footprint on a resting creep, and accepts one elsewhere', () => {
    const s = createInitialState(1);
    restingCreep(s, 9, 2, 2);
    step(s, [place(2, 2)], LANE); // anchor on the creep
    step(s, [place(1, 1)], LANE); // footprint (1,1)-(2,2) contains the creep
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(80);
    step(s, [place(5, 3)], LANE); // clear of the creep — accepted
    expect(s.towers.id).toHaveLength(1);
  });

  it("no-ops a footprint on a mid-edge creep's committed head", () => {
    const s = createInitialState(1);
    committedCreep(s, 9, 1, 2, 2, 2, 4); // committed (1,2) → (2,2)
    step(s, [place(2, 2)], LANE); // anchor on the head
    step(s, [place(2, 1)], LANE); // footprint (2,1)-(3,2) contains the head
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(80);
  });

  it('ignores a corrupt far-away head (not one step away) when validating a build', () => {
    // A row with edgeProgress > 0 but a head 4 cells away is illegal: advanceCreep
    // drops it this same tick. canPlaceTower must not let that bogus head veto an
    // otherwise-legal build — the "committed" test mirrors advanceCreep's adjacency
    // rule, so the row is treated as resting at its (col,row) instead.
    const s = createInitialState(1);
    committedCreep(s, 9, 1, 2, 5, 3, 4); // bogus: head (5,3) is 4 cols from (1,2)
    step(s, [place(4, 3)], LANE); // footprint (4,3)-(5,4) contains the bogus head (5,3)
    expect(s.towers.id).toHaveLength(1); // built — the far head did not veto it
    expect(s.creeps.id).toHaveLength(0); // and movement dropped the corrupt row
    expect(s.lives).toBe(10); // dropped, not leaked
  });

  it("no-ops a build closing a committed diagonal's corner cell, accepts one clear of it", () => {
    const s = createInitialState(1);
    committedCreep(s, 9, 2, 2, 3, 3, 5); // diagonal SE commit; corners (3,2) and (2,3)
    step(s, [place(3, 1)], LANE); // footprint contains corner (3,2)
    expect(s.towers.id).toHaveLength(0);
    expect(s.bounty).toBe(80);
    step(s, [place(5, 1)], LANE); // clear of cell, head, and corners — accepted
    expect(s.towers.id).toHaveLength(1);
    expect(s.creeps.id).toEqual([9]); // the diagonal creep advanced, not dropped
    expect(s.lives).toBe(10);
  });

  it('no-ops a build that would strand a live creep even though the entrance stays connected', () => {
    // On POCKET, towers at (2,4) and (1,2) seal the bottom-left pocket {(1,4),(1,5)}
    // while entrance (0,1) → exit (8,2) remains open along the top rows.
    const withCreep = createInitialState(1);
    restingCreep(withCreep, 9, 1, 5);
    step(withCreep, [place(2, 4)], POCKET);
    expect(withCreep.towers.id).toHaveLength(1); // creep still routes out via (1,3)
    step(withCreep, [place(1, 2)], POCKET);
    expect(withCreep.towers.id).toHaveLength(1); // rejected: would strand the creep
    expect(withCreep.bounty).toBe(75);

    // Control: with no creep in the pocket the same second build is legal.
    const empty = createInitialState(1);
    step(empty, [place(2, 4)], POCKET);
    step(empty, [place(1, 2)], POCKET);
    expect(empty.towers.id).toHaveLength(2);
    expect(empty.bounty).toBe(70);
  });
});

describe('sellTower — validation no-ops', () => {
  it('no-ops an unknown or malformed tower id', () => {
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE);
    const before = JSON.stringify({ towers: s.towers, bounty: s.bounty });
    const bad = [
      sell(99),
      { kind: 'sellTower', tower: 'x' },
      { kind: 'sellTower', tower: 1.5 },
      { kind: 'sellTower' },
    ] as unknown as SimInput[];
    step(s, bad, LANE);
    expect(JSON.stringify({ towers: s.towers, bounty: s.bounty })).toBe(before);
  });

  it('no-ops a sell whose refund would leave the safe-integer range', () => {
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE);
    s.bounty = Number.MAX_SAFE_INTEGER; // forged-huge restored bounty
    step(s, [sell(1)], LANE);
    expect(s.towers.id).toEqual([1]); // tower kept, refund refused
    expect(s.bounty).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('dynamic re-path (commit-to-next through step)', () => {
  it('re-routes a live mid-edge creep the tick a wall lands, without dropping it', () => {
    const s = createInitialState(1);
    step(s, [spawn()], LANE);
    for (let t = 1; t < 10; t++) step(s, [], LANE);
    // 10 ticks × 26 = 260: one full edge crossed — at (1,2), committed to (2,2).
    expect([s.creeps.col[0], s.creeps.row[0]]).toEqual([1, 2]);
    expect([s.creeps.headCol[0], s.creeps.headRow[0]]).toEqual([2, 2]);
    expect(s.creeps.edgeProgress[0]).toBe(4);

    step(s, [place(3, 1)], LANE); // wall the straight lane ahead of it
    expect(s.towers.id).toHaveLength(1);

    const rows = new Set<number>();
    let dropped = false;
    for (let t = 0; t < 250 && s.lives === 10; t++) {
      if (s.creeps.id.length === 0) dropped = true;
      for (const r of s.creeps.row) rows.add(r);
      step(s, [], LANE);
    }
    expect(dropped).toBe(false); // never vanished before leaking
    expect(s.lives).toBe(9); // it still reached the exit...
    expect(rows.has(3)).toBe(true); // ...by detouring off the straight row
  });

  it('re-opens the lane on sell: a later creep runs the straight row untouched', () => {
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE);
    step(s, [sell(1)], LANE);
    step(s, [spawn()], LANE);
    const rows = new Set<number>();
    for (let t = 0; t < 150 && s.lives === 10; t++) {
      for (const r of s.creeps.row) rows.add(r);
      step(s, [], LANE);
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
      const s = createInitialState(9);
      const trace: string[] = [];
      step(s, [spawn(), place(3, 1)], LANE);
      for (let t = 0; t < 80; t++) {
        step(s, t % 20 === 0 ? [spawn()] : [], LANE);
        trace.push(hashSimState(s));
      }
      step(s, [sell(1)], LANE);
      for (let t = 0; t < 80; t++) {
        step(s, [], LANE);
        trace.push(hashSimState(s));
      }
      return { trace, hash: hashSimState(s) };
    };
    const cold = runOnce(); // populates the LANE field cache
    const warm = runOnce(); // hits it
    expect(warm.trace).toEqual(cold.trace);
    expect(warm.hash).toBe(cold.hash);
  });

  it('spawn→build and build→spawn on one tick both head off the final geometry', () => {
    const run = (inputs: SimInput[]): SimState => {
      const s = createInitialState(1);
      step(s, inputs, LANE);
      return s;
    };
    const a = run([spawn(), place(2, 1)]);
    const b = run([place(2, 1), spawn()]);
    // Entity ids differ by arrival order; everything positional must not.
    for (const key of ['col', 'row', 'headCol', 'headRow', 'edgeProgress', 'hp'] as const) {
      expect(a.creeps[key]).toEqual(b.creeps[key]);
    }
    expect(a.towers.col).toEqual(b.towers.col);
    expect(a.bounty).toBe(b.bounty);
    expect(a.creeps.id).toHaveLength(1); // the spawn survived the same-tick build
  });
});

describe('tower-state totality (canonical row rule; cold-restore consistent)', () => {
  type Corruptor = (s: SimState) => void;
  const pushTowerRow = (s: SimState, id: number, col: number, row: number, spend: number): void => {
    s.towers.id.push(id);
    s.towers.col.push(col);
    s.towers.row.push(row);
    s.towers.spend.push(spend);
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
      const s = createInitialState(1);
      corrupt(s);
      expect(materializeTowerMask(LANE.grid, s.towers).every((b) => b === 0)).toBe(true);
      expect(findValidTowerIndex(LANE.grid, s.towers, 7)).toBe(-1);
      const bountyBefore = s.bounty;
      expect(() => step(s, [sell(7)], LANE)).not.toThrow();
      expect(s.bounty).toBe(bountyBefore);
    });
  }

  it('a duplicate id resolves to the first valid row (mask, sell, and compaction agree)', () => {
    const s = createInitialState(1);
    pushTowerRow(s, 7, 2, 1, TOWER_COST);
    pushTowerRow(s, 7, 5, 3, TOWER_COST); // same id, disjoint footprint — shadowed
    const mask = materializeTowerMask(LANE.grid, s.towers);
    expect(mask[1 * 9 + 2]).toBe(1); // first row's footprint is real
    expect(mask[3 * 9 + 5]).toBe(0); // shadowed duplicate is invisible
    step(s, [sell(7)], LANE);
    expect(s.towers.id).toHaveLength(0); // sold + shadowed row compacted away
    expect(s.bounty).toBe(83); // refunded exactly once
  });

  it('an overlapping row is invisible and unsellable; the earlier row wins', () => {
    const s = createInitialState(1);
    pushTowerRow(s, 7, 2, 1, TOWER_COST);
    pushTowerRow(s, 8, 3, 2, TOWER_COST); // overlaps (3,2) with row 7
    const mask = materializeTowerMask(LANE.grid, s.towers);
    expect(mask[2 * 9 + 3]).toBe(1); // row 7's cell
    expect(mask[3 * 9 + 4]).toBe(0); // row 8 contributed nothing
    const bountyBefore = s.bounty;
    step(s, [sell(8)], LANE);
    expect(s.bounty).toBe(bountyBefore); // overlapping row is not sellable
  });

  it('a forged non-safe bounty makes place AND sell no-op', () => {
    const s = createInitialState(1);
    step(s, [place(3, 1)], LANE);
    s.bounty = 2 ** 53;
    step(s, [place(5, 3)], LANE);
    step(s, [sell(1)], LANE);
    expect(s.towers.id).toEqual([1]);
    expect(s.bounty).toBe(2 ** 53);
  });

  it('stays total on a restored state missing whole SoA containers/columns (e.g. a pre-v3 snapshot)', () => {
    // A snapshot taken under an older sim shape has no `towers` object and no
    // creep head columns. step() must coerce the missing pieces to the empty/drop
    // path rather than dereference `undefined` and throw (ADR 0006 §4 totality).
    const legacy = {
      tick: 3,
      rngState: 7,
      lives: 10,
      bounty: 80,
      nextEntityId: 3,
      // v2-shaped creeps: no headCol/headRow columns.
      creeps: { id: [1, 2], hp: [5, 5], col: [1, 2], row: [2, 2], edgeProgress: [4, 0] },
      // no `towers` key at all
    } as unknown as SimState;
    expect(() => step(legacy, [place(4, 3)], LANE)).not.toThrow();
    expect(legacy.towers.id).toHaveLength(1); // the build still lands
    expect(legacy.creeps.id).toHaveLength(0); // head-less legacy creeps drop (ragged policy)
    expect(legacy.lives).toBe(10); // dropped, not leaked

    // A null container and a non-array column are coerced the same way.
    const nulled = { ...createInitialState(1), towers: null } as unknown as SimState;
    expect(() => step(nulled, [], LANE)).not.toThrow();
    const raggedCol = createInitialState(1);
    step(raggedCol, [spawn()], LANE);
    (raggedCol.creeps as unknown as { headRow: unknown }).headRow = undefined;
    expect(() => step(raggedCol, [], LANE)).not.toThrow();
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
      const live = createInitialState(1);
      step(live, [spawn()], LANE);
      corrupt(live);
      const restored = JSON.parse(JSON.stringify(live)) as SimState;
      for (let t = 0; t < 5; t++) {
        step(live, [place(5, 3), sell(7)], LANE);
        step(restored, [place(5, 3), sell(7)], LANE);
      }
      expect(JSON.stringify(restored)).toBe(JSON.stringify(live));
    }
  });
});
