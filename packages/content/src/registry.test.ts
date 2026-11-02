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
  createInitialState,
  deriveScore,
  deriveStars,
  MAX_RULESET_TEXT_UNITS,
  MAX_MATCH_TICKS,
  rulesetDigest,
  RulesetError,
  DIAG_LEN,
  type SimState,
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
    expect(ruleset.formatVersion).toBe(3);
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
    // Re-pinned M3 story 8 (m3.md, "Economy" — the balance pass's lever on the board-full
    // wave): every cost a fifth dearer, rounded up to a whole bounty, in the same order.
    expect(ruleset.towerCatalog).toEqual([
      {
        id: 'basic',
        cost: 6,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      },
      {
        id: 'slow',
        cost: 10,
        attack: { domain: 'both', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 2 },
          { kind: 'slow', mulFp: 128, durationTicks: 40 },
        ],
      },
      {
        id: 'splash',
        cost: 15,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 60, travelTicks: 8 },
        effects: [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 384 }],
      },
      {
        id: 'venom',
        cost: 11,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 2 },
          { kind: 'dot', damagePerTick: 4, cadenceTicks: 10, durationTicks: 60 },
        ],
      },
      {
        id: 'stun',
        cost: 12,
        attack: { domain: 'ground', rangeFp: 768, cadenceTicks: 40, travelTicks: 2 },
        effects: [
          { kind: 'direct', form: 'single', damage: 4 },
          { kind: 'stun', chanceNum: 64, durationTicks: 20 },
        ],
      },
      {
        id: 'antiair',
        cost: 9,
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
        cost: 18,
        effects: [{ kind: 'support', damageMulFp: 384 }],
      },
      {
        id: 'mine',
        cost: 8,
        attack: { domain: 'ground', rangeFp: 576, travelTicks: 1 },
        effects: [{ kind: 'burst', form: 'aoe', damage: 45, radiusFp: 640 }],
      },
      {
        id: 'frost-splash',
        cost: 20,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 60, travelTicks: 8 },
        effects: [
          { kind: 'direct', form: 'aoe', damage: 6, radiusFp: 384 },
          { kind: 'slow', mulFp: 179, durationTicks: 30 },
        ],
      },
    ]);
  });

  it('carries the starting economy, refund/slow-floor fractions and early-call bounty divisor', () => {
    // Re-pinned M3 story 5 (m3.md, "Lives" and "Economy"): 20 starting lives for a run three
    // times M2's length, and the early-call bounty divisor 50 → 100, so a call on M3's
    // 500–800-tick countdowns pays at most 5–8. Refund is M2's. Re-pinned M3 story 8: the
    // starting bounty 80 → 96 with the towers' costs (a fifth dearer), so the opening still
    // buys sixteen basics.
    expect(ruleset.balance).toEqual({
      startingLives: 20,
      startingBounty: 96,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 100,
    });
  });

  it('carries the scoring weights and early-call score divisor', () => {
    // Re-pinned M2-S11 P4: `survivalMul` 35 → 50 — ruling 8's designated lever for the
    // win-over-loss margin, set from the bounded-knapsack extremes at the foot of this
    // file (worst win 218 vs best loss 201, margin 17 ≥ the pre-committed 15).
    // Re-pinned M3 story 5 (m3.md, "Scoring & star grade"): scaled to 20 lives —
    // `survivalMul` 50 → 25 keeps M2's 500-point survival ceiling, the star cutoffs double
    // to [1, 12, 18], and the early-call score credit takes the bounty's divisor, 100.
    expect(ruleset.scoring).toEqual({
      survivalMul: 25,
      starThresholds: [1, 12, 18],
      earlyCallScoreDivisor: 100,
    });
  });

  it('carries the board geometry: crossing-medium, a 28×24 grid with two crossing pairs', () => {
    expect(board.id).toBe('crossing-medium');
    expect(defaultBoardId(ruleset)).toBe('crossing-medium');
    expect(board.widthTiles).toBe(28);
    expect(board.heightTiles).toBe(24);
    // M3 story 4: the crossing board — west → east along row 11, north → south down
    // column 13, each entrance heading for its own one exit (m3.md, "The board").
    expect(board.entrances).toEqual([
      { id: 'west', cell: { col: 0, row: 11 }, destination: ['east'] },
      { id: 'north', cell: { col: 13, row: 0 }, destination: ['south'] },
    ]);
    expect(board.exits).toEqual([
      { id: 'east', cell: { col: 27, row: 11 } },
      { id: 'south', cell: { col: 13, row: 23 } },
    ]);
    // The creep HP curve (m3.md, "Creep HP growth"): flat at 100 through block 1, then rising
    // every wave of block 2 to 175 at wave 20 (M3 story 6), and on through block 3 to 270 at
    // wave 25, flat from there to wave 30 (M3 story 7). Re-pinned M3 story 8: 270 from wave 24
    // (was 255), so the curve flattens the wave after the measured board-full wave, 23.
    expect(board.waves.map((w) => w.hpPercent)).toEqual([
      ...Array<number>(10).fill(100),
      110,
      120,
      130,
      140,
      150,
      155,
      160,
      165,
      170,
      175,
      195,
      215,
      235,
      ...Array<number>(7).fill(270),
    ]);
  });

  // Re-pinned M3 story 5: block 1 of the first-pass arc (m3.md, "First-pass arc", rows 1–10)
  // replaces story 4's placeholder (M2's ten waves with five streams moved north). Wave 1 is
  // the familiar opener; the north route opens at wave 3; air flies the west lane only
  // (waves 6 and 9); the wall is wave 9's armored flyers; wave 10's one boss comes from the
  // west, its escort down the north route 600 ticks later. Every clear bonus is the spec's
  // `2 + ⌊(wave − 1) / 10⌋`, plus 4 on the boss wave.
  // Re-pinned M3 story 6: block 2 (rows 11–20) follows, its hit points rising 110 → 175.
  // Wave 11 is the relief, on a 700-tick countdown; the north route carries the full mix; the
  // north lane's air joins at wave 16; the wall is wave 19's armored flyers from the west
  // beside armored creeps from the north; wave 20 sends a boss down each route, each with its
  // escort 600 ticks behind on its own route.
  // Re-pinned M3 story 7: block 3 (rows 21–30) completes the arc, its hit points rising 195 →
  // 270 by wave 25 and flat after. Wave 21 is the relief, on an 800-tick countdown; wave 26
  // flies both lanes at once; the wall is wave 29's armored flyers down both lanes; wave 30
  // sends two bosses from the west, 400 ticks apart, and one from the north, each route's
  // armored-flyer escort 600 ticks behind its last boss. Clear bonuses are 4, and 8 on wave 30.
  // Re-pinned M3 story 8 (the balance pass): wave 16 flies 12 flyers down the north lane, 8
  // ticks apart (was 10, 12 apart); the wall, wave 19, sends 10 armored flyers (was 8) and 4
  // north swarm (was 10); wave 24 rises to 270% (was 255).
  it('carries the whole first-pass arc, row for row: compositions, routes, spacings, offsets, countdowns, clear bonuses, hit points', () => {
    const e = (
      creepId: string,
      entrance: string,
      count: number,
      spacingTicks: number,
      offsetTicks = 0,
    ) => ({
      creepId,
      entrance,
      count,
      spacingTicks,
      offsetTicks,
    });
    const wave = (
      index: number,
      countdownTicks: number,
      clearBonus: number,
      entries: unknown[],
      hpPercent = 100,
    ) => ({
      index,
      countdownTicks,
      clearBonus,
      hpPercent,
      entries,
    });
    // prettier-ignore
    expect(board.waves).toEqual([
      wave(0, 600, 2, [e('normal', 'west', 10, 20)]),
      wave(1, 500, 2, [e('swarm', 'west', 16, 5)]),
      wave(2, 500, 2, [e('normal', 'north', 10, 20)]),
      wave(3, 500, 2, [e('fast', 'west', 8, 15), e('fast', 'north', 6, 15, 60)]),
      wave(4, 500, 2, [e('armored', 'north', 6, 25), e('normal', 'west', 8, 20)]),
      wave(5, 500, 2, [e('flying', 'west', 8, 15)]),
      wave(6, 500, 2, [e('normal', 'west', 12, 15), e('swarm', 'north', 10, 6)]),
      wave(7, 500, 2, [e('resolute', 'north', 6, 15), e('fast', 'west', 6, 15)]),
      wave(8, 500, 2, [e('armored-flyer', 'west', 6, 20), e('normal', 'north', 8, 20, 100)]),
      wave(9, 600, 6, [e('boss', 'west', 1, 20), e('normal', 'north', 8, 20, 600)]),
      wave(10, 700, 3, [e('normal', 'west', 8, 20), e('normal', 'north', 8, 20)], 110),
      wave(11, 500, 3, [e('swarm', 'north', 14, 5), e('swarm', 'west', 12, 5)], 120),
      wave(12, 500, 3, [e('resolute', 'west', 8, 15), e('resolute', 'north', 8, 15)], 130),
      wave(13, 500, 3, [e('armored', 'west', 6, 25), e('armored', 'north', 6, 25)], 140),
      wave(14, 500, 3, [e('normal', 'west', 10, 15), e('swarm', 'north', 10, 5), e('fast', 'north', 6, 15, 120)], 150),
      wave(15, 550, 3, [e('flying', 'north', 12, 8)], 155),
      wave(16, 500, 3, [e('fast', 'north', 12, 12), e('resolute', 'west', 8, 15)], 160),
      wave(17, 500, 3, [e('armored', 'north', 8, 20), e('swarm', 'west', 16, 5)], 165),
      wave(18, 550, 3, [e('armored-flyer', 'west', 10, 18), e('armored', 'north', 8, 20), e('swarm', 'north', 4, 5, 120)], 170),
      wave(19, 700, 7, [e('boss', 'west', 1, 20), e('boss', 'north', 1, 20, 200), e('normal', 'west', 8, 20, 600), e('normal', 'north', 8, 20, 800)], 175),
      wave(20, 800, 4, [e('normal', 'west', 6, 15), e('normal', 'north', 6, 15)], 195),
      wave(21, 500, 4, [e('swarm', 'west', 16, 4), e('swarm', 'north', 10, 4)], 215),
      wave(22, 550, 4, [e('fast', 'west', 10, 12), e('fast', 'north', 10, 12)], 235),
      wave(23, 550, 4, [e('armored', 'west', 8, 20), e('armored', 'north', 8, 20)], 270),
      wave(24, 550, 4, [e('normal', 'west', 10, 12), e('normal', 'north', 10, 12), e('swarm', 'north', 8, 4, 150)], 270),
      wave(25, 600, 4, [e('armored-flyer', 'west', 10, 15), e('flying', 'north', 10, 15)], 270),
      wave(26, 550, 4, [e('swarm', 'north', 14, 4), e('fast', 'north', 8, 12, 60), e('resolute', 'west', 6, 12)], 270),
      wave(27, 550, 4, [e('armored', 'west', 8, 20), e('armored', 'north', 8, 20), e('fast', 'west', 8, 12, 100)], 270),
      wave(28, 600, 4, [e('armored-flyer', 'west', 8, 15), e('armored-flyer', 'north', 6, 15), e('armored', 'north', 8, 18), e('swarm', 'west', 8, 4, 120)], 270),
      wave(29, 700, 8, [e('boss', 'west', 2, 400), e('boss', 'north', 1, 20, 200), e('armored-flyer', 'west', 8, 20, 1000), e('armored-flyer', 'north', 8, 20, 800)], 270),
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
  // The shipped default board — `crossing-medium` since M3 story 4, on block 1's schedule
  // since M3 story 5, blocks 1–2's since M3 story 6 and the whole arc's since M3 story 7.
  const board = bundle.boards[0]!;
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
  // Re-pinned M3 story 5: block 1's countdowns, 600 + 500×8 + 600, put the boss wave's
  // launch at prefix 5200; its north escort keeps the same tail, 600 + 140 = 740, so the
  // last spawn lands at 5200 + 740 = 5940 — still the max.
  // Re-pinned M3 story 6: block 2's countdowns, 700 + 500×4 + 550 + 500×2 + 550 + 700 = 5500,
  // put wave 20 (index 19) at prefix 10700; its north escort starts 800 ticks in, tail
  // 800 + (8-1)*20 = 940, so the last spawn lands at 10700 + 940 = 11640 — the new max.
  // Re-pinned M3 story 7: block 3's countdowns, 800 + 500 + 550×3 + 600 + 550×2 + 600 + 700 =
  // 5950, put wave 30 (index 29) at prefix 16650; its west armored-flyer escort starts 1000
  // ticks in, tail 1000 + (8-1)*20 = 1140, so the last spawn lands at 16650 + 1140 = 17790 —
  // the new max, and m3.md's hands-off schedule.
  it('latestSpawnTick = 17790 (wave index 29 launches at prefix 16650; its 8x20 west `armored-flyer` escort starts 1000 ticks in, tail 1140)', () => {
    console.log(
      'registry.test.ts: waves.length =',
      waves.length,
      'latestSpawnTick =',
      latestSpawnTick,
    );
    expect(waves).toHaveLength(30);
    expect(latestSpawnTick).toBe(17_790);
  });

  // Re-pinned M2-S11 P4 (measured): 30470 → 31070, entirely from `latestSpawnTick`'s
  // own +600 above; `traversal` is unmoved (P4 touched neither the board nor the slow
  // floor nor the slowest creep's speed). Headroom under MAX_MATCH_TICKS: 4930 at
  // sv16's 36,000, 40,930 since sv17's 72,000 (M3 story 2) — the bound itself is unmoved.
  // Re-pinned M3 story 5: 31070 → 32970, entirely from block 1's longer countdowns above;
  // `traversal` is unmoved. Headroom under MAX_MATCH_TICKS: 39,030.
  // Re-pinned M3 story 6: 32970 → 38670, entirely from block 2's countdowns and wave 20's
  // escort tail; `traversal` is unmoved. Headroom under MAX_MATCH_TICKS: 33,330.
  // Re-pinned M3 story 7: 38670 → 44820, entirely from block 3's countdowns and wave 30's
  // escort tail — m3.md's compile check; `traversal` is unmoved. Headroom under
  // MAX_MATCH_TICKS: 27,180.
  it('total bound = latestSpawnTick + traversal = 44820, comfortably under MAX_MATCH_TICKS (72000)', () => {
    // Derived from the same bundle-read terms the tests above pin, not re-typed as
    // `17790 + 27030` — the same reason stress.test.ts's own pin does this.
    const total = latestSpawnTick + traversal;
    console.log('registry.test.ts: total bound =', total, 'MAX_MATCH_TICKS =', MAX_MATCH_TICKS);
    expect(total).toBe(44_820);
    expect(MAX_MATCH_TICKS).toBe(72_000);
    expect(total).toBeLessThan(MAX_MATCH_TICKS);
  });

  // The bundle must actually compile under this bound — a passing arithmetic pin
  // above proves nothing if the compiler disagrees; this ties the two together.
  it('compiles cleanly given the bound holds', () => {
    expect(() => compileRuleset(bundle, board.id)).not.toThrow();
  });
});

describe('the win-over-loss score ordering invariant (m2.md §Scoring & star grade; M2-S11 P4 sets the margin)', () => {
  // `deriveScore` (index.ts): running/won = cumulativeKillBounty + cumulativeEarlyCallCredit
  // (+ max(0,lives) × survivalMul when won); lost = ZERO since #25 / sv16 — the kill bounty
  // is forfeited alongside the early-call credit. A leaked creep earns no kill bounty.
  // Derived entirely from the COMPILED bundle's own bounty/leakCost/lives/survivalMul terms
  // — never typed as a literal — so a catalog or wave edit changes what this test computes,
  // not just what it happens to match.
  //
  // WHAT #25 DID TO THIS BLOCK. Through sv15 the losing side of the ordering was a BALANCE
  // property: the best losing score was `B − (cheapest Σbounty that spends L lives)` = 201,
  // and keeping it under the worst win was a tuning obligation discharged by `survivalMul`.
  // sv16 makes the losing side a THEOREM — every loss grades 0 — so the knapsack below no
  // longer computes a score. It is kept, and renamed to what it now measures: the largest
  // kill bounty a losing run could have banked, i.e. the SIZE of the forfeiture. That keeps
  // the content-derived arithmetic (and its 201) under test rather than deleting it, and
  // the ordering itself is now asserted against the real `deriveScore`/`deriveStars` on a
  // forged terminal loss carrying exactly that bounty — the strongest form of the claim,
  // since it fails if the contract is ever quietly reverted, not merely if a number drifts.
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
  // The shipped default board — `crossing-medium` since M3 story 4, on block 1's schedule
  // and M3's 20 lives and `survivalMul` 25 since M3 story 5, blocks 1–2's schedule since M3
  // story 6 and the whole arc's since M3 story 7.
  const board = bundle.boards[0]!;
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

  // KNAPSACK 1 — BEST LOSING KILL BOUNTY = B − min Σbounty over leak-subsets with
  // ΣleakCost ≥ L. The life axis SATURATES at L (spending more than L lives is still just
  // a loss), so a 0/1 knapsack over `scheduled` with the index clamped to L answers it
  // exactly. Inner loop descends so each scheduled creep is used at most once. Through
  // sv15 this WAS the best losing score; since sv16 it is the largest bounty a loss can
  // forfeit, and the forged terminal below is what turns it into a grade.
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
  const bestLossKillBounty = B - minBounty[L]!;

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

  /** The best-case losing terminal, graded by the REAL scorer: a forged `lost` state
   *  carrying the largest kill bounty any losing run of this bundle could have banked,
   *  plus a deliberately outsized early-call credit. Both accumulators are nonzero, so a
   *  scorer that forfeited neither, or only one, would grade this above 0. */
  function bestCaseLosingTerminal(): SimState {
    const compiled = compileRuleset(bundle, board!.id);
    return {
      ...createInitialState(1, compiled),
      phase: 'lost',
      lives: 0,
      cumulativeKillBounty: bestLossKillBounty,
      cumulativeEarlyCallCredit: 1_000,
    };
  }

  it('worst win beats best loss by the pre-committed margin, derived from the bundle', () => {
    const compiled = compileRuleset(bundle, board.id);
    const bestLossScore = deriveScore(bestCaseLosingTerminal(), compiled);
    console.log(
      `registry.test.ts: B=${B} bestLossKillBounty=${bestLossKillBounty} ` +
        `bestLossScore=${bestLossScore} worstWinScore=${worstWinScore} ` +
        `margin=${worstWinScore - bestLossScore} survivalMul=${survivalMul}`,
    );
    // Re-pinned M2-S11 P4 (measured). `B` is unchanged from P3 at 211 — P4 moved no
    // creep bounty and no wave composition. `bestLossKillBounty` is unchanged at 201: the
    // cheapest way to spend 10 lives is still ten 1-bounty leaks, and the schedule holds
    // 62 of them, so the knapsack and the retired greedy agree here. `worstWinScore`
    // moves 203 → 218 purely because P4 raised `survivalMul` 35 → 50 — the one lever
    // ruling 8 assigns to this margin, because it appears only in the winning terminal
    // and so moves worst-win without touching combat, economy or clear bonuses.
    // Re-pinned M3 story 5 (measured): block 1 schedules 129 creeps whose bounty also sums
    // to 211. At 20 lives the cheapest loss leaks twenty 1-bounty creeps, so the largest
    // bounty a loss can forfeit is 211 − 20 = 191; the worst win leaks 19 lives' worth of
    // the richest creeps (the boss, twelve 3-bounty and four 2-bounty creeps: 69) and keeps
    // one life at `survivalMul` 25: 211 − 69 + 25 = 167.
    // Re-pinned M3 story 6 (measured): blocks 1–2 schedule 323 creeps whose bounty sums to
    // 577. The cheapest loss still leaks twenty 1-bounty creeps, so a loss can forfeit at most
    // 577 − 20 = 557; the worst win leaks 19 lives' worth of the richest creeps (the three
    // bosses and ten 3-bounty creeps: 105) and keeps one life: 577 − 105 + 25 = 497.
    // Re-pinned M3 story 7 (measured): the whole arc schedules 546 creeps whose bounty sums to
    // 1,084 (m3.md's budget). A loss can forfeit at most 1,084 − 20 = 1,064; the worst win
    // leaks all six bosses (18 lives, 150) and one 3-bounty creep and keeps one life:
    // 1,084 − 153 + 25 = 956.
    // Re-pinned M3 story 8 (measured): the balance pass's block-2 moves add two flyers (4) and
    // two armored flyers (6) and cut six swarm (6): 544 creeps, 1,088 bounty. A loss can
    // forfeit at most 1,088 − 20 = 1,068; the worst win leaks the same 153: 1,088 − 153 + 25
    // = 960.
    expect(B).toBe(1088);
    expect(bestLossKillBounty).toBe(1068);
    expect(worstWinScore).toBe(960);
    // Re-pinned #25 (SIM_VERSION 15 → 16, measured): the best losing SCORE moves 201 → 0,
    // and the margin 17 → 218 with it.
    expect(bestLossScore).toBe(0);
    // S11's pre-committed margin floor of 15 (ruling 3) USED to be asserted here as
    // `worstWinScore - bestLossScore >= 15`. It is gone rather than re-pinned: with the
    // losing side structurally 0 and the winning side exactly pinned one line above, that
    // comparison was `218 - 0 >= 15` — implied by its own neighbours, incapable of being
    // the assertion that fails, and so coverage in appearance only. The two exact pins
    // above are what actually catch a catalog or wave edit now; `survivalMul` is no longer
    // the lever this invariant rests on, and the floor it was tuned against is discharged
    // history. The structural claim itself is the test below.
  });

  it('the ordering is now STRUCTURAL, not a tuning result — the richest possible loss still grades 0★/0 (#25, sv16)', () => {
    const compiled = compileRuleset(bundle, board.id);
    const lost = bestCaseLosingTerminal();
    // Anti-vacuity first: this terminal really is carrying both score inputs, and the
    // bounty half is the arc's own maximum, not a token value.
    expect(lost.cumulativeKillBounty).toBe(1068);
    expect(lost.cumulativeEarlyCallCredit).toBeGreaterThan(0);
    // ...and it grades 0 on both readouts, so no losing run of this bundle can reach any
    // winning run's score — without a leaderboard consumer gating on phase or stars.
    expect(deriveScore(lost, compiled)).toBe(0);
    expect(deriveStars(lost, compiled)).toBe(0);
    expect(worstWinScore).toBeGreaterThan(0); // the winning side is nonempty
  });
});
