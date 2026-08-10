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
        // Re-pinned M2-S11 P4: `cadenceTicks` 20 → 15. The wave-8 wall (arc row 8, 6 ×
        // `armored-flyer`: air, armor 5, so `antiair`'s 8 nets 3 a hit and nothing else in
        // the catalog touches air for more than 2) could not be cleared at cadence 20
        // without making `antiair` the dominant spend of every surviving build — the "you
        // must have built antiair" gate the plan flags for escalation. 15 clears it while
        // leaving the PER-HIT arithmetic (damage 8, minus armor) untouched, so every
        // domain-gating and net-damage proof elsewhere keeps its claim unchanged.
        attack: { domain: 'air', rangeFp: 1280, cadenceTicks: 15, travelTicks: 2 },
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
    // Re-pinned M2-S11 P4: `survivalMul` 35 → 50 — ruling 8's designated lever for the
    // win-over-loss margin, set from the bounded-knapsack extremes at the foot of this
    // file (worst win 218 vs best loss 201, margin 17 ≥ the pre-committed 15).
    expect(ruleset.scoring).toEqual({
      survivalMul: 50,
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

  // Re-pinned M2-S11 P3 (measured): P1 authors the full ten-wave arc per m2.md's spec
  // table, inserting arc row 5 (12x`normal`+6x`swarm`) at index 4 and arc row 9
  // (10x`swarm`+6x`fast`+4x`armored`+4x`flying`) at index 8, and renumbering every wave
  // — `resolute`+`fast` moves from index 4 to index 6, `armored-flyer` from index 6 to
  // index 7, and the boss finale from index 7 to index 9.
  it("carries the ten waves: 10 × normal @ spacing 20, then 16 × swarm @ spacing 5 (the S4a AoE showcase), then 8 × fast @ spacing 15 (the S3 slow-showcase), then 6 × armored @ spacing 25 (the S5a armor showcase), then wave index 4's 12 × normal + 6 × swarm @ spacing 12/5 (arc row 5), then wave index 5's 8 × flying @ spacing 15 (the S7 air showcase), then wave index 6's 6 × resolute + 6 × fast @ spacing 15/15 (the S6 immunity showcase), then wave index 7's 6 × armored-flyer @ spacing 20 (the S10 armored-air showcase), then wave index 8's 10 × swarm + 6 × fast + 4 × armored + 4 × flying @ spacing 6/12/20/20 (arc row 9), then wave index 9's 1 × boss + 8 × normal @ spacing 20/20 (the S10 boss finale)", () => {
    const normalEntries = [{ creepId: 'normal', count: 10, spacingTicks: 20, offsetTicks: 0 }];
    const swarmEntries = [{ creepId: 'swarm', count: 16, spacingTicks: 5, offsetTicks: 0 }];
    const fastEntries = [{ creepId: 'fast', count: 8, spacingTicks: 15, offsetTicks: 0 }];
    const armoredEntries = [{ creepId: 'armored', count: 6, spacingTicks: 25, offsetTicks: 0 }];
    const normalSwarmEntries = [
      { creepId: 'normal', count: 12, spacingTicks: 12, offsetTicks: 0 },
      { creepId: 'swarm', count: 6, spacingTicks: 5, offsetTicks: 0 },
    ];
    const flyingEntries = [{ creepId: 'flying', count: 8, spacingTicks: 15, offsetTicks: 0 }];
    const resoluteFastEntries = [
      { creepId: 'resolute', count: 6, spacingTicks: 15, offsetTicks: 0 },
      { creepId: 'fast', count: 6, spacingTicks: 15, offsetTicks: 0 },
    ];
    const armoredFlyerEntries = [
      { creepId: 'armored-flyer', count: 6, spacingTicks: 20, offsetTicks: 0 },
    ];
    const swarmFastArmoredFlyingEntries = [
      { creepId: 'swarm', count: 10, spacingTicks: 6, offsetTicks: 0 },
      { creepId: 'fast', count: 6, spacingTicks: 12, offsetTicks: 0 },
      { creepId: 'armored', count: 4, spacingTicks: 20, offsetTicks: 0 },
      { creepId: 'flying', count: 4, spacingTicks: 20, offsetTicks: 0 },
    ];
    const bossEntries = [
      { creepId: 'boss', count: 1, spacingTicks: 20, offsetTicks: 0 },
      // Re-pinned M2-S11 P4: the boss's `normal` escort gains `offsetTicks` 600. At 0 the
      // escort (speed 26) overtook the boss (speed 18) and screened it — every tower
      // preferring the creep nearest the exit — so the finale was fought against the
      // escort while the boss walked through behind it. Composition is untouched (ruling
      // 2): same creep ids, same counts, same order; only the stream's start moves.
      { creepId: 'normal', count: 8, spacingTicks: 20, offsetTicks: 600 },
    ];
    expect(board.waves).toEqual([
      { index: 0, countdownTicks: 500, clearBonus: 4, entries: normalEntries },
      { index: 1, countdownTicks: 300, clearBonus: 4, entries: swarmEntries },
      { index: 2, countdownTicks: 300, clearBonus: 5, entries: fastEntries },
      { index: 3, countdownTicks: 300, clearBonus: 5, entries: armoredEntries },
      { index: 4, countdownTicks: 300, clearBonus: 6, entries: normalSwarmEntries },
      { index: 5, countdownTicks: 300, clearBonus: 6, entries: flyingEntries },
      { index: 6, countdownTicks: 300, clearBonus: 7, entries: resoluteFastEntries },
      { index: 7, countdownTicks: 300, clearBonus: 7, entries: armoredFlyerEntries },
      { index: 8, countdownTicks: 300, clearBonus: 8, entries: swarmFastArmoredFlyingEntries },
      { index: 9, countdownTicks: 400, clearBonus: 12, entries: bossEntries },
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
  // 8x `normal`, both spacing 20). Its prefix countdown is 2700 — the sum of waves
  // 0..7's OWN countdowns, 500+300×6+400, i.e. INCLUDING wave 7's own 400, because
  // `compileRuleset` adds wave k's countdown before computing `prefixCountdown +
  // tails[k]`. (An earlier draft of this comment said "minus the wave's own countdown,
  // i.e. the sum of waves 0..6 = 2300", which contradicts the 2700 in the same
  // sentence — CodeRabbit, PR #92. The assertion was right; the parenthetical was
  // wrong, and this file's comments are the derivation of record.) Its tail is
  // (8-1)*20 = 140 on the `normal` entry (the `boss` entry's tail is 0 at count 1), so
  // its launch-tick spawn lands at prefix 2700 + tail 140 = 2840 — the new max.
  // Re-pinned M2-S11 P3 (measured): P1 grows the arc 8 -> 10 waves (arc rows 5 and 9
  // inserted, every wave renumbered). The boss finale is now wave index 9, whose own
  // prefix countdown is 500+300×8+400 = 3300, tail (8-1)*20 = 140 on its `normal`
  // entries — 3300 + 140 = 3440, the new max.
  // Re-pinned M2-S11 P4 (measured): the boss wave's `normal` escort gains `offsetTicks`
  // 600 (see the wave-schedule pin above for why). An entry's tail is
  // `offsetTicks + (count-1) × spacingTicks` = 600 + 140 = 740, so the boss wave's last
  // spawn lands at prefix 3300 + 740 = 4040 — the new max.
  it('latestSpawnTick = 4040 (wave index 9 launches at prefix 3300; its 8x20 `normal` entry now starts 600 ticks in, tail 740)', () => {
    console.log(
      'registry.test.ts: waves.length =',
      waves.length,
      'latestSpawnTick =',
      latestSpawnTick,
    );
    expect(waves).toHaveLength(10);
    expect(latestSpawnTick).toBe(4_040);
  });

  // Re-pinned M2-S11 P4 (measured): 30470 → 31070, entirely from `latestSpawnTick`'s
  // own +600 above; `traversal` is unmoved (P4 touched neither the board nor the slow
  // floor nor the slowest creep's speed). Headroom under MAX_MATCH_TICKS: 4930.
  it('total bound = latestSpawnTick + traversal = 31070, comfortably under MAX_MATCH_TICKS (36000)', () => {
    // Derived from the same bundle-read terms the tests above pin, not re-typed as
    // `3440 + 27030` — the same reason stress.test.ts's own pin does this.
    const total = latestSpawnTick + traversal;
    console.log('registry.test.ts: total bound =', total, 'MAX_MATCH_TICKS =', MAX_MATCH_TICKS);
    expect(total).toBe(31_070);
    expect(MAX_MATCH_TICKS).toBe(36_000);
    expect(total).toBeLessThan(MAX_MATCH_TICKS);
  });

  // The bundle must actually compile under this bound — a passing arithmetic pin
  // above proves nothing if the compiler disagrees; this ties the two together.
  it('compiles cleanly given the bound holds', () => {
    expect(() => compileRuleset(bundle, 'field-01')).not.toThrow();
  });
});

describe('the win-over-loss score ordering invariant (m2.md:272-277; M2-S11 P4 sets the margin)', () => {
  // `deriveScore` (index.ts): running/won = cumulativeKillBounty + cumulativeEarlyCallCredit
  // (+ max(0,lives) × survivalMul when won); lost = cumulativeKillBounty only, early-call
  // credit forfeited. A leaked creep earns no kill bounty. Derived entirely from the
  // COMPILED bundle's own bounty/leakCost/lives/survivalMul terms — never typed as a
  // literal — so a catalog or wave edit changes what this test computes, not just what it
  // happens to match.
  //
  // M2-S11 P4 replaces S10's PER-KIND GREEDY with the plan's own BOUNDED KNAPSACKS over
  // the SCHEDULED CREEP MULTISET. The greedy silently assumed both extremes are reached by
  // leaking copies of a single best kind, which is only true while the schedule happens to
  // hold enough of it; the knapsack chooses a subset of the ACTUAL scheduled spawns, each a
  // discrete item with its own (leakCost, bounty), so a schedule that runs out of cheap
  // leaks changes the answer instead of being quietly rounded over.
  //
  // BOTH NUMBERS ARE CONSERVATIVE BOUNDS, not achievable scores: nothing here asks whether
  // a replay exists that actually leaks exactly that subset (a leak set is constrained by
  // what a build can physically let through, and by wave ORDER, neither of which this
  // models). An unachievable bound is a valid guard — the invariant it protects is "no
  // losing score can reach any winning score" — but it must never be reported as the real
  // best loss.
  const text = readFileSync(BUNDLED_ARTIFACT_URL, 'utf8');
  const bundle = parseRulesetJson(text);
  const board = bundle.boards.find((b) => b.id === 'field-01');
  if (board === undefined) throw new Error("no board 'field-01' in the shipped bundle");
  const creepById = new Map(bundle.creepCatalog.map((c) => [c.id, c]));
  const L = bundle.balance.startingLives;
  const survivalMul = bundle.scoring.survivalMul;

  // THE SCHEDULED CREEP MULTISET — one entry per creep the schedule actually spawns,
  // expanded from every wave entry's own `count`, each carrying its own (leakCost, bounty).
  const scheduled: { leakCost: number; bounty: number }[] = [];
  for (const wave of board.waves) {
    for (const entry of wave.entries) {
      const creep = creepById.get(entry.creepId);
      if (creep === undefined) throw new Error(`unknown creepId ${entry.creepId} in a wave`);
      for (let i = 0; i < entry.count; i++) {
        scheduled.push({ leakCost: creep.leakCost, bounty: creep.bounty });
      }
    }
  }
  // B — total scheduled kill bounty (ruling 8's "today's arithmetic: 211" cross-check).
  const B = scheduled.reduce((sum, c) => sum + c.bounty, 0);

  // KNAPSACK 1 — BEST LOSS = B − min Σbounty over leak-subsets with ΣleakCost ≥ L.
  // The life axis SATURATES at L (spending more than L lives is still just a loss), so a
  // 0/1 knapsack over `scheduled` with the index clamped to L answers it exactly. Inner
  // loop descends so each scheduled creep is used at most once.
  const INF = Number.POSITIVE_INFINITY;
  const minBounty = new Array<number>(L + 1).fill(INF);
  minBounty[0] = 0;
  for (const c of scheduled) {
    for (let spent = L; spent >= 0; spent--) {
      if (minBounty[spent] === INF) continue;
      const next = Math.min(L, spent + c.leakCost);
      minBounty[next] = Math.min(minBounty[next]!, minBounty[spent]! + c.bounty);
    }
  }
  const bestLossScore = B - minBounty[L]!;

  // KNAPSACK 2 — WORST WIN = min over leak-subsets with ΣleakCost ≤ L−1 of
  // (B − Σbounty) + (L − ΣleakCost) × survivalMul, at zero early-call credit. Here the
  // life axis must NOT saturate (the surviving-lives term reads it), so this is an exact
  // 0/1 knapsack for the MAXIMUM bounty at each attainable leak total 0…L−1.
  const maxBounty = new Array<number>(L).fill(Number.NEGATIVE_INFINITY);
  maxBounty[0] = 0;
  for (const c of scheduled) {
    for (let spent = L - 1; spent >= c.leakCost; spent--) {
      const from = maxBounty[spent - c.leakCost]!;
      if (from === Number.NEGATIVE_INFINITY) continue;
      maxBounty[spent] = Math.max(maxBounty[spent]!, from + c.bounty);
    }
  }
  let worstWinScore = INF;
  for (let spent = 0; spent < L; spent++) {
    if (maxBounty[spent] === Number.NEGATIVE_INFINITY) continue;
    worstWinScore = Math.min(worstWinScore, B - maxBounty[spent]! + (L - spent) * survivalMul);
  }

  /** The margin S11 pre-committed to (ruling 3), before any of these numbers were run. */
  const MARGIN_FLOOR = 15;

  it('worst win beats best loss by the pre-committed margin, derived from the bundle', () => {
    console.log(
      `registry.test.ts: B=${B} bestLossScore=${bestLossScore} worstWinScore=${worstWinScore} ` +
        `margin=${worstWinScore - bestLossScore} survivalMul=${survivalMul}`,
    );
    // Re-pinned M2-S11 P4 (measured). `B` is unchanged from P3 at 211 — P4 moved no
    // creep bounty and no wave composition. `bestLossScore` is unchanged at 201: the
    // cheapest way to spend 10 lives is still ten 1-bounty leaks, and the schedule holds
    // 62 of them, so the knapsack and the retired greedy agree here. `worstWinScore`
    // moves 203 → 218 purely because P4 raised `survivalMul` 35 → 50 — the one lever
    // ruling 8 assigns to this margin, because it appears only in the winning terminal
    // and so moves worst-win without touching combat, economy or clear bonuses.
    expect(B).toBe(211);
    expect(bestLossScore).toBe(201);
    expect(worstWinScore).toBe(218);
    expect(worstWinScore - bestLossScore).toBeGreaterThanOrEqual(MARGIN_FLOOR);
  });
});
