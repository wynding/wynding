// catalog.test.ts — the M2-S11 P7 catalog-scale perf bundle.
//
// Like the stress bundle, this is a CEILING and not a description of real play: 1,000,000
// hp creeps and 1,000,000 starting lives exist so the scene stays alive and populated for
// the sampling window (see `stress.test.ts`'s header for the full argument — `step()`
// freezes on a terminal phase, and a benchmark measuring a frozen sim reports superb
// numbers while proving nothing). Unlike the stress bundle, its TOWER CATALOG is real:
// the nine shipped `wynding-core` towers, verbatim, because the whole point of this scene
// is the browser frame-time cost of the SHIPPED catalog at 150-tower scale.
//
// Two numbers here are load-bearing in a way a reader must not "tidy":
//   - `startingBounty: 1601` is the EXACT cost of the committed 165-placement table
//     (`packages/perf/src/layout.ts`'s `CATALOG_TOWER_ID_AT`). The stress scene's
//     zero-leftover oracle rests on an equal-cost assumption (150 × 12 = 1800) that a
//     real catalog breaks; deriving the bounty from the table instead is what keeps that
//     oracle meaningful here. Change one, change the other.
//   - `slowFloorNum/Den: 3/4` is what makes this bundle COMPILE AT ALL. At the shipped ¼
//     floor, `compileRuleset`'s termination gate rejects it (see the gate test below).

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseRulesetJson,
  compileRuleset,
  RulesetError,
  MAX_MATCH_TICKS,
  MAX_TOWERS,
  DIAG_LEN,
} from '@wynding/sim';
import { bundledRulesetIds, getBundledRuleset } from './registry';
import { CATALOG_BOARD_ID, CATALOG_RULESET_ID, CATALOG_RULESET_URL } from './catalog';

const text = readFileSync(CATALOG_RULESET_URL, 'utf8');

describe('the catalog bundle compiles through the genuine parse/compile path', () => {
  it('parses and compiles via parseRulesetJson + compileRuleset, no bespoke loader', () => {
    const bundle = parseRulesetJson(text);
    expect(bundle.rulesetId).toBe(CATALOG_RULESET_ID);
    const compiled = compileRuleset(bundle, CATALOG_BOARD_ID);
    expect(compiled.boardId).toBe(CATALOG_BOARD_ID);
  });
});

describe('the catalog bundle is absent from the shipped registry', () => {
  // Same guarantee `stress.test.ts` holds for its own bundle: a synthetic 40×40,
  // 1,000,000-hp perf bundle must never reach a client build, and `wynding-core`'s
  // content hash — the one every player plays against — must stay untouched by its
  // presence in this package.
  it('bundledRulesetIds() does not contain catalog-40x40', () => {
    expect(bundledRulesetIds()).not.toContain(CATALOG_RULESET_ID);
  });

  it('getBundledRuleset(catalog-40x40) throws RulesetError', () => {
    expect(() => getBundledRuleset(CATALOG_RULESET_ID)).toThrow(RulesetError);
  });
});

describe('the catalog bundle carries the nine REAL wynding-core towers, verbatim', () => {
  // If this drifted, the scene would measure the frame-time cost of a tower catalog
  // nobody ships — which is precisely what the stress scene already does, and precisely
  // what this scene exists NOT to do. Compared field-for-field against the shipped
  // bundle's own text rather than against restated literals.
  const core = parseRulesetJson(
    readFileSync(new URL('./rulesets/wynding-core.json', import.meta.url), 'utf8'),
  );
  const catalog = parseRulesetJson(text);

  it('has exactly the nine shipped tower ids', () => {
    expect(catalog.towerCatalog.map((t) => t.id)).toEqual([
      'basic',
      'slow',
      'splash',
      'venom',
      'stun',
      'antiair',
      'beacon',
      'mine',
      'frost-splash',
    ]);
  });

  it('each tower def is deep-equal to wynding-core’s own', () => {
    for (const tower of catalog.towerCatalog) {
      const shipped = core.towerCatalog.find((t) => t.id === tower.id);
      expect(shipped, `wynding-core has no tower '${tower.id}'`).toBeDefined();
      expect(tower).toEqual(shipped);
    }
  });

  it('startingBounty is the EXACT cost of the amended 165-placement distribution', () => {
    // The amendment moved the 15 mines off the anchor set onto their own route-neutral
    // pads (see `packages/perf/src/layout.ts`'s `CATALOG_MINE_PADS` for the three measured
    // impossibilities that forced it), so the scene places 165 towers, not 150: 135
    // attackers + 15 beacons on the anchors, 15 mines on pads.
    const cost = (id: string): number => catalog.towerCatalog.find((t) => t.id === id)!.cost;
    const spend =
      20 * cost('basic') +
      20 * cost('slow') +
      19 * cost('splash') +
      19 * cost('venom') +
      19 * cost('stun') +
      19 * cost('antiair') +
      19 * cost('frost-splash') +
      15 * cost('beacon') +
      15 * cost('mine');
    expect(spend).toBe(1601);
    expect(catalog.balance.startingBounty).toBe(spend);
    // …and the distribution really is 165 placements: 135 attackers over the 135
    // non-beacon anchors (135 = 19 × 7 + 2), plus 15 beacons, plus 15 mine pads.
    expect(20 + 20 + 19 + 19 + 19 + 19 + 19).toBe(135);
    expect(135 + 15 + 15).toBe(165);
  });
});

describe('the catalog bundle’s four synthetic creeps', () => {
  const catalog = parseRulesetJson(text);
  const byId = Object.fromEntries(catalog.creepCatalog.map((c) => [c.id, c]));

  it('carries the packet’s four kinds at the packet’s stats', () => {
    expect(catalog.creepCatalog.map((c) => c.id).sort()).toEqual([
      'cat-air',
      'cat-ground',
      'cat-heavy',
      'cat-immune',
    ]);
    for (const c of catalog.creepCatalog) {
      expect(c.hp).toBe(1_000_000);
      expect(c.speedFp).toBe(23);
      expect(c.bounty).toBe(1);
    }
    expect(byId['cat-ground']!.domain).toBe('ground');
    expect(byId['cat-air']!.domain).toBe('air');
    expect(byId['cat-immune']!.domain).toBe('ground');
    expect(byId['cat-heavy']!.domain).toBe('ground');
  });

  it('cat-immune carries armor 0 DELIBERATELY — armor 6 would negate `slow`’s 2 damage', () => {
    // The immunity probe needs impacts whose effects demonstrably REACH the creep; the
    // `slow` tower's direct damage is 2, which armor 6 would fully absorb, leaving the
    // probe unable to distinguish "immune" from "never hit". Armor lives on `cat-heavy`
    // instead — the armored-population row — whose dual immunity also makes its leak tick
    // independent of every status effect.
    expect(byId['cat-immune']!.armor).toBe(0);
    expect(byId['cat-immune']!.immunities).toEqual(['slow', 'stun']);
    const slowTower = catalog.towerCatalog.find((t) => t.id === 'slow')!;
    const direct = slowTower.effects.find((e) => e.kind === 'direct')!;
    expect('damage' in direct ? direct.damage : 0).toBe(2);
    expect(byId['cat-immune']!.armor).toBeLessThan(2);
  });

  it('cat-heavy is the multi-life leak witness: leakCost 3, armor 6, dual immunity', () => {
    expect(byId['cat-heavy']!.leakCost).toBe(3);
    expect(byId['cat-heavy']!.armor).toBe(6);
    expect(byId['cat-heavy']!.immunities).toEqual(['slow', 'stun']);
    // Every other kind leaks for 1, so a `lives` delta of 3 can only be a heavy.
    expect(byId['cat-ground']!.leakCost).toBe(1);
    expect(byId['cat-air']!.leakCost).toBe(1);
    expect(byId['cat-immune']!.leakCost).toBe(1);
  });
});

describe('the catalog bundle’s single wave', () => {
  const catalog = parseRulesetJson(text);
  const wave = catalog.boards[0]!.waves[0]!;

  it('is 16 entries: 6 ground / 4 immune / 2 heavy at spacing 16, 4 air at spacing 24', () => {
    expect(catalog.boards[0]!.waves).toHaveLength(1);
    expect(wave.countdownTicks).toBe(100);
    expect(wave.entries).toHaveLength(16);
    const ground = wave.entries.filter((e) => e.creepId === 'cat-ground');
    const immune = wave.entries.filter((e) => e.creepId === 'cat-immune');
    const heavy = wave.entries.filter((e) => e.creepId === 'cat-heavy');
    const air = wave.entries.filter((e) => e.creepId === 'cat-air');
    expect([ground.length, immune.length, heavy.length, air.length]).toEqual([6, 4, 2, 4]);
    for (const e of [...ground, ...immune, ...heavy]) {
      expect(e.count).toBe(19);
      expect(e.spacingTicks).toBe(16);
    }
    for (const e of air) {
      expect(e.count).toBe(146);
      expect(e.spacingTicks).toBe(24);
    }
    // Offsets 0..15 in the packet's pinned order — the stagger that removes systematic
    // lockstep (ground residues distinct mod 16, air mod 24). Order is load-bearing: it
    // assigns creep ids, which drive every id-based tie-break.
    expect(wave.entries.map((e) => e.offsetTicks)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('totals 812 spawns — 228 ground-family (114/76/38) + 584 air', () => {
    expect(6 * 19).toBe(114);
    expect(4 * 19).toBe(76);
    expect(2 * 19).toBe(38);
    expect(114 + 76 + 38).toBe(228);
    expect(4 * 146).toBe(584);
    const compiled = compileRuleset(catalog, CATALOG_BOARD_ID);
    expect(compiled.waves[0]!.spawns).toHaveLength(812);
    const byKind: Record<string, number> = {};
    for (const s of compiled.waves[0]!.spawns) byKind[s.creepId] = (byKind[s.creepId] ?? 0) + 1;
    expect(byKind).toEqual({
      'cat-ground': 114,
      'cat-immune': 76,
      'cat-heavy': 38,
      'cat-air': 584,
    });
  });

  it('the ground family is done spawning by tick 399; the air stream runs to 3,595', () => {
    // Last ground-family spawn: countdown 100 + offset 11 + 18 × 16.
    expect(100 + 11 + 18 * 16).toBe(399);
    // Last air spawn: countdown 100 + offset 15 + 145 × 24 — PAST the window's end
    // (3,554, the amended [1055, 3554] window), so the stream never dries mid-sample.
    expect(100 + 15 + 145 * 24).toBe(3_595);
    expect(3_595).toBeGreaterThan(3_554);
  });
});

describe('the compile-time gates this bundle sits inside', () => {
  const catalog = parseRulesetJson(text);
  const compiled = compileRuleset(catalog, CATALOG_BOARD_ID);

  it('the ¾ slow floor is what makes it compile: 3,595 + 32,178 = 35,773 <= 36,000', () => {
    expect(catalog.balance.slowFloorNum).toBe(3);
    expect(catalog.balance.slowFloorDen).toBe(4);
    // ⌈23 × ¾⌉ = 18 — every slowable creep's floor speed.
    const minEffSpeedFp = Math.ceil((23 * 3) / 4);
    expect(minEffSpeedFp).toBe(18);
    const cells = compiled.board.grid.width * compiled.board.grid.height;
    expect(cells).toBe(1_600);
    expect(cells * DIAG_LEN).toBe(579_200);
    expect(Math.ceil((cells * DIAG_LEN) / minEffSpeedFp)).toBe(32_178);
    expect(3_595 + 32_178).toBe(35_773);
    expect(35_773).toBeLessThanOrEqual(MAX_MATCH_TICKS);
    expect(MAX_MATCH_TICKS).toBe(36_000);
    // Margin, stated so a schedule edit that eats it is visible: 227 ticks.
    expect(MAX_MATCH_TICKS - 35_773).toBe(227);
  });

  it('at the shipped ¼ floor the SAME schedule is REJECTED — the gate is real, not decorative', () => {
    // `slow`'s mulFp is 128, so ⌊23 × 128/256⌋ = 11 at a ¼ floor, and the bound blows
    // past 36,000. Proven by actually compiling the edited bundle, not by arithmetic
    // alone: this is the test that fails at author time if a future edit reverts the
    // floor.
    const quarterFloor = {
      ...catalog,
      balance: { ...catalog.balance, slowFloorNum: 1, slowFloorDen: 4 },
    };
    expect(() => compileRuleset(quarterFloor, CATALOG_BOARD_ID)).toThrow(RulesetError);
    expect(Math.max(Math.floor((23 * 128) / 256), Math.ceil((23 * 1) / 4))).toBe(11);
    expect(3_595 + Math.ceil(579_200 / 11)).toBeGreaterThan(MAX_MATCH_TICKS);
  });

  it('the AoE scan gate clears: MAX_TOWERS x 812 scheduled spawns = 812,000 <= 2,000,000', () => {
    expect(MAX_TOWERS).toBe(1_000);
    expect(MAX_TOWERS * 812).toBe(812_000);
    expect(MAX_TOWERS * 812).toBeLessThanOrEqual(2_000_000);
  });
});
