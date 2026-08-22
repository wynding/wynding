// story-flying-wave.test.ts — the M2-S7 P6 pinned wave-5 measurement (PLAN.md §P6).
//
// LOCATION NOTE, same reasoning as `story-armored-wave.test.ts`'s own header: this file
// lives beside `parity.test.ts` (not in `packages/sim`, which cannot import
// `@wynding/content`) so every scenario below runs the REAL shipped `wynding-core`
// bundle through `compileRuleset` → `step()`, not a hand-assembled replica of wave 5.
//
// PURPOSE: closing the gap this story exists to close (an independent review's P2
// finding) — the catalog carried the `flying` creep and the `antiair` tower, but no
// wave spawned `flying`, so the whole air mechanic was unreachable in the shipped
// product. This file witnesses S7's own done-criteria (m2.md Story 7) against the
// bundle now that wave index 5 (8 × `flying`, appended by this packet) actually spawns
// it:
//   - flyers cross a full maze untouched by ground towers;
//   - flyers die to `antiair`;
//   - flyers are slowed by `slow` (now both-domain);
//   - placement over a flyer's occupied cell succeeds.
//
// Every scenario below shares one baseline: a small `basic` wall (waves 0-2) plus a
// `venom` pair built ahead of wave 3 (armored) — the IDENTICAL geometry
// `story-armored-wave.test.ts` proved clears waves 0-4 with zero leaks and all ten
// starting lives intact. Reusing a proven wall keeps each scenario's own build (the
// part that's actually under test) isolated to wave 5 alone, rather than re-deriving
// "does this survive the first five waves" in every `it`.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run story-flying-wave
// after temporarily logging the values (see parity.test.ts's header for the harness
// pattern) — never hand-compute a golden.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  compileRuleset,
  deriveScore,
  deriveStars,
  MAX_MATCH_TICKS,
  type SimInput,
  type SimState,
  type CompiledRuleset,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import {
  waveIndexForCreep,
  wallInputsFromTick,
  wallInputsFromObservedWave,
  waveLaunchTickObserved,
} from './wave-lookup';

/** Fixed seed — same convention as parity.test.ts / story-armored-wave.test.ts. */
const SCENARIO_SEED = 0x5eed;

/** Fixed-point cell size (`FP_ONE`, `@wynding/engine`), inlined rather than imported
 *  for the same reason `parity.test.ts` inlines `fnv1a`: pulling in the engine package
 *  for one constant would add a runtime dependency edge this file doesn't otherwise
 *  need. Used only to derive a live flyer's occupied CELL from its raw fixed-point
 *  `fromX`/`fromY` columns — see the last `it` below, the only place that needs it. */
const FP_ONE = 256;

// The proven `basic` wall (waves 0-2) — byte-identical anchors to
// `story-armored-wave.test.ts`'s `basicAnchors`: a `basic` pair at columns 2, 6 and 10
// (rows 10 and 12, flanking the row-11 lane), six towers total, cost 30 of the
// starting 80 bounty.
const basicAnchors: { col: number; row: number }[] = [
  { col: 2, row: 10 },
  { col: 2, row: 12 },
  { col: 6, row: 10 },
  { col: 6, row: 12 },
  { col: 10, row: 10 },
  { col: 10, row: 12 },
];

// The `venom` pair built ahead of wave 3 (`armored`) — column 16, rows 10 and 12, the
// same flanking geometry one lane further back, byte-identical to
// `story-armored-wave.test.ts`'s `column16Anchors`.
const column16Anchors: { col: number; row: number }[] = [
  { col: 16, row: 10 },
  { col: 16, row: 12 },
];

/** The shared baseline build: the `basic` wall plus the `venom` pair, anchored 200 ticks
 *  after the `armored` wave's own OBSERVED countdown start (located by creep id, never a
 *  hardcoded index; S11 P2) — exactly `story-armored-wave.test.ts`'s first scripted
 *  build, proven there to clear waves 0-4 with zero leaks and all ten lives intact. Each
 *  scenario below layers its OWN `flying`-wave-scoped towers on top via `extra`. */
function baselineInputs(
  ruleset: CompiledRuleset,
  extra: (tick: number, state: SimState) => SimInput[],
): (tick: number, state: SimState) => SimInput[] {
  const basicWall = wallInputsFromTick(basicAnchors, 'basic');
  const armoredWaveIndex = waveIndexForCreep(ruleset, 'armored');
  const venomWall = wallInputsFromObservedWave(
    ruleset,
    armoredWaveIndex,
    column16Anchors,
    'venom',
    200,
  );
  return (tick: number, state: SimState): SimInput[] => {
    const out = basicWall(tick);
    out.push(...venomWall(tick, state));
    out.push(...extra(tick, state));
    return out;
  };
}

describe('wave 5 (the appended `flying` wave) — S7 done-criteria, each measured', () => {
  // SHARED SCENARIO (S11 P2 completion): the proven ground-only wave-0-4 wall, no
  // `antiair`, run to terminal ONCE — the mechanism-proof test below (untouched proof +
  // the de-indexed "leaked, not killed" claim) and its outcome-golden sibling (the full
  // terminal state, which a mutation check shows is genuinely position-sensitive) both
  // read off this SAME run's results. vitest runs `it`s in declaration order within a
  // file (no `.concurrent` is used anywhere in this file).
  let groundOnlyResult: {
    ruleset: CompiledRuleset;
    state: SimState;
    flyingWaveIndex: number;
    sawAnyFlyer: boolean;
  } | null = null;

  function runGroundOnlyWall() {
    if (groundOnlyResult) return groundOnlyResult;
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const inputs = baselineInputs(ruleset, () => []);
    const flyingDef = ruleset.creepById['flying'];
    if (!flyingDef) throw new Error("expected a compiled 'flying' creep");
    const flyingWaveIndex = waveIndexForCreep(ruleset, 'flying');

    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    // PROOF THE FEATURE ENGAGED, before any terminal measurement: every `flying`
    // creep observed, on every tick it exists, sits at exactly its spawn HP — no
    // ground tower in this build (`basic`, `venom`) attacks the `air` domain, so
    // nothing should ever land a hit. This is the literal witness for "untouched",
    // not just an inference from the leak count below.
    let sawAnyFlyer = false;
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
      state = step(state, ruleset, inputs(t, state));
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'flying') {
          sawAnyFlyer = true;
          expect(state.creeps.hp[i]).toBe(flyingDef.hp);
        }
      }
    }
    groundOnlyResult = { ruleset, state, flyingWaveIndex, sawAnyFlyer };
    return groundOnlyResult;
  }

  it(
    'a ground-only wall (the proven wave-0-4 build, no `antiair`) leaves wave 5 untouched — it crosses the whole maze and leaks in full',
    { timeout: 120_000 },
    () => {
      const { state, flyingWaveIndex, sawAnyFlyer } = runGroundOnlyWall();
      expect(sawAnyFlyer).toBe(true);

      // THE S11 P2 MECHANISM CLAIM, de-indexed (a mutation check — swap arc rows 6/7 — shows
      // this holds independent of anything past wave 5, unlike the full-array terminal pins
      // moved to the outcome-golden sibling below): wave 5 (`flying`, located by creep id)
      // leaked — and combined with the untouched proof above (every observed flyer sat at
      // exactly its spawn HP, so none was ever killed), every flyer that spawned left the
      // sim via leak, i.e. "leaks in full".
      expect(state.waveLeaked[flyingWaveIndex]).toBe(true);
    },
  );

  // OUTCOME GOLDEN (position-sensitive by nature, re-measured when the arc moves) — split
  // out of the mechanism-proof test above at S11 P2 completion. Same run as that test
  // (`runGroundOnlyWall`'s module-level memo), same literals as before this split —
  // nothing here was re-measured, only re-homed.
  it(
    'a ground-only wall (the proven wave-0-4 build, no `antiair`) — the full-game terminal state, outcome golden (position-sensitive by nature, re-measured when the arc moves)',
    { timeout: 120_000 },
    () => {
      const { ruleset, state } = runGroundOnlyWall();

      // --- THE MEASUREMENT — measured, not invented. Re-pinned M2-S10 P3: the loop
      // above now runs to terminal under `MAX_MATCH_TICKS` rather than a fixed 2400
      // ticks, and the OUTCOME FLIPS 'won' → 'lost' (Story 10 Risk 1 ruling: reported
      // for S11's balance pass, never tuned away). This build stays exactly the proven
      // waves-0-4 wall plus nothing new — it has no answer for `air`-domain creeps at
      // all, so after wave index 5's 8 `flying` leak in full (lives 10 → 2, as
      // measured under M2-S7), wave index 6's `armored-flyer` (also air, and armored
      // besides) leaks too: its first two leaks (spaced 20 ticks apart, each its own
      // tick) drain lives 2 → 1 → 0, and the run FREEZES there — before wave index 6
      // finishes launching its remaining four `armored-flyer`, and long before wave
      // index 7 (the boss) ever launches. `waveResolved[6]` and `waveResolved[7]` both
      // stay `false`; `waveLeaked[6]` is `true` (at least one leak observed) even
      // though the wave itself never finished resolving.
      // Re-pinned M2-S11 P3 (measured). P1's
      // ten-wave arc inserts a new wave 4 (12x`normal`+6x`swarm`) before `flying` (which
      // stays at index 5 — the insertion lands before it, not after), and pushes
      // `armored-flyer` to index 7 and the boss to index 9. This build's own baseline
      // (byte-identical to `story-armored-wave.test.ts`'s first script) now clears the
      // new wave 4 too, so its terminal figures move by the same amount as that file's
      // test 1 — see that test's own comment for the full before/after derivation.
      // Re-measured final at P4b — unchanged from P3 (this ground-only build never
      // reaches the boss/antiair/survival mechanics P4 tuned; it freezes at 0 lives
      // before wave index 9 ever launches).
      console.log(
        `[story-flying-wave #1] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
          `leaked=${state.leakedCount} bounty=${state.bounty} hash=${hashSimState(state)} ` +
          `score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)}`,
      );
      expect(state.phase).toBe('lost');
      expect(state.tick).toBe(2886);
      expect(state.lives).toBe(0);
      expect(state.leakedCount).toBe(10);
      expect(state.waveResolved).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
        false,
      ]);
      // Wave index 5 leaked in full (8), and wave index 7 leaked at least once (2, the
      // pair that drove lives to 0) before the freeze cut it off mid-wave.
      expect(state.waveLeaked).toEqual([
        false,
        false,
        false,
        false,
        false,
        true,
        false,
        true,
        false,
        false,
      ]);
      expect(state.waveCursor).toBe(8);
      // cumulativeKillBounty re-measured at 102 (+18 over the pre-S11 84): the new wave 4
      // contributes its own kills; wave index 5 contributes 0 kills (only leaks), and
      // wave index 7's two observed leaks before the freeze also contribute 0 kills.
      expect(state.cumulativeKillBounty).toBe(102);
      expect(state.bounty).toBe(165);
      expect(hashSimState(state)).toBe('bd6516b9');
      // Re-pinned #25 (SIM_VERSION 15 → 16, measured): score 102 → 0. The sv16 lost
      // branch forfeits the kill bounty too, so the 102 pinned above grades nothing.
      expect(deriveScore(state, ruleset)).toBe(0);
      expect(deriveStars(state, ruleset)).toBe(0);
    },
  );

  // Title scoped at M2-S10 P3: this scenario's S7 done-criterion has always been about
  // WAVE INDEX 5 specifically, and the run no longer ends there — it now continues into
  // waves 6/7, which DO leak (5 in total). "Zero leaks" was true of the whole run when
  // the bundle stopped at six waves; it is now true only of wave index 5, which is the
  // claim the test actually makes and asserts below (ship-review P3).
  // SHARED SCENARIO (S11 P2 completion): the `antiair` wall built ahead of wave 5, run to
  // terminal ONCE — the mechanism-proof test below (engagement proof + the S7
  // done-criterion, de-indexed) and its outcome-golden sibling (the full terminal state)
  // both read off this SAME run's results.
  let antiairResult: {
    ruleset: CompiledRuleset;
    state: SimState;
    flyingWaveIndex: number;
    antiairCost: number;
  } | null = null;

  function runAntiairWall() {
    if (antiairResult) return antiairResult;
    // Four `antiair` towers, columns 20 and 24, rows 10 and 12 — the same flanking
    // geometry as the `basic`/`venom` walls, one lane further back still, anchored 200
    // ticks after the `flying` wave's OWN observed countdown start (located by creep
    // id, never a hardcoded index; S11 P2) — well ahead of its natural launch, so every
    // tower has established its fire cadence before the first `flying` spawn.
    const antiairAnchors: { col: number; row: number }[] = [
      { col: 20, row: 10 },
      { col: 20, row: 12 },
      { col: 24, row: 10 },
      { col: 24, row: 12 },
    ];
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const flyingWaveIndex = waveIndexForCreep(ruleset, 'flying');
    const antiairWall = wallInputsFromObservedWave(
      ruleset,
      flyingWaveIndex,
      antiairAnchors,
      'antiair',
      200,
    );
    const inputs = baselineInputs(ruleset, antiairWall);

    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
      state = step(state, ruleset, inputs(t, state));
    }
    const antiairCost = ruleset.towerById['antiair']?.cost;
    if (antiairCost === undefined) throw new Error("expected 'antiair' in the compiled catalog");
    antiairResult = { ruleset, state, flyingWaveIndex, antiairCost };
    return antiairResult;
  }

  it(
    'an `antiair` wall built ahead of wave 5 kills every `flying` creep — zero leaks ON WAVE INDEX 5',
    { timeout: 120_000 },
    () => {
      const { state, flyingWaveIndex, antiairCost } = runAntiairWall();

      // PROOF THE FEATURE ENGAGED: all four placements accepted (tower count AND spend
      // both match the compiled catalog's cost — proving none silently no-op'd).
      expect(state.towers.towerId.filter((id) => id === 'antiair')).toHaveLength(4);
      const antiairSpend = state.towers.towerId.reduce(
        (sum, id, i) => (id === 'antiair' ? sum + state.towers.spend[i]! : sum),
        0,
      );
      expect(antiairSpend).toBe(4 * antiairCost);

      // THE S7 DONE-CRITERION, de-indexed (a mutation check — swap arc rows 6/7 — shows
      // this holds independent of anything past wave 5, unlike the full-array terminal pins
      // moved to the outcome-golden sibling below): wave index 5 (`flying`, located by creep
      // id) fully RESOLVED and never LEAKED — i.e. `antiair` killed all eight `flying`.
      expect(state.waveResolved[flyingWaveIndex]).toBe(true);
      expect(state.waveLeaked[flyingWaveIndex]).toBe(false);
    },
  );

  // OUTCOME GOLDEN (position-sensitive by nature, re-measured when the arc moves) — split
  // out of the mechanism-proof test above at S11 P2 completion. Same run as that test
  // (`runAntiairWall`'s module-level memo), same literals as before this split — nothing
  // here was re-measured, only re-homed.
  it(
    'an `antiair` wall built ahead of wave 5 — the full-game terminal state, outcome golden (position-sensitive by nature, re-measured when the arc moves)',
    { timeout: 120_000 },
    () => {
      const { ruleset, state } = runAntiairWall();

      // --- THE MEASUREMENT — measured, not invented. Re-pinned M2-S10 P3: the loop
      // above now runs to terminal under `MAX_MATCH_TICKS` instead of a fixed 2400
      // ticks. Wave index 5 (`flying`) still dies to `antiair` in full (0 leaks, lives
      // still 10 at that point — unchanged from M2-S7). But this build's `antiair`
      // towers, an AIR-only weapon, have no answer for the ground-domain `boss`/
      // `normal` in wave index 7, and only partial answer for wave index 6's armored
      // `armored-flyer` (armor 5 against `antiair`'s 8 nets 3/hit — enough to kill
      // some, not all, before they cross). The scenario still WINS (this build clears
      // enough of both remaining waves to stay above 0 lives), but on far fewer lives
      // and with both trailing waves partially leaked.
      // Re-pinned M2-S11 P3 (measured). P1's
      // ten-wave arc inserts a new wave 4 before `flying` (still index 5) and a new wave 8
      // (arc row 9) before the boss (now index 9), and pushes `resolute`+`fast` to index 6
      // and `armored-flyer` to index 7. This build (the proven wave-0-4 wall plus an
      // `antiair` wall ahead of `flying`) now also clears the new wave 4 and engages the
      // new wave 8, and survives all the way to a win over the (renumbered) boss wave.
      // Measured before (M2-S10 P3) → after (M2-S11 P3): tick 3141 → 3741; lives 3 → 2;
      // leakedCount 5 → 6; waveCursor 8 → 10; cumulativeKillBounty 114 → 171; bounty
      // 149 → 212; score 219 → 241; stars 1 → 1 (unchanged).
      // Re-pinned M2-S11 P4 (measured), the balance pass. Three P4 levers reach this
      // scenario: `antiair` cadence 20 → 15 (this build's four `antiair` towers now land
      // a third more shots, so wave index 7's `armored-flyer` costs it two fewer lives —
      // leakedCount 6 → 4, lives 2 → 4); the boss wave's `normal` escort gaining
      // `offsetTicks` 600 (the run's tail lengthens by exactly that, tick 3741 → 4112);
      // and `survivalMul` 35 → 50 (score 241 → 377 = 177 kill bounty + 4 × 50). The S7
      // done-criterion below — wave index 5 resolved and never leaked — is untouched.
      // Re-measured final at P4b — unchanged from P4 (this is already the P4-tuned
      // measurement; no further change landed after it).
      console.log(
        `[story-flying-wave #2] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
          `leaked=${state.leakedCount} bounty=${state.bounty} hash=${hashSimState(state)} ` +
          `score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)}`,
      );
      expect(state.phase).toBe('won');
      expect(state.tick).toBe(4112);
      expect(state.lives).toBe(4);
      expect(state.leakedCount).toBe(4);
      expect(state.waveResolved).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
      // Wave index 5 still clean (all killed, per the load-bearing proof this scenario
      // exists for); wave indices 7, 8 and 9 each leak at least one creep.
      expect(state.waveLeaked).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
        true,
        true,
      ]);
      expect(state.waveCursor).toBe(10);
      // The S7 done-criterion itself (wave index 5 resolved, never leaked) is asserted in
      // the mechanism-proof test above, de-indexed — not duplicated here.
      expect(state.cumulativeKillBounty).toBe(177);
      expect(state.bounty).toBe(218);
      expect(hashSimState(state)).toBe('4c8de2bc');
      expect(deriveScore(state, ruleset)).toBe(377);
      expect(deriveStars(state, ruleset)).toBe(1);
    },
  );

  // SHARED SCENARIO (S11 P2 completion): the ground-only wall plus two `slow` towers
  // ahead of wave 5, run to terminal ONCE — the mechanism-proof test below (the slowed-
  // flyer engagement proof, position-free) and its outcome-golden sibling (the full
  // terminal state) both read off this SAME run's results.
  let slowResult: { ruleset: CompiledRuleset; state: SimState; sawSlowedFlyer: boolean } | null =
    null;

  function runSlowWall() {
    if (slowResult) return slowResult;
    // Two `slow` towers, columns 20, rows 9 and 13 — off-lane, within the 4-cell
    // range of the row-11 flight line, anchored 200 ticks after the `flying` wave's
    // OWN observed countdown start (ahead of its launch, same reasoning as the
    // `antiair` wall above).
    const slowAnchors: { col: number; row: number }[] = [
      { col: 20, row: 9 },
      { col: 20, row: 13 },
    ];
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const flyingWaveIndex = waveIndexForCreep(ruleset, 'flying');
    const slowWall = wallInputsFromObservedWave(ruleset, flyingWaveIndex, slowAnchors, 'slow', 200);
    const inputs = baselineInputs(ruleset, slowWall);

    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    // Mid-trace probe (same idiom as parity.test.ts's Codex R2-3 proof), narrowed to
    // `flying` specifically — a self-consistent golden alone cannot certify the
    // `slow` commands actually landed on an AIR creep (as opposed to a ground one
    // elsewhere in the same run), so this asserts a `flying` creep really carried a
    // nonzero `slowMulFp` at some tick.
    let sawSlowedFlyer = false;
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
      state = step(state, ruleset, inputs(t, state));
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'flying' && state.creeps.slowMulFp[i] !== 0) {
          sawSlowedFlyer = true;
        }
      }
    }
    slowResult = { ruleset, state, sawSlowedFlyer };
    return slowResult;
  }

  it(
    '`slow` towers (now both-domain) land a slow status on a `flying` creep',
    { timeout: 120_000 },
    () => {
      const { state, sawSlowedFlyer } = runSlowWall();
      expect(sawSlowedFlyer).toBe(true);

      // Terminal proof the `slow` placements survived (not silently no-op'd): both
      // still stand.
      expect(state.towers.towerId.filter((id) => id === 'slow')).toHaveLength(2);
    },
  );

  // OUTCOME GOLDEN (position-sensitive by nature, re-measured when the arc moves) — split
  // out of the mechanism-proof test above at S11 P2 completion. Same run as that test
  // (`runSlowWall`'s module-level memo), same literals as before this split — nothing
  // here was re-measured, only re-homed.
  it(
    '`slow` towers (now both-domain) ahead of wave 5 — the full-game terminal state, outcome golden (position-sensitive by nature, re-measured when the arc moves)',
    { timeout: 120_000 },
    () => {
      const { ruleset, state } = runSlowWall();

      // --- THE MEASUREMENT — measured, not invented. Re-pinned M2-S10 P3: the loop
      // above now runs to terminal under `MAX_MATCH_TICKS` rather than a fixed 2400
      // ticks, and the OUTCOME FLIPS 'won' → 'lost' (Story 10 Risk 1 ruling: reported
      // for S11's balance pass, never tuned away). `slow` also carries a small direct
      // hit (2 damage, per the catalog), so — unlike the ground-only scenario above —
      // this build chips one `flying` kill out of wave index 5's 8 (lives 10 → 3,
      // unchanged from M2-S7). But the two `slow` towers have no answer for wave index
      // 6's `armored-flyer` beyond that same small chip (armor 5 nets 0 against a
      // 2-point hit, so it is pure leak pressure again): its first three leaks (spaced
      // 20 ticks apart) drain lives 3 → 2 → 1 → 0, and the run FREEZES there — before
      // wave index 6 finishes, and long before wave index 7 (the boss) ever launches.
      // Re-pinned M2-S11 P3 (measured). Same
      // insertion as tests 1/2 above: a new wave 4 before `flying` (still index 5), a new
      // wave 8 before the boss (now index 9), `armored-flyer` now index 7. This build
      // (the proven wave-0-4 wall plus two `slow` towers ahead of `flying`) clears the
      // new wave 4 too, chips one `flying` kill from wave index 5 same as before, then
      // `armored-flyer` (now index 7) leaks and freezes the run at 0 lives before the
      // boss ever launches. Re-measured final at P4b — unchanged from P3 (this build
      // freezes at 0 lives before the boss/antiair/survival mechanics P4 tuned).
      console.log(
        `[story-flying-wave #3] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
          `leaked=${state.leakedCount} bounty=${state.bounty} hash=${hashSimState(state)} ` +
          `score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)}`,
      );
      expect(state.phase).toBe('lost');
      expect(state.tick).toBe(2926);
      expect(state.lives).toBe(0);
      expect(state.leakedCount).toBe(10);
      expect(state.waveResolved).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
        false,
      ]);
      expect(state.waveLeaked).toEqual([
        false,
        false,
        false,
        false,
        false,
        true,
        false,
        true,
        false,
        false,
      ]);
      expect(state.waveCursor).toBe(9);
      // cumulativeKillBounty re-measured at 106 — stated as MEASURED, not decomposed:
      // this run's `slow` towers also slow ground creeps and shift what dies where, so
      // its delta from the pre-S11 value does not reduce to per-wave terms the way the
      // wall-only run's does (see test 1's decomposition for that baseline). Wave
      // index 7's three observed leaks before the freeze contribute 0 kills.
      expect(state.cumulativeKillBounty).toBe(106);
      expect(state.bounty).toBe(153);
      expect(hashSimState(state)).toBe('3471ba09');
      // Re-pinned #25 (SIM_VERSION 15 → 16, measured): score 106 → 0, the sv16 lost
      // branch. The 106 pinned above is what it forfeits.
      expect(deriveScore(state, ruleset)).toBe(0);
      expect(deriveStars(state, ruleset)).toBe(0);
    },
  );

  it("placement over a live `flying` creep's occupied cell succeeds", () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const inputs = baselineInputs(ruleset, () => []);
    const flyingWaveIndex = waveIndexForCreep(ruleset, 'flying');
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);

    // Find a live `flying` creep's OCCUPIED cell (PRD 0001 §3's "the cell containing
    // its point"), derived the same way `tower.ts`'s `creepOccupiedCell` does, over
    // this board's specific geometry: entrance and exit are both row 11
    // (`registry.test.ts`'s own board-geometry pin), so `airLineFollowNeighbor`'s
    // zero-cross-product straight step keeps every flight segment a pure horizontal
    // edge, `headRow === fromRow === 11` throughout. For a horizontal `edgeLen`-256
    // step, `deriveValidCreepPosition`'s floor interpolation never crosses a cell
    // boundary until the segment snaps (`px = fromX + progress`, and `progress <
    // 256`), so the occupied cell is simply `floor(fromX/256)`, `floor(fromY/256)` —
    // i.e., `fromCol`/`fromRow` themselves. Column 13+ is chosen deliberately, not
    // arbitrarily: `registry.test.ts`'s board-geometry test shows the entrance cell
    // `(0,11)`'s ONLY passable neighbor is `(1,11)` (its row-10/row-12 neighbors are
    // `blocked` border), so anchoring a 2×2 footprint at columns 1-2 would fail
    // canPlaceTower's OWN maze-invariant clause (5) by sealing the entrance — a
    // structural fact about this board, not about flyers. Column 13 sits well past
    // that bottleneck, in the wide-open interior where the invariant can route
    // around any single 2×2 footprint.
    // Anchored to the flying wave's OWN OBSERVED launch, never a static tick literal
    // (S11 P2) — unlike `wallInputsFromObservedWave`'s placement commands (which fire at
    // countdown-start + a lead), this loop must run PAST launch: a flyer needs several
    // ticks to spawn and travel to column 13. `OBSERVATION_MARGIN_TICKS` is the margin
    // the old literal (`2400`) implied past this scenario's own flying-wave launch tick;
    // regenerate if it ever proves too tight for a re-cut scenario.
    const OBSERVATION_MARGIN_TICKS = 500;
    let flyerCell: { col: number; row: number } | null = null;
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running' && flyerCell === null; t++) {
      const launchTick = waveLaunchTickObserved(state, flyingWaveIndex);
      if (launchTick !== null && t > launchTick + OBSERVATION_MARGIN_TICKS) break;
      state = step(state, ruleset, inputs(t, state));
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'flying') {
          const col = Math.floor(state.creeps.fromX[i]! / FP_ONE);
          const row = Math.floor(state.creeps.fromY[i]! / FP_ONE);
          if (col >= 13) {
            flyerCell = { col, row };
            break;
          }
        }
      }
    }
    if (flyerCell === null) {
      throw new Error(
        'expected to observe a live flying creep past column 13 within ' +
          `${OBSERVATION_MARGIN_TICKS} ticks of wave 5's observed launch`,
      );
    }
    expect(flyerCell.row).toBe(11); // the straight row-11 flight line, confirmed live

    const towersBefore = state.towers.towerId.length;
    const bountyBefore = state.bounty;
    const antiairCost = ruleset.towerById['antiair']?.cost;
    if (antiairCost === undefined) throw new Error("expected 'antiair' in the compiled catalog");

    // Build directly on the flyer's own occupied cell, the very next tick (the
    // flyer's speed — 30 fp/tick against a 256-wide cell — leaves it resident there
    // for several more ticks, so this remains a same-cell placement).
    state = step(state, ruleset, [{ kind: 'placeTower', anchor: flyerCell, towerId: 'antiair' }]);

    // THE ASSERTION: the placement was ACCEPTED, not a silent no-op — a ground
    // creep on this exact cell would have failed `canPlaceTower`'s clause 3
    // (PRD 0001 §3); a `flying` creep does not, because air never occupies a cell
    // for placement purposes (M2-S7 P4).
    expect(state.towers.towerId.length).toBe(towersBefore + 1);
    expect(state.towers.towerId[state.towers.towerId.length - 1]).toBe('antiair');
    expect(state.bounty).toBe(bountyBefore - antiairCost);
  });
});
