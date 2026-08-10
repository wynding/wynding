// layout-catalog.test.ts — the CATALOG scene's committed placement + pad tables,
// machine-checked (M2-S11 P7, as amended).
//
// A separate file from `layout.test.ts` so the stress describe blocks are untouched: P8
// depends on the stress side being byte-identical after this packet, and a test file this
// packet edits is a test file this packet could weaken.
//
// EVERY positional constraint the packet states is enforced HERE, not by review — that is
// the whole reason the tables are committed literals rather than rules evaluated at run
// time. The three measured IMPOSSIBILITIES that forced the amendment (mines off the anchor
// set, onto route-neutral pads) are pinned as tests too, at the bottom: they are the
// amendment's standing justification, and if a future geometry change makes any of them
// false, that test goes red and the amendment should be revisited rather than inherited.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseRulesetJson,
  compileRuleset,
  materializeTowerMask,
  computeDistanceField,
  shortestPath,
  DIAG_LEN,
  type CompiledRuleset,
  type TowerValidityView,
} from '@wynding/sim';
import { CATALOG_RULESET_URL, CATALOG_BOARD_ID } from '@wynding/content/catalog';
import {
  stressAnchors,
  CATALOG_TOWER_ID_AT,
  catalogTowerIdAt,
  catalogPlacements,
  catalogRoutePath,
  catalogRouteLength,
  catalogRouteCumulativeFp,
  CATALOG_MINE_PADS,
  CATALOG_DETONATOR_PAD_COUNT,
  CATALOG_DETONATING_MINE_INDICES,
  CATALOG_SURVIVING_MINE_INDICES,
  CATALOG_DETONATOR_ROUTE_INDICES,
  CATALOG_DETONATOR_LOWER_BOUND_TICKS,
  catalogDetonatorLowerBoundTicks,
  CATALOG_TOWER_COUNT,
  CATALOG_TOTAL_SPEND,
  type CatalogTowerId,
} from './layout';
import {
  CATALOG_ATTACKER_COUNTS,
  CATALOG_SAMPLE_END_TICK,
  CATALOG_SAMPLE_START_TICK,
} from './oracle-catalog';

const FP_ONE = 256;
const HALF_CELL = 128;

const bundle = parseRulesetJson(readFileSync(CATALOG_RULESET_URL, 'utf8'));
const compiled = compileRuleset(bundle, CATALOG_BOARD_ID);
const anchors = stressAnchors();
const placements = catalogPlacements();
const route = catalogRoutePath(compiled);
const cum = catalogRouteCumulativeFp(compiled);

type Cell = { col: number; row: number };

/** A tower's 2×2 footprint CENTRE, in fixed point — the shared corner of its four cells,
 *  exactly what `combat.ts` computes (`(col + 1) * FP_ONE`). Every range check below is
 *  measured from here, not from the anchor cell, or it would be measuring a different
 *  tower than the sim fires. */
function withinFp(at: Cell, cell: Cell, rangeFp: number): boolean {
  const dx = cell.col * FP_ONE + HALF_CELL - (at.col + 1) * FP_ONE;
  const dy = cell.row * FP_ONE + HALF_CELL - (at.row + 1) * FP_ONE;
  return dx * dx + dy * dy <= rangeFp * rangeFp;
}

/** Two 2×2 footprints share ≥ 1 FULL CELL EDGE (the `support.ts` aura rule; corner-only
 *  touch excluded). For anchors on a 2×2 grid that reduces to exactly this. */
function edgeAdjacent(i: number, j: number): boolean {
  const a = anchors[i]!;
  const b = anchors[j]!;
  const dc = Math.abs(a.col - b.col);
  const dr = Math.abs(a.row - b.row);
  return (dc <= 1 && dr === 2) || (dr <= 1 && dc === 2);
}

/** The flight line: air creeps fly straight from entrance to exit
 *  (`movement.ts`'s `airLineFollowNeighbor`), which on this board is row 20, cols 0..39. */
const FLIGHT_LINE: Cell[] = Array.from({ length: 40 }, (_, col) => ({ col, row: 20 }));

/** True iff the tower assigned at anchor `index` has an attack whose OWN compiled
 *  `rangeFp` covers ≥ 1 cell of a path its OWN compiled `domain` can actually engage —
 *  ground/`both` against the ground route, `air` against the flight line. Resolved per
 *  assigned tower, never against a shared literal range: a geometrically-in-range tower
 *  that cannot legally target the path's occupants proves nothing about the buff. */
function engagesAPath(index: number): boolean {
  const def = compiled.towerById[catalogTowerIdAt(index)];
  const attack = def?.attack;
  if (attack === undefined) return false;
  const cells = attack.domain === 'air' ? FLIGHT_LINE : route;
  return cells.some((c) => withinFp(anchors[index]!, c, attack.rangeFp));
}

/** The route recomputed over an arbitrary placement set — the sim's own mask/field/path
 *  pipeline, exactly as `catalogRoutePath` builds it. */
function routeOver(ps: readonly { anchor: Cell; towerId: string }[]): readonly Cell[] {
  const grid = compiled.board.grid;
  const towers: TowerValidityView = {
    id: ps.map((_, i) => i + 1),
    col: ps.map((p) => p.anchor.col),
    row: ps.map((p) => p.anchor.row),
    spend: ps.map((p) => compiled.towerById[p.towerId]!.cost),
    towerId: ps.map((p) => p.towerId),
  };
  const mask = materializeTowerMask(grid, towers, compiled.towerById);
  return shortestPath(grid, computeDistanceField(grid, mask), grid.entrance) ?? [];
}
const routeKey = (p: readonly Cell[]): string => p.map((c) => `${c.col},${c.row}`).join('|');
const BASE_KEY = routeKey(route);

/** The `mine`'s TRIGGER range — its own compiled `attack.rangeFp`, read from the bundle
 *  rather than restated as 576, so a catalog edit moves this check with it. */
const MINE_TRIGGER_FP = (() => {
  const attack = compiled.towerById['mine']?.attack;
  if (attack === undefined) throw new Error('the catalog bundle has no `mine` attack block');
  return attack.rangeFp;
})();

/** The first route index within trigger range of a 2×2 placed at `at`, or `Infinity`. */
function firstInRangeIndex(at: Cell): number {
  for (let k = 0; k < route.length; k++) {
    if (withinFp(at, route[k]!, MINE_TRIGGER_FP)) return k;
  }
  return Number.POSITIVE_INFINITY;
}

const FOOTPRINT_DELTAS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

describe('the committed 165-placement table', () => {
  it('is 150 anchors + 15 mine pads, and catalogTowerIdAt agrees index for index', () => {
    expect(CATALOG_TOWER_ID_AT).toHaveLength(150);
    expect(CATALOG_MINE_PADS).toHaveLength(15);
    expect(placements).toHaveLength(CATALOG_TOWER_COUNT);
    expect(CATALOG_TOWER_COUNT).toBe(165);
    for (let i = 0; i < 150; i++) {
      expect(placements[i]!.towerId).toBe(CATALOG_TOWER_ID_AT[i]);
      expect(placements[i]!.anchor).toEqual(anchors[i]);
      expect(catalogTowerIdAt(i)).toBe(CATALOG_TOWER_ID_AT[i]);
    }
    for (let i = 150; i < 165; i++) {
      expect(placements[i]!.towerId).toBe('mine');
      expect(catalogTowerIdAt(i)).toBe('mine');
      expect(placements[i]!.anchor).toEqual({
        col: CATALOG_MINE_PADS[i - 150]!.col,
        row: CATALOG_MINE_PADS[i - 150]!.row,
      });
    }
  });

  it('throws rather than falling back outside the table', () => {
    expect(() => catalogTowerIdAt(165)).toThrow();
    expect(() => catalogTowerIdAt(-1)).toThrow();
  });

  it('places all nine real catalog tower ids at the amended counts', () => {
    const expected: Readonly<Record<CatalogTowerId, number>> = {
      basic: 20,
      slow: 20,
      splash: 19,
      venom: 19,
      stun: 19,
      antiair: 19,
      'frost-splash': 19,
      beacon: 15,
      mine: 15,
    };
    const tally: Record<string, number> = {};
    for (const p of placements) tally[p.towerId] = (tally[p.towerId] ?? 0) + 1;
    expect(tally).toEqual(expected);
    for (const id of Object.keys(expected)) expect(compiled.towerById[id]).toBeDefined();
    // Machine-tie the DECLARED attacker counts (the adversarial damage ceiling's input,
    // oracle-catalog.ts) to the REALIZED placement tally — without this, a coordinated
    // re-pin could leave the "no combat deaths" proof bounding a distribution the scene
    // no longer places (PR #93 ship-review round 2).
    expect(tally).toEqual({ ...CATALOG_ATTACKER_COUNTS, beacon: 15, mine: 15 });
  });

  it('the 135 non-beacon anchors follow the uncapped round-robin, re-derived here', () => {
    // The rule, re-run rather than trusted: beacons hold anchors 10, 12, …, 38; every
    // other anchor takes the next kind in the rotation, no exhaustion cap.
    const KIND_ORDER: CatalogTowerId[] = [
      'basic',
      'slow',
      'splash',
      'venom',
      'stun',
      'antiair',
      'frost-splash',
    ];
    const beaconSet = new Set([10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38]);
    const rebuilt: CatalogTowerId[] = new Array(150).fill('beacon');
    let cursor = 0;
    for (let i = 0; i < 150; i++) {
      if (beaconSet.has(i)) continue;
      rebuilt[i] = KIND_ORDER[cursor % KIND_ORDER.length]!;
      cursor++;
    }
    expect(rebuilt).toEqual([...CATALOG_TOWER_ID_AT]);
    expect(cursor).toBe(135);
    // 135 = 19 × 7 + 2, so exactly two kinds land 20 and the rest 19.
    expect(135).toBe(19 * 7 + 2);
  });

  it('costs exactly 1,601 — the bundle’s startingBounty, so leftover bounty is a real oracle', () => {
    const spend = placements.reduce((s, p) => s + compiled.towerById[p.towerId]!.cost, 0);
    expect(spend).toBe(CATALOG_TOTAL_SPEND);
    expect(spend).toBe(1_601);
    expect(spend).toBe(bundle.balance.startingBounty);
    // The three components, so a shifted count is visible rather than merely summed away.
    const attackers = 20 * 5 + 20 * 8 + 19 * 12 + 19 * 9 + 19 * 10 + 19 * 7 + 19 * 16;
    expect(attackers).toBe(1_286);
    expect(attackers + 15 * 15 + 15 * 6).toBe(1_601);
  });

  it('no two placements’ 2x2 footprints overlap, and every cell is in the buildable interior', () => {
    const seen = new Set<string>();
    for (const p of placements) {
      for (const [dc, dr] of FOOTPRINT_DELTAS) {
        const col = p.anchor.col + dc;
        const row = p.anchor.row + dr;
        expect(col).toBeGreaterThanOrEqual(1);
        expect(col).toBeLessThanOrEqual(38);
        expect(row).toBeGreaterThanOrEqual(1);
        expect(row).toBeLessThanOrEqual(38);
        const cellKey = `${col},${row}`;
        expect(seen.has(cellKey), `footprint overlap at ${cellKey}`).toBe(false);
        seen.add(cellKey);
      }
    }
  });

  it('reuses the stress geometry: the as-built route is 329 cells', () => {
    expect(catalogRouteLength(compiled)).toBe(329);
    expect(route).toHaveLength(329);
  });
});

describe('the beacon constraint', () => {
  const beacons = CATALOG_TOWER_ID_AT.flatMap((id, i) => (id === 'beacon' ? [i] : []));

  it('sits on anchors 10, 12, …, 38', () => {
    expect(beacons).toEqual([10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38]);
  });

  it('every beacon is edge-adjacent to >= 1 ATTACKING anchor that can engage a path its own domain covers', () => {
    for (const b of beacons) {
      const qualifying = anchors
        .map((_, j) => j)
        .filter(
          (j) =>
            j !== b && edgeAdjacent(b, j) && CATALOG_TOWER_ID_AT[j] !== 'beacon' && engagesAPath(j),
        );
      expect(
        qualifying.length,
        `beacon at anchor ${b} (${anchors[b]!.col},${anchors[b]!.row}) has no qualifying attacking neighbour`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('resolves range PER ASSIGNED TOWER — stun reaches 3 tiles, antiair 5, the rest 4', () => {
    expect(compiled.towerById['stun']!.attack!.rangeFp).toBe(3 * FP_ONE);
    expect(compiled.towerById['antiair']!.attack!.rangeFp).toBe(5 * FP_ONE);
    for (const id of ['basic', 'slow', 'splash', 'venom', 'frost-splash']) {
      expect(compiled.towerById[id]!.attack!.rangeFp).toBe(4 * FP_ONE);
    }
    expect(compiled.towerById['antiair']!.attack!.domain).toBe('air');
    expect(compiled.towerById['slow']!.attack!.domain).toBe('both');
  });

  it('no beacon is edge-adjacent to another beacon (support towers never buff each other)', () => {
    for (const a of beacons) {
      for (const b of beacons) if (a !== b) expect(edgeAdjacent(a, b)).toBe(false);
    }
  });
});

describe('the mine pads', () => {
  const detonators = CATALOG_MINE_PADS.slice(0, CATALOG_DETONATOR_PAD_COUNT);
  const survivors = CATALOG_MINE_PADS.slice(CATALOG_DETONATOR_PAD_COUNT);

  it('are 10 detonators + 5 survivors, at the committed coordinates', () => {
    expect(CATALOG_DETONATOR_PAD_COUNT).toBe(10);
    expect(detonators).toEqual([
      { col: 26, row: 10 },
      { col: 28, row: 10 },
      { col: 30, row: 10 },
      { col: 32, row: 10 },
      { col: 25, row: 12 },
      { col: 34, row: 12 },
      { col: 25, row: 14 },
      { col: 36, row: 14 },
      { col: 28, row: 15 },
      { col: 25, row: 16 },
    ]);
    expect(survivors).toEqual([
      { col: 25, row: 1 },
      { col: 27, row: 1 },
      { col: 29, row: 1 },
      { col: 31, row: 1 },
      { col: 33, row: 1 },
    ]);
    expect(CATALOG_DETONATING_MINE_INDICES).toEqual([
      150, 151, 152, 153, 154, 155, 156, 157, 158, 159,
    ]);
    expect(CATALOG_SURVIVING_MINE_INDICES).toEqual([160, 161, 162, 163, 164]);
  });

  it('are NOT anchors — the whole point of the amendment', () => {
    const anchorKeys = new Set(anchors.map((a) => `${a.col},${a.row}`));
    for (const pad of CATALOG_MINE_PADS) {
      expect(anchorKeys.has(`${pad.col},${pad.row}`)).toBe(false);
    }
  });

  it('every pad is ROUTE-NEUTRAL: the full 165-tower route is byte-identical to the 150-anchor route', () => {
    const anchorsOnly = placements.slice(0, 150);
    expect(routeKey(routeOver(anchorsOnly))).toBe(BASE_KEY);
    expect(routeKey(routeOver(placements))).toBe(BASE_KEY);
  });

  it('every pad is NON-LOAD-BEARING: removing its tower alone leaves the sequence byte-identical', () => {
    for (let i = 150; i < 165; i++) {
      const without = placements.filter((_, j) => j !== i);
      expect(routeKey(routeOver(without)), `removing the pad at index ${i} rerouted the maze`).toBe(
        BASE_KEY,
      );
    }
  });

  it('the post-detonation maze (all ten detonators gone, 155 towers) is byte-identical too', () => {
    const post = placements.filter((_, j) => j < 150 || j >= 160);
    expect(post).toHaveLength(155);
    expect(routeKey(routeOver(post))).toBe(BASE_KEY);
  });

  it('every detonator is within trigger range (2.25 tiles) of a route cell, at the pinned index', () => {
    expect(MINE_TRIGGER_FP).toBe(576);
    expect(MINE_TRIGGER_FP / FP_ONE).toBeCloseTo(2.25);
    const measured = detonators.map((p) => firstInRangeIndex(p));
    expect(measured).toEqual([...CATALOG_DETONATOR_ROUTE_INDICES]);
    expect(measured).toEqual([316, 316, 317, 319, 314, 321, 312, 323, 311, 310]);
  });

  it('every survivor is out of trigger range of EVERY route cell — it can never fire', () => {
    for (const pad of survivors) {
      expect(firstInRangeIndex(pad), `survivor pad (${pad.col},${pad.row}) is in range`).toBe(
        Number.POSITIVE_INFINITY,
      );
    }
  });

  it('the committed detonator lower bounds are the CONTINUOUS-PATH arithmetic, re-derived', () => {
    const derived = catalogDetonatorLowerBoundTicks(compiled);
    expect(derived).toEqual([...CATALOG_DETONATOR_LOWER_BOUND_TICKS]);
    expect([...derived].sort((a, b) => a - b)).toEqual([
      3553, 3564, 3575, 3597, 3618, 3618, 3635, 3657, 3682, 3714,
    ]);
  });

  it('a CELL-CENTRE bound would be wrong — strictly later than the continuous-path one', () => {
    // Pinned as a test because the first draft of the committed table made exactly this
    // mistake and a real run beat it by 2–4 ticks. A creep's position is a point moving
    // ALONG the segments between cell centres, so it enters the trigger circle before the
    // first cell centre inside it; a centre-only bound therefore over-claims.
    const centreBound = CATALOG_DETONATOR_ROUTE_INDICES.map((k) => 100 + Math.floor(cum[k]! / 23));
    const trueBound = catalogDetonatorLowerBoundTicks(compiled);
    for (let i = 0; i < trueBound.length; i++) {
      expect(centreBound[i]!).toBeGreaterThanOrEqual(trueBound[i]!);
    }
    expect(centreBound.some((v, i) => v > trueBound[i]!)).toBe(true);
  });

  it('the window/detonation margin is THIN, and the packet’s claim is observational', () => {
    // The strict lower bound puts the earliest possible detonation at 3,553 — two ticks
    // BEFORE the window's last tick. So "no detonation inside the window" cannot be proven
    // from this arithmetic and is asserted observationally by the oracle instead (observed
    // earliest: 3,559). This test exists so that gap is a recorded fact rather than an
    // assumption a later reader inherits.
    expect(CATALOG_SAMPLE_START_TICK).toBe(1_055);
    expect(CATALOG_SAMPLE_END_TICK).toBe(3_554);
    const earliest = Math.min(...CATALOG_DETONATOR_LOWER_BOUND_TICKS);
    expect(earliest).toBe(3_553);
    expect(earliest).toBeLessThan(CATALOG_SAMPLE_END_TICK);
  });
});

describe('the impossibilities that forced the amendment (pinned, not re-argued)', () => {
  it('ESCALATED #1: NOT ONE of the 150 anchors is out of trigger range of EVERY route cell', () => {
    // The packet's original criterion for a surviving mine selects the EMPTY SET on this
    // geometry. Resolution applied: the mines left the anchor set for their own pads,
    // where 300 route-neutral never-in-range positions exist.
    const outOfRangeOfAll = anchors.filter(
      (a) => firstInRangeIndex(a) === Number.POSITIVE_INFINITY,
    );
    expect(outOfRangeOfAll).toEqual([]);
  });

  it('ESCALATED #2: NOT ONE of the 150 anchors is non-load-bearing for the maze', () => {
    // Removing ANY single anchor changes the route's cell sequence — the stress maze is
    // eight single-gap bands plus six greedy tail baffles, so every anchor is structural
    // by construction. Resolution applied: mines stand on pads whose removal provably
    // does not reroute (asserted above).
    const anchorsOnly = placements.slice(0, 150);
    const nonLoadBearing = anchorsOnly.filter(
      (_, i) => routeKey(routeOver(anchorsOnly.filter((__, j) => j !== i))) === BASE_KEY,
    );
    expect(nonLoadBearing).toEqual([]);
  });

  it('ESCALATED #3: no route-neutral pad exists anywhere near the EARLY route', () => {
    // Why detonation cannot happen during warm-up at ANY route-index cutoff. Route cells
    // 1–28 run up the one-cell-wide col-1 corridor, east along row 2, then down col 4; a
    // 2×2 pad within trigger range of them has nowhere to stand but inside a one-wide
    // corridor, and occupying one reroutes. Resolution applied: detonation moved to the
    // post-window leak-probe extension.
    const anchorsOnly = placements.slice(0, 150);
    const occupied = new Set<string>();
    for (const p of anchorsOnly) {
      for (const [dc, dr] of FOOTPRINT_DELTAS) {
        occupied.add(`${p.anchor.col + dc},${p.anchor.row + dr}`);
      }
    }
    let legal = 0;
    let neutral = 0;
    let earliestNeutralIndex = Number.POSITIVE_INFINITY;
    let inRangeOfEarlyAndNeutral = 0;
    for (let row = 1; row <= 37; row++) {
      for (let col = 1; col <= 37; col++) {
        let free = true;
        for (const [dc, dr] of FOOTPRINT_DELTAS) {
          if (occupied.has(`${col + dc},${row + dr}`)) free = false;
        }
        if (!free) continue;
        legal++;
        const isNeutral =
          routeKey(routeOver([...anchorsOnly, { anchor: { col, row }, towerId: 'mine' }])) ===
          BASE_KEY;
        if (!isNeutral) continue;
        neutral++;
        const first = firstInRangeIndex({ col, row });
        if (first >= 1 && first < earliestNeutralIndex) earliestNeutralIndex = first;
        if (first >= 1 && first <= 28) inRangeOfEarlyAndNeutral++;
      }
    }
    expect(legal).toBe(460);
    expect(neutral).toBe(359);
    // The headline fact: zero route-neutral pads reach the early route…
    expect(inRangeOfEarlyAndNeutral).toBe(0);
    // …and the earliest any route-neutral pad reaches the route AT ALL is index 290, so
    // widening the packet's "cells 1–28" cutoff to any smaller index buys nothing.
    expect(earliestNeutralIndex).toBe(290);
  });
});

describe('the catalog bundle’s compile-time gate arithmetic', () => {
  it('pins latestSpawnTick + maxTraversalTicks = 35,773 <= 36,000 at the ¾ slow floor', () => {
    const wave = compiled.waves[0]!;
    const spawns = wave.spawns;
    const latestSpawnTick = wave.countdownTicks + spawns[spawns.length - 1]!.offsetTicks;
    expect(spawns).toHaveLength(812);
    expect(latestSpawnTick).toBe(3_595);

    expect(compiled.balance.slowFloorNum).toBe(3);
    expect(compiled.balance.slowFloorDen).toBe(4);
    const minEffSpeedFp = Math.ceil((23 * 3) / 4);
    expect(minEffSpeedFp).toBe(18);

    const grid: CompiledRuleset['board']['grid'] = compiled.board.grid;
    const cells = grid.width * grid.height;
    expect(cells).toBe(1_600);
    expect(cells * DIAG_LEN).toBe(579_200);
    const maxTraversalTicks = Math.ceil((cells * DIAG_LEN) / minEffSpeedFp);
    expect(maxTraversalTicks).toBe(32_178);
    expect(latestSpawnTick + maxTraversalTicks).toBe(35_773);
    expect(latestSpawnTick + maxTraversalTicks).toBeLessThanOrEqual(36_000);
  });

  it('the shipped ¼ floor would NOT compile — the ¾ floor is what makes this bundle legal', () => {
    const quarterFloorEff = Math.max(Math.floor((23 * 128) / 256), Math.ceil((23 * 1) / 4));
    expect(quarterFloorEff).toBe(11);
    expect(3_595 + Math.ceil(579_200 / quarterFloorEff)).toBeGreaterThan(36_000);
  });

  it('the AoE scan gate clears: MAX_TOWERS (1000) x 812 scheduled spawns = 812,000 <= 2,000,000', () => {
    expect(1_000 * compiled.waves[0]!.spawns.length).toBe(812_000);
    expect(1_000 * compiled.waves[0]!.spawns.length).toBeLessThanOrEqual(2_000_000);
  });

  it('the air stream outlives the window, and no ground creep can leak inside it', () => {
    // Last air spawn: countdown 100 + offset 15 + 145 × 24 — past the window's end, so
    // the stream never dries mid-sample.
    expect(100 + 15 + 145 * 24).toBe(3_595);
    expect(3_595).toBeGreaterThan(CATALOG_SAMPLE_END_TICK);
    // First possible ground leak: 328 traversed steps at ≥ 256 fp each, 23 fp/tick, from
    // the earliest ground spawn at tick 100. Statuses only lengthen it.
    expect(route.length - 1).toBe(328);
    expect(100 + Math.ceil((328 * 256) / 23)).toBe(3_751);
    expect(3_751).toBeGreaterThan(CATALOG_SAMPLE_END_TICK);
  });
});
