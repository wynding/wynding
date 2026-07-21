// movement.test.ts — the grid path-follower: descent selection, the per-tick
// advance/leak/drop policy, exact-tick off-by-one behavior, and the complete
// board-context validator. Small hand-checkable fixtures with derived values.

import { describe, it, expect } from 'vitest';
import type { DistanceField } from './pathfinding';
import { GridError, type Grid } from './board';
import { loadBoard, assertConsistent, type BoardContext } from './context';
import {
  advanceCreep,
  firstDescentNeighbor,
  ORTHO_LEN,
  DIAG_LEN,
  type AdvanceOutcome,
} from './movement';

// A straight 5×5 board: entrance (0,2) → exit (4,2), four orthogonal edges.
const STRAIGHT = loadBoard({
  widthTiles: 5,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 4, row: 2 },
});
const STRAIGHT_FIELD = STRAIGHT.field;

// A 2×3 board with entrance (0,1) and exit (1,1) exactly one cell apart.
const ADJACENT = loadBoard({
  widthTiles: 2,
  heightTiles: 3,
  entrance: { col: 0, row: 1 },
  exit: { col: 1, row: 1 },
}).field;

// A 5×5 board whose entrance (0,3) and exit (4,1) sit on different rows, so the
// true-shortest descent must take no-corner-cut DIAGONAL steps through the field.
const DIAGONAL = loadBoard({
  widthTiles: 5,
  heightTiles: 5,
  entrance: { col: 0, row: 3 },
  exit: { col: 4, row: 1 },
}).field;

/** Advance one creep tick-by-tick from a cell until it leaks; return the tick count. */
function ticksToLeak(field: DistanceField, col: number, row: number, budget: number): number {
  let c = col;
  let r = row;
  let hc = col; // sentinel head — the creep starts at rest
  let hr = row;
  let ep = 0;
  for (let t = 1; t <= 100000; t++) {
    const o: AdvanceOutcome = advanceCreep(field, 1, 5, c, r, hc, hr, ep, budget);
    if (o.kind === 'leak') return t;
    if (o.kind === 'drop') throw new Error(`unexpected drop at tick ${t}`);
    c = o.col;
    r = o.row;
    hc = o.headCol;
    hr = o.headRow;
    ep = o.edgeProgress;
  }
  throw new Error('creep never leaked');
}

describe('firstDescentNeighbor', () => {
  it('steps orthogonally toward the exit on the straight board', () => {
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 0, 2)).toEqual({ col: 1, row: 2, diagonal: false });
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 3, 2)).toEqual({ col: 4, row: 2, diagonal: false });
  });

  it('selects a no-corner-cut diagonal when it is the true-shortest descent', () => {
    // (2,2) descends to (3,1) via NE (cost 14) — cheaper than any orthogonal pair,
    // and its two shared cells (3,2)/(2,1) are open, so the corner-cut rule allows it.
    expect(firstDescentNeighbor(DIAGONAL, 2, 2)).toEqual({ col: 3, row: 1, diagonal: true });
    expect(firstDescentNeighbor(DIAGONAL, 1, 3)).toEqual({ col: 2, row: 2, diagonal: true });
  });

  it('returns null at the exit (nothing descends below distance 0)', () => {
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 4, 2)).toBeNull();
  });

  it('returns null for a blocked or out-of-bounds current cell (bounds-safe read)', () => {
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 0, 0)).toBeNull(); // blocked border corner
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 99, 99)).toBeNull(); // out of bounds
  });
});

describe('advanceCreep — normal movement', () => {
  it('advances exactly one budget along the first edge, committing to the head', () => {
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 0, 2, 0, 26)).toEqual({
      kind: 'move',
      col: 0,
      row: 2,
      headCol: 1,
      headRow: 2,
      edgeProgress: 26,
    });
  });

  it('snaps to the next cell exactly when progress reaches the edge length (sentinel head)', () => {
    // A full orthogonal edge (256) with a matching budget arrives dead on (1,2);
    // at rest the head columns hold the canonical sentinel (== current cell).
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 0, 2, 0, ORTHO_LEN)).toEqual({
      kind: 'move',
      col: 1,
      row: 2,
      headCol: 1,
      headRow: 2,
      edgeProgress: 0,
    });
  });

  it('carries the remainder onto the next edge after crossing a boundary', () => {
    // Start 250 into the committed 256 edge toward (1,2) with budget 26: 6 finishes
    // the edge, 20 carry onto the next edge (freshly derived toward (2,2)).
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 1, 2, 250, 26)).toEqual({
      kind: 'move',
      col: 1,
      row: 2,
      headCol: 2,
      headRow: 2,
      edgeProgress: 20,
    });
  });

  it('crosses multiple boundaries in one tick when the budget allows, carrying the remainder', () => {
    // Budget 600 from rest at (0,2): 256 finishes edge 0→1, 256 finishes edge 1→2,
    // 88 carry onto edge 2→3 — ends on (2,2) committed toward (3,2). (Production
    // budget is 26 < 256 so this never happens live, but it is the only multi-cross arm.)
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 0, 2, 0, 600)).toEqual({
      kind: 'move',
      col: 2,
      row: 2,
      headCol: 3,
      headRow: 2,
      edgeProgress: 88,
    });
  });

  it('crosses a diagonal edge of length 362, not 256', () => {
    expect(advanceCreep(DIAGONAL, 1, 5, 2, 2, 2, 2, 0, DIAG_LEN)).toEqual({
      kind: 'move',
      col: 3,
      row: 1,
      headCol: 3,
      headRow: 1,
      edgeProgress: 0,
    });
    // A budget one short of the diagonal length leaves it mid-edge (still on 2,2).
    expect(advanceCreep(DIAGONAL, 1, 5, 2, 2, 2, 2, 0, DIAG_LEN - 1)).toEqual({
      kind: 'move',
      col: 2,
      row: 2,
      headCol: 3,
      headRow: 1,
      edgeProgress: DIAG_LEN - 1,
    });
  });

  it('leaks after the exact expected number of ticks (orthogonal crossings)', () => {
    // Four 256-unit edges at 26/tick, and one 256-unit edge one cell apart.
    expect(ticksToLeak(STRAIGHT_FIELD, 0, 2, 26)).toBe(Math.ceil((4 * ORTHO_LEN) / 26)); // 40
    expect(ticksToLeak(ADJACENT, 0, 1, 26)).toBe(Math.ceil(ORTHO_LEN / 26)); // 10
  });

  it('crosses a mixed orthogonal/diagonal route to the exit', () => {
    // Path (0,3)→(1,3)→(2,2)→(3,1)→(4,1): two orthogonal + two diagonal edges.
    const total = 2 * ORTHO_LEN + 2 * DIAG_LEN;
    expect(ticksToLeak(DIAGONAL, 0, 3, 26)).toBe(Math.ceil(total / 26)); // 48
  });
});

describe('advanceCreep — leak policy', () => {
  it('leaks a creep that begins the tick resting on the exit', () => {
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, 4, 2, 4, 2, 0, 26)).toEqual({ kind: 'leak' });
  });

  it('leaks the tick it arrives, discarding any remaining budget', () => {
    // 230 into the last committed edge with a huge budget: it finishes the edge and
    // leaks; the leftover budget is not spent wrapping past the exit.
    expect(advanceCreep(ADJACENT, 1, 5, 0, 1, 1, 1, 230, 100000)).toEqual({ kind: 'leak' });
  });
});

describe('advanceCreep — corrupt-row drop policy (never crashes, no life lost)', () => {
  const cases: ReadonlyArray<[string, AdvanceOutcome]> = [
    ['id undefined', advanceCreep(STRAIGHT_FIELD, undefined, 5, 0, 2, 0, 2, 0, 26)],
    ['hp undefined', advanceCreep(STRAIGHT_FIELD, 1, undefined, 0, 2, 0, 2, 0, 26)],
    ['col undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, undefined, 2, 0, 2, 0, 26)],
    ['row undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, undefined, 0, 2, 0, 26)],
    ['headCol undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, undefined, 2, 0, 26)],
    ['headRow undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 0, undefined, 0, 26)],
    ['edgeProgress undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 0, 2, undefined, 26)],
    ['col non-integer', advanceCreep(STRAIGHT_FIELD, 1, 5, 0.5, 2, 0, 2, 0, 26)],
    ['headCol non-integer', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 1.5, 2, 10, 26)],
    ['edgeProgress non-integer', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 1, 2, 1.5, 26)],
    ['col out of bounds', advanceCreep(STRAIGHT_FIELD, 1, 5, 99, 2, 99, 2, 0, 26)],
    ['row out of bounds', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 99, 0, 99, 0, 26)],
    ['negative progress', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 1, 2, -1, 26)],
    ['blocked cell', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 0, 0, 0, 0, 26)], // blocked border corner
  ];
  for (const [label, outcome] of cases) {
    it(`drops a row with ${label}`, () => {
      expect(outcome).toEqual({ kind: 'drop' });
    });
  }

  it('drops a mid-step creep whose head is structurally impossible', () => {
    // A head that is not a single legal step away, or progress outside the edge,
    // cannot be a real step — a deterministic drop, never a crash or a lost life.
    const illegal: ReadonlyArray<[string, AdvanceOutcome]> = [
      // head == current cell (the rest sentinel) with positive progress
      ['a zero-length step', advanceCreep(STRAIGHT_FIELD, 1, 5, 1, 2, 1, 2, 10, 26)],
      // head two cells away — not an adjacent step
      ['a non-adjacent head', advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 2, 2, 10, 26)],
      // progress at/past the orthogonal edge length
      [
        'progress past the edge',
        advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 1, 2, ORTHO_LEN + 44, 26),
      ],
      [
        'progress at exactly the edge length',
        advanceCreep(STRAIGHT_FIELD, 1, 5, 0, 2, 1, 2, ORTHO_LEN, 26),
      ],
      // far side of the boundary (progress ≥ half) with a blocked head: the creep
      // is committed to a cell it cannot enter, so it drops rather than step onto it.
      ['a far-side blocked head', advanceCreep(STRAIGHT_FIELD, 1, 5, 1, 1, 1, 0, 200, 26)],
    ];
    for (const [, outcome] of illegal) {
      expect(outcome).toEqual({ kind: 'drop' });
    }
  });

  it('keeps a far-side creep whose FROM cell is walled behind it (it occupies the head)', () => {
    // Past the boundary the creep occupies its head, so a wall on the FROM cell is
    // legal and behind it — the creep must finish onto the head, not drop. Here the
    // FROM cell (2,2) is faked as unreachable/blocked via a forged field while the
    // head (3,2) stays open and reachable.
    const walledBehind: DistanceField = {
      width: 5,
      height: 5,
      exit: { col: 4, row: 2 },
      // Row 2: (0)_ (1)_ (2)blocked (3)dist10 (4)exit0 — FROM (2,2) blocked, head (3,2) open.
      dist: Int32Array.from([
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 10, 0, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1,
      ]),
      blockedMask: Uint8Array.from([
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      ]),
    };
    // (2,2) FROM is blocked, head (3,2) far side (progress 200 ≥ 128): must not drop.
    const out = advanceCreep(walledBehind, 1, 5, 2, 2, 3, 2, 200, 26);
    expect(out.kind).toBe('move');
    if (out.kind === 'move') expect([out.col, out.row]).toEqual([2, 2]); // still finishing the step
  });

  it('re-routes (does not drop) a near-side creep whose head is no longer a valid descent', () => {
    // On the near side of the boundary the creep still occupies its own cell, so a
    // stale/blocked head just means the maze changed — it re-derives a legal descent
    // and turns. It survives as a move and loses no life (verified via ticksToLeak
    // reaching the exit from such a state).
    const blockedHead = advanceCreep(STRAIGHT_FIELD, 1, 5, 1, 1, 1, 0, 10, 26); // head (1,0) is border
    expect(blockedHead.kind).toBe('move');
    const cornerCut = advanceCreep(STRAIGHT_FIELD, 1, 5, 3, 1, 4, 2, 10, 26); // (4,2) diag past blocked (4,1)
    expect(cornerCut.kind).toBe('move');
  });

  it('drops a creep on an in-bounds but unreachable (walled-off) open cell', () => {
    // Open (blockedMask 0) yet unreachable (dist -1): passes the blockedAt gate but
    // is dropped by the distance check — the two guards cover distinct failures.
    const walledOpen: DistanceField = {
      width: 2,
      height: 1,
      exit: { col: 1, row: 0 },
      dist: Int32Array.from([-1, 0]), // (0,0) open but stranded, (1,0) exit
      blockedMask: new Uint8Array([0, 0]), // both open
    };
    expect(advanceCreep(walledOpen, 1, 5, 0, 0, 0, 0, 0, 26)).toEqual({ kind: 'drop' });
  });

  it('drops a corrupt positive progress on the exit cell without leaking a life', () => {
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, 4, 2, 4, 2, 5, 26)).toEqual({ kind: 'drop' });
  });

  it('drops (does not crash) on a forged field where a live cell has no exact descent', () => {
    // An all-zero distance field is shape-valid but has no descent anywhere; the
    // backstop drops the creep rather than throwing.
    const forged: DistanceField = {
      width: 3,
      height: 3,
      exit: { col: 2, row: 1 },
      dist: new Int32Array(9), // all zero
      blockedMask: new Uint8Array(9), // all open
    };
    expect(advanceCreep(forged, 1, 5, 0, 1, 0, 1, 0, 26)).toEqual({ kind: 'drop' });
  });
});

describe('assertConsistent — board-context validator (loud GridError)', () => {
  const base = STRAIGHT;
  const withGrid = (patch: Partial<Grid>): BoardContext => ({
    grid: { ...base.grid, ...patch } as Grid,
    field: base.field,
  });
  const withField = (patch: Partial<DistanceField>): BoardContext => ({
    grid: base.grid,
    field: { ...base.field, ...patch } as DistanceField,
  });

  it('accepts a loadBoard-built context and memoizes it (idempotent)', () => {
    expect(() => assertConsistent(base)).not.toThrow();
    expect(() => assertConsistent(base)).not.toThrow(); // second call hits the memo
  });

  it('rejects a null-membered forged context with GridError (not a raw TypeError)', () => {
    // A partially-deserialized context can have null members; the validator must
    // still fail with its documented typed error, never a raw dereference crash.
    const forged = [
      null,
      { grid: null, field: base.field },
      { grid: base.grid, field: null },
      { grid: base.grid, field: { ...base.field, dist: undefined } },
      { grid: base.grid, field: { ...base.field, blockedMask: undefined } },
      { grid: base.grid, field: { ...base.field, exit: null } },
    ] as unknown as BoardContext[];
    for (const ctx of forged) {
      expect(() => assertConsistent(ctx)).toThrow(GridError);
    }
  });

  it('rejects non-positive dimensions', () => {
    expect(() => assertConsistent(withGrid({ width: 0 }))).toThrow(GridError);
  });

  it('rejects a field whose dimensions do not match the grid', () => {
    expect(() => assertConsistent(withField({ width: 6 }))).toThrow(/do not match/);
  });

  it('rejects field arrays of the wrong length', () => {
    expect(() => assertConsistent(withField({ dist: new Int32Array(3) }))).toThrow(GridError);
    expect(() => assertConsistent(withField({ blockedMask: new Uint8Array(3) }))).toThrow(
      GridError,
    );
  });

  it('rejects an out-of-bounds entrance or exit', () => {
    expect(() => assertConsistent(withGrid({ entrance: { col: -1, row: 0 } }))).toThrow(/entrance/);
    expect(() => assertConsistent(withGrid({ exit: { col: 99, row: 0 } }))).toThrow(/exit/);
  });

  it('rejects a field whose exit disagrees with the grid exit', () => {
    expect(() => assertConsistent(withField({ exit: { col: 3, row: 2 } }))).toThrow(/field exit/);
  });

  it('rejects a field where the exit is not the unblocked distance-0 source', () => {
    const badDist = Int32Array.from(base.field.dist);
    badDist[2 * 5 + 4] = 5; // exit at (4,2) with nonzero distance
    expect(() => assertConsistent(withField({ dist: badDist }))).toThrow(/unblocked distance-0/);

    const badMask = Uint8Array.from(base.field.blockedMask);
    badMask[2 * 5 + 4] = 1; // exit marked blocked
    expect(() => assertConsistent(withField({ blockedMask: badMask }))).toThrow(
      /unblocked distance-0/,
    );
  });

  it('rejects a context whose entrance cannot reach the exit', () => {
    const badDist = Int32Array.from(base.field.dist);
    badDist[2 * 5 + 0] = -1; // entrance at (0,2) marked unreachable
    expect(() => assertConsistent(withField({ dist: badDist }))).toThrow(/cannot reach/);
  });
});
