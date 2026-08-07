// support.test.ts — the support-aura adjacency rule (M2-S8). Unit-level: the geometry,
// the strongest-single-aura rule, the `null` short-circuit, and the fixed-point buff
// arithmetic. The end-to-end behaviour (a buffed shot's snapshotted amount, the sell
// transition, armor piercing) is measured against the SHIPPED bundle in
// `packages/content/src/story-support.test.ts`; this file pins the pieces that story
// cannot reach — out-of-bounds stamping, an invalid row, and the identity/saturation
// edges of `buffAmount`.

import { describe, it, expect } from 'vitest';
import { buildGrid, type Grid } from './board';
import { emptyTowers, type TowerArrays } from './tower';
import { buildAuraIndex, auraMulFor, buffAmount, SUPPORT_MUL_IDENTITY } from './support';

/** A plain open board with the standard blocked border ring and the two openings. */
function grid(width = 12, height = 12): Grid {
  return buildGrid({
    widthTiles: width,
    heightTiles: height,
    entrance: { col: 0, row: Math.floor(height / 2) },
    exit: { col: width - 1, row: Math.floor(height / 2) },
  });
}

const BEACON = { cost: 15, support: { damageMulFp: 384 } };
const STRONGER = { cost: 15, support: { damageMulFp: 512 } };
const ATTACKER = { cost: 5 };
const CATALOG = { beacon: BEACON, strong: STRONGER, basic: ATTACKER };

/** Build a tower SoA from `(towerId, col, row)` triples, with each row's `spend` set to
 *  its catalog cost — `forEachValidTower` treats a spend↔towerId mismatch as an INVALID
 *  row, so getting this wrong would silently empty the walk. */
function towersOf(
  rows: readonly (readonly [string, number, number])[],
  spendOverride?: readonly number[],
): TowerArrays {
  const t = emptyTowers();
  rows.forEach(([towerId, col, row], i) => {
    t.id.push(i + 1);
    t.col.push(col);
    t.row.push(row);
    t.spend.push(
      spendOverride?.[i] ?? (CATALOG as Record<string, { cost: number }>)[towerId]!.cost,
    );
    t.targetId.push(0);
    t.nextFireTick.push(0);
    t.towerId.push(towerId);
  });
  return t;
}

describe('buildAuraIndex — the stamp', () => {
  it('returns null when no support tower is placed (the pre-scan short-circuit)', () => {
    const g = grid();
    expect(buildAuraIndex(g, towersOf([['basic', 2, 2]]), CATALOG)).toBeNull();
    expect(buildAuraIndex(g, emptyTowers(), CATALOG)).toBeNull();
  });

  it('stamps the eight orthogonal ring cells and NOT the four diagonal corners', () => {
    const g = grid();
    const index = buildAuraIndex(g, towersOf([['beacon', 4, 4]]), CATALOG);
    expect(index).not.toBeNull();
    const key = (c: number, r: number): number => r * g.width + c;
    // The full edge-sharing ring of a 2×2 at (4,4).
    for (const [c, r] of [
      [3, 4],
      [3, 5],
      [6, 4],
      [6, 5],
      [4, 3],
      [5, 3],
      [4, 6],
      [5, 6],
    ] as const) {
      expect(index!.get(key(c, r))).toBe(384);
    }
    // The four corner-only cells. This omission IS the corner-exclusion rule (m2.md) —
    // if these were stamped, a diagonally touching footprint would be buffed.
    for (const [c, r] of [
      [3, 3],
      [6, 3],
      [3, 6],
      [6, 6],
    ] as const) {
      expect(index!.get(key(c, r))).toBeUndefined();
    }
    // Its own four cells are never stamped — a beacon does not buff itself, and nothing
    // reads its stamp anyway (support towers never fire).
    for (const [c, r] of [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ] as const) {
      expect(index!.get(key(c, r))).toBeUndefined();
    }
    expect(index!.size).toBe(8);
  });

  it('takes the MAX where two auras overlap, never the sum — strongest single aura wins', () => {
    const g = grid();
    // Two beacons of DIFFERENT strength whose rings share cell (6,5): the ×1.5 beacon at
    // (4,4) and the ×2 beacon at (6,6). A summing index would put 896 there.
    const index = buildAuraIndex(
      g,
      towersOf([
        ['beacon', 4, 4],
        ['strong', 6, 6],
      ]),
      CATALOG,
    )!;
    expect(index.get(5 * g.width + 6)).toBe(512);
    // ... and the max is taken in BOTH directions, so the walk order is not observable:
    // (4,6) is stamped by the weaker beacon's ring only.
    expect(index.get(6 * g.width + 4)).toBe(384);
  });

  it('never stamps out of bounds — a negative column would ALIAS onto the previous row', () => {
    // Under `row * width + col`, cell (-1, r) keys to `r·width − 1`, which is exactly
    // (width−1, r−1). Unreachable today (the border ring is permanently blocked, so a
    // valid footprint always sits at least one cell in) — but the bounds check is what
    // keeps a future open-border board from aliasing SILENTLY instead of failing.
    const g = grid();
    const index = buildAuraIndex(g, towersOf([['beacon', 1, 1]]), CATALOG)!;
    for (const k of index.keys()) {
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(g.width * g.height);
      const col = k % g.width;
      const row = (k - col) / g.width;
      // Every stamped cell is a genuine ring cell of the (1,1) footprint — never an
      // alias that merely happens to be in range.
      expect(Math.abs(col - 1) <= 2 && Math.abs(row - 1) <= 2).toBe(true);
    }
  });

  it('ignores an INVALID row — a beacon whose spend does not match its cost stamps nothing', () => {
    const g = grid();
    // The pre-scan sees the `towerId` and builds the map (deliberately: it classifies
    // nothing), but the canonical `forEachValidTower` walk rejects the row, so the map
    // comes back empty rather than carrying a stamp the sim itself does not honour.
    const index = buildAuraIndex(g, towersOf([['beacon', 4, 4]], [999]), CATALOG);
    expect(index).not.toBeNull();
    expect(index!.size).toBe(0);
  });
});

describe('auraMulFor — the lookup', () => {
  it('is the identity for a null index and for a cell no aura reaches', () => {
    const g = grid();
    expect(auraMulFor(null, g, 4, 4)).toBe(SUPPORT_MUL_IDENTITY);
    const index = buildAuraIndex(g, towersOf([['beacon', 4, 4]]), CATALOG);
    expect(auraMulFor(index, g, 9, 9)).toBe(SUPPORT_MUL_IDENTITY);
  });

  it('takes the strongest over the recipient’s FOUR footprint cells, not just its anchor', () => {
    const g = grid();
    const index = buildAuraIndex(g, towersOf([['beacon', 4, 4]]), CATALOG);
    // A recipient at (6,4) has its anchor ON a stamped cell.
    expect(auraMulFor(index, g, 6, 4)).toBe(384);
    // A recipient at (4,6) reaches the ring through its anchor row too...
    expect(auraMulFor(index, g, 4, 6)).toBe(384);
    // ... and one at (3,6) reaches it only through its (4,6) cell — the anchor (3,6) is
    // a corner-only cell and is NOT stamped, so an anchor-only lookup would miss this.
    expect(index!.get(6 * g.width + 3)).toBeUndefined();
    expect(auraMulFor(index, g, 3, 6)).toBe(384);
  });

  it('never reads out of bounds — an out-of-range anchor must not ALIAS onto the next row', () => {
    // The read half of the same `row * width + col` aliasing the stamp guards against: a
    // lookup at `col = width - 1` keys its `dc = 1` cells to column 0 of the NEXT row, and
    // column 0 IS stamped by a beacon anchored at column 1. Without the guard this returns
    // that beacon's multiplier for a tower on the far side of the board. Unreachable
    // through `forEachValidTower` today (a valid anchor caps at `width - 2`); asserted
    // directly, since an unreachable-today alias is exactly what a future open-border
    // board would turn into a silent wrong answer.
    const g = grid();
    const index = buildAuraIndex(g, towersOf([['beacon', 1, 4]]), CATALOG)!;
    // The beacon at col 1 stamps column 0 on rows 4 and 5 — the cells the alias would hit.
    expect(index.get(4 * g.width + 0)).toBe(384);
    // A tower anchored at the last column is nowhere near it, and must read the identity.
    expect(auraMulFor(index, g, g.width - 1, 3)).toBe(SUPPORT_MUL_IDENTITY);
  });

  it('excludes a corner-only neighbour — the aura is an edge share, not a radius', () => {
    const g = grid();
    const index = buildAuraIndex(g, towersOf([['beacon', 4, 4]]), CATALOG);
    // (6,6) touches (5,5) at a point only. All four of its cells are unstamped.
    expect(auraMulFor(index, g, 6, 6)).toBe(SUPPORT_MUL_IDENTITY);
  });
});

describe('buffAmount — the fixed-point arithmetic', () => {
  it('is an exact identity at 256, so an unbuffed board is bit-for-bit unchanged', () => {
    for (const n of [0, 1, 7, 10, 8, 4, 1_000_000]) {
      expect(buffAmount(n, SUPPORT_MUL_IDENTITY)).toBe(n);
    }
  });

  it('floors rather than rounds — 10→15, 8→12, 4→6, 2→3, 1→1, 5→7', () => {
    // 1 and 5 are the interesting ones: ×1.5 gives 1.5 and 7.5, so a rounding
    // implementation would return 2 and 8. The sim is integer-only by contract.
    expect([1, 2, 4, 5, 8, 10].map((n) => buffAmount(n, 384))).toEqual([1, 3, 6, 7, 12, 15]);
  });

  it('is exact across the WHOLE domain a compiling bundle can reach — no saturation needed', () => {
    // The reachable domain, derived rather than guessed: `ruleset-schema.ts` bounds
    // `damage`/`damagePerTick` by `isPosInt`'s default `GENERIC_MAX` (1e6), and
    // `capability.ts` bounds `maxSupportDamageMulFp` at 1024. Anything a bundle that
    // COMPILES can hand this function lives inside those two ceilings, and the largest
    // product is ~1.02e9 — nowhere near `Number.MAX_SAFE_INTEGER`. Two earlier versions
    // carried a saturation branch justified by "the schema leaves damage unbounded"; it
    // does not, and both branches computed a wrong answer in the region they claimed to
    // protect. This asserts the ceilings hold and the arithmetic is exact at them.
    const MAX_AUTHORED_DAMAGE = 1_000_000; // ruleset-schema.ts GENERIC_MAX
    const MAX_MUL_FP = 1024; // capability.ts maxSupportDamageMulFp at sv12
    expect(buffAmount(MAX_AUTHORED_DAMAGE, MAX_MUL_FP)).toBe(4_000_000);
    expect(Number.isSafeInteger(MAX_AUTHORED_DAMAGE * MAX_MUL_FP)).toBe(true);
    expect(MAX_AUTHORED_DAMAGE * MAX_MUL_FP).toBeLessThan(Number.MAX_SAFE_INTEGER / 1e6);
    // Monotonic and never below its input across that domain — the two properties a
    // "strengthening" multiplier must have, checked as laws rather than pinned pairs.
    let previous = 0;
    for (const amount of [1, 2, 7, 1_000, 65_535, 999_999, MAX_AUTHORED_DAMAGE]) {
      const got = buffAmount(amount, 384);
      // Only PROPERTIES here — monotonic, and never below its input. An earlier version
      // also asserted `got === Math.floor(amount * 384 / 256)`, which restates the
      // function's own body and so cannot fail for any implementation sharing the
      // formula, including a wrong one that swapped multiplier for divisor consistently.
      // The independent goldens live in the `floors rather than rounds` test above
      // (1→1, 2→3, 4→6, 5→7, 8→12, 10→15), hand-checked rather than re-derived.
      expect(got).toBeGreaterThanOrEqual(previous);
      expect(got).toBeGreaterThanOrEqual(amount);
      previous = got;
    }
  });

  it('leaves non-positive/unsafe inputs alone', () => {
    expect(buffAmount(0, 384)).toBe(0);
    expect(buffAmount(-5, 384)).toBe(-5);
    expect(buffAmount(1.5, 384)).toBe(1.5);
  });
});
