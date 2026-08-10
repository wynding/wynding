// oracle-catalog.test.ts — the catalog oracle's PURE parts (M2-S11 P7).
//
// `runCatalogScene` itself is excluded from the coverage gate and exercised by running
// `pnpm perf:catalog` (see `vitest.config.ts`'s note). What IS unit-tested here is
// everything a wrong number would silently pass through: the window arithmetic, the
// adversarial damage ceiling recomputed from the real bundle, and `catalogAssertions`'
// fold — including that it FAILS on the shapes it is supposed to fail on, since an
// oracle that cannot report a miss is not an oracle.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseRulesetJson, compileRuleset } from '@wynding/sim';
import { CATALOG_RULESET_URL, CATALOG_BOARD_ID } from '@wynding/content/catalog';
import {
  adversarialDamagePerTickMilli,
  catalogAssertions,
  CATALOG_ATTACKER_COUNTS,
  CATALOG_SAMPLE_START_TICK,
  CATALOG_SAMPLE_END_TICK,
  CATALOG_SAMPLE_TICKS,
  CATALOG_WARMUP_AFTER_BUILD_TICKS,
  GROUND_FAMILY_EXACT,
  GROUND_FAMILY_TOTAL,
  LIVE_AIR_FLOOR,
  LIVE_CREEPS_FLOOR,
  LIVE_TOWERS_EXACT,
  type CatalogSample,
  type CatalogSceneResult,
} from './oracle-catalog';
import { CATALOG_BUILD_TICKS } from './scenario';
import { CATALOG_DETONATOR_LOWER_BOUND_TICKS, CATALOG_TOWER_COUNT } from './layout';

const compiled = compileRuleset(
  parseRulesetJson(readFileSync(CATALOG_RULESET_URL, 'utf8')),
  CATALOG_BOARD_ID,
);

describe('the catalog scene’s window arithmetic', () => {
  it('opens at 1055 and closes at 3554 — 2,500 samples, a CLOSED range by the harness convention', () => {
    // The named constant is held at 1,000 and the ABSOLUTE window is DERIVED from it. The
    // packet pinned both 1,000 and [1050, 3549], which were consistent only while the
    // scene built 150 towers in 50 ticks; the amendment's 165 placements make the build 55
    // ticks, so the two can no longer both hold and the named constant wins (its stated
    // semantics are "relative to the end of the build").
    expect(CATALOG_WARMUP_AFTER_BUILD_TICKS).toBe(1_000);
    expect(CATALOG_BUILD_TICKS).toBe(55);
    expect(CATALOG_SAMPLE_START_TICK).toBe(1_055);
    expect(CATALOG_SAMPLE_TICKS).toBe(2_500);
    expect(CATALOG_SAMPLE_END_TICK).toBe(3_554);
    // A CLOSED [1055, 3555] would be 2,501 ticks and contradict the convention.
    expect(CATALOG_SAMPLE_END_TICK - CATALOG_SAMPLE_START_TICK + 1).toBe(CATALOG_SAMPLE_TICKS);
  });

  it('the ground-family equalities sum to 228 and the total floor is 228 + 72', () => {
    expect(GROUND_FAMILY_EXACT).toEqual({ 'cat-ground': 114, 'cat-immune': 76, 'cat-heavy': 38 });
    expect(Object.values(GROUND_FAMILY_EXACT).reduce((a, b) => a + b, 0)).toBe(GROUND_FAMILY_TOTAL);
    expect(GROUND_FAMILY_TOTAL + LIVE_AIR_FLOOR).toBe(LIVE_CREEPS_FLOOR);
  });
});

describe('the adversarial damage ceiling (the “no combat deaths” proof)', () => {
  it('recomputes 50.0 hp/tick from the REAL bundle at the AMENDED 135-attacker counts', () => {
    // Re-derived because the amendment changed the distribution: the packet's original
    // 120 attackers (20/20/20/20/15/15/10) gave 42.75 hp/tick; moving the mines onto pads
    // freed 15 anchors, so the seven kinds now stand 20/20/19/19/19/19/19 = 135 and the
    // ceiling RISES. Re-measured again when the catalog bundle picked up the shipped
    // catalog's S11 balance pass (antiair cadenceTicks 20 → 15, the arc's wave-8 lever —
    // this bundle mirrors the shipped defs by test, so the ceiling follows the tuning).
    // Term by term, each ×1.5 for a beacon buff:
    //   basic    20 × 10 / 30 × 1.5 = 10.00
    //   slow     20 ×  2 / 30 × 1.5 =  2.00
    //   splash   19 ×  8 / 60 × 1.5 =  3.80
    //   venom    19 ×  2 / 30 × 1.5 =  1.90  direct
    //            19 ×  4 / 10 × 1.5 = 11.40  DoT
    //   stun     19 ×  4 / 40 × 1.5 =  2.85
    //   antiair  19 ×  8 / 15 × 1.5 = 15.20
    //   frost    19 ×  6 / 60 × 1.5 =  2.85
    //                        total  = 50.00 hp/tick
    const milli = adversarialDamagePerTickMilli(compiled, CATALOG_ATTACKER_COUNTS);
    expect(milli).toBe(50_000);
    expect(Object.values(CATALOG_ATTACKER_COUNTS).reduce((a, b) => a + b, 0)).toBe(135);
  });

  it('clears the 1,000,000 hp floor with a 3.3x margin across the whole 6,000-tick probe pass', () => {
    const milli = adversarialDamagePerTickMilli(compiled, CATALOG_ATTACKER_COUNTS);
    const mines = Math.ceil((15 * 45 * 384) / 256); // all fifteen mines, beacon-buffed
    expect(mines).toBe(1_013);
    // 6,001 — the probe loop is inclusive of tick 6,000, and the ceiling bounds the
    // WHOLE pass (re-pinned when the off-by-one was fixed at S11 close-out).
    const total = Math.ceil((milli * 6_001) / 1_000) + mines;
    expect(total).toBe(301_063);
    // The margin, stated as a number rather than as "nearly 4x": 1e6 / 301,063 = 3.32.
    expect(total * 3).toBeLessThan(compiled.creepById['cat-ground']!.hp);
    expect(compiled.creepById['cat-ground']!.hp / total).toBeGreaterThan(3.3);
  });

  it('throws on an unknown tower id rather than silently scoring it as zero', () => {
    expect(() => adversarialDamagePerTickMilli(compiled, { 'no-such-tower': 1 })).toThrow();
  });
});

// ── catalogAssertions, over synthetic scene results ───────────────────────────

function sample(over: Partial<CatalogSample> = {}): CatalogSample {
  return {
    tick: CATALOG_SAMPLE_START_TICK,
    phase: 'running',
    liveCreeps: 400,
    byKind: { 'cat-ground': 114, 'cat-immune': 76, 'cat-heavy': 38, 'cat-air': 172 },
    slowedCreeps: 60,
    stunnedCreeps: 3,
    dotRecords: 25,
    liveTowers: LIVE_TOWERS_EXACT,
    immuneColumnsClean: true,
    ...over,
  };
}

const ROUTE = Array.from({ length: 329 }, (_, i) => ({ col: i % 40, row: (i * 7) % 40 }));

function result(over: Partial<CatalogSceneResult> = {}): CatalogSceneResult {
  return {
    compiled,
    samples: Array.from({ length: CATALOG_SAMPLE_TICKS }, (_, i) =>
      sample({ tick: CATALOG_SAMPLE_START_TICK + i }),
    ),
    towersAfterBuild: CATALOG_TOWER_COUNT,
    leftoverBountyAfterBuild: 0,
    towersAtWindowStart: LIVE_TOWERS_EXACT,
    minTowersInWindow: LIVE_TOWERS_EXACT,
    detonationTicks: [...CATALOG_DETONATOR_LOWER_BOUND_TICKS]
      .sort((a, b) => a - b)
      .map((t) => t + 5),
    asBuiltRoute: ROUTE,
    postDetonationRoute: ROUTE,
    dotDroppedTotal: 0,
    supportProbeImpacts: 500,
    immunityProbeImpacts: 500,
    airProbeImpacts: 500,
    finalTowers: LIVE_TOWERS_EXACT - 10,
    survivorsAliveAtEnd: 5,
    leak: {
      tick: 4_200,
      leaked: [
        { id: 1, creepId: 'cat-heavy', leakCost: 3 },
        { id: 2, creepId: 'cat-air', leakCost: 1 },
      ],
      livesDelta: 4,
      expectedDelta: 4,
      heavySummand: 3,
      heavyCount: 1,
    },
    adversarialDamageCeiling: 301_063,
    creepHp: 1_000_000,
    firingTowersByKind: {},
    placedTowersByKind: {},
    ...over,
  };
}

describe('catalogAssertions', () => {
  it('passes every row on a scene that meets the packet’s declared shape', () => {
    const rows = catalogAssertions(result());
    const failed = rows.filter((r) => !r.pass);
    expect(failed.map((r) => `${r.name}: ${String(r.measured)} vs ${r.bound}`)).toEqual([]);
    expect(rows.length).toBeGreaterThan(20);
  });

  it('fails the ground-family equality when ONE sampled tick is off by one', () => {
    const samples = Array.from({ length: CATALOG_SAMPLE_TICKS }, (_, i) =>
      sample({ tick: CATALOG_SAMPLE_START_TICK + i }),
    );
    samples[1_234] = sample({
      tick: CATALOG_SAMPLE_START_TICK + 1_234,
      byKind: { 'cat-ground': 113, 'cat-immune': 76, 'cat-heavy': 38, 'cat-air': 172 },
    });
    const rows = catalogAssertions(result({ samples }));
    const row = rows.find((r) => r.name === 'live cat-ground, every sampled tick')!;
    expect(row.pass).toBe(false);
    expect(row.measured).toBe('113..114');
  });

  it('fails route-sequence equality on a REORDERED route of the same length', () => {
    // The point of asserting the SEQUENCE rather than the length: a different 329-cell
    // path has a different diagonal mix, coverage and mine-trigger geometry.
    const shuffled = [...ROUTE.slice(1), ROUTE[0]!];
    const rows = catalogAssertions(result({ postDetonationRoute: shuffled }));
    const row = rows.find((r) => r.name === 'route CELL SEQUENCE, as-built vs post-detonation')!;
    expect(row.pass).toBe(false);
    expect(row.measured).toBe('DIFFERENT');
  });

  it('fails the immunity SoA row when any cat-immune tick carries a status', () => {
    const samples = Array.from({ length: CATALOG_SAMPLE_TICKS }, (_, i) =>
      sample({ tick: CATALOG_SAMPLE_START_TICK + i }),
    );
    samples[7] = sample({ tick: CATALOG_SAMPLE_START_TICK + 7, immuneColumnsClean: false });
    const rows = catalogAssertions(result({ samples }));
    const row = rows.find((r) => r.name === 'immunity probe (cat-immune status columns all zero)')!;
    expect(row.pass).toBe(false);
    expect(row.measured).toBe('1 dirty ticks');
  });

  it('fails when the leak probe never observed a cat-heavy leak', () => {
    const rows = catalogAssertions(result({ leak: null }));
    const row = rows.find((r) => r.name === 'multi-life leak probe')!;
    expect(row.pass).toBe(false);
  });

  it('fails when the lives delta disagrees with the summed leakCost of the leaked ids', () => {
    const rows = catalogAssertions(
      result({
        leak: {
          tick: 4_200,
          leaked: [{ id: 1, creepId: 'cat-heavy', leakCost: 3 }],
          livesDelta: 1, // the aggregate that a per-creep leakCost of 3 must contradict
          expectedDelta: 3,
          heavySummand: 3,
          heavyCount: 1,
        },
      }),
    );
    const row = rows.find((r) => r.name.startsWith('multi-life leak probe: lives delta'))!;
    expect(row.pass).toBe(false);
    expect(row.measured).toBe('1 vs 3');
  });

  it('fails a non-running sampled tick', () => {
    const samples = Array.from({ length: CATALOG_SAMPLE_TICKS }, (_, i) =>
      sample({ tick: CATALOG_SAMPLE_START_TICK + i }),
    );
    samples[2_499] = sample({ tick: CATALOG_SAMPLE_END_TICK, phase: 'lost' });
    const rows = catalogAssertions(result({ samples }));
    expect(rows.find((r) => r.name === 'phase, every sampled tick')!.pass).toBe(false);
  });
});
