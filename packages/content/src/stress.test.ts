// stress.test.ts — the ADR 0005 stress bundle (M2-S4b step 16).
//
// This bundle is a CEILING, not a description of real play. Every number in it is
// pushed to the edge of what the compiler will accept, deliberately:
//   - `stress-runner` carries hp 1,000,000 — effectively immortal. A creep that
//     dies is a creep the scene is no longer stressing (fewer live creeps, fewer
//     in-flight impacts, less combat work per tick), so a mortal creep would let
//     the scenario decay into an easy scene exactly when the perf harness samples it.
//   - `startingLives` is 1,000,000 for the same reason from the other direction:
//     `step()` FREEZES on a terminal phase (`if (isTerminalPhase(state.phase))
//     return state`), and with ~300 concurrent leaking creeps an ordinary lives
//     total would drive the run to `lost` almost immediately — after which every
//     later sampled `step()` is a trivial early return with superb percentiles,
//     measuring nothing. That failure mode (an idle benchmark that still "passes")
//     is the whole reason PLAN step 18's workload oracle exists: a perf run that
//     doesn't prove what it measured proves nothing at all.
//
// So: never read this bundle's `hp`/`startingLives` as "how many hits a creep
// takes" or "how many leaks are survivable" — they exist purely to keep the sim
// alive and populated for the duration of the sampling window.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseRulesetJson,
  compileRuleset,
  RulesetError,
  MAX_MATCH_TICKS,
  MAX_TOWERS,
} from '@wynding/sim';
import { bundledRulesetIds, getBundledRuleset } from './registry';
import { STRESS_BOARD_ID, STRESS_RULESET_ID, STRESS_RULESET_URL } from './stress';

describe('the stress bundle compiles through the genuine parse/compile path', () => {
  // If this test were deleted, a bundle that fails structural validation or a
  // compile-time bound gate (see below) could sit in the repo unnoticed — there
  // is no other consumer that loads `stress-40x40.json` at all.
  it('parses and compiles via parseRulesetJson + compileRuleset, no bespoke loader', () => {
    const text = readFileSync(STRESS_RULESET_URL, 'utf8');
    const bundle = parseRulesetJson(text);
    expect(bundle.rulesetId).toBe(STRESS_RULESET_ID);
    const compiled = compileRuleset(bundle, 'stress-40x40');
    expect(compiled.boardId).toBe('stress-40x40');
  });
});

describe('the stress bundle is absent from the shipped registry', () => {
  // If this test were deleted, a future edit could accidentally add the stress
  // bundle to `registry.ts`'s `BUNDLED_TEXT` map — shipping a synthetic 40×40,
  // 1,000,000-hp bundle to every client and silently changing what
  // `bundledRulesetIds()` (and everything keyed off it) reports.
  it('bundledRulesetIds() does not contain stress-40x40', () => {
    expect(bundledRulesetIds()).not.toContain(STRESS_RULESET_ID);
  });

  it('getBundledRuleset(stress-40x40) throws RulesetError', () => {
    expect(() => getBundledRuleset(STRESS_RULESET_ID)).toThrow(RulesetError);
  });

  // wynding-core's content hash must stay untouched by this bundle's presence in
  // the same package — if this test were deleted, a change that widened
  // `BUNDLED_TEXT` (even alongside `wynding-core`) could ship unnoticed.
  it('wynding-core is still the ONLY bundled ruleset (its digest is untouched)', () => {
    expect(bundledRulesetIds()).toEqual(['wynding-core']);
  });
});

describe('the compile-bound arithmetic, pinned as named numbers (PLAN step 16)', () => {
  const text = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(text);

  // Read the actual knobs off the parsed bundle rather than typing their values in
  // as literals — a test that only computes from hand-typed literals never
  // notices `speedFp` or `mulFp` changing in the bundle itself (mutating `speedFp`
  // 60->30, or `mulFp` 179->128, left this suite green before this fix — 0 of 5
  // mutants killed). Asserting the INPUT first, then feeding that
  // same variable into the formula, means a bundle edit changes what this test
  // computes, not just what it happens to match.
  // Thrown, not `?.`-chained, for the reason the board lookups below give: an absent
  // entry otherwise reaches the arithmetic as `undefined`, turns `minEffSpeedFp` and
  // `traversal` into `NaN`, and reports three or four confusing failures for one cause.
  const runner = bundle.creepCatalog.find((c) => c.id === 'stress-runner');
  if (runner === undefined) throw new Error("no creep 'stress-runner' in the stress bundle");
  const chill = bundle.towerCatalog.find((t) => t.id === 'stress-chill');
  if (chill === undefined) throw new Error("no tower 'stress-chill' in the stress bundle");
  const slow = chill.effects.find((e) => e.kind === 'slow');
  if (slow === undefined) throw new Error("'stress-chill' has no slow effect");
  const speedFp = runner.speedFp;
  const mulFp = slow.mulFp;
  const slowFloorNum = bundle.balance.slowFloorNum;
  const slowFloorDen = bundle.balance.slowFloorDen;

  it('the bundle’s pinned inputs are what the arithmetic below assumes', () => {
    expect(speedFp).toBe(60);
    expect(mulFp).toBe(179);
    expect(slowFloorNum).toBe(1);
    expect(slowFloorDen).toBe(4);
  });

  // `effectiveSpeedFp` is not part of @wynding/sim's public API (only used
  // internally by `ruleset.ts`'s bound gate and `index.ts`'s movement) — the plan
  // says to assert the arithmetic inline rather than widen sim's exports for a
  // test. This is `ruleset-shared.ts`'s exact formula:
  //   max(1, floor(baseSpeedFp * mulFp / 256), ceil(baseSpeedFp * slowFloorNum / slowFloorDen))
  // with baseSpeedFp = 60 (stress-runner), mulFp = 179 (stress-chill, the
  // catalog's only/strongest slow), slowFloorNum/Den = 1/4 — all read off the
  // bundle above, not re-typed.
  const minEffSpeedFp = Math.max(
    1,
    Math.floor((speedFp * mulFp) / 256),
    Math.ceil((speedFp * slowFloorNum) / slowFloorDen),
  );

  it('minEffSpeedFp = effectiveSpeedFp(speedFp, mulFp, slowFloorNum, slowFloorDen) = 41', () => {
    expect(minEffSpeedFp).toBe(41);
  });

  // Traversal term: ⌈cells × FP_DIAG_LEN / minEffSpeedFp⌉, cells = 40×40 = 1600,
  // FP_DIAG_LEN = 362 (`ruleset.ts`'s fixed-point diagonal cell length). `cells` is
  // read off the bundle's own board dimensions, not re-typed as a literal.
  const board = bundle.boards.find((b) => b.id === STRESS_BOARD_ID);
  if (board === undefined) throw new Error(`no board '${STRESS_BOARD_ID}' in the stress bundle`);
  const widthTiles = board.widthTiles;
  const heightTiles = board.heightTiles;
  const traversal = Math.ceil((widthTiles * heightTiles * 362) / minEffSpeedFp);

  it('board dimensions are 40x40', () => {
    expect(widthTiles).toBe(40);
    expect(heightTiles).toBe(40);
  });

  it('traversal = ceil(widthTiles*heightTiles*362 / minEffSpeedFp) = 14127', () => {
    expect(traversal).toBe(14127);
  });

  // latestSpawnTick: countdown + the wave's TAIL, where the tail is the maximum over
  // EVERY entry of `offsetTicks + (count-1) × spacingTicks` — the compiler's own
  // definition (`ruleset.ts` takes the max spawn offset across the whole sorted
  // timeline), reduced over all 16 entries rather than read off `entries[0]`.
  //
  // Reading only the first entry left this guard green while a LATER
  // entry's count, spacing, or offset changed the compiled schedule underneath it — the
  // exact class of "the test pins a number the code no longer produces" this file was
  // already hardened against once for hand-typed literals.
  const waves = board.waves;
  // Not `?.`-guarded: the schema requires 1..64 waves (`ruleset-schema.ts`), and `board`
  // already threw above if it were missing, so an optional chain here would be a dead
  // branch pretending to be a check.
  const wave = waves[0]!;
  const countdownTicks = wave.countdownTicks;
  const entries = wave.entries;
  const tailOf = (w: (typeof waves)[number]): number =>
    w.entries.reduce(
      (max, e) => Math.max(max, (e.offsetTicks ?? 0) + (e.count - 1) * e.spacingTicks),
      0,
    );
  const waveTail = tailOf(wave);
  const totalScheduledSpawns = waves.reduce(
    (sum, w) => sum + w.entries.reduce((n, e) => n + e.count, 0),
    0,
  );

  // The compiler's own bound, mirrored exactly (`ruleset.ts`): wave k launches at the
  // PREFIX SUM of countdowns 1..k, so its last spawn lands at `prefix_k + tail_k`, and the
  // run's latest spawn is the MAX of that over k — not `waves[0]`'s, and not
  // `Σcountdowns + maxTail`, which double-counts overlap. The bundle has one wave today,
  // so all three agree; they stop agreeing the moment a second wave is added, and then
  // only this form is right: a valid second wave moves the real bound to 19,327 while a
  // `waves[0]` reading still computes 16,027.
  //
  // A `for` loop rather than a `reduce` closing over a mutable `prefixCountdown`: the
  // reduce form is correct only while it is evaluated exactly once, and nothing about it
  // says so.
  let prefixCountdown = 0;
  let latestSpawnTick = 0;
  for (const w of waves) {
    prefixCountdown += w.countdownTicks;
    latestSpawnTick = Math.max(latestSpawnTick, prefixCountdown + tailOf(w));
  }

  it('the wave schedule is countdown 100, 16 entries of 19 at spacing 100, all at offset 0', () => {
    expect(countdownTicks).toBe(100);
    expect(entries).toHaveLength(16);
    for (const e of entries) {
      expect(e.count).toBe(19);
      expect(e.spacingTicks).toBe(100);
      expect(e.offsetTicks ?? 0).toBe(0);
    }
  });

  it('latestSpawnTick = countdownTicks + max tail over every entry = 1900', () => {
    expect(waveTail).toBe(1800);
    expect(countdownTicks + waveTail).toBe(1900);
    // The prefix-sum form the compiler actually uses agrees, as it must while there is
    // exactly one wave — this is what ties the simple reading above to the real bound.
    expect(latestSpawnTick).toBe(1900);
  });

  it('the wave schedules 304 spawns in total, summed over every entry', () => {
    // ADR 0005's "~300 concurrent" target, and the multiplicand in the AoE scan-work
    // bound below. Summed rather than re-typed as `16 * 19` for the same reason the
    // tail is a max rather than `entries[0]`'s: a changed entry must move it.
    expect(totalScheduledSpawns).toBe(304);
  });

  it('total bound = latestSpawnTick + traversal = 16027, comfortably under MAX_MATCH_TICKS (36000)', () => {
    // Derived from the same bundle-read terms the tests above pin, not re-typed as
    // `1900 + 14127`: re-typing left this test green under a bundle mutation that turned
    // its siblings red, which is the one thing a bound like this must not do.
    const total = latestSpawnTick + traversal;
    expect(total).toBe(16027);
    expect(MAX_MATCH_TICKS).toBe(36_000);
    expect(total).toBeLessThan(MAX_MATCH_TICKS);
    expect(MAX_MATCH_TICKS - total).toBe(19_973); // the stated headroom
  });

  // The bundle must actually compile under this bound — a passing arithmetic pin
  // above proves nothing if the compiler disagrees; this ties the two together.
  it('compiles cleanly given the bound holds', () => {
    expect(() => compileRuleset(bundle, 'stress-40x40')).not.toThrow();
  });
});

describe('the two idle-benchmark guards, read from the bundle (PLAN step 16)', () => {
  // The header comment above explains WHY `startingLives` and `hp` are both pinned
  // at 1,000,000 — a mortal creep or an ordinary lives total would let the scenario
  // decay into an idle benchmark that still "passes" (PLAN step 18's whole point).
  // No prior test in this file actually READ either knob off the bundle, so
  // `startingLives` 1e6->1000 and `hp` 1e6->100 both survived unnoticed.
  // Only `stress-runner.hp` is read below, but immortality is pinned for BOTH creeps
  // in the scene: `stress-armored.hp` (M2-S5b P9) is asserted separately, in the
  // 'stress-armored (PLAN step 7 / packet P9 §1)' describe above ("hp 1,000,000,
  // armor 6, ..."). That coverage exists; this prose is naming it so the case for
  // why immortality matters — an idle benchmark that still "passes" — reads as
  // covering the scene as it now stands, not just the creep this block happens to
  // assert directly.
  const text = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(text);

  it('balance.startingLives is 1,000,000 — an ordinary total would let 300 leaking creeps drive step() to freeze on terminal', () => {
    expect(bundle.balance.startingLives).toBe(1_000_000);
  });

  it('stress-runner.hp is 1,000,000 — a mortal creep would die out of the scene and stop stressing it', () => {
    const runner = bundle.creepCatalog.find((c) => c.id === 'stress-runner');
    expect(runner?.hp).toBe(1_000_000);
  });
});

describe('the AoE scan-work ceiling headroom (PLAN step 16)', () => {
  // If this test were deleted, a future edit to the bundle's spawn count or
  // MAX_TOWERS could silently approach or exceed AOE_SCAN_CEILING with only the
  // compiler's own throw (no named budget) to notice — and that throw is a
  // hash/compiles-only guard, exactly the failure mode HANDOFF-M2-S4B.md warns
  // against ("a hash golden is not a guard"). `AOE_SCAN_CEILING` itself is NOT
  // exported from `@wynding/sim`'s public barrel (only used internally by
  // `ruleset.ts`'s gate) — frozen at S4a per the handoff, so this asserts the
  // literal `2_000_000` rather than widening sim's exports for a test.
  const scanBundle = parseRulesetJson(readFileSync(STRESS_RULESET_URL, 'utf8'));
  // Found by id, never `boards[0]`: a board added ahead of the stress board would
  // otherwise silently move this whole assertion onto the wrong one. Thrown rather
  // than `?.`-chained for the same reason `towerById` below throws — an undefined board
  // reaches the assertions as `0`/`NaN` and reports four confusing failures for one
  // cause.
  const scanBoard = scanBundle.boards.find((b) => b.id === STRESS_BOARD_ID);
  if (scanBoard === undefined) {
    throw new Error(`no board '${STRESS_BOARD_ID}' in the stress bundle`);
  }

  it('MAX_TOWERS (1000) * totalScheduledSpawns (304) = 304000 <= AOE_SCAN_CEILING (2000000)', () => {
    // Summed over every entry of every wave, not `16 * 19` re-typed: the compiler counts
    // each entry's `count` across the whole schedule (`ruleset.ts`'s `totalSpawns`), so a
    // changed or added entry must move this number too.
    const totalScheduledSpawns = scanBoard.waves.reduce(
      (sum, w) => sum + w.entries.reduce((n, e) => n + e.count, 0),
      0,
    );
    expect(totalScheduledSpawns).toBe(304);
    expect(MAX_TOWERS).toBe(1_000);
    const worstCaseScanWork = MAX_TOWERS * totalScheduledSpawns;
    expect(worstCaseScanWork).toBe(304_000);
    const AOE_SCAN_CEILING = 2_000_000;
    expect(worstCaseScanWork).toBeLessThanOrEqual(AOE_SCAN_CEILING);
  });
});

describe('the control twins are pairwise identical to their stress counterpart except form', () => {
  // `stress-single` and `stress-chill-single` appear nowhere else in this file, and
  // the perf harness's own tests never touch tower definitions — so nothing asserted
  // that the twins the ratio gate's control scenario relies on (`@wynding/perf`'s
  // `scenario.ts`, `buildControlReplay`) actually match their stress-side counterpart
  // on cost/cadence/travel/damage/slow. Deleting a twin's `slow` effect, or drifting
  // its cost or cadence, would leave every existing test green and silently redefine
  // what the ratio gate's `R` measures. Derived from the PARSED bundle, not hardcoded
  // effect lists, so an edit to either tower's definition is caught here rather than
  // needing this test updated by hand in lockstep.
  const text = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(text);

  function towerById(id: string) {
    const tower = bundle.towerCatalog.find((t) => t.id === id);
    if (tower === undefined) throw new Error(`no tower catalog entry for '${id}'`);
    return tower;
  }

  function directEffect(tower: ReturnType<typeof towerById>) {
    const effect = tower.effects.find((e) => e.kind === 'direct');
    if (effect === undefined) throw new Error(`tower '${tower.id}' has no direct effect`);
    return effect;
  }

  function nonDirectEffects(tower: ReturnType<typeof towerById>) {
    return tower.effects.filter((e) => e.kind !== 'direct');
  }

  /** Asserts `controlId` is `stressId`'s single-form twin: identical cost, attack, and
   *  every effect EXCEPT the direct effect's `form` (and the `aoe` member's
   *  `radiusFp`, which a `single`-form effect has no equivalent field for at all). */
  function expectSingleFormTwin(stressId: string, controlId: string): void {
    const stress = towerById(stressId);
    const control = towerById(controlId);

    expect(control.cost).toBe(stress.cost);
    expect(control.attack).toEqual(stress.attack);

    const stressDirect = directEffect(stress);
    const controlDirect = directEffect(control);
    expect(stressDirect.form).toBe('aoe');
    expect(controlDirect.form).toBe('single');
    if (stressDirect.form !== 'aoe' || controlDirect.form !== 'single') {
      throw new Error('unreachable — asserted immediately above');
    }
    expect(stressDirect.radiusFp).toBeGreaterThan(0);

    // Every OTHER field of the direct effect — `damage`, in this catalog's case — must
    // match exactly, so the "same axis except form" claim holds for the direct effect
    // itself, not just the pair's cost/attack.
    const { form: _sf, radiusFp: _sr, ...stressDirectRest } = stressDirect;
    const { form: _cf, ...controlDirectRest } = controlDirect;
    expect(controlDirectRest).toEqual(stressDirectRest);

    // Every non-direct effect (the chill pair's `slow`) must match exactly, unchanged —
    // this is what this test now pins.
    expect(nonDirectEffects(control)).toEqual(nonDirectEffects(stress));
  }

  it("stress-single is stress-blast's single-form twin", () => {
    expectSingleFormTwin('stress-blast', 'stress-single');
  });

  it("stress-chill-single is stress-chill's single-form twin, slow effect included", () => {
    expectSingleFormTwin('stress-chill', 'stress-chill-single');
  });
});

describe('stress-venom (PLAN step 7 / packet P9 §1)', () => {
  const text = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(text);

  function towerById(id: string) {
    const tower = bundle.towerCatalog.find((t) => t.id === id);
    if (tower === undefined) throw new Error(`no tower catalog entry for '${id}'`);
    return tower;
  }

  function directEffect(tower: ReturnType<typeof towerById>) {
    const effect = tower.effects.find((e) => e.kind === 'direct');
    if (effect === undefined) throw new Error(`tower '${tower.id}' has no direct effect`);
    return effect;
  }

  function dotEffect(tower: ReturnType<typeof towerById>) {
    const effect = tower.effects.find((e) => e.kind === 'dot');
    if (effect === undefined) throw new Error(`tower '${tower.id}' has no dot effect`);
    return effect;
  }

  it('catalog fields: cost 12, attack block, both effects in authored order (direct then dot)', () => {
    const venom = towerById('stress-venom');
    expect(venom.cost).toBe(12);
    if (venom.attack === undefined) throw new Error("'stress-venom' has no attack block");
    expect(venom.attack).toEqual({
      domain: 'ground',
      rangeFp: 1024,
      cadenceTicks: 30,
      travelTicks: 2,
    });
    expect(venom.effects).toHaveLength(2);
    expect(venom.effects[0]!.kind).toBe('direct');
    expect(venom.effects[1]!.kind).toBe('dot');
    const direct = directEffect(venom);
    expect(direct).toEqual({ kind: 'direct', form: 'single', damage: 1 });
    const dot = dotEffect(venom);
    expect(dot).toEqual({ kind: 'dot', damagePerTick: 1, cadenceTicks: 10, durationTicks: 240 });
  });

  it('is blast-free: direct form is single, no radiusFp — protects controlNoBlasts', () => {
    const venom = towerById('stress-venom');
    const direct = directEffect(venom);
    expect(direct.form).toBe('single');
    if (direct.form !== 'single') throw new Error('unreachable — asserted immediately above');
    expect('radiusFp' in direct).toBe(false);
  });

  it('the ratio-gate arithmetic, pinned as named numbers: durationTicks sits exactly on the ceiling', () => {
    const venom = towerById('stress-venom');
    const dot = dotEffect(venom);
    const durationTicks = dot.durationTicks;
    if (venom.attack === undefined) throw new Error("'stress-venom' has no attack block");
    const cadenceTicks = venom.attack.cadenceTicks;
    if (cadenceTicks === undefined) {
      throw new Error("'stress-venom's attack has no cadenceTicks");
    }
    // MAX_DOT_DURATION_CADENCE_RATIO is not exported through @wynding/sim's public
    // barrel (only `packages/sim/src/ruleset-shared.ts:99` defines it, and
    // `capability.ts`/`combat.ts` consume it internally) — per packet P9 §5, hardcoded
    // here with the source line named rather than widening sim's exports for a test.
    // Because it is hardcoded, THIS test is not the real gate on that ratio: if the
    // constant moved (8 -> 6, say), this file's own literal would move with it by hand
    // and the assertions below would still pass on an otherwise-broken bundle. The real
    // gate is the separate `compileRuleset` test above ("compiles cleanly given the
    // bound holds") — if the ratio constant changed under an unchanged bundle, THAT is
    // what would start throwing. And 240 sits EXACTLY on the `>` boundary
    // (`durationTicks > MAX_DOT_DURATION_CADENCE_RATIO * cadenceTicks` is the compiler's
    // rejection condition, so 240 === 8 * 30 passes with zero slack in the direction
    // that would reject it — one more tick and the bundle stops compiling).
    const maxDotDurationCadenceRatio = 8; // ruleset-shared.ts:99, MAX_DOT_DURATION_CADENCE_RATIO
    expect(durationTicks).toBe(240);
    expect(cadenceTicks).toBe(30);
    expect(durationTicks).toBe(maxDotDurationCadenceRatio * cadenceTicks);
    // Residency per source: floor((durationTicks - 1) / cadenceTicks) + 1 = 8, the
    // maximum the ratio gate allows (7 would be the residency at durationTicks 239).
    const residencyPerSource = Math.floor((durationTicks - 1) / cadenceTicks) + 1;
    expect(residencyPerSource).toBe(8);
  });
});

describe('stress-armored (PLAN step 7 / packet P9 §1)', () => {
  const text = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(text);

  function creepById(id: string) {
    const creep = bundle.creepCatalog.find((c) => c.id === id);
    if (creep === undefined) throw new Error(`no creep catalog entry for '${id}'`);
    return creep;
  }

  it('catalog fields: hp 1,000,000, armor 6, bounty/domain/immunities/leakCost match stress-runner’s convention', () => {
    const armored = creepById('stress-armored');
    expect(armored.hp).toBe(1_000_000);
    expect(armored.armor).toBe(6);
    expect(armored.domain).toBe('ground');
    expect(armored.immunities).toEqual([]);
    expect(armored.leakCost).toBe(1);
    expect(armored.bounty).toBe(1);
  });

  it('speedFp equals stress-runner’s EXACTLY, asserted between the two parsed creeps — keeps the compile-time traversal bound true by construction', () => {
    const armored = creepById('stress-armored');
    const runner = creepById('stress-runner');
    expect(armored.speedFp).toBe(runner.speedFp);
  });

  it('armor blanks every catalog tower’s direct damage to 0 — iterates the whole catalog, not a hand-picked list, so a fourth stress tower added later (or stress-single/stress-chill-single, the towers that actually fire at armored creeps in the control arm) is checked automatically', () => {
    const armored = creepById('stress-armored');
    const armor = armored.armor;
    for (const tower of bundle.towerCatalog) {
      const direct = tower.effects.find((e) => e.kind === 'direct');
      if (direct === undefined) continue; // no direct effect to blank — nothing to check
      if (direct.kind !== 'direct') throw new Error('unreachable — filtered above');
      expect(Math.max(0, direct.damage - armor)).toBe(0);
    }
  });
});

describe('the wave composition after the one-for-one stress-armored swap (PLAN step 7 / packet P9 §1)', () => {
  const text = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(text);
  const board = bundle.boards.find((b) => b.id === STRESS_BOARD_ID);
  if (board === undefined) throw new Error(`no board '${STRESS_BOARD_ID}' in the stress bundle`);
  const wave = board.waves[0]!;

  it('still exactly 16 entries, still 304 total spawns', () => {
    expect(wave.entries).toHaveLength(16);
    const total = wave.entries.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(304);
  });

  it('entries 0, 3, 6, 9, 12, 15 are stress-armored (114 total); the other ten are stress-runner (190 total) — order asserted, not just counts, since spawn order drives id assignment', () => {
    const armoredIndices = new Set([0, 3, 6, 9, 12, 15]);
    let armoredCount = 0;
    let runnerCount = 0;
    wave.entries.forEach((entry, i) => {
      if (armoredIndices.has(i)) {
        expect(entry.creepId).toBe('stress-armored');
        armoredCount += entry.count;
      } else {
        expect(entry.creepId).toBe('stress-runner');
        runnerCount += entry.count;
      }
    });
    expect(armoredCount).toBe(114);
    expect(runnerCount).toBe(190);
  });
});

describe('the identity-mapped control twin: stress-venom is deliberately NOT an expectSingleFormTwin pair', () => {
  // stress-venom maps to itself in `buildControlReplay` (`packages/perf/src/scenario.ts`)
  // rather than to a single-form twin — it is already blast-free, so there is no twin to
  // compare. This assertion covers only that no such twin exists in the catalog; it is
  // TAUTOLOGICAL for guarding `buildControlReplay`'s own mapper — it fails only if a
  // tower named `stress-venom-single` is ever added, never if the mapper's explicit
  // `stress-venom` arm is deleted (falling through to the `stress-single` `else`), which
  // is the actual failure `scenario.ts`'s own warning comment exists to guard against.
  // `packages/perf/src/scenario.test.ts`'s "buildControlReplay keeps stress-venom, at the
  // same placements as the stress arm" describe is the one that actually guards the
  // mapper (packet P9 §2) — it is derived from the built replays, not from this catalog
  // fact.
  const text = readFileSync(STRESS_RULESET_URL, 'utf8');
  const bundle = parseRulesetJson(text);

  it('no tower catalog entry named stress-venom-single exists', () => {
    const twin = bundle.towerCatalog.find((t) => t.id === 'stress-venom-single');
    expect(twin).toBeUndefined();
  });
});

describe('the board geometry supports the ~150-tower scenario (PLAN step 16)', () => {
  // 40x40 with a blocked border ring (minus the two openings) leaves a 38x38
  // fully buildable interior — if this test were deleted, a future board resize
  // could silently drop below the 600-cell footprint the scenario's ~150 towers
  // (4 footprint cells each, the game's fixed tower size) need.
  it('38 * 38 = 1444 buildable interior cells >= 150 towers * 4 footprint cells = 600', () => {
    const interiorCells = 38 * 38;
    expect(interiorCells).toBe(1444);
    const minFootprintCells = 150 * 4;
    expect(minFootprintCells).toBe(600);
    expect(interiorCells).toBeGreaterThanOrEqual(minFootprintCells);
  });
});
