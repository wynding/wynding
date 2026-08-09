// registry.test.ts — the bundled ruleset registry. Pins every authored
// value (carrying forward the intent of the deleted `boards.test.ts`, now over the
// registry-loaded artifact) and proves the registry's own contract: happy path,
// caching, unknown-id rejection, deep-frozen results, and — the two-loaders
// invariant (ADR 0007 §2 / PLAN M2-S1 Validation architecture) — artifact fidelity
// between the bundled `?raw` text and the on-disk JSON file.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseRulesetJson,
  compileRuleset,
  MAX_RULESET_TEXT_UNITS,
  MAX_MATCH_TICKS,
  rulesetDigest,
  RulesetError,
  DIAG_LEN,
} from '@wynding/sim';
import {
  DEFAULT_RULESET_ID,
  getBundledRuleset,
  bundledRulesetIds,
  defaultBoardId,
} from './registry';
import { BUNDLED_ARTIFACT_URL } from './artifact';
// The registry module holds its bundled `?raw` text in a private map; import the
// same specifier here so the fidelity test below compares the literal string the
// registry embeds (not just its parsed/validated shape) to the on-disk bytes.
import rawWyndingCore from './rulesets/wynding-core.json?raw';

describe('getBundledRuleset (happy path + authored values)', () => {
  const ruleset = getBundledRuleset();
  const board = ruleset.boards[0]!;

  it('defaults to DEFAULT_RULESET_ID = wynding-core, version 1', () => {
    expect(DEFAULT_RULESET_ID).toBe('wynding-core');
    expect(ruleset.formatVersion).toBe(2);
    expect(ruleset.rulesetId).toBe('wynding-core');
    expect(ruleset.version).toBe(1);
  });

  it('is also reachable by explicit id', () => {
    expect(getBundledRuleset('wynding-core')).toBe(ruleset);
  });

  it('carries the creep catalog: `normal`, the S3 `fast` creep, the S4a `swarm` creep, the S5a `armored` creep, the S6 `resolute` creep, the S7 `flying` creep, and the S10 `armored-flyer` and `boss` creeps', () => {
    expect(ruleset.creepCatalog).toEqual([
      {
        id: 'normal',
        hp: 20,
        speedFp: 26,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 1,
      },
      {
        id: 'fast',
        hp: 16,
        speedFp: 44,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 2,
      },
      {
        id: 'swarm',
        hp: 7,
        speedFp: 30,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 1,
      },
      {
        id: 'armored',
        hp: 36,
        speedFp: 22,
        armor: 6,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 3,
      },
      {
        id: 'resolute',
        hp: 20,
        speedFp: 44,
        armor: 0,
        domain: 'ground',
        immunities: ['slow'],
        leakCost: 1,
        bounty: 2,
      },
      {
        id: 'flying',
        hp: 18,
        speedFp: 30,
        armor: 0,
        domain: 'air',
        immunities: [],
        leakCost: 1,
        bounty: 2,
      },
      {
        id: 'armored-flyer',
        hp: 30,
        speedFp: 26,
        armor: 5,
        domain: 'air',
        immunities: [],
        leakCost: 1,
        bounty: 3,
      },
      {
        id: 'boss',
        hp: 400,
        speedFp: 18,
        armor: 8,
        domain: 'ground',
        immunities: ['stun'],
        role: 'boss',
        leakCost: 3,
        bounty: 25,
      },
    ]);
  });

  it('carries the tower catalog: `basic`, the S3 `slow` tower (S7: attack domain widens ground → both), the S4a `splash` tower, the S5a `venom` tower, the S6 `stun` tower, the S7 `antiair` tower, the S8 `beacon` (attackless — a support bundle carries no `attack` key at all), the S9 `mine` (a burst bundle: its `attack` carries a trigger range, not a firing cadence — it never fires twice), and the S10 `frost-splash` tower', () => {
    expect(ruleset.towerCatalog).toEqual([
      {
        id: 'basic',
        cost: 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      },
      {
        id: 'slow',
        cost: 8,
        attack: { domain: 'both', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 2 },
          { kind: 'slow', mulFp: 128, durationTicks: 40 },
        ],
      },
      {
        id: 'splash',
        cost: 12,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 60, travelTicks: 8 },
        effects: [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 384 }],
      },
      {
        id: 'venom',
        cost: 9,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 2 },
          { kind: 'dot', damagePerTick: 4, cadenceTicks: 10, durationTicks: 60 },
        ],
      },
      {
        id: 'stun',
        cost: 10,
        attack: { domain: 'ground', rangeFp: 768, cadenceTicks: 40, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 4 },
          { kind: 'stun', chanceNum: 64, durationTicks: 20 },
        ],
      },
      {
        id: 'antiair',
        cost: 7,
        attack: { domain: 'air', rangeFp: 1280, cadenceTicks: 20, travelTicks: 2 },
        effects: [{ kind: 'direct', form: 'single', damage: 8 }],
      },
      {
        id: 'beacon',
        cost: 15,
        effects: [{ kind: 'support', damageMulFp: 384 }],
      },
      {
        id: 'mine',
        cost: 6,
        attack: { domain: 'ground', rangeFp: 576, travelTicks: 1 },
        effects: [{ kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 }],
      },
      {
        id: 'frost-splash',
        cost: 16,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 60, travelTicks: 8 },
        effects: [
          { kind: 'direct', form: 'aoe', damage: 6, radiusFp: 384 },
          { kind: 'slow', mulFp: 179, durationTicks: 30 },
        ],
      },
    ]);
  });

  it('carries the starting economy, refund/slow-floor fractions and early-call bounty divisor', () => {
    expect(ruleset.balance).toEqual({
      startingLives: 10,
      startingBounty: 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 50,
    });
  });

  it('carries the scoring weights and early-call score divisor', () => {
    expect(ruleset.scoring).toEqual({
      survivalMul: 35,
      starThresholds: [1, 6, 9],
      earlyCallScoreDivisor: 50,
    });
  });

  it('carries the board geometry: field-01, a 28×24 grid', () => {
    expect(board.id).toBe('field-01');
    expect(defaultBoardId(ruleset)).toBe('field-01');
    expect(board.widthTiles).toBe(28);
    expect(board.heightTiles).toBe(24);
    expect(board.entrance).toEqual({ col: 0, row: 11 });
    expect(board.exit).toEqual({ col: 27, row: 11 });
  });

  it("carries the eight waves: 10 × normal @ spacing 20, then 16 × swarm @ spacing 5 (the S4a AoE showcase), then 8 × fast @ spacing 15 (the S3 slow-showcase), then 6 × armored @ spacing 25 (the S5a armor showcase), then wave index 4's 6 × resolute + 6 × fast @ spacing 15/15 (the S6 immunity showcase), then wave index 5's 8 × flying @ spacing 15 (the S7 air showcase), then wave index 6's 6 × armored-flyer @ spacing 20 (the S10 armored-air showcase), then wave index 7's 1 × boss + 8 × normal @ spacing 20/20 (the S10 boss finale)", () => {
    const normalEntries = [{ creepId: 'normal', count: 10, spacingTicks: 20, offsetTicks: 0 }];
    const swarmEntries = [{ creepId: 'swarm', count: 16, spacingTicks: 5, offsetTicks: 0 }];
    const fastEntries = [{ creepId: 'fast', count: 8, spacingTicks: 15, offsetTicks: 0 }];
    const armoredEntries = [{ creepId: 'armored', count: 6, spacingTicks: 25, offsetTicks: 0 }];
    const resoluteFastEntries = [
      { creepId: 'resolute', count: 6, spacingTicks: 15, offsetTicks: 0 },
      { creepId: 'fast', count: 6, spacingTicks: 15, offsetTicks: 0 },
    ];
    const flyingEntries = [{ creepId: 'flying', count: 8, spacingTicks: 15, offsetTicks: 0 }];
    const armoredFlyerEntries = [
      { creepId: 'armored-flyer', count: 6, spacingTicks: 20, offsetTicks: 0 },
    ];
    const bossEntries = [
      { creepId: 'boss', count: 1, spacingTicks: 20, offsetTicks: 0 },
      { creepId: 'normal', count: 8, spacingTicks: 20, offsetTicks: 0 },
    ];
    expect(board.waves).toEqual([
      { index: 0, countdownTicks: 500, clearBonus: 4, entries: normalEntries },
      { index: 1, countdownTicks: 300, clearBonus: 4, entries: swarmEntries },
      { index: 2, countdownTicks: 300, clearBonus: 5, entries: fastEntries },
      { index: 3, countdownTicks: 300, clearBonus: 5, entries: armoredEntries },
      { index: 4, countdownTicks: 300, clearBonus: 7, entries: resoluteFastEntries },
      { index: 5, countdownTicks: 300, clearBonus: 6, entries: flyingEntries },
      { index: 6, countdownTicks: 300, clearBonus: 7, entries: armoredFlyerEntries },
      { index: 7, countdownTicks: 400, clearBonus: 12, entries: bossEntries },
    ]);
  });

  it('is the only bundled ruleset', () => {
    expect(bundledRulesetIds()).toEqual(['wynding-core']);
  });
});

describe('getBundledRuleset (caching + freezing)', () => {
  it('caches: repeated calls for the same id return the SAME frozen instance', () => {
    const first = getBundledRuleset('wynding-core');
    const second = getBundledRuleset('wynding-core');
    expect(second).toBe(first);
    const byDefault = getBundledRuleset();
    expect(byDefault).toBe(first);
  });

  it('throws RulesetError for an unknown ruleset id', () => {
    expect(() => getBundledRuleset('no-such-ruleset')).toThrow(RulesetError);
  });

  it('returns a deep-frozen result', () => {
    const ruleset = getBundledRuleset();
    expect(Object.isFrozen(ruleset)).toBe(true);
    expect(Object.isFrozen(ruleset.creepCatalog)).toBe(true);
    expect(Object.isFrozen(ruleset.creepCatalog[0])).toBe(true);
    expect(Object.isFrozen(ruleset.towerCatalog[0])).toBe(true);
    expect(Object.isFrozen(ruleset.balance)).toBe(true);
    expect(Object.isFrozen(ruleset.scoring)).toBe(true);
    expect(Object.isFrozen(ruleset.boards[0])).toBe(true);
    expect(Object.isFrozen(ruleset.boards[0]!.waves[0])).toBe(true);
  });
});

describe('artifact fidelity (the two-loaders invariant, ADR 0007 §2)', () => {
  it('the on-disk text is string-identical to the registry-bundled text', () => {
    const diskText = readFileSync(BUNDLED_ARTIFACT_URL, 'utf8');
    expect(diskText).toBe(rawWyndingCore);
    expect(diskText.length).toBeLessThanOrEqual(MAX_RULESET_TEXT_UNITS);
    // Both loaders run the SAME text through the SAME parseRulesetJson, so their
    // normalized output — and thus their digest — must agree exactly.
    const registryRuleset = getBundledRuleset();
    const diskRuleset = parseRulesetJson(diskText);
    expect(diskRuleset).toEqual(registryRuleset);
    expect(rulesetDigest(diskRuleset)).toBe(rulesetDigest(registryRuleset));
  });
});

describe('the compile-bound arithmetic, pinned as named numbers (M2-S5a P5, mirrors stress.test.ts)', () => {
  // Same idiom as stress.test.ts's own compile-bound pin: read the knobs off the
  // parsed bundle rather than hand-typing them, so a bundle edit changes what this
  // test computes, not just what it happens to match. This bundle now carries EIGHT
  // waves (the S5a `armored` wave at index 3, the S6 `resolute`+`fast` wave at index
  // 4, the S7 `flying` wave at index 5, the S10 `armored-flyer` wave at index 6 and
  // the S10 `boss`+`normal` wave at index 7), so the prefix-sum form is load-bearing
  // here in a way stress.test.ts's single-wave bundle doesn't exercise.
  const text = readFileSync(BUNDLED_ARTIFACT_URL, 'utf8');
  const bundle = parseRulesetJson(text);
  const board = bundle.boards.find((b) => b.id === 'field-01');
  if (board === undefined) throw new Error("no board 'field-01' in the shipped bundle");
  const slowTower = bundle.towerCatalog.find((t) => t.id === 'slow');
  if (slowTower === undefined) throw new Error("no tower 'slow' in the shipped bundle");
  const slowEffect = slowTower.effects.find((e) => e.kind === 'slow');
  if (slowEffect === undefined) throw new Error("'slow' has no slow effect");
  const mulFp = slowEffect.mulFp;
  const slowFloorNum = bundle.balance.slowFloorNum;
  const slowFloorDen = bundle.balance.slowFloorDen;

  // `effectiveSpeedFp` (ruleset-shared.ts): max(1, floor(speedFp*mulFp/256),
  // ceil(speedFp*slowFloorNum/slowFloorDen)) — the minimum over every creep id ANY
  // wave spawns, exactly as `ruleset.ts`'s own bound gate computes it.
  const minEffSpeedFp = Math.min(
    ...bundle.creepCatalog.map((c) =>
      Math.max(
        1,
        Math.floor((c.speedFp * mulFp) / 256),
        Math.ceil((c.speedFp * slowFloorNum) / slowFloorDen),
      ),
    ),
  );

  it('minEffSpeedFp = 9 (the S10 `boss` creep, 18 under `slow`: max(1, floor(18*128/256), ceil(18*1/4)) = max(1, 9, 5) = 9)', () => {
    console.log('registry.test.ts: minEffSpeedFp =', minEffSpeedFp);
    expect(minEffSpeedFp).toBe(9);
  });

  const cells = board.widthTiles * board.heightTiles;
  const traversal = Math.ceil((cells * DIAG_LEN) / minEffSpeedFp);

  it('board is 28x24 (672 cells); traversal = ceil(672*362/9) = 27030', () => {
    console.log('registry.test.ts: cells =', cells, 'traversal =', traversal);
    expect(board.widthTiles).toBe(28);
    expect(board.heightTiles).toBe(24);
    expect(cells).toBe(672);
    expect(traversal).toBe(27_030);
  });

  // latestSpawnTick, mirroring `ruleset.ts`'s own prefix-sum definition: wave k
  // launches at the prefix sum of countdowns 1..k, so its last spawn lands at
  // `prefix_k + tail_k`, and the run's latest spawn is the MAX of that over k.
  const waves = board.waves;
  const tailOf = (w: (typeof waves)[number]): number =>
    w.entries.reduce(
      (max, e) => Math.max(max, (e.offsetTicks ?? 0) + (e.count - 1) * e.spacingTicks),
      0,
    );
  let prefixCountdown = 0;
  let latestSpawnTick = 0;
  for (const w of waves) {
    prefixCountdown += w.countdownTicks;
    latestSpawnTick = Math.max(latestSpawnTick, prefixCountdown + tailOf(w));
  }

  // Re-pinned M2-S10 P3: the bundle gains an EIGHTH wave (index 7, 1x `boss` +
  // 8x `normal`, both spacing 20). Its prefix countdown is 2700
  // (500+300+300+300+300+300+300+400 minus the wave's own countdown, i.e. the sum of
  // waves 0..6 = 2300... — computed here, not re-typed) and its tail is
  // (8-1)*20 = 140 on the `normal` entry (the `boss` entry's tail is 0 at count 1), so
  // its launch-tick spawn lands at prefix 2700 + tail 140 = 2840 — the new max.
  it('latestSpawnTick = 2840 (wave index 7 launches at prefix 2700, tail 140 on its 8x20 `normal` entries)', () => {
    console.log(
      'registry.test.ts: waves.length =',
      waves.length,
      'latestSpawnTick =',
      latestSpawnTick,
    );
    expect(waves).toHaveLength(8);
    expect(latestSpawnTick).toBe(2_840);
  });

  it('total bound = latestSpawnTick + traversal = 29870, comfortably under MAX_MATCH_TICKS (36000)', () => {
    // Derived from the same bundle-read terms the tests above pin, not re-typed as
    // `2840 + 27030` — the same reason stress.test.ts's own pin does this.
    const total = latestSpawnTick + traversal;
    console.log('registry.test.ts: total bound =', total, 'MAX_MATCH_TICKS =', MAX_MATCH_TICKS);
    expect(total).toBe(29_870);
    expect(MAX_MATCH_TICKS).toBe(36_000);
    expect(total).toBeLessThan(MAX_MATCH_TICKS);
  });

  // The bundle must actually compile under this bound — a passing arithmetic pin
  // above proves nothing if the compiler disagrees; this ties the two together.
  it('compiles cleanly given the bound holds', () => {
    expect(() => compileRuleset(bundle, 'field-01')).not.toThrow();
  });
});

describe('the win-over-loss score ordering invariant (m2.md:272-277, pinned for the S10 eight-wave bundle)', () => {
  // `deriveScore` (index.ts): running/won = cumulativeKillBounty + cumulativeEarlyCallCredit
  // (+ max(0,lives) × survivalMul when won); lost = cumulativeKillBounty only, early-call
  // credit forfeited. A leaked creep earns no kill bounty. Derived entirely from the
  // bundle's own bounty/leakCost/lives/survivalMul terms — never typed as 141/143 — so a
  // catalog or wave edit changes what this test computes, not just what it happens to match.
  const text = readFileSync(BUNDLED_ARTIFACT_URL, 'utf8');
  const bundle = parseRulesetJson(text);
  const board = bundle.boards.find((b) => b.id === 'field-01');
  if (board === undefined) throw new Error("no board 'field-01' in the shipped bundle");
  const creepById = new Map(bundle.creepCatalog.map((c) => [c.id, c]));
  const startingLives = bundle.balance.startingLives;
  const survivalMul = bundle.scoring.survivalMul;

  // Total kill bounty available: every creep any wave spawns, summed count × bounty.
  let totalBounty = 0;
  for (const wave of board.waves) {
    for (const entry of wave.entries) {
      const creep = creepById.get(entry.creepId);
      if (creep === undefined) throw new Error(`unknown creepId ${entry.creepId} in a wave`);
      totalBounty += entry.count * creep.bounty;
    }
  }

  // Best loss: reach 0 lives while forfeiting the LEAST bounty possible. Every
  // leakCost-1 creep costs exactly 1 life to leak, so the cheapest way to spend
  // `startingLives` lives is to leak `startingLives` copies of whichever leakCost-1
  // creep has the lowest bounty.
  const leakCost1Creeps = bundle.creepCatalog.filter((c) => c.leakCost === 1);
  const cheapestBounty = Math.min(...leakCost1Creeps.map((c) => c.bounty));
  const bestLossLeaked = startingLives * cheapestBounty;
  const bestLossScore = totalBounty - bestLossLeaked;

  // Worst win: forfeit the MOST bounty possible while keeping lives at 1 (the least a
  // win can hold). Leak the highest-leakCost creep (the boss) first — it buys the most
  // bounty per life spent — then spend the remaining life budget on the highest-bounty
  // leakCost-1 creep.
  // Ties in `leakCost` break toward the HIGHER bounty, not first-wins: first-wins
  // would understate `worstWinLeaked` (and so overstate `worstWinScore`) the day a
  // second leakCost-3 creep lands with a higher bounty than `boss` — the opposite of
  // the `remainingLifeBudget` clamp below, which is deliberately conservative. This
  // keeps both non-conservative-direction risks closed the same way.
  const priciestCreep = bundle.creepCatalog.reduce((a, b) =>
    b.leakCost > a.leakCost || (b.leakCost === a.leakCost && b.bounty > a.bounty) ? b : a,
  );
  // Clamped at 0 (ship-review P3): this greedy assumes the priciest creep fits inside the
  // life budget, which holds for the shipped bundle (boss 3 vs 10 starting lives) but goes
  // NEGATIVE — silently inflating `worstWinLeaked` — the day a creep's `leakCost` reaches
  // `startingLives`. The clamp keeps the invariant conservative rather than nonsensical if
  // that ever happens; the assertion below still measures the real bundle.
  const remainingLifeBudget = Math.max(0, startingLives - 1 - priciestCreep.leakCost);
  const richestLeakCost1Bounty = Math.max(...leakCost1Creeps.map((c) => c.bounty));
  const worstWinLeaked = priciestCreep.bounty + remainingLifeBudget * richestLeakCost1Bounty;
  const worstWinScore = totalBounty - worstWinLeaked + 1 * survivalMul;

  it('best-loss score < worst-win score, derived from the bundle', () => {
    console.log(
      'registry.test.ts: totalBounty =',
      totalBounty,
      'bestLossScore =',
      bestLossScore,
      'worstWinScore =',
      worstWinScore,
    );
    expect(totalBounty).toBe(151);
    expect(bestLossScore).toBe(141);
    expect(worstWinScore).toBe(143);
    expect(bestLossScore).toBeLessThan(worstWinScore);
  });
});
