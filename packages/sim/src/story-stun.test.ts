// story-stun.test.ts — M2 Story 6 P8: the stun tower / resolute creep counterplay —
// the sim RNG seam and the draw, the stun status column, immunity interaction (both
// the new stun axis and the slow-immunity filter that rides in alongside it),
// chain-lock, blast draw order, the movement/blast-lead exclusions, and the
// compile/preview/capability totality rails.
//
// Coverage list mirrors PLAN.md P8 "Coverage that must exist by name" 1-17. Two
// items live elsewhere by necessity, documented there rather than duplicated here:
//   - Test 3 ("rngState is byte-identical after many ticks under a stun-free
//     ruleset") is the REWRITE-IN-PLACE of the `#45` inert anchor at
//     `sim.test.ts` — that file's own claim ("step() never touches rngState") is
//     now false since M2-S6 P2, so the surviving half lives there, not here.
//   - Test 17 (the wave-index-4 measured golden) lives in
//     `packages/content/src/story-armored-wave.test.ts`, in the shape that file
//     already uses — `packages/sim` cannot import `@wynding/content` (this file's
//     own header convention; see `determinism.test.ts`), so a sim-side copy would
//     measure a REPLICA of wave 4, not the shipped one.
//
// Test 15 is deleted (QC fix pass): its assertions were guaranteed by
// construction, reading fields off the already-compiled module-level `RULESET`,
// so it could never fail even if the sv10 capability profile regressed — only
// disappear by collection. `capability.test.ts`'s dimension-by-dimension sv10
// coverage (P4, verify-not-rebuild) already covers accepted kinds and both
// immunities; see the deletion site (was test 15) for the one-line pointer.
//
// Test 16 (the renderer's unresolved-`creepId` `warded` totality guard) is
// provably a render-only concern: `packages/sim` has no renderer to test it
// against. It is already covered, and verified here to still hold, at
// `packages/render/src/render.test.ts:258-274` (P6) — documented, not
// duplicated, per this packet's "verify, do not rebuild" instruction.

import { describe, it, expect } from 'vitest';
import type { CreepDef, TowerDef } from '@wynding/types';
import { Rng } from '@wynding/engine';
import {
  createInitialState,
  step,
  previewInputs,
  isTerminalPhase,
  compileRuleset,
  MAX_MATCH_TICKS,
  type SimState,
} from './index';
import { RulesetError, type CompiledRuleset } from './ruleset';
import { runCombat, satAdd, type CombatCreeps, type Impact } from './combat';
import { emptyTowers } from './tower';
import { testBundle, testRuleset, pushCreep, runCombatT, TEST_SLOW_TOWER } from './test-support';

const LANE = {
  widthTiles: 14,
  heightTiles: 14,
  entrance: { col: 0, row: 6 },
  exit: { col: 13, row: 6 },
} as const;

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

// --- P8's literal fixture catalogs — typed in verbatim, nothing chosen here. ---

const T_STUN_ALWAYS: TowerDef = {
  id: 't-stun-always',
  cost: 10,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 40, travelTicks: 2 },
  effects: [
    { kind: 'direct', form: 'single', damage: 4 },
    { kind: 'stun', chanceNum: 256, durationTicks: 20 },
  ],
};
// Identical to T_STUN_ALWAYS — kept as its own id (PLAN.md P8) so the blanking
// (from the creep's armor, not the tower) reads clearly at test 9/14's call site.
const T_STUN_BLANK: TowerDef = {
  id: 't-stun-blank',
  cost: 10,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 40, travelTicks: 2 },
  effects: [
    { kind: 'direct', form: 'single', damage: 4 },
    { kind: 'stun', chanceNum: 256, durationTicks: 20 },
  ],
};
const T_STUN_CHANCE: TowerDef = {
  id: 't-stun-chance',
  cost: 10,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 40, travelTicks: 2 },
  effects: [
    { kind: 'direct', form: 'single', damage: 4 },
    { kind: 'stun', chanceNum: 64, durationTicks: 20 },
  ],
};
const T_BLAST_LEAD: TowerDef = {
  id: 't-blast-lead',
  cost: 12,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 60, travelTicks: 8 },
  effects: [{ kind: 'direct', form: 'aoe', damage: 8, radiusFp: 256 }],
};
const T_STUN_AOE: TowerDef = {
  id: 't-stun-aoe',
  cost: 10,
  attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 40, travelTicks: 2 },
  effects: [
    { kind: 'direct', form: 'aoe', damage: 4, radiusFp: 384 },
    { kind: 'stun', chanceNum: 64, durationTicks: 20 },
  ],
};

const C_PLAIN: CreepDef = {
  id: 'c-plain',
  hp: 200,
  speedFp: 26,
  armor: 0,
  domain: 'ground',
  immunities: [],
  leakCost: 1,
  bounty: 1,
};
const C_STUN_IMMUNE: CreepDef = {
  id: 'c-stun-immune',
  hp: 200,
  speedFp: 26,
  armor: 0,
  domain: 'ground',
  immunities: ['stun'],
  leakCost: 1,
  bounty: 1,
};
const C_SLOW_IMMUNE: CreepDef = {
  id: 'c-slow-immune',
  hp: 200,
  speedFp: 26,
  armor: 0,
  domain: 'ground',
  immunities: ['slow'],
  leakCost: 1,
  bounty: 1,
};
const C_BLANKED: CreepDef = {
  id: 'c-blanked',
  hp: 200,
  speedFp: 22,
  armor: 6,
  domain: 'ground',
  immunities: [],
  leakCost: 1,
  bounty: 1,
};
const C_SWIFT: CreepDef = {
  id: 'c-swift',
  hp: 200,
  speedFp: 44,
  armor: 0,
  domain: 'ground',
  immunities: [],
  leakCost: 1,
  bounty: 1,
};

// One shared ruleset carrying all five fixture towers and all five fixture creeps
// (plus test-support's default 'basic' tower/'normal' creep) — every test below
// draws a fresh `SimState` from `createInitialState`, so sharing the one compiled
// (immutable) ruleset across tests is safe.
const RULESET = testRuleset(LANE, {
  extraTowers: [T_STUN_ALWAYS, T_STUN_BLANK, T_STUN_CHANCE, T_BLAST_LEAD, T_STUN_AOE],
  extraCreeps: [C_PLAIN, C_STUN_IMMUNE, C_SLOW_IMMUNE, C_BLANKED, C_SWIFT],
});
const FIELD = RULESET.board.field;
const GRID = RULESET.board.grid;
const SF_NUM = RULESET.balance.slowFloorNum;
const SF_DEN = RULESET.balance.slowFloorDen;

/** A resting-creeps SoA row builder (mirrors story-aoe.test.ts's `restingCreeps`),
 *  extended with `creepId`/`stunUntilTick` overrides so fixtures carrying armor/
 *  immunities and pre-set stun can be built directly for `runCombat`. */
function restingCreeps(
  rows: ReadonlyArray<{
    readonly id: number;
    readonly col: number;
    readonly row: number;
    readonly hp: number;
    readonly creepId?: string;
    readonly stunUntilTick?: number;
  }>,
): CombatCreeps {
  return {
    id: rows.map((r) => r.id),
    hp: rows.map((r) => r.hp),
    bounty: rows.map(() => 1),
    speed: rows.map(() => 26),
    fromX: rows.map((r) => cx(r.col)),
    fromY: rows.map((r) => cy(r.row)),
    headCol: rows.map((r) => r.col),
    headRow: rows.map((r) => r.row),
    progress: rows.map(() => 0),
    wave: rows.map(() => 0),
    creepId: rows.map((r) => r.creepId ?? 'c-plain'),
    slowMulFp: rows.map(() => 0),
    slowUntilTick: rows.map(() => 0),
    stunUntilTick: rows.map((r) => r.stunUntilTick ?? 0),
  };
}

/**
 * Every `while (s.tick < N) step(...)` loop in this file goes through here rather
 * than a bare `while` (QC finding, M2-S6 fix pass). `step()` returning without
 * advancing `tick` — an early-return on a terminal phase that forgot to bump it, say
 * — would make a bare `while (s.tick < target)` spin forever: vitest's
 * `--testTimeout` cannot interrupt a synchronous loop, so a regression in the
 * guarded feature produces a HUNG CI job, not a red test (reproduced twice). `cap`
 * defaults generously above every target this file drives to except test 14's
 * deliberate run to `MAX_MATCH_TICKS`, which passes its own.
 */
function stepUntil(
  s: SimState,
  ruleset: CompiledRuleset,
  keepGoing: () => boolean,
  cap = 10_000,
): void {
  let iterations = 0;
  while (keepGoing()) {
    step(s, ruleset, []);
    iterations++;
    if (iterations > cap) {
      throw new Error(
        `stepUntil exceeded ${cap} iterations without satisfying its stop condition — ` +
          `step() is not advancing tick (hang guard, M2-S6 QC fix pass)`,
      );
    }
  }
}

function stunEffectOf(tower: TowerDef): { chanceNum: number; durationTicks: number } {
  const e = tower.effects.find((x) => x.kind === 'stun');
  if (e?.kind !== 'stun') throw new Error(`expected ${tower.id} to carry a stun effect`);
  return e;
}

function movementSnapshot(s: SimState): {
  fromX: number;
  fromY: number;
  headCol: number;
  headRow: number;
  progress: number;
} {
  return {
    fromX: s.creeps.fromX[0] as number,
    fromY: s.creeps.fromY[0] as number,
    headCol: s.creeps.headCol[0] as number,
    headRow: s.creeps.headRow[0] as number,
    progress: s.creeps.progress[0] as number,
  };
}

describe('1. draw determinism (m2.md: "stun chains are deterministic per seed")', () => {
  // SETUP: t-stun-chance (chanceNum 64) direct-then-stun, against c-plain, via one
  // hand-built `targeted` impact resolved by `runCombat` at tick 0 (no tower/
  // movement involved — isolates the draw itself). Seeds 208 (first draw 63 ->
  // stuns) and 354 (first draw 65 -> does not) sit on opposite sides of the
  // chanceNum 64 threshold — verified against `new Rng(seed).nextInt(256)` below,
  // per PLAN.md's own mutation-check table (which also names this pair).
  const chance = stunEffectOf(T_STUN_CHANCE);
  function oneImpact(): Impact {
    return {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 1,
      domain: 'ground',
      effects: [
        { kind: 'direct', amount: 4 },
        { kind: 'stun', chanceNum: chance.chanceNum, durationTicks: chance.durationTicks },
      ],
    };
  }
  function oneCreep(): CombatCreeps {
    return restingCreeps([{ id: 1, col: 5, row: 5, hp: 200 }]);
  }

  it('same seed -> byte-identical stunUntilTick across two independent runs', () => {
    const a = runCombatT(
      oneCreep(),
      emptyTowers(),
      [oneImpact()],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
      undefined,
      new Rng(208),
    );
    const b = runCombatT(
      oneCreep(),
      emptyTowers(),
      [oneImpact()],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
      undefined,
      new Rng(208),
    );
    // DERIVED, not measured (this file's own rule) — and load-bearing here: comparing
    // ONLY `a` to `b` is vacuous against a neutered `applyStun` that always writes `0`
    // (`0 === 0` still passes). Asserting each against the independently-derived
    // non-zero `satAdd(applicationTick, durationTicks)` — seed 208's first draw is 63,
    // which IS < chanceNum 64, so this run genuinely stuns — makes the comparison mean
    // something: both runs reaching the same REAL, non-zero value.
    const derived = satAdd(0, chance.durationTicks);
    expect(a.creeps.stunUntilTick[0]).toBe(derived);
    expect(b.creeps.stunUntilTick[0]).toBe(derived);
    expect(a.creeps.stunUntilTick[0]).toBe(b.creeps.stunUntilTick[0]);
  });

  it('seed 208 (draw 63) stuns; seed 354 (draw 65) does not — the divergence is in stunUntilTick, never a world-hash comparison (that would be vacuous — sim.test.ts:143-147)', () => {
    const draw208 = new Rng(208).nextInt(256);
    const draw354 = new Rng(354).nextInt(256);
    expect(draw208).toBe(63);
    expect(draw354).toBe(65);

    const resultA = runCombatT(
      oneCreep(),
      emptyTowers(),
      [oneImpact()],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
      undefined,
      new Rng(208),
    );
    const resultB = runCombatT(
      oneCreep(),
      emptyTowers(),
      [oneImpact()],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
      undefined,
      new Rng(354),
    );

    // DERIVED, not measured: stunUntilTick is `satAdd(applicationTick, durationTicks)`
    // exactly when the draw < chanceNum, else 0.
    expect(resultA.creeps.stunUntilTick[0]).toBe(
      draw208 < chance.chanceNum ? satAdd(0, chance.durationTicks) : 0,
    );
    expect(resultB.creeps.stunUntilTick[0]).toBe(
      draw354 < chance.chanceNum ? satAdd(0, chance.durationTicks) : 0,
    );
    expect(resultA.creeps.stunUntilTick[0]).not.toBe(resultB.creeps.stunUntilTick[0]);
  });

  // Mutation check 2 (PLAN.md Verification): `rng.nextInt(256) < effect.chanceNum`
  // mutated to `<=` is invisible to every OTHER seed in this file — it only differs
  // from the correct `<` at a draw EXACTLY EQUAL to chanceNum (64). Seed 75's first
  // draw is exactly 64 (verified below, matching PLAN.md's pre-computed figure) —
  // this is the one case that turns that mutation red.
  it('seed 75 (draw exactly 64) does NOT stun at chanceNum 64 — the strict `<` boundary', () => {
    const draw75 = new Rng(75).nextInt(256);
    expect(draw75).toBe(64);
    const result = runCombatT(
      oneCreep(),
      emptyTowers(),
      [oneImpact()],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
      undefined,
      new Rng(75),
    );
    expect(result.creeps.stunUntilTick[0]).toBe(0); // 64 is NOT < 64 — no stun
  });
});

describe('2. rngState draw-consumption rules (PASS 2 gating)', () => {
  // SETUP: t-stun-always (chanceNum 256 — guaranteed landing) direct-then-stun,
  // via a hand-built targeted impact and `runCombat` DIRECTLY (not `runCombatT` —
  // its `creepById` DEFAULTS to `{}`, which would erase c-stun-immune's immunity
  // unless every call passed the override). `RULESET.creepById` supplies the real
  // compiled defs. Seed/tick
  // are arbitrary (any seed) — chanceNum 256 makes the outcome seed-independent.
  const eff = stunEffectOf(T_STUN_ALWAYS);
  function impactFor(targetId: number): Impact {
    return {
      kind: 'targeted',
      impactTick: 0,
      targetId,
      sourceId: 1,
      domain: 'ground',
      effects: [
        { kind: 'direct', amount: 4 },
        { kind: 'stun', chanceNum: eff.chanceNum, durationTicks: eff.durationTicks },
      ],
    };
  }

  // A SHORTER stun landing on a longer active one must NOT truncate it: `applyStun`
  // takes the later expiry, not the newer write. Without this case the rule has no
  // witness at all — every fixture and every shipped tower uses `durationTicks: 20`,
  // so reverting `applyStun` to the unconditional write leaves the whole suite green
  // (measured: 525/525). Both impacts resolve in queue order on the same tick, so the
  // short one is applied strictly after the long one.
  it('a shorter stun does not cancel a longer active one — longest remaining wins', () => {
    const creeps = restingCreeps([{ id: 1, col: 5, row: 5, hp: 200, creepId: 'c-plain' }]);
    const stunFor = (durationTicks: number): Impact => ({
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 1,
      domain: 'ground',
      effects: [{ kind: 'stun', chanceNum: 256, durationTicks }],
    });
    const result = runCombat(
      creeps,
      emptyTowers(),
      [stunFor(20), stunFor(5)],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(1),
    );
    // DERIVED, not measured: the longer effect's own expiry, per the file's rule.
    expect(result.creeps.stunUntilTick[0]).toBe(satAdd(0, 20));
  });

  it('a stun-immune target consumes no draw — rngState unchanged, never stunned', () => {
    const creeps = restingCreeps([{ id: 1, col: 5, row: 5, hp: 200, creepId: 'c-stun-immune' }]);
    const rng = new Rng(1);
    const before = rng.getState();
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impactFor(1)],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      rng,
    );
    expect(rng.getState()).toBe(before);
    expect(result.creeps.stunUntilTick[0]).toBe(0);
  });

  it('a non-immune, non-lethal attempt consumes EXACTLY one draw', () => {
    const creeps = restingCreeps([{ id: 1, col: 5, row: 5, hp: 200, creepId: 'c-plain' }]);
    const rng = new Rng(1);
    runCombat(
      creeps,
      emptyTowers(),
      [impactFor(1)],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      rng,
    );
    const expected = new Rng(1);
    expected.nextU32(); // exactly one draw
    expect(rng.getState()).toBe(expected.getState());
  });

  it('a lethal hit consumes no draw — PASS 2 (every status kind) only runs when the creep survives PASS 1', () => {
    const creeps = restingCreeps([{ id: 1, col: 5, row: 5, hp: 4, creepId: 'c-plain' }]); // dies to the direct 4
    const rng = new Rng(1);
    const before = rng.getState();
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impactFor(1)],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      rng,
    );
    expect(rng.getState()).toBe(before);
    expect(result.creeps.hp).toHaveLength(0); // swept dead
  });
});

// Test 3 ("rngState byte-identical, stun-free") is rewritten in place at
// sim.test.ts's `#45` describe block — see this file's header.

describe('4. a forged non-uint32 rngState self-heals on the first tick', () => {
  it("coerces via >>> 0 — the SAME expression Rng's own constructor uses, no separate repair code", () => {
    const s = createInitialState(1, RULESET);
    const forged = -42;
    s.rngState = forged;
    step(s, RULESET, []); // this run's stun-free (nothing placed) — never draws
    expect(s.rngState).toBe(forged >>> 0);
  });

  // A NON-NUMBER is the case `Rng`'s own `>>> 0` cannot save, because `>>>` THROWS on a
  // BigInt or Symbol rather than coercing (Codex P2). Before M2-S6 `rngState` was inert,
  // so nothing dereferenced it and the sim's "forged state degrades deterministically,
  // never throws" posture held for free; activating the RNG is what put that at risk, so
  // `coerceSoa` now type-repairs the field ahead of the construction. Without that repair
  // this test does not fail an assertion — it throws a TypeError out of `step()`, which
  // is exactly the totality break being guarded.
  it('a forged NON-NUMBER rngState repairs rather than throwing out of step()', () => {
    for (const forged of [10n as unknown as number, Symbol('nope') as unknown as number]) {
      const s = createInitialState(1, RULESET);
      s.rngState = forged;
      expect(() => step(s, RULESET, [])).not.toThrow();
      expect(typeof s.rngState).toBe('number');
      expect(Number.isSafeInteger(s.rngState)).toBe(true);
    }
  });
});

describe('5/7. stun overrides slow (independent clocks) and the expiry boundary is inclusive', () => {
  // SETUP: a creep forged with an active slow (mulFp 128, expiring at tick 10 —
  // forged directly, mirroring story-slow.test.ts's own forged-status idiom),
  // then genuinely stunned by a real t-stun-always tower placed at tick 0 (impact
  // resolves tick 2, chanceNum 256 -> guaranteed, stunUntilTick = satAdd(2,20) =
  // 22 — DERIVED, asserted via `satAdd`, not the literal). Assertions taken at
  // tick 3 (just-stunned), tick 11 (slow expired, still stunned), tick 23 (both
  // expired) and one further tick (resumed movement).
  const ruleset = testRuleset(LANE, { extraTowers: [T_STUN_ALWAYS], extraCreeps: [C_PLAIN] });

  it('movement freezes byte-identical while stunned; the slow record clears on its OWN schedule underneath; movement resumes the tick after stun expires', () => {
    const s = createInitialState(1, ruleset);
    pushCreep(s, {
      id: 1,
      hp: 10_000,
      col: 5,
      row: 6,
      creepId: 'c-plain',
      slowMulFp: 128,
      slowUntilTick: 10,
    });
    step(s, ruleset, [
      { kind: 'placeTower', anchor: { col: 5, row: 3 }, towerId: 't-stun-always' },
    ]); // tick 0
    step(s, ruleset, []); // tick 1
    step(s, ruleset, []); // tick 2 — impact resolves
    expect(s.tick).toBe(3);
    const eff = stunEffectOf(T_STUN_ALWAYS);
    expect(s.creeps.stunUntilTick[0]).toBe(satAdd(2, eff.durationTicks)); // 22, DERIVED

    const frozen = movementSnapshot(s);

    stepUntil(s, ruleset, () => s.tick < 11);
    // Slow expired ON ITS OWN SCHEDULE (tick 10) — independent of the stun, which
    // is still live.
    expect(s.creeps.slowMulFp[0]).toBe(0);
    expect(s.creeps.slowUntilTick[0]).toBe(0);
    expect(s.creeps.stunUntilTick[0]).toBe(22);
    expect(movementSnapshot(s)).toEqual(frozen); // byte-identical to the frozen input

    stepUntil(s, ruleset, () => s.tick < 23); // still <= 22 -> held through this boundary
    expect(s.creeps.stunUntilTick[0]).toBe(0); // swept at the close of tick 22's combat
    expect(movementSnapshot(s)).toEqual(frozen); // T+D (22) still held — inclusive boundary

    step(s, ruleset, []); // tick 23 (T+D+1) — movement resumes
    expect(movementSnapshot(s)).not.toEqual(frozen);
  });
});

describe('6. stunned creep + maze change survives (the P3 hazard) and re-paths on the first tick it moves again', () => {
  // SETUP: the SAME 7x5 "WIDE" board movement.test.ts's own re-path fixture uses
  // (entrance (0,2), exit (6,2)) — a wall at (3,1)/(3,2) is documented there as
  // "the descent from (2,2) differs" once built. `c-plain` is pushed resting at
  // (2,2), then ONE ordinary (unstunned) tick moves it mid-edge toward (3,2)
  // (verified: headCol 3, progress 26 — its occupied CELL is still (2,2), the
  // exact cell the wall's descent change targets). `stunUntilTick` is then forged
  // to `satAdd(currentTick, T_STUN_ALWAYS's own durationTicks)` (read off the
  // fixture, not a literal) so it freezes from exactly this mid-edge point,
  // mirroring how a real `t-stun-always` hit would have landed it. The wall is
  // placed on the SAME tick the freeze is read for movement — WITHOUT P3's
  // `budget > 0` guard, the re-path TURN still executes at budget 0, corrupting
  // the row (a non-centre `from` point at `progress === 0`) so it is DROPPED the
  // VERY NEXT tick (mutation check 4 — verified empirically before writing this
  // test: the corruption is silent for one tick, then the row vanishes).
  it('does not drop, holds through the freeze byte-identical, and resumes/re-paths cleanly once unstunned', () => {
    const ruleset = testRuleset(
      { widthTiles: 7, heightTiles: 5, entrance: { col: 0, row: 2 }, exit: { col: 6, row: 2 } },
      { extraCreeps: [C_PLAIN] },
    );
    const s = createInitialState(1, ruleset);
    pushCreep(s, { id: 1, hp: 200, col: 2, row: 2, creepId: 'c-plain' });
    step(s, ruleset, []); // one ordinary tick -> mid-edge, unstunned
    expect(s.creeps.progress[0]).toBeGreaterThan(0); // genuinely mid-segment
    expect(s.creeps.headCol[0]).toBe(3); // heading toward (3,2), pre-wall descent

    const eff = stunEffectOf(T_STUN_ALWAYS);
    s.creeps.stunUntilTick[0] = satAdd(s.tick, eff.durationTicks);
    const stunUntil = s.creeps.stunUntilTick[0] as number;
    const frozen = movementSnapshot(s);

    const wallA = { kind: 'placeTower', anchor: { col: 3, row: 1 }, towerId: 'basic' } as const;
    const wallB = { kind: 'placeTower', anchor: { col: 3, row: 2 }, towerId: 'basic' } as const;
    step(s, ruleset, [wallA, wallB]); // the maze change, while stunned — must not drop
    expect(s.creeps.id).toEqual([1]); // survived
    expect(movementSnapshot(s)).toEqual(frozen); // byte-identical — the turn deferred

    stepUntil(s, ruleset, () => s.tick <= stunUntil);
    expect(s.creeps.id).toEqual([1]); // still alive through the whole hold
    expect(movementSnapshot(s)).toEqual(frozen);

    // Unstunned now — re-paths (onto the now-different descent) and keeps moving
    // without being dropped.
    for (let i = 0; i < 20 && s.creeps.id.length > 0; i++) step(s, ruleset, []);
    expect(s.creeps.id).toEqual([1]);
    expect(movementSnapshot(s)).not.toEqual(frozen);
  });

  // ...AND IT STAYS TARGETABLE WHILE FROZEN (Codex P2). Surviving the maze change is only
  // half the requirement. The two `basic` towers built above are real, damaging towers in
  // range, and one of them sits on (3,2) — the exact cell this creep's head points at — so
  // the stunned row now carries a head whose `distAt` is negative. `remainingRouteDist`
  // used to return `null` for that and `runCombat` skipped the creep entirely, which meant
  // a stunned creep became UNSHOOTABLE for the whole stun: the player freezes something and
  // is then unable to kill it. It cannot re-path its way out either, because re-pathing
  // needs movement and it has none.
  //
  // The witness is damage, not a live-list peek: hp must fall while frozen. This fails
  // without the from-cell fallback in `remainingRouteDist`, and it fails as a plain
  // assertion rather than a crash, which is what makes it a usable regression guard.
  it('stays TARGETABLE while frozen even though the build blocked its head cell', () => {
    const ruleset = testRuleset(
      { widthTiles: 7, heightTiles: 5, entrance: { col: 0, row: 2 }, exit: { col: 6, row: 2 } },
      { extraCreeps: [C_PLAIN] },
    );
    const s = createInitialState(1, ruleset);
    pushCreep(s, { id: 1, hp: 200, col: 2, row: 2, creepId: 'c-plain' });
    step(s, ruleset, []);
    expect(s.creeps.headCol[0]).toBe(3);

    const eff = stunEffectOf(T_STUN_ALWAYS);
    s.creeps.stunUntilTick[0] = satAdd(s.tick, eff.durationTicks);
    const stunUntil = s.creeps.stunUntilTick[0] as number;

    step(s, ruleset, [
      { kind: 'placeTower', anchor: { col: 3, row: 1 }, towerId: 'basic' },
      { kind: 'placeTower', anchor: { col: 3, row: 2 }, towerId: 'basic' },
    ]);
    const hpAfterBuild = s.creeps.hp[0] as number;
    expect(s.creeps.id).toEqual([1]);

    stepUntil(s, ruleset, () => s.tick <= stunUntil);
    expect(s.creeps.id).toEqual([1]); // still alive (hp 200 outlasts the hold)
    expect(s.creeps.hp[0] as number).toBeLessThan(hpAfterBuild); // and genuinely shot at
  });
});

describe('8. resolute-shape slow immunity: applySlow never writes, speed unchanged', () => {
  // SETUP: TEST_SLOW_TOWER (test-support's mirror of the shipped `slow` tower:
  // direct 2, slow mulFp 128 duration 40) against c-slow-immune, via `runCombat`
  // directly (needs the real `creepById` for the immunity lookup). Any seed —
  // slow has no chance roll.
  it('slowMulFp/slowUntilTick stay at (0,0); the direct hit still lands (immunity is per-kind, not blanket)', () => {
    const slowEff = TEST_SLOW_TOWER.effects.find((e) => e.kind === 'slow');
    const directEff = TEST_SLOW_TOWER.effects.find((e) => e.kind === 'direct');
    if (slowEff?.kind !== 'slow' || directEff?.kind !== 'direct') {
      throw new Error('expected TEST_SLOW_TOWER to carry direct+slow effects');
    }
    const impact: Impact = {
      kind: 'targeted',
      impactTick: 0,
      targetId: 1,
      sourceId: 1,
      domain: 'ground',
      effects: [
        { kind: 'direct', amount: directEff.damage },
        { kind: 'slow', mulFp: slowEff.mulFp, durationTicks: slowEff.durationTicks },
      ],
    };
    const creeps = restingCreeps([{ id: 1, col: 5, row: 5, hp: 200, creepId: 'c-slow-immune' }]);
    const result = runCombat(
      creeps,
      emptyTowers(),
      [impact],
      [],
      0,
      0,
      FIELD,
      GRID,
      {},
      RULESET.creepById,
      SF_NUM,
      SF_DEN,
      new Rng(1),
    );
    expect(result.creeps.slowMulFp[0]).toBe(0);
    expect(result.creeps.slowUntilTick[0]).toBe(0);
    expect(result.creeps.speed[0]).toBe(26); // the test's own name's claim, actually read
    expect(result.creeps.hp[0]).toBe(200 - directEff.damage); // direct still applies
  });
});

describe('9/14. chain-lock is permitted (Rob, 2026-08-04): two stun towers, offset by 20 ticks, hold one creep indefinitely', () => {
  // SETUP: two t-stun-blank towers (chanceNum 256, duration 20, cadence 40)
  // placed at T=0 and T=20, with c-blanked (armor 6, blanks the tower's damage 4
  // to zero) resting in range of BOTH anchors from before either placement
  // (pushCreep, never spawned via a wave) — the precondition PLAN.md P8 names for
  // genuine phase interleave: a tower's fire phase is set by its FIRST FIRE, and
  // both towers must first-fire on their own placement tick, 20 apart, for
  // continuous coverage. The counterplay is opportunity cost: these two towers
  // are permanently committed to holding this one creep and kill nothing else.
  function buildLockedState(): { s: SimState; ruleset: ReturnType<typeof testRuleset> } {
    const ruleset = testRuleset(LANE, { extraTowers: [T_STUN_BLANK], extraCreeps: [C_BLANKED] });
    const s = createInitialState(1, ruleset);
    pushCreep(s, {
      id: 1,
      hp: 200,
      col: 6,
      row: 6,
      creepId: 'c-blanked',
      speed: C_BLANKED.speedFp,
    });
    step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 6, row: 4 }, towerId: 't-stun-blank' }]); // T=0
    stepUntil(s, ruleset, () => s.tick < 20);
    step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 6, row: 8 }, towerId: 't-stun-blank' }]); // T=20
    return { s, ruleset };
  }

  it('test 9: the creep never moves and never takes damage, measured over 500 ticks', () => {
    const { s, ruleset } = buildLockedState();
    const frozen = movementSnapshot(s);
    stepUntil(s, ruleset, () => s.tick < 500);

    expect(s.creeps.hp[0]).toBe(200); // armor 6 blanks damage 4 to zero, forever
    expect(s.creeps.stunUntilTick[0]).toBeGreaterThanOrEqual(s.tick); // still actively locked
    expect(movementSnapshot(s)).toEqual(frozen);
    expect(s.towers.towerId.filter((id) => id === 't-stun-blank')).toHaveLength(2); // both still stand
  });

  it("test 14: the lock is genuinely nonterminal within MAX_MATCH_TICKS — a timeout, not a hang (packages/replay's own rejection case, not importable here — see below)", () => {
    // `packages/sim` cannot import `@wynding/replay` to call its `validate()`
    // directly: `@wynding/replay` itself depends on `@wynding/sim` (its own
    // package.json), so the reverse import would be a circular package AND
    // TypeScript project-reference graph, which `tsc`'s project references (and
    // this monorepo's turbo `^typecheck`/`^build` pipelines) reject outright as a
    // cycle. This test instead proves directly, over the sim alone, exactly what
    // `packages/replay/src/index.ts`'s own validator loop checks: driving to
    // `MAX_MATCH_TICKS` (the SAME constant the validator imports, re-exported by
    // `./index`) without ever reaching a terminal phase — its own "timeout"
    // rejection branch, verbatim. FINDING FOR ROB (deviation from the plan's
    // literal wording "rejected by the replay validator"): the assertion below is
    // the closest available proof without introducing a circular dependency.
    //
    // The injected creep shares wave index 0 (pushCreep's default) with the
    // ruleset's own single generated wave, so `waveResolved[0]` can never become
    // true while it survives (aliveByWave[0] stays > 0 forever) — the match can
    // never reach 'won' regardless of what that other wave does. Its own single
    // spawn is pushed to the tail of the tick budget (countdownTicks 30,000 — the
    // largest this board's compile-time bound gate accepts alongside the board's
    // own traversal-ticks term) so it plays no role either way: even a leak from
    // it costs at most one life against the default starting 10, never 'lost'.
    const bundle = testBundle(LANE, {
      extraTowers: [T_STUN_BLANK],
      extraCreeps: [C_BLANKED],
      countdownTicks: 30_000,
      waveCount: 1,
    });
    const ruleset = compileRuleset(bundle, 'test');
    const s = createInitialState(1, ruleset);
    pushCreep(s, {
      id: 1,
      hp: 200,
      col: 6,
      row: 6,
      creepId: 'c-blanked',
      speed: C_BLANKED.speedFp,
    });
    step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 6, row: 4 }, towerId: 't-stun-blank' }]); // T=0
    stepUntil(s, ruleset, () => s.tick < 20);
    step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 6, row: 8 }, towerId: 't-stun-blank' }]); // T=20
    // `cap` is bumped above MAX_MATCH_TICKS itself here — this loop's WHOLE POINT is
    // to drive to that target, unlike every other call site's smaller ones.
    stepUntil(s, ruleset, () => s.tick < MAX_MATCH_TICKS, MAX_MATCH_TICKS + 1_000);

    expect(s.tick).toBe(MAX_MATCH_TICKS);
    expect(isTerminalPhase(s.phase)).toBe(false);
    expect(s.phase).toBe('running');
  });
});

describe("10. blast draw order follows blastMembers' creep-id ascending order — provably, not vacuously", () => {
  // SETUP: t-stun-aoe (chanceNum 64) fired as a single blast Impact covering
  // three c-plain creeps at the same point, in a SHUFFLED SoA row order (ids 3,
  // 1, 2) but ascending ids 1, 2, 3. Seed 23's first three draws are 46, 91, 62
  // (verified against `new Rng(23)` below, matching PLAN.md's own pre-computed
  // figures exactly) -> STUN(46<64), no-stun(91>=64), STUN(62<64) — assigned by
  // ASCENDING id, never row order. A row-order traversal over this exact shuffle
  // would instead land draw 46 on id 3, 91 on id 1, and 62 on id 2 — flipping id
  // 1 from stunned to not and id 3 from stunned to... (still stunned, by luck of
  // this particular shuffle+seed combination, which is exactly why the ASSIGNMENT
  // below is checked per id, not just the multiset of outcomes) not, so this
  // assertion set is NOT satisfied by a wrong (row-order) traversal.
  it('draws attach to ascending creep id, not SoA row order', () => {
    const stun = stunEffectOf(T_STUN_AOE);
    const direct = T_STUN_AOE.effects.find((e) => e.kind === 'direct');
    if (direct?.kind !== 'direct' || direct.form !== 'aoe') {
      throw new Error('expected t-stun-aoe to carry an aoe direct effect');
    }
    const r = new Rng(23);
    const draws = [r.nextInt(256), r.nextInt(256), r.nextInt(256)];
    expect(draws).toEqual([46, 91, 62]);

    const CENTER = { x: cx(6), y: cy(6) };
    const creeps = restingCreeps([
      { id: 3, col: 6, row: 6, hp: 200, creepId: 'c-plain' },
      { id: 1, col: 6, row: 6, hp: 200, creepId: 'c-plain' },
      { id: 2, col: 6, row: 6, hp: 200, creepId: 'c-plain' },
    ]);
    const impact: Impact = {
      kind: 'blast',
      impactTick: 0,
      x: CENTER.x,
      y: CENTER.y,
      radiusFp: direct.radiusFp,
      sourceId: 1,
      domain: 'ground',
      effects: [
        { kind: 'direct', amount: direct.damage },
        { kind: 'stun', chanceNum: stun.chanceNum, durationTicks: stun.durationTicks },
      ],
    };
    const result = runCombatT(
      creeps,
      emptyTowers(),
      [impact],
      0,
      0,
      FIELD,
      GRID,
      {},
      SF_NUM,
      SF_DEN,
      undefined,
      new Rng(23),
    );
    const byId = new Map<number, number>();
    result.creeps.id.forEach((id, i) =>
      byId.set(id as number, result.creeps.stunUntilTick[i] as number),
    );
    // DERIVED from `draws` (this file's test 1 already sets the discipline: derive
    // the expected outcome from the draw itself, never hardcode which ids stun) —
    // `draws[k]` is the k-th ascending-id creep's roll (id 1, 2, 3 in that order),
    // so `byId.get(k+1)` must equal `satAdd(applicationTick, durationTicks)` exactly
    // when `draws[k] < chanceNum`, else 0.
    [1, 2, 3].forEach((id, k) => {
      expect(byId.get(id)).toBe(draws[k]! < stun.chanceNum ? satAdd(0, stun.durationTicks) : 0);
    });
  });
});

describe('11. a blast fired at a stunned creep leads ahead of it and CAN miss; an unstunned control at the same position is hit', () => {
  // SETUP: t-blast-lead (travelTicks 8, radiusFp 256) against c-swift (speed 44):
  // lead = 44 x 8 = 352 fp, clearing the 256 fp radius (splash's own 384 fp
  // radius would NOT be cleared by a `fast` creep's lead, per PLAN.md's own
  // worked reasoning — this dedicated fixture exists precisely so the miss is
  // real, not vacuous). Two fresh states, same anchor/position/tick; the only
  // difference is a pre-set `stunUntilTick` on the target (forged directly,
  // mirroring story-slow.test.ts's forged-status idiom) covering the whole
  // 8-tick flight, so the target is provably motionless throughout.
  const ruleset = testRuleset(LANE, { extraTowers: [T_BLAST_LEAD], extraCreeps: [C_SWIFT] });
  const anchor = { col: 5, row: 3 };
  const START = { col: 5, row: 6 };
  const damage = T_BLAST_LEAD.effects.find((e) => e.kind === 'direct');
  if (damage?.kind !== 'direct') throw new Error('expected t-blast-lead to carry a direct effect');

  it('stunned target: no damage (miss); unstunned control: damage taken (hit)', () => {
    // `pushCreep`'s `speed` column is independent of `creepId` (it does not look up
    // the catalog) — must be set explicitly to C_SWIFT.speedFp (44), or the SoA
    // row silently carries `pushCreep`'s own default (26) and the lead is wrong.
    const stunned = createInitialState(1, ruleset);
    pushCreep(stunned, {
      id: 1,
      hp: 200,
      col: START.col,
      row: START.row,
      creepId: 'c-swift',
      speed: C_SWIFT.speedFp,
      stunUntilTick: 1000, // covers the whole 8-tick flight
    });
    step(stunned, ruleset, [{ kind: 'placeTower', anchor, towerId: 't-blast-lead' }]);
    for (let i = 0; i < 8; i++) step(stunned, ruleset, []);
    expect(stunned.creeps.hp[0]).toBe(200); // MISS — the lead outran the stationary target

    const control = createInitialState(1, ruleset);
    pushCreep(control, {
      id: 1,
      hp: 200,
      col: START.col,
      row: START.row,
      creepId: 'c-swift',
      speed: C_SWIFT.speedFp,
    });
    step(control, ruleset, [{ kind: 'placeTower', anchor, towerId: 't-blast-lead' }]);
    for (let i = 0; i < 8; i++) step(control, ruleset, []);
    expect(control.creeps.hp[0]).toBe(200 - damage.damage); // HIT — real movement matched the lead
  });
});

describe('12. previewInputs purity over a forged stun column (the P1 COW discipline)', () => {
  it('a forged stunUntilTick repairs in the PREVIEW clone only — the source array is never mutated', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 10, col: 6, row: 6, creepId: 'c-plain' });
    s.creeps.stunUntilTick = [-5]; // invalid — needs repair
    Object.freeze(s.creeps.stunUntilTick);
    expect(() => previewInputs(s, RULESET, [{ kind: 'noop' }])).not.toThrow();
    const { preview } = previewInputs(s, RULESET, [{ kind: 'noop' }]);
    expect(preview.creeps.stunUntilTick[0]).toBe(0); // repaired in the preview clone
    expect(s.creeps.stunUntilTick[0]).toBe(-5); // source untouched
  });
});

describe("coerceSoa's AUTHORITATIVE expired-stun repair (QC fix pass — zero prior coverage: test 12 above only exercises the 'preview' call site; every real step() goes through 'authoritative' and, before this, had no stun-repair coverage at all)", () => {
  // Both cases below freeze the state at a TERMINAL phase (`won`) before calling
  // `step()`, rather than driving a live/running row as PLAN.md's literal wording
  // for this fix suggested ("the row moves that tick"). That is a deliberate,
  // measured deviation, not a shortcut: `coerceSoa(..., 'authoritative')` runs at
  // the very top of `step()`, BEFORE the "FREEZE ON TERMINAL" early return
  // (index.ts) — so it is the ONLY thing that ever touches `stunUntilTick` on a
  // terminal step, with no movement phase and no combat phase running afterward.
  // On a RUNNING tick, by contrast, this repair is invisibly double-backed: the
  // movement phase's OWN `stunUntilTick >= state.tick` comparison already treats
  // an invalid/expired value as "not stunned" without needing it zeroed, and
  // combat's end-of-tick expiry sweep (`combat.ts`, same tick, same `<=`
  // condition) independently clears it again regardless of whether coerceSoa did.
  // Verified empirically before writing this test: a running-tick version of
  // these two cases (forged/expired stunUntilTick, assert movement proceeds) stays
  // GREEN even with this repair fully disabled — exactly the false-negative shape
  // this fix exists to close. The terminal-freeze construction is the only
  // scenario that isolates the repair from both safety nets, so it is what
  // actually goes red under the mutation below (verified in $TMPDIR).
  it('a forged non-integer stunUntilTick = 1.5 repairs to 0 via the authoritative coerceSoa call alone, on an otherwise-frozen terminal step', () => {
    // 1.5, not a negative value: a fresh state's `tick` is 0, and a NEGATIVE forged
    // value is ALSO `< repairTick` for any repairTick ≥ 0 — so it would be caught
    // redundantly by the sibling "already expired" clause below, not this one,
    // making the two cases test the same branch under the hood. A non-integer,
    // non-negative value isolates the OTHER clause (`Number.isSafeInteger` failure)
    // cleanly: it is invalid, but not "expired" by the `< repairTick` comparison.
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 200, col: 6, row: 6, creepId: 'c-plain' });
    s.phase = 'won'; // terminal — movement/combat never run this step
    s.creeps.stunUntilTick[0] = 1.5; // forged — not a safe integer
    step(s, RULESET, []);
    expect(s.phase).toBe('won'); // still the terminal no-op path
    expect(s.creeps.stunUntilTick[0]).toBe(0); // repaired by coerceSoa alone
  });

  it('an already-expired forged stunUntilTick (tick 50, stunUntilTick 10) is likewise repaired by the authoritative coerceSoa call alone, on an otherwise-frozen terminal step', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 1, hp: 200, col: 6, row: 6, creepId: 'c-plain' });
    s.tick = 50;
    s.phase = 'won'; // terminal — movement/combat never run this step
    s.creeps.stunUntilTick[0] = 10; // stunUntilTick < repairTick(50) — already expired
    step(s, RULESET, []);
    expect(s.phase).toBe('won');
    expect(s.tick).toBe(50); // frozen — proves movement/combat did not also fix this
    expect(s.creeps.stunUntilTick[0]).toBe(0); // repaired
  });
});

describe('13. a bundle carrying a stun tower still compiles (bound gate not regressed to unbounded)', () => {
  // A REAL WITNESS for "the bound gate at ruleset.ts deliberately ignores stun"
  // (QC fix pass — the earlier form only read fields off the already-compiled
  // module-level `RULESET`, which would pass unchanged even with no bound gate at
  // all; reverting the capability profile kills it by collection, not by failing
  // it). `maxTraversalTicks` (ruleset.ts) is a pure function of board geometry and
  // `minEffSpeedFp`, itself derived only from creep speed and the catalog's SLOW
  // multiplier — the presence of a `stun` effect never enters that computation. So
  // an unregressed gate must accept/reject on the EXACT SAME wave-`countdownTicks`
  // boundary whether or not the catalog carries a stun tower. Binary-search that
  // boundary for a bundle WITH `t-stun-always` in its catalog and for an otherwise-
  // identical bundle WITHOUT it, and assert they land on the identical tick. If the
  // gate ever started modelling stun (treating a stunned creep's speed as 0 — the
  // rejected alternative `ruleset.ts`'s own comment names, which would make
  // `maxTraversalTicks` infinite and reject every stun-carrying bundle), the
  // with-stun boundary would collapse to below zero while the stun-free one stayed
  // put, and this assertion would fail.
  function compiles(withStun: boolean, countdownTicks: number): boolean {
    try {
      testRuleset(LANE, {
        extraTowers: withStun ? [T_STUN_ALWAYS] : [],
        countdownTicks,
      });
      return true;
    } catch (err) {
      // Narrow deliberately: only a capability/bound REJECTION counts as "does not
      // compile". A bare `catch` would swallow a TypeError from a mistyped fixture and
      // report it as a rejection, silently moving the binary-search boundary and making
      // the with-stun/stun-free comparison agree for the wrong reason — which would
      // hollow out the very assertion this probe exists to make.
      if (err instanceof RulesetError) return false;
      throw err;
    }
  }

  // `compiles` is monotone non-increasing in `countdownTicks` (a larger countdown
  // only ever pushes `latestSpawnTick` later, never earlier), so a binary search
  // over a range known to compile at its low end and reject at its high end finds
  // the exact boundary in O(log n) compiles.
  function boundary(withStun: boolean): number {
    let lo = 1; // countdownTicks must be a positive int (schema)
    let hi = 40_000; // > MAX_MATCH_TICKS (36_000) with slack — known to reject
    if (!compiles(withStun, lo)) throw new Error('probe lower bound unexpectedly rejects');
    if (compiles(withStun, hi)) throw new Error('probe upper bound unexpectedly compiles');
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (compiles(withStun, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  it('compiles without throwing, and the bound gate finds the SAME terminal-tick boundary with and without a stun tower in the catalog', () => {
    expect(() =>
      testRuleset(LANE, { extraTowers: [T_STUN_ALWAYS], extraCreeps: [C_PLAIN] }),
    ).not.toThrow();

    const withStunBoundary = boundary(true);
    const withoutStunBoundary = boundary(false);
    expect(withStunBoundary).toBeGreaterThan(0); // a real, finite boundary was found
    expect(withStunBoundary).toBe(withoutStunBoundary);
  });
});

// Test 15 is deleted (QC fix pass): both its assertions were guaranteed by
// construction (reading fields off the already-compiled module-level `RULESET`),
// so reverting the sv10 capability profile would kill it by collection ("no
// tests"), not by failing it. `capability.test.ts` already covers sv10's accepted
// kinds and both immunities per-dimension — see that file, not a re-derivation here.

// Test 16 (renderer warded-totality guard on an unresolved creepId) is a
// render-only concern with no sim-side expression — verified covered at
// packages/render/src/render.test.ts:258-274 (see this file's header).

// Test 17 (the wave-index-4 measured golden) lives in
// packages/content/src/story-armored-wave.test.ts (see this file's header).
