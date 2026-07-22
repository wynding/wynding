// movement.test.ts — point-authoritative creep movement (Story 4, closes #17):
// derived point/occupancy, the derive-not-store edge length, transitional re-paths
// that turn FROM the actual point (no backward snap), exact leak/boundary timing,
// the per-tick drop policy, and mid-transitional serialize/restore determinism.

import { describe, it, expect } from 'vitest';
import { computeDistanceField, type DistanceField } from './pathfinding';
import { GridError, type Grid } from './board';
import { loadBoard, assertConsistent, type BoardContext } from './context';
import { createInitialState, step, hashSimState, type SimInput, type SimState } from './index';
import {
  advanceCreep,
  deriveValidCreepPosition,
  firstDescentNeighbor,
  isqrt,
  ORTHO_LEN,
  DIAG_LEN,
  type AdvanceOutcome,
} from './movement';

/** Fixed-point centre of a cell coordinate. */
const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

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

// A 7×5 open board and a variant with a small wall at (3,1)/(3,2), so the descent
// from (2,2) differs between them — the re-path fixture.
const WIDE = loadBoard({
  widthTiles: 7,
  heightTiles: 5,
  entrance: { col: 0, row: 2 },
  exit: { col: 6, row: 2 },
});
const WIDE_FIELD = WIDE.field;
const wideWallMask = (): Uint8Array => {
  const mask = new Uint8Array(WIDE.grid.width * WIDE.grid.height);
  mask[1 * 7 + 3] = 1; // (3,1)
  mask[2 * 7 + 3] = 1; // (3,2)
  return mask;
};
const WIDE_WALLED = computeDistanceField(WIDE.grid, wideWallMask());

/** Advance one resting creep tick-by-tick from a cell until it leaks; return the tick count. */
function ticksToLeak(field: DistanceField, col: number, row: number, budget: number): number {
  let fromX = cx(col);
  let fromY = cy(row);
  let hc = col; // rest sentinel — head == cell
  let hr = row;
  let p = 0;
  for (let t = 1; t <= 100000; t++) {
    const o: AdvanceOutcome = advanceCreep(field, 1, 5, fromX, fromY, hc, hr, p, budget);
    if (o.kind === 'leak') return t;
    if (o.kind === 'drop') throw new Error(`unexpected drop at tick ${t}`);
    fromX = o.fromX;
    fromY = o.fromY;
    hc = o.headCol;
    hr = o.headRow;
    p = o.progress;
  }
  throw new Error('creep never leaked');
}

describe('isqrt — exact integer floor square root', () => {
  it('is exact on perfect squares and the values in between', () => {
    expect(isqrt(0)).toBe(0);
    expect(isqrt(1)).toBe(1);
    expect(isqrt(2)).toBe(1);
    expect(isqrt(3)).toBe(1);
    expect(isqrt(4)).toBe(2);
    expect(isqrt(65536)).toBe(256); // 256²
    expect(isqrt(131072)).toBe(DIAG_LEN); // 256²+256² ⇒ the diagonal constant
    expect(isqrt(131043)).toBe(361); // 362² − 1
  });
  it('coerces non-safe or non-positive input to 0', () => {
    expect(isqrt(-5)).toBe(0);
    expect(isqrt(1.5)).toBe(0);
    expect(isqrt(NaN)).toBe(0);
  });
});

describe('deriveValidCreepPosition — the shared point/occupancy seam', () => {
  it('derives the resting point and occupied cell from a centre', () => {
    const g = deriveValidCreepPosition(cx(1), cy(2), 1, 2, 0, STRAIGHT_FIELD);
    expect(g).not.toBeNull();
    expect(g?.point).toEqual({ x: cx(1), y: cy(2) });
    expect(g?.occupancyCell).toEqual({ col: 1, row: 2 });
    expect(g?.edgeLen).toBe(ORTHO_LEN);
  });

  it('floors the derived point to a cell — the boundary belongs to the higher cell', () => {
    // Mid-edge (1,2)→(2,2): at progress 127 the point x is 511 (cell 1); at the
    // exact boundary 512 (progress 128) it floors into cell 2.
    const near = deriveValidCreepPosition(cx(1), cy(2), 2, 2, 127, STRAIGHT_FIELD);
    expect(near?.point.x).toBe(511);
    expect(near?.occupancyCell.col).toBe(1);
    const onEdge = deriveValidCreepPosition(cx(1), cy(2), 2, 2, 128, STRAIGHT_FIELD);
    expect(onEdge?.point.x).toBe(512);
    expect(onEdge?.occupancyCell.col).toBe(2); // floor(512/256) === 2
  });

  it('derives a transitional edge length via isqrt from an interior point', () => {
    // From an interior point (not a centre) toward an adjacent centre.
    const fromX = cx(2) + 40;
    const g = deriveValidCreepPosition(fromX, cy(2), 3, 2, 0, WIDE_FIELD);
    expect(g?.edgeLen).toBe(isqrt((cx(3) - fromX) ** 2 + 0));
  });

  it('rejects corrupt rows (non-integer, off-board, out-of-range progress, bad sentinel)', () => {
    expect(deriveValidCreepPosition(1.5, cy(2), 1, 2, 0, STRAIGHT_FIELD)).toBeNull();
    expect(deriveValidCreepPosition(cx(1), cy(2), 9, 2, 0, STRAIGHT_FIELD)).toBeNull(); // head OOB
    expect(deriveValidCreepPosition(cx(1), cy(2), 3, 2, 0, STRAIGHT_FIELD)).toBeNull(); // not adjacent
    expect(deriveValidCreepPosition(cx(1), cy(2), 2, 2, ORTHO_LEN, STRAIGHT_FIELD)).toBeNull(); // progress ≥ edgeLen
    expect(deriveValidCreepPosition(cx(1), cy(2), 2, 2, -1, STRAIGHT_FIELD)).toBeNull(); // negative
    expect(deriveValidCreepPosition(cx(1), cy(2), 1, 2, 10, STRAIGHT_FIELD)).toBeNull(); // zero-len step, progress>0
    expect(deriveValidCreepPosition(cx(1) + 5, cy(2), 1, 2, 0, STRAIGHT_FIELD)).toBeNull(); // rest not on centre
  });
});

describe('firstDescentNeighbor', () => {
  it('steps orthogonally toward the exit on the straight board', () => {
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 0, 2)).toEqual({ col: 1, row: 2, diagonal: false });
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 3, 2)).toEqual({ col: 4, row: 2, diagonal: false });
  });

  it('selects a no-corner-cut diagonal when it is the true-shortest descent', () => {
    expect(firstDescentNeighbor(DIAGONAL, 2, 2)).toEqual({ col: 3, row: 1, diagonal: true });
    expect(firstDescentNeighbor(DIAGONAL, 1, 3)).toEqual({ col: 2, row: 2, diagonal: true });
  });

  it('returns null at the exit and for a blocked/out-of-bounds cell', () => {
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 4, 2)).toBeNull();
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 0, 0)).toBeNull(); // blocked border corner
    expect(firstDescentNeighbor(STRAIGHT_FIELD, 99, 99)).toBeNull(); // out of bounds
  });
});

describe('advanceCreep — normal movement', () => {
  it('advances one budget along the first edge, from-point unchanged until arrival', () => {
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 0, 2, 0, 26)).toEqual({
      kind: 'move',
      fromX: cx(0),
      fromY: cy(2),
      headCol: 1,
      headRow: 2,
      progress: 26,
    });
  });

  it('snaps the from-point to the next centre when progress reaches the edge (sentinel head)', () => {
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 0, 2, 0, ORTHO_LEN)).toEqual({
      kind: 'move',
      fromX: cx(1), // from snapped onto the (1,2) centre
      fromY: cy(2),
      headCol: 1, // rest sentinel: head == current cell
      headRow: 2,
      progress: 0,
    });
  });

  it('carries the remainder onto the next edge after crossing a boundary', () => {
    // 250 into the (0,2)→(1,2) edge, budget 26: 6 finishes it, 20 carry onto the
    // freshly-derived (1,2)→(2,2) edge with the from-point snapped to the (1,2) centre.
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 1, 2, 250, 26)).toEqual({
      kind: 'move',
      fromX: cx(1),
      fromY: cy(2),
      headCol: 2,
      headRow: 2,
      progress: 20,
    });
  });

  it('crosses multiple boundaries in one tick when the budget allows', () => {
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 0, 2, 0, 600)).toEqual({
      kind: 'move',
      fromX: cx(2),
      fromY: cy(2),
      headCol: 3,
      headRow: 2,
      progress: 88,
    });
  });

  it('crosses a diagonal edge of length 362, not 256', () => {
    expect(advanceCreep(DIAGONAL, 1, 5, cx(2), cy(2), 2, 2, 0, DIAG_LEN)).toEqual({
      kind: 'move',
      fromX: cx(3),
      fromY: cy(1),
      headCol: 3,
      headRow: 1,
      progress: 0,
    });
    expect(advanceCreep(DIAGONAL, 1, 5, cx(2), cy(2), 2, 2, 0, DIAG_LEN - 1)).toEqual({
      kind: 'move',
      fromX: cx(2),
      fromY: cy(2),
      headCol: 3,
      headRow: 1,
      progress: DIAG_LEN - 1,
    });
  });

  it('leaks after the exact expected number of ticks', () => {
    expect(ticksToLeak(STRAIGHT_FIELD, 0, 2, 26)).toBe(Math.ceil((4 * ORTHO_LEN) / 26)); // 40
    expect(ticksToLeak(ADJACENT, 0, 1, 26)).toBe(Math.ceil(ORTHO_LEN / 26)); // 10
    const mixed = 2 * ORTHO_LEN + 2 * DIAG_LEN;
    expect(ticksToLeak(DIAGONAL, 0, 3, 26)).toBe(Math.ceil(mixed / 26)); // 48
  });
});

describe('advanceCreep — point-authoritative re-path (closes #17)', () => {
  it('turns FROM the actual point onto a transitional segment (no backward snap)', () => {
    // Committed (2,2)→(3,2) at progress 100 (point x=740). The maze then walls (3,2),
    // so the descent from (2,2) changes: the creep turns from its ACTUAL point (740,y),
    // not by snapping back to the (2,2) centre.
    const newHead = firstDescentNeighbor(WIDE_WALLED, 2, 2);
    expect(newHead).not.toBeNull();
    expect(newHead?.col === 3 && newHead?.row === 2).toBe(false); // genuinely re-routed

    const out = advanceCreep(WIDE_WALLED, 1, 5, cx(2), cy(2), 3, 2, 100, 26);
    expect(out.kind).toBe('move');
    if (out.kind !== 'move') return;
    expect(out.fromX).toBe(cx(2) + 100); // turned from P = 740, an interior point…
    expect(out.fromX % 256).not.toBe(128); // …NOT a cell centre (transitional segment)
    expect([out.headCol, out.headRow]).toEqual([newHead?.col, newHead?.row]);
    expect(out.progress).toBe(26); // advanced along the new transitional edge
  });

  it('re-paths again on the very next tick if the descent keeps changing', () => {
    // Two consecutive re-paths must both stay valid moves (never a drop/crash): first
    // under the walled field, then feed the transitional result back under the OPEN
    // field (descent changes again) and confirm it re-routes onto a fresh segment.
    const first = advanceCreep(WIDE_WALLED, 1, 5, cx(2), cy(2), 3, 2, 100, 26);
    expect(first.kind).toBe('move');
    if (first.kind !== 'move') return;
    const second = advanceCreep(
      WIDE_FIELD, // maze reverts — descent from the occupied cell differs again
      1,
      5,
      first.fromX,
      first.fromY,
      first.headCol,
      first.headRow,
      first.progress,
      26,
    );
    expect(second.kind).toBe('move');
  });

  it('crosses a transitional segment THEN a normal one in a single tick', () => {
    // From an interior point of cell 2 heading to (3,2), a big budget finishes the
    // short transitional segment (isqrt length 136), snaps onto the lattice, and
    // continues on a normal edge — the from-point ends on a cell centre, proving the
    // lattice was re-established.
    const interiorX = cx(2) + 120; // 760: inside cell 2, near the (3,2) boundary
    const out = advanceCreep(WIDE_FIELD, 1, 5, interiorX, cy(2), 3, 2, 0, 600);
    expect(out.kind).toBe('move');
    if (out.kind !== 'move') return;
    expect(out.fromX % 256).toBe(128); // snapped onto a centre after the transitional seg
    expect(out.fromY % 256).toBe(128);
  });
});

describe('advanceCreep — leak policy', () => {
  it('leaks a creep resting on the exit', () => {
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, cx(4), cy(2), 4, 2, 0, 26)).toEqual({ kind: 'leak' });
  });

  it('leaks a resting-on-exit creep independent of its head columns (head-agnostic arrival)', () => {
    // At progress 0 the point IS the from-point, so a creep centred on the exit has
    // arrived and leaks even if its (unused) head sentinel is non-canonical/forged.
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, cx(4), cy(2), 0, 0, 0, 26)).toEqual({ kind: 'leak' });
  });

  it('leaks the tick it arrives, discarding remaining budget', () => {
    expect(advanceCreep(ADJACENT, 1, 5, cx(0), cy(1), 1, 1, 230, 100000)).toEqual({ kind: 'leak' });
  });

  it('leaks only when the point reaches the exit centre, not when it enters the exit cell', () => {
    // 130 into the (0,1)→(1,1) edge: the point (x=258) is already inside the exit cell
    // (floor 258/256 = 1) but NOT on its centre, so the creep advances rather than leaks.
    const mid = advanceCreep(ADJACENT, 1, 5, cx(0), cy(1), 1, 1, 130, 1);
    expect(mid.kind).toBe('move');
  });
});

describe('advanceCreep — corrupt-row drop policy (never crashes, no life lost)', () => {
  const cases: ReadonlyArray<[string, AdvanceOutcome]> = [
    ['id undefined', advanceCreep(STRAIGHT_FIELD, undefined, 5, cx(0), cy(2), 0, 2, 0, 26)],
    ['hp undefined', advanceCreep(STRAIGHT_FIELD, 1, undefined, cx(0), cy(2), 0, 2, 0, 26)],
    ['fromX undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, undefined, cy(2), 0, 2, 0, 26)],
    ['fromY undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), undefined, 0, 2, 0, 26)],
    ['headCol undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), undefined, 2, 0, 26)],
    ['headRow undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 0, undefined, 0, 26)],
    ['progress undefined', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 0, 2, undefined, 26)],
    ['fromX non-integer', advanceCreep(STRAIGHT_FIELD, 1, 5, 128.5, cy(2), 0, 2, 0, 26)],
    ['headCol non-integer', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(1), cy(2), 1.5, 2, 10, 26)],
    ['progress non-integer', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(1), cy(2), 2, 2, 1.5, 26)],
    ['from-point out of bounds', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(99), cy(2), 99, 2, 0, 26)],
    ['head out of bounds', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 0, 99, 0, 26)],
    ['negative progress', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(1), cy(2), 2, 2, -1, 26)],
    [
      'resting on a blocked border cell',
      advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(0), 0, 0, 0, 26),
    ],
    ['non-adjacent head', advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 2, 2, 10, 26)],
    [
      'progress past the edge',
      advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 1, 2, ORTHO_LEN + 44, 26),
    ],
    [
      'progress at exactly the edge',
      advanceCreep(STRAIGHT_FIELD, 1, 5, cx(0), cy(2), 1, 2, ORTHO_LEN, 26),
    ],
    [
      'zero-length step with progress',
      advanceCreep(STRAIGHT_FIELD, 1, 5, cx(1), cy(2), 1, 2, 10, 26),
    ],
  ];
  for (const [label, outcome] of cases) {
    it(`drops a row with ${label}`, () => {
      expect(outcome).toEqual({ kind: 'drop' });
    });
  }

  it('keeps a far-side committed creep whose FROM cell is walled behind it', () => {
    // Past the mid-edge boundary the creep occupies its HEAD cell, so a wall built on
    // the cell it just left (a legal, common maze move) is behind it — validation
    // must check only the occupied (head) cell, never the walled from cell, so the
    // creep finishes its step rather than silently vanishing.
    const walledBehind: DistanceField = {
      width: 5,
      height: 5,
      exit: { col: 4, row: 2 },
      // Row 2: (2,2) blocked (walled behind), (3,2) dist 10 open, (4,2) exit 0.
      dist: Int32Array.from([
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 10, 0, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1,
      ]),
      blockedMask: Uint8Array.from([
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      ]),
    };
    // from=(2,2) centre, head (3,2), progress 200 (past half of 256) ⇒ occupies (3,2).
    const out = advanceCreep(walledBehind, 1, 5, cx(2), cy(2), 3, 2, 200, 26);
    expect(out.kind).toBe('move'); // survives — the walled from cell is behind it
    if (out.kind === 'move') expect([out.headCol, out.headRow]).toEqual([3, 2]);
  });

  it('drops (no life lost) a corrupt creep whose FROM cell is the exit with positive progress', () => {
    // A genuine creep leaks the instant its point reaches the exit centre and never
    // departs; a forged row sitting at the exit centre but heading to an adjacent
    // cell is corrupt. It must DROP, not walk back into the exit and cost a life.
    expect(advanceCreep(STRAIGHT_FIELD, 1, 5, cx(4), cy(2), 3, 2, 200, 26)).toEqual({
      kind: 'drop',
    });
  });

  it('drops a creep whose occupied cell is in-bounds but unreachable (walled off)', () => {
    const walledOpen: DistanceField = {
      width: 2,
      height: 1,
      exit: { col: 1, row: 0 },
      dist: Int32Array.from([-1, 0]), // (0,0) open but stranded, (1,0) exit
      blockedMask: new Uint8Array([0, 0]),
    };
    expect(advanceCreep(walledOpen, 1, 5, cx(0), cy(0), 0, 0, 0, 26)).toEqual({ kind: 'drop' });
  });

  it('drops (does not crash) on a forged field where a live cell has no exact descent', () => {
    const forged: DistanceField = {
      width: 3,
      height: 3,
      exit: { col: 2, row: 1 },
      dist: new Int32Array(9), // all zero — no descent anywhere
      blockedMask: new Uint8Array(9),
    };
    expect(advanceCreep(forged, 1, 5, cx(0), cy(1), 0, 1, 0, 26)).toEqual({ kind: 'drop' });
  });
});

describe('mid-transitional serialize/restore is byte-identical (determinism)', () => {
  // A 9×6 lane: a wall built while a creep is mid-edge forces a transitional segment.
  const LANE: BoardContext = loadBoard({
    widthTiles: 9,
    heightTiles: 6,
    entrance: { col: 0, row: 2 },
    exit: { col: 8, row: 2 },
  });
  const spawn: SimInput = { kind: 'spawnCreep', hp: 50 }; // survives to the exit

  it('resumes identically when snapshotted on a transitional tick', () => {
    // Reference run: spawn, advance a few ticks, wall the lane (re-path → transitional),
    // then continue. The build tick puts the live creep on a transitional segment.
    const ref = createInitialState(7);
    const trace: string[] = [];
    step(ref, [spawn], LANE);
    for (let t = 0; t < 6; t++) step(ref, [], LANE); // mid-edge
    step(ref, [{ kind: 'placeTower', anchor: { col: 3, row: 1 } }], LANE); // re-path here
    trace.push(hashSimState(ref));
    for (let t = 0; t < 40; t++) {
      step(ref, [], LANE);
      trace.push(hashSimState(ref));
    }

    // Restore run: replay to the transitional tick, JSON round-trip, then continue.
    const live = createInitialState(7);
    step(live, [spawn], LANE);
    for (let t = 0; t < 6; t++) step(live, [], LANE);
    step(live, [{ kind: 'placeTower', anchor: { col: 3, row: 1 } }], LANE);
    const restored = JSON.parse(JSON.stringify(live)) as SimState;
    const resumed: string[] = [hashSimState(restored)];
    for (let t = 0; t < 40; t++) {
      step(restored, [], LANE);
      resumed.push(hashSimState(restored));
    }

    expect(resumed).toEqual(trace);
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
    expect(() => assertConsistent(base)).not.toThrow();
  });

  it('rejects a null-membered forged context with GridError (not a raw TypeError)', () => {
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
    badDist[2 * 5 + 4] = 5;
    expect(() => assertConsistent(withField({ dist: badDist }))).toThrow(/unblocked distance-0/);

    const badMask = Uint8Array.from(base.field.blockedMask);
    badMask[2 * 5 + 4] = 1;
    expect(() => assertConsistent(withField({ blockedMask: badMask }))).toThrow(
      /unblocked distance-0/,
    );
  });

  it('rejects a context whose entrance cannot reach the exit', () => {
    const badDist = Int32Array.from(base.field.dist);
    badDist[2 * 5 + 0] = -1;
    expect(() => assertConsistent(withField({ dist: badDist }))).toThrow(/cannot reach/);
  });
});
