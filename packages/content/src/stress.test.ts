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
import { STRESS_RULESET_ID, STRESS_RULESET_URL } from './stress';

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
  // as literals — QC: a test that only computes from hand-typed literals never
  // notices `speedFp` or `mulFp` changing in the bundle itself (mutating `speedFp`
  // 60->30, or `mulFp` 179->128, left this suite green before this fix — 0 of 5
  // mutants killed). Asserting the INPUT first, then feeding that
  // same variable into the formula, means a bundle edit changes what this test
  // computes, not just what it happens to match.
  const runner = bundle.creepCatalog.find((c) => c.id === 'stress-runner');
  const chill = bundle.towerCatalog.find((t) => t.id === 'stress-chill');
  const speedFp = runner?.speedFp;
  const mulFp = chill?.effects.find((e) => e.kind === 'slow')?.mulFp;
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
  it('minEffSpeedFp = effectiveSpeedFp(speedFp, mulFp, slowFloorNum, slowFloorDen) = 41', () => {
    const minEffSpeedFp = Math.max(
      1,
      Math.floor((speedFp! * mulFp!) / 256),
      Math.ceil((speedFp! * slowFloorNum) / slowFloorDen),
    );
    expect(minEffSpeedFp).toBe(41);
  });

  // Traversal term: ⌈cells × FP_DIAG_LEN / minEffSpeedFp⌉, cells = 40×40 = 1600,
  // FP_DIAG_LEN = 362 (`ruleset.ts`'s fixed-point diagonal cell length). `cells` is
  // read off the bundle's own board dimensions, not re-typed as a literal.
  const board = bundle.boards.find((b) => b.id === 'stress-40x40');
  const widthTiles = board?.widthTiles;
  const heightTiles = board?.heightTiles;

  it('board dimensions are 40x40', () => {
    expect(widthTiles).toBe(40);
    expect(heightTiles).toBe(40);
  });

  it('traversal = ceil(widthTiles*heightTiles*362 / minEffSpeedFp) = 14127', () => {
    const minEffSpeedFp = Math.max(
      1,
      Math.floor((speedFp! * mulFp!) / 256),
      Math.ceil((speedFp! * slowFloorNum) / slowFloorDen),
    );
    const cells = widthTiles! * heightTiles!;
    const traversal = Math.ceil((cells * 362) / minEffSpeedFp);
    expect(traversal).toBe(14127);
  });

  // latestSpawnTick: countdown + the wave's TAIL, where the tail is the maximum over
  // EVERY entry of `offsetTicks + (count-1) × spacingTicks` — the compiler's own
  // definition (`ruleset.ts` takes the max spawn offset across the whole sorted
  // timeline), reduced over all 16 entries rather than read off `entries[0]`.
  //
  // QC (CodeRabbit): reading only the first entry left this guard green while a LATER
  // entry's count, spacing, or offset changed the compiled schedule underneath it — the
  // exact class of "the test pins a number the code no longer produces" this file was
  // already hardened against once for hand-typed literals.
  const wave = board?.waves[0];
  const countdownTicks = wave?.countdownTicks;
  const entries = wave?.entries ?? [];
  const waveTail = entries.reduce(
    (max, e) => Math.max(max, (e.offsetTicks ?? 0) + (e.count - 1) * e.spacingTicks),
    0,
  );
  const totalScheduledSpawns = entries.reduce((sum, e) => sum + e.count, 0);

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
    expect(countdownTicks! + waveTail).toBe(1900);
  });

  it('the wave schedules 304 spawns in total, summed over every entry', () => {
    // ADR 0005's "~300 concurrent" target, and the multiplicand in the AoE scan-work
    // bound below. Summed rather than re-typed as `16 * 19` for the same reason the
    // tail is a max rather than `entries[0]`'s: a changed entry must move it.
    expect(totalScheduledSpawns).toBe(304);
  });

  it('total bound = 1900 + 14127 = 16027, comfortably under MAX_MATCH_TICKS (36000)', () => {
    const total = 1900 + 14127;
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

describe('the two idle-benchmark guards, read from the bundle (PLAN step 16, QC: read from the bundle rather than hand-typed literals)', () => {
  // The header comment above explains WHY `startingLives` and `hp` are both pinned
  // at 1,000,000 — a mortal creep or an ordinary lives total would let the scenario
  // decay into an idle benchmark that still "passes" (PLAN step 18's whole point).
  // No prior test in this file actually READ either knob off the bundle, so
  // `startingLives` 1e6->1000 and `hp` 1e6->100 both survived unnoticed.
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
  it('MAX_TOWERS (1000) * totalScheduledSpawns (304) = 304000 <= AOE_SCAN_CEILING (2000000)', () => {
    // Summed over every entry of every wave, not `16 * 19` re-typed: the compiler counts
    // each entry's `count` across the whole schedule (`ruleset.ts`'s `totalSpawns`), so a
    // changed or added entry must move this number too (QC, CodeRabbit).
    const scanBundle = parseRulesetJson(readFileSync(STRESS_RULESET_URL, 'utf8'));
    const totalScheduledSpawns = (scanBundle.boards[0]?.waves ?? []).reduce(
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

describe('the control twins are pairwise identical to their stress counterpart except form (QC round 2)', () => {
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
    // this is what QC round 1 fixed and what this test now pins.
    expect(nonDirectEffects(control)).toEqual(nonDirectEffects(stress));
  }

  it("stress-single is stress-blast's single-form twin", () => {
    expectSingleFormTwin('stress-blast', 'stress-single');
  });

  it("stress-chill-single is stress-chill's single-form twin, slow effect included", () => {
    expectSingleFormTwin('stress-chill', 'stress-chill-single');
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
