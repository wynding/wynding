// story-armored-wave.test.ts — the M2-S5a P8 pinned wave-4 measurement (PLAN.md step 38).
//
// LOCATION NOTE (deviation from PLAN.md's file list): the plan names
// `packages/sim/src/story-armored-wave.test.ts`, but `packages/sim`'s dependencies are
// `@wynding/engine` and `@wynding/types` only (see `determinism.test.ts`'s own header) — it
// cannot import `@wynding/content`, and a test built there would have to hand-assemble a
// wave-4 ruleset inline rather than load the real shipped `wynding-core` bundle. That would
// measure a REPLICA of wave 4, not the shipped wave 4, which is exactly what this
// measurement must not do. This file lives beside `parity.test.ts` instead, which already
// runs the real shipped bundle through `compileRuleset` → `step()` — the same idiom this
// file follows.
//
// PURPOSE: m2.md's `armored` creep design intent is that flat armor blanks small direct
// hits, and only armor-bypassing DoT (or a big enough hit) gets through. Wave 4 (index 3,
// `6 x armored`, appended in P5) is the first wave that actually tests this. The grill's
// arithmetic predicted one `venom` deals ~30 DoT damage to a 36 HP `armored` creep on a
// single pass, so a PAIR of towers was wanted. This test does not trust that prediction —
// it scripts a sane, modest build (a small `basic` wall for the three earlier, unarmored
// waves, plus a `venom` PAIR built ahead of wave 4) and pins whatever the sim actually
// produces: the exact leak count, lives remaining, and terminal outcome.
//
// AND THE PREDICTION WAS OPTIMISTIC — which is exactly why it is measured (QC round 1).
// At `venom`'s current DoT 4 (M2-S5b PR A), the pinned 13 DoT ticks across six `armored`
// creeps is 52 damage total (13 x 4), ~9 per creep, still well short of the ~30 per creep
// the arithmetic suggested: a creep is only in a venom tower's range for part of its pass,
// so most records expire unfinished. DoT is decisive here regardless — the second test
// below removes the venom pair and the wave leaks — but the margin comes from the pair
// plus the basic wall together, not from DoT alone.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run story-armored-wave
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
  type StepEvents,
  type CompiledRuleset,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { waveIndexForCreep, anchoredWallInputs } from './wave-lookup';

/** Fixed seed — same convention as parity.test.ts. */
const SCENARIO_SEED = 0x5eed;

// The scripted build's `basic` wall, stated so the scenario is reproducible by reading
// it, and SHARED (module scope, not per-test copies) by both tests below — the second
// test's claim of using "the same script, same seed, same basic wall" is only true if
// this is structurally the same array/function both tests build on, not two literals
// that merely happen to currently match (CodeRabbit, PR #78, Major).
//
// A `basic` pair at columns 2, 6 and 10 (rows 10 and 12, flanking the row-11 lane, the
// same flanking geometry parity.test.ts uses) — six towers total, cost 30 of the
// starting 80 bounty. This is a deliberately modest wall: enough `basic` DPS (10
// damage, armor-0 against every creep in waves 0-2) to handle the three unarmored
// waves, not an overbuilt wall sized to also brute-force the armored wave on its own.
const basicAnchors: { col: number; row: number }[] = [
  { col: 2, row: 10 },
  { col: 2, row: 12 },
  { col: 6, row: 10 },
  { col: 6, row: 12 },
  { col: 10, row: 10 },
  { col: 10, row: 12 },
];

// The second pair of anchors the first test's `venom` pair stands on (column 16, rows 10
// and 12 — the same flanking geometry, one lane further back). Module scope for the same
// reason `basicAnchors` is (lines 52-56): the venom-heavy build below (PLAN.md step 3) plants
// its `basic` pair on these exact anchors and ticks, kinds swapped — that claim is only
// true if both tests read the same source array, not two literals that merely happen to
// match.
const column16Anchors: { col: number; row: number }[] = [
  { col: 16, row: 10 },
  { col: 16, row: 12 },
];

/** Builds a fresh `inputs`-style placement function: one tower of `towerId` placed
 *  every `spacingTicks` ticks (default 10, this file's original cadence), in
 *  `anchors` order, starting at `startTick` (default 0, this file's original
 *  unhurried early build) — extended with explicit `startTick`/`spacingTicks`
 *  parameters (M2-S6 P8 test 17) so a LATE build (ahead of the fifth wave, not tick
 *  0) is expressible without a second helper. Returns a NEW closure (its own
 *  cursor) each call, so callers never share placement state even when they build
 *  on the same anchor array. */
function anchorWallInputs(
  anchors: readonly { col: number; row: number }[],
  towerId: string,
  startTick = 0,
  spacingTicks = 10,
): (tick: number) => SimInput[] {
  let next = 0;
  return (tick: number): SimInput[] => {
    const out: SimInput[] = [];
    if (tick >= startTick && (tick - startTick) % spacingTicks === 0 && next < anchors.length) {
      out.push({ kind: 'placeTower', anchor: anchors[next]!, towerId });
      next++;
    }
    return out;
  };
}

/** The `basic`-wall specialization the two wave-4 tests build on: `anchorWallInputs` over
 *  `basicAnchors`, `basic` towers. (The venom-heavy test below deliberately does NOT use
 *  it — it calls `anchorWallInputs(basicAnchors, 'venom')` for the same anchors and
 *  cadence with the kind swapped, which is the whole point of that comparison.) */
function basicWallInputs(): (tick: number) => SimInput[] {
  return anchorWallInputs(basicAnchors, 'basic');
}

describe('wave 4 (the appended `armored` wave) — a pinned, scripted-build measurement', () => {
  // SHARED SCENARIO (S11 P2 completion): the small basic wall for waves 0-2, plus a venom
  // pair built ahead of wave 4, run to terminal ONCE — the mechanism-proof test below (DoT
  // engagement, wave 4 specifically cleared, both located/derived rather than pinned as a
  // whole-array position) and its outcome-golden sibling (the full terminal state, which a
  // mutation check shows is genuinely position-sensitive — an arc reorder past wave 4
  // changes downstream ticks/hash/bounty even though wave 4 itself is untouched) both read
  // off this SAME run's results. vitest runs `it`s in declaration order within a file (no
  // `.concurrent` is used anywhere in this file), so the module-level memo below is filled
  // by whichever of the two tests runs first — always this file's first `it`, by
  // construction — and the second reads the cache; no simulation runs twice.
  let wave4ScriptResult: {
    ruleset: CompiledRuleset;
    state: SimState;
    armoredWaveIndex: number;
    sawLiveDotRecord: boolean;
    dotTicksAtWave3Resolve: number;
    dotDroppedAtWave3Resolve: number;
    wave3ResolvedTick: number | null;
  } | null = null;

  function runWave4Script() {
    if (wave4ScriptResult) return wave4ScriptResult;
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    // The `armored` wave, LOCATED by creep id in the compiled schedule (ruling 1) — never
    // a hardcoded index, so this survives P1's renumber unedited.
    const armoredWaveIndex = waveIndexForCreep(ruleset, 'armored');
    // The `venom` PAIR (the grill's arithmetic, PLAN.md step 38) — column 16, rows 10 and
    // 12, the same flanking geometry. Anchored 200 ticks after the `armored` wave's own
    // OBSERVED countdown start (a script-owned lead, not a static tick literal — S11 P2),
    // well ahead of its natural launch, so both towers have established their fire
    // cadence before the first `armored` creep is in range. `basic`'s own 10 damage nets
    // only 4/hit against `armored`'s armor 6 (P1's formula); `venom`'s direct 2 nets 0 —
    // the DoT is what has to do the real work here.
    const basicWall = basicWallInputs();
    const venomWall = anchoredWallInputs(ruleset, armoredWaveIndex, column16Anchors, 'venom', 200);
    function inputs(tick: number, state: SimState): SimInput[] {
      const out = basicWall(tick);
      out.push(...venomWall(tick, state));
      return out;
    }

    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    // A reused, mutable `StepEvents` collector (combat.ts's documented contract: the two
    // DoT counters are mutable and NOT reset per-call) — accumulates `dotTicks`/`dotDropped`
    // across the whole run, proving DoT actually engaged rather than merely being present
    // in the bundle. The two ARRAYS on the same object are append-only and nothing drains
    // them, so they are cleared each tick (CodeRabbit, PR #78): over 1,900 ticks they would
    // otherwise retain every impact point and every shot fired for the whole run, for no
    // reason — only the scalar counters are being accumulated on purpose.
    const events: StepEvents = { impactPoints: [], fired: [], dotTicks: 0, dotDropped: 0 };
    let sawLiveDotRecord = false;
    // Entity id -> catalog creepId, built up as creeps spawn (`state.creeps.id` /
    // `state.creeps.creepId` are parallel arrays, updated every tick — PLAN.md step 3).
    // This is the precondition the DoT-share report below depends on: it is checked, not
    // assumed, and a targetId this map has never seen is a finding, not a skip.
    //
    // WHAT IT CHECKS, precisely (QC round 1 — an earlier draft claimed more): this walks
    // every RESIDENT record post-step, which is not literally every counted `dotTicks`
    // tick. Measured on this run, 4 of the 13 counted ticks land on a tick where the
    // record is already gone — a killing tick, where step (6)'s survivor sweep removes the
    // record in the same phase it fired. Those four are still covered, for two reasons
    // worth stating rather than leaving to a reader to reconstruct:
    //   (a) `applyDot` sets `nextTickTick = tick + cadenceTicks` with a positive cadence,
    //       so a record that ever ticks was necessarily resident — and therefore observed
    //       here — for at least one tick before its first application; and
    //   (b) entity ids are allocated monotonically and never recycled, so a map entry can
    //       never go stale and a same-tick spawn-and-poison is still resolvable.
    // (b) is also why there is no ordering hazard: the map is refreshed from post-step
    // `state.creeps` before `state.dots` is read in the same iteration.
    //
    // MEASUREMENT WINDOW, bounded (M2-S6 P5 — a finding, not something to skip). The
    // armored-only invariant below held over the WHOLE run only because the bundle
    // carried four waves and wave index 3 (`armored`) was the last one; the venom pair
    // was never in range of anything else. M2-S6 appends a FIFTH wave (index 4:
    // `resolute` + `fast`, neither armored) that crosses the same lane and the same
    // venom pair, so a DoT record targeting one of THOSE creeps would now falsify the
    // check if it ran to the end of the loop. Rather than weaken the armored-only
    // assertion — that is the finding this test exists to carry — the window is bounded
    // to the tick wave index 3 actually resolves: the DoT counters are snapshotted
    // there, and the armored-only check runs only up to and including that tick. The
    // loop itself still runs the full 1,900 ticks so the terminal measurement below
    // (which now legitimately includes wave index 4) is real.
    const creepKindById = new Map<number, string>();
    let wave3ResolvedTick: number | null = null;
    let dotTicksAtWave3Resolve = 0;
    let dotDroppedAtWave3Resolve = 0;
    // M2-S7 P6: the loop bound widened 1900 -> 2400. The bundle carried a SIXTH
    // wave (index 5, 8x `flying`, appended by S7), and `phase` only reaches a
    // terminal value once every wave has resolved (index.ts's `waveResolved.every`
    // check) — this build places no `antiair`, so wave index 5's flyers cross the
    // whole board untouched by every standing ground tower and leak out, which
    // this file's terminal measurement below now has to actually witness rather
    // than truncate before it happens.
    // M2-S10 P3: the bundle now carries a SEVENTH and EIGHTH wave (index 6
    // `armored-flyer`, index 7 `boss`+`normal`), and a fixed tick count can no
    // longer be trusted to cover them — the loop now runs until the sim itself
    // reaches a terminal phase, capped at `MAX_MATCH_TICKS` (the sim's own
    // compile-time bound), never a hand-picked constant. It does not change
    // anything about the wave-3-scoped snapshot logic above, which is guarded by
    // `wave3ResolvedTick === null` and fires long before the extension matters.
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
      events.impactPoints.length = 0;
      events.fired.length = 0;
      state = step(state, ruleset, inputs(t, state), events);
      sawLiveDotRecord ||= state.dots.length > 0;
      for (let i = 0; i < state.creeps.id.length; i++) {
        creepKindById.set(state.creeps.id[i]!, state.creeps.creepId[i]!);
      }
      if (wave3ResolvedTick === null) {
        for (const dot of state.dots) {
          const kind = creepKindById.get(dot.targetId);
          if (kind === undefined) {
            throw new Error(
              `DoT record targetId ${dot.targetId} at tick ${t} is not in the observed ` +
                'creep-id map — the DoT-share derivation below assumes every live record ' +
                'targets an `armored` creep, and this is a finding, not something to skip.',
            );
          }
          expect(kind).toBe('armored');
        }
        if (state.waveResolved[armoredWaveIndex] || state.waveLeaked[armoredWaveIndex]) {
          wave3ResolvedTick = t;
          // `dotTicks`/`dotDropped` are optional collector fields (StepEvents' `?:`
          // idiom); this collector literal always supplies both as `0`, so `?? 0` only
          // satisfies the type here — it never masks an actual gap.
          dotTicksAtWave3Resolve = events.dotTicks ?? 0;
          dotDroppedAtWave3Resolve = events.dotDropped ?? 0;
        }
      }
    }
    wave4ScriptResult = {
      ruleset,
      state,
      armoredWaveIndex,
      sawLiveDotRecord,
      dotTicksAtWave3Resolve,
      dotDroppedAtWave3Resolve,
      wave3ResolvedTick,
    };
    return wave4ScriptResult;
  }

  it(
    'a small basic wall for waves 0-2, plus a venom pair built ahead of wave 4, clears the whole game',
    { timeout: 120_000 },
    () => {
      const {
        ruleset,
        state,
        armoredWaveIndex,
        sawLiveDotRecord,
        dotTicksAtWave3Resolve,
        dotDroppedAtWave3Resolve,
        wave3ResolvedTick,
      } = runWave4Script();

      // wave index 3 (`armored`) must actually have resolved inside the run for the
      // snapshot above to mean anything.
      expect(wave3ResolvedTick).not.toBeNull();

      // THE S11 P2 MECHANISM CLAIM, de-indexed (a mutation check — swap arc rows 6/7 — shows
      // this holds independent of anything past wave 4, unlike the full-array terminal pins
      // moved to the outcome-golden sibling below): wave 4 (`armored`, located by creep id)
      // itself resolved clean, never leaked.
      expect(state.waveResolved[armoredWaveIndex]).toBe(true);
      expect(state.waveLeaked[armoredWaveIndex]).toBe(false);

      // Proof the DoT mechanic actually fired against the armored wave (not a self-consistent
      // golden alone — Codex R2-3's precedent, applied here to DoT rather than slow): the
      // venom pair is placed at tick 1300/1310 and only wave index 3's `armored` creeps
      // (spawning from tick 1400) are ever in range of it before wave index 3 resolves, so
      // every tick counted in the snapshot below is wave-index-3 DoT.
      expect(sawLiveDotRecord).toBe(true);
      // 13, down from 26 at DoT 2 (M2-S5b PR A): each armored creep now dies to fewer DoT
      // ticks since each tick hits harder, so the surviving-window tick count drops — but
      // total DoT damage applied (dotTicks x damagePerTick) comes out the same 52 either way
      // (13 x 4 = 26 x 2), which is this run's outcome, not a general identity. Regenerated
      // by running, not computed by hand. Snapshotted at wave index 3's resolution (see
      // above) — the RUN's final `events.dotTicks` is now higher (17) because the fifth
      // wave's `resolute`/`fast` creeps also cross the venom pair afterward; that excess is
      // outside this test's armored-only oracle and is not asserted here.
      expect(dotTicksAtWave3Resolve).toBe(13);
      expect(dotDroppedAtWave3Resolve).toBe(0);

      // Terminal proof the placements survived (not silently no-op'd): six `basic` and both
      // `venom` towers still stand.
      expect(state.towers.towerId.filter((id) => id === 'basic').length).toBe(6);
      expect(state.towers.towerId.filter((id) => id === 'venom').length).toBe(2);

      // --- REPORTED, NOT GATED (PLAN.md step 3): DoT's share of the damage
      // dealt to the armored wave. Valid ONLY because the precondition above holds — every
      // counted `dotTicks` tick targeted an `armored` creep, since the venom pair is placed
      // at ticks 1300/1310 and only wave 4's `armored` creeps are ever in its range before
      // wave index 3 resolves. M2-S6 P5: uses the SNAPSHOTTED `dotTicksAtWave3Resolve`, not
      // the run's final `events.dotTicks` — the fifth wave (index 4) also crosses the venom
      // pair afterward, and its DoT ticks are not armored-only, so they must not enter this
      // derivation. If a future build script puts `venom` in range of an unarmored wave
      // BEFORE wave index 3 resolves, this derivation is void and the packet must add
      // per-kind damage attribution instead.
      //
      // `dotTicksAtWave3Resolve x damagePerTick` (derived from the compiled catalog, not a
      // literal) is DoT damage APPLIED, not damage that mattered: it does NOT net overkill
      // on the killing tick, so it is an upper bound, not effective damage. Compared
      // against `6 x 36 = 216` armored starting HP (6 armored spawns in wave 4, from the
      // compiled wave schedule; 36 HP each, from the compiled catalog).
      const venomTowerDef = ruleset.towerById['venom'];
      if (!venomTowerDef) throw new Error("expected a compiled 'venom' tower");
      const venomDotEffect = venomTowerDef.effects.find((e) => e.kind === 'dot');
      if (!venomDotEffect || venomDotEffect.kind !== 'dot') {
        throw new Error("expected the compiled 'venom' tower to carry a dot effect");
      }
      const armoredDef = ruleset.creepById['armored'];
      if (!armoredDef) throw new Error("expected a compiled 'armored' creep");
      const armoredWave = ruleset.waves[armoredWaveIndex];
      const armoredEntry = armoredWave?.entriesSummary.find((e) => e.creepId === 'armored');
      if (!armoredEntry) {
        throw new Error("expected the armored wave's entriesSummary to name 'armored'");
      }

      // `dotTicksAtWave3Resolve` is a plain local — `expect(dotTicksAtWave3Resolve).toBe(13)`
      // above already proves it holds the snapshotted, armored-only-window count.
      const dotDamageApplied = dotTicksAtWave3Resolve * venomDotEffect.amount;
      const armoredStartingHp = armoredEntry.count * armoredDef.hp;
      const dotSharePct = (dotDamageApplied / armoredStartingHp) * 100;
      console.log(
        `[story-armored-wave] DoT damage applied vs armored starting HP: ${dotDamageApplied} / ` +
          `${armoredStartingHp} = ${dotSharePct.toFixed(2)}% (upper bound, does not net overkill)`,
      );
      // Measured: 13 dotTicks x 4 damagePerTick = 52 applied, against 6 x 36 = 216 armored
      // starting HP -> 24.07%. Reported, not gated (see the derivation note above).
    },
  );

  // OUTCOME GOLDEN (position-sensitive by nature, re-measured when the arc moves) — split
  // out of the mechanism-proof test above at S11 P2 completion. A mutation check (swap arc
  // rows 6/7 back) shows this whole terminal shape — tick, hash, bounty, and above all the
  // FULL `waveResolved`/`waveLeaked` arrays — depends on the ORDER of every wave from
  // index 5 onward, not just on wave 4 (which is what the mechanism-proof test above
  // actually claims). Same run as that test (`runWave4Script`'s module-level memo), same
  // literals as before this split — nothing here was re-measured, only re-homed.
  it(
    'a small basic wall for waves 0-2, plus a venom pair built ahead of wave 4 — the full-game terminal state, outcome golden (position-sensitive by nature, re-measured when the arc moves)',
    { timeout: 120_000 },
    () => {
      const { ruleset, state } = runWave4Script();

      // --- THE MEASUREMENT (PLAN.md step 38) ---
      //
      // Wave 4 (index 3, `armored`) is CLEARABLE with this sane build: every wave through
      // index 4 resolves with zero leaks. M2-S6 P5: the bundle carries a fifth wave (index
      // 4, `resolute`+`fast`), which crosses the same standing basic wall and venom pair
      // and ALSO resolves clean — this file does not build anything new for it (that is
      // P8's job), the same six `basic` plus the venom pair happen to carry it too.
      //
      // M2-S7 P6: the bundle carried a sixth wave (index 5, 8x `flying`), and this build
      // has no `antiair` — a ground-only wall, by construction (this is the wave-4 armored
      // measurement, not the flying one). Every flyer in wave index 5 crossed the entire
      // board untouched (S7's own done-criterion, witnessed here as a side effect: a
      // ground-only build cannot touch it) and leaked, costing 8 of the 10 starting lives,
      // but the game still WON (every wave resolved).
      //
      // M2-S10 P3, and this is a REAL measured outcome, not a truncation artifact — the
      // OUTCOME FLIPS 'won' → 'lost' (Story 10 Risk 1 ruling: reported for S11's balance
      // pass, never tuned away). This build's geometry is byte-identical to
      // `story-flying-wave.test.ts`'s own ground-only scenario (same `basic` wall, same
      // `venom` pair, same seed), so it produces the IDENTICAL terminal state: wave index
      // 6's `armored-flyer` — also air, also untouched by this ground-only build — leaks
      // too, and its first two leaks (spaced 20 ticks apart) drain lives 2 → 1 → 0. The run
      // FREEZES there, before wave index 6 finishes and long before wave index 7 (the
      // boss) ever launches.
      //
      // Re-pinned M2-S11 P3 (measured). P1's ten-wave
      // arc inserts arc row 5 (a new wave 4, 12x`normal`+6x`swarm`) between `armored` and
      // `flying`, and renumbers every later wave — `armored-flyer` is now wave index 7
      // (was 6). The claim itself is unchanged: this ground-only build still clears
      // everything through the new wave 4 and the (renumbered) `flying`/`resolute`+`fast`
      // waves, then `armored-flyer` (now index 7) leaks in full and freezes the run at 0
      // lives before the boss (now index 9) ever launches. Measured before (M2-S10 P3) →
      // after (M2-S11 P3): tick 2586 → 2886; waveCursor 7 → 8; cumulativeKillBounty
      // 84 → 102 (+18, the new wave 4's own kills); bounty 141 → 165 (+18 kill bounty,
      // +6 new wave 4's clear bonus). Re-measured final at P4b — unchanged from P3 (arc
      // tuning — survivalMul 50, antiair cadence 15, boss-escort offset 600 — never touches
      // this ground-only build's path to freezing before the boss launches).
      console.log(
        `[story-armored-wave #1] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
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
      // Kill-bounty proof every creep across waves 0-4 was killed, not leaked, and wave
      // index 5's 8 `flying` (and wave index 7's two observed `armored-flyer` leaks before
      // the freeze) were leaked, not killed (0 contribution). Re-measured at 102 (+18 over
      // the pre-S11 84): the new wave 4 (12x`normal`+6x`swarm`) contributes its own kills.
      expect(state.cumulativeKillBounty).toBe(102);
      // `bounty` re-measured at 165 (+24 over the pre-S11 141: +18 kill bounty, +6 the new
      // wave 4's own clear bonus). No wave past it ever pays a clear bonus (each either
      // leaked or never finished resolving).
      expect(state.bounty).toBe(165);
      expect(hashSimState(state)).toBe('bd6516b9');
      // Lost score formula: kill-bounty only — no early-call credit and no survival term
      // at all under the lost branch.
      expect(deriveScore(state, ruleset)).toBe(102);
      expect(deriveStars(state, ruleset)).toBe(0);
    },
  );

  // The COUNTERFACTUAL (QC round 1). The test above pins that the build clears wave 4,
  // but on its own it cannot show the venom pair is what does it — a balance change
  // making DoT irrelevant would simply require re-pinning `dotTicks`/`tick`/the hash,
  // which is precisely the failure mode this file exists to guard against. So: the same
  // script, same seed, same basic wall, with ONLY the venom pair removed.
  it('the same build WITHOUT the venom pair leaks the armored wave — DoT is what clears it', () => {
    const inputs = basicWallInputs();

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    const events: StepEvents = { impactPoints: [], fired: [], dotTicks: 0, dotDropped: 0 };
    for (let t = 0; t < 1900; t++) {
      events.impactPoints.length = 0;
      events.fired.length = 0;
      state = step(state, ruleset, inputs(t), events);
    }

    // No venom tower stands, so no DoT record is ever created — the armor-bypass channel
    // is entirely absent, and `basic`'s 10 damage nets only 4/hit against armor 6.
    expect(events.dotTicks).toBe(0);
    expect(state.dots).toEqual([]);
    // The armored wave now leaks. This is the assertion that makes the first test mean
    // something: the venom pair is worth exactly these leaks.
    // M2-S6 P5: `waveLeaked` is now length 5 (the appended wave index 4, `resolute`+
    // `fast`, resolves clean against the same basic wall — both carry 0 armor, like
    // `normal`/`fast`/`swarm`; `armored` is the one pre-S6 exception at armor 6 — so
    // `leakedCount`/`lives` are unaffected by its addition).
    // M2-S7 P6: `waveLeaked` widened to length 6 (the appended wave index 5, `flying`) —
    // still trailing `false` at this same tick-1900 sample. This test's loop bound is
    // NOT extended to settlement (unlike the three `phase`-asserting tests in this file):
    // wave index 5 only starts counting down once wave index 4 launches (~tick 1700) and
    // launches itself ~300 ticks later, so at tick 1900 it has not yet spawned — this
    // snapshot is unaffected by its existence, only by its bare presence in the array.
    // M2-S10 P3: `waveLeaked` widens again to length 8 (the appended wave index 6
    // `armored-flyer`, index 7 `boss`+`normal`) — both still trailing `false` at this
    // same tick-1900 sample for the identical reason: neither's countdown has even
    // started yet this early in the run (they chain off wave index 5, which has not
    // itself launched by tick 1900).
    // M2-S11 P3 (measured), STRUCTURAL RE-PIN: `waveLeaked` widens to length 10 (P1's
    // ten-wave arc). Purely structural — `leakedCount`/`lives` are unaffected (the
    // armored wave, still index 3, is unmoved and unreachable-by-later-waves at
    // tick 1900), and the two new trailing entries are `false` for the same reason: no
    // countdown for anything past the (renumbered) `armored-flyer`/boss waves has
    // started this early.
    expect(state.leakedCount).toBe(4);
    expect(state.waveLeaked).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(state.lives).toBe(6);
  });
});

describe('`venom` is a specialist, not a strict upgrade — exact per-bounty arithmetic over the compiled catalog (PLAN.md step 3)', () => {
  // Why arithmetic and not a measurement: under ONE STATED MODEL — a single tower holding
  // a single target in range for the whole window — damage-per-bounty is an exact property
  // of the compiled catalog (attack cadence, dot cadence, damage amounts, cost), so running
  // the sim would only add noise and make the answer depend on which build script happened
  // to be chosen, when the claim is about the numbers alone.
  //
  // STATE THE MODEL, because the DoT term depends on it and an earlier draft of this
  // comment claimed independence from "targeting order, spacing" that it does not have:
  // `venomDot.amount * venomDotTicks` counts 6 ticks per 60 only for one continuously
  // engaged target. Per-source independence means a venom that SWITCHES targets seeds a
  // second record and exceeds 6 ticks in the window, and a venom whose target leaves range
  // delivers fewer — this file's own header records that the real wave-4 pass does the
  // latter ("a creep is only in a venom tower's range for part of its pass"). The model is
  // the right one for a per-bounty VALUE comparison, since both towers are measured under
  // it identically; it is not a prediction about any particular run.
  //
  // DoT bypasses armor entirely — see `applyDirect(creeps, idx, record.amount, 0)` in the
  // DoT tick step of `packages/sim/src/combat.ts`, the file's only `applyDirect(..., 0)`
  // call, whose literal `0` is documented there as intentional armor bypass rather than a
  // forgotten argument. So a `dot` effect's contribution is never reduced by the target's
  // armor, unlike `direct`. (Cited by symbol, not line number: an earlier draft cited lines
  // that had already drifted onto an unrelated expiry guard.)
  it('venom beats basic per bounty against armored but loses against unarmored (both gated)', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));

    const basic = ruleset.towerById['basic'];
    const venom = ruleset.towerById['venom'];
    const armored = ruleset.creepById['armored'];
    if (!basic) throw new Error("expected a compiled 'basic' tower");
    if (!venom) throw new Error("expected a compiled 'venom' tower");
    if (!armored) throw new Error("expected a compiled 'armored' creep");
    // M2-S8 (sv12): `CompiledTower.attack` is optional — a support bundle carries
    // none. Both of these attack, so a missing attack is a broken fixture; name it
    // rather than let a non-null assertion turn it into an opaque TypeError later.
    // M2-S9 (sv13): it is also a UNION on `mode` — a burst bundle carries a trigger
    // range but no cadence at all. This whole test is shots-per-window arithmetic, so
    // it is meaningful only for a CADENCED tower; narrow on `mode` for the same reason
    // and in the same shape, so a catalog edit that turned `basic` or `venom` into a
    // burst tower would fail loudly here instead of quietly dividing by `undefined`.
    const basicAttack = basic.attack;
    const venomAttack = venom.attack;
    if (basicAttack?.mode !== 'cadenced') {
      throw new Error("expected the compiled 'basic' tower to attack on a cadence");
    }
    if (venomAttack?.mode !== 'cadenced') {
      throw new Error("expected the compiled 'venom' tower to attack on a cadence");
    }

    const basicDirect = basic.effects.find((e) => e.kind === 'direct');
    const venomDirect = venom.effects.find((e) => e.kind === 'direct');
    const venomDot = venom.effects.find((e) => e.kind === 'dot');
    if (!basicDirect || basicDirect.kind !== 'direct') {
      throw new Error("expected the compiled 'basic' tower to carry a direct effect");
    }
    if (!venomDirect || venomDirect.kind !== 'direct') {
      throw new Error("expected the compiled 'venom' tower to carry a direct effect");
    }
    if (!venomDot || venomDot.kind !== 'dot') {
      throw new Error("expected the compiled 'venom' tower to carry a dot effect");
    }

    // The window must divide evenly by every cadence in play, or the shot/tick counts
    // below silently truncate into the wrong ratio instead of failing loudly — a future
    // cadence change must break THIS assertion, not silently corrupt the ones after it.
    const WINDOW = 60;
    expect(WINDOW % basicAttack.cadenceTicks).toBe(0);
    expect(WINDOW % venomAttack.cadenceTicks).toBe(0);
    expect(WINDOW % venomDot.cadenceTicks).toBe(0);

    // AND the residency assumption itself must be guarded, not just the cadences (QC round
    // 1 on this packet — a real hole, found by mutation). The 6-ticks-per-window DoT term
    // holds only because each shot REFRESHES the record before the previous one expires,
    // i.e. `dot.durationTicks >= the tower's own attack cadence`. Nothing else enforces
    // that: `ruleset-schema.ts`'s dot validator checks `durationTicks >= dot.cadenceTicks`
    // (a DoT must tick at least once) and no more.
    //
    // The concrete hole, verified by mutation: setting `venom.dot.durationTicks` 60 -> 10
    // is schema-legal and compiles. Real steady state becomes 2 DoT ticks per 60 (applied
    // at t, ticks once at t+10 which IS `untilTick`, swept, next shot at t+30), so venom
    // vs `armored` = 4 x 2 = 8 — EXACTLY `basic`'s 8, at 9 bounty against 5. The product
    // goal inverts. Without this line the test still computed 60/10 = 6 ticks, still
    // asserted 24, and still passed, while three sim goldens went red — the precise
    // inversion of this test's purpose, which is to be the one that needs no simulation.
    expect(venomDot.durationTicks).toBeGreaterThanOrEqual(venomAttack.cadenceTicks);

    const basicShots = WINDOW / basicAttack.cadenceTicks;
    const venomShots = WINDOW / venomAttack.cadenceTicks;
    const venomDotTicks = WINDOW / venomDot.cadenceTicks;

    const armor = armored.armor; // derived from the compiled catalog, not hardcoded

    // vs armored (armor blanks basic's direct hit down to (10-6)=4; venom's direct 2 is
    // fully blanked to 0; the dot ignores armor entirely).
    const venomVsArmored =
      Math.max(0, venomDirect.amount - armor) * venomShots + venomDot.amount * venomDotTicks;
    const basicVsArmored = Math.max(0, basicDirect.amount - armor) * basicShots;
    expect(venomVsArmored).toBe(24);
    expect(basicVsArmored).toBe(8);
    // Compared as integer cross-multiplication, never floating point: a/costA > b/costB
    // becomes a*costB > b*costA.
    expect(venomVsArmored * basic.cost).toBeGreaterThan(basicVsArmored * venom.cost);

    // vs unarmored (armor 0 — neither direct hit is blanked).
    const venomVsUnarmored = venomDirect.amount * venomShots + venomDot.amount * venomDotTicks;
    const basicVsUnarmored = basicDirect.amount * basicShots;
    expect(venomVsUnarmored).toBe(28);
    expect(basicVsUnarmored).toBe(20);
    expect(venomVsUnarmored * basic.cost).toBeLessThan(basicVsUnarmored * venom.cost);
  });
});

describe('a venom-heavy build (PLAN.md step 3) — same board, same seed, kinds swapped', () => {
  // Same board, same seed, same geometry idiom as the first script above, with the kinds
  // swapped: six `venom` on `basicAnchors` (cost 54 of the starting 80), built on the same
  // ticks the `basic` wall was built on above (tick 0, 10, 20, 30, 40, 50 — one every 10
  // ticks in anchor order, `anchorWallInputs`'s cadence); two `basic` on `column16Anchors`
  // (cost 10), built at ticks 1300/1310 — the first test's venom pair's anchors and ticks,
  // kind swapped. `venom` is deliberately the weaker buy against unarmored creeps (the
  // test above), so this build is exercised across ALL five waves (M2-S6 appends wave
  // index 4), not just wave 4 — and waves 0-2 are where it is under-served. See the
  // measurement below: it wins, but pays a life to the wave-1 swarm rush.
  // SHARED SCENARIO (S11 P2 completion) — same idiom as `runWave4Script` above: the
  // venom-heavy build run to terminal ONCE, read by both the mechanism-proof test (the
  // wave-1 specialist trade, de-indexed) and its outcome-golden sibling (the full terminal
  // state). vitest's declaration-order execution (no `.concurrent` in this file) means the
  // memo is always filled by the mechanism-proof test, which is declared first.
  let venomHeavyResult: { ruleset: CompiledRuleset; state: SimState } | null = null;

  function runVenomHeavyScript() {
    if (venomHeavyResult) return venomHeavyResult;
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    // The `basic` pair, kind-swapped from the first test above, anchored the same way —
    // 200 ticks after the `armored` wave's OWN observed countdown start (located by
    // creep id, never a hardcoded index; S11 P2).
    const armoredWaveIndex = waveIndexForCreep(ruleset, 'armored');
    const venomWall = anchorWallInputs(basicAnchors, 'venom');
    const basicPairWall = anchoredWallInputs(
      ruleset,
      armoredWaveIndex,
      column16Anchors,
      'basic',
      200,
    );
    function inputs(tick: number, state: SimState): SimInput[] {
      const out = venomWall(tick);
      out.push(...basicPairWall(tick, state));
      return out;
    }

    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    const events: StepEvents = { impactPoints: [], fired: [], dotTicks: 0, dotDropped: 0 };
    // M2-S7 P6: loop bound widened 1900 -> 2400, same reason as the first test above —
    // `phase` only reaches a terminal value once the appended sixth wave (index 5,
    // `flying`) has resolved too, and this build has no `antiair` to touch it.
    // M2-S10 P3: same reason as the first test above — the bundle now carries two
    // more waves (index 6, 7), so the loop runs until terminal, capped at
    // `MAX_MATCH_TICKS`, never a hand-picked tick constant.
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
      events.impactPoints.length = 0;
      events.fired.length = 0;
      state = step(state, ruleset, inputs(t, state), events);
    }
    venomHeavyResult = { ruleset, state };
    return venomHeavyResult;
  }

  it(
    'six venom plus a basic pair wins, but LEAKS one swarm on wave 1 — the specialist trade, measured',
    { timeout: 120_000 },
    () => {
      const { ruleset, state } = runVenomHeavyScript();

      // Terminal proof the placements survived: six `venom` and two `basic` still stand.
      expect(state.towers.towerId.filter((id) => id === 'venom').length).toBe(6);
      expect(state.towers.towerId.filter((id) => id === 'basic').length).toBe(2);

      // THE S11 P2 MECHANISM CLAIM, de-indexed (a mutation check — swap arc rows 6/7 — shows
      // this holds independent of anything past wave 3, unlike the full-array terminal pins
      // moved to the outcome-golden sibling below): waves 0-3 (located by creep id, the
      // waves this test's own build targets) resolve exactly as the specialist-trade claim
      // says — wave 1 (`swarm`) is the only one of the four that leaks.
      const normalWaveIndex = waveIndexForCreep(ruleset, 'normal');
      const swarmWaveIndex = waveIndexForCreep(ruleset, 'swarm');
      const fastWaveIndex = waveIndexForCreep(ruleset, 'fast');
      const armoredWaveIndex = waveIndexForCreep(ruleset, 'armored');
      expect(state.waveResolved[normalWaveIndex]).toBe(true);
      expect(state.waveResolved[swarmWaveIndex]).toBe(true);
      expect(state.waveResolved[fastWaveIndex]).toBe(true);
      expect(state.waveResolved[armoredWaveIndex]).toBe(true);
      expect(state.waveLeaked[normalWaveIndex]).toBe(false);
      expect(state.waveLeaked[swarmWaveIndex]).toBe(true);
      expect(state.waveLeaked[fastWaveIndex]).toBe(false);
      expect(state.waveLeaked[armoredWaveIndex]).toBe(false);
    },
  );

  // OUTCOME GOLDEN (position-sensitive by nature, re-measured when the arc moves) — split
  // out of the mechanism-proof test above at S11 P2 completion. A mutation check (swap arc
  // rows 6/7 back) shows the full `waveResolved` array (and, by the same reasoning, the
  // rest of this terminal shape) depends on the order of every wave from index 5 onward —
  // the wave-1 specialist trade the mechanism-proof test above actually claims is
  // unaffected by it. Same run as that test (`runVenomHeavyScript`'s module-level memo),
  // same literals as before this split — nothing here was re-measured, only re-homed.
  it(
    'six venom plus a basic pair — the full-game terminal state, outcome golden (position-sensitive by nature, re-measured when the arc moves)',
    { timeout: 120_000 },
    () => {
      const { ruleset, state } = runVenomHeavyScript();

      // THE MEASUREMENT, AND IT IS NOT WHAT THE PLAN PREDICTED (M2-S5b PR A, escalated and
      // ruled 2026-08-02). PLAN.md step 3 pinned this build expecting the same terminal shape
      // as the first script — every wave resolved, ZERO leaks, lives intact — and named an
      // early-wave leak as a live risk that escalates rather than gets tuned away. It leaks.
      // The build is unchanged and no catalog number moved; only this expectation did, from a
      // prediction to what the sim actually produces.
      //
      // WHY it leaks — stated as the EXPLANATION, not as something this test measures (QC
      // round 1: an earlier draft wrote it as measured, and it is not). A `swarm` has 7 creep
      // HP. `basic` deals 10 in one hit and kills it outright. `venom` deals 2 direct, then 4
      // per DoT tick every 10 ticks — so a `swarm` under a single venom's fire dies some ticks
      // after it is hit rather than on the hit, and wave 1 is 16 `swarm` at `spacingTicks` 5.
      // Note the model's limit: six `venom` stand on `basicAnchors` with overlapping range, so
      // a creep crossing them picks up several INDEPENDENT records (per-source independence)
      // and dies faster than a one-tower reading suggests. Nothing here attributes the leak to
      // per-creep DoT timing — no per-creep instrumentation exists in this test.
      //
      // What IS pinned is the counterfactual: the first test plants `basic` on these exact six
      // anchors at these exact ticks and leaks nothing. So the wave-1 comparison is exactly
      // six `basic` vs six `venom` on identical geometry, seed, and pacing. That is `venom`'s
      // specialist trade as gameplay rather than arithmetic — the test above proves it is the
      // worse buy per bounty against unarmored creeps (28/9 vs 20/5); this shows what that
      // costs a player who builds nothing else.
      //
      // So this build WINS — 9 lives, still 3 stars — but pays exactly one life for going pure
      // venom into the swarm wave. Waves 0, 2 and 3 (the armored wave this file exists for)
      // all resolve clean, and all eight towers stand: exactly wave 1, exactly one creep, not
      // a broader collapse.
      //
      // M2-S6 P5: the bundle now also carries wave index 4 (`resolute`+`fast`), which
      // likewise crosses the same standing towers and resolves clean — the terminal figures
      // below are re-measured to include it, and the wave-1 leak (this test's whole point)
      // is unaffected.
      //
      // M2-S7 P6, same story as the first test in this file: the bundle now also carries
      // wave index 5 (8x `flying`), and this build has no `antiair` — every flyer crosses
      // the board untouched and leaks, on top of the one already-pinned wave-1 `swarm`
      // leak. The wave-1 comparison this test exists for (six `basic` vs six `venom` on
      // identical geometry) is unaffected — that leak is still exactly one creep, still
      // wave index 1 — the terminal figures below simply now legitimately include wave
      // index 5's own, unrelated, unengaged leak.
      //
      // The build stays pinned in full (PLAN.md step 3, Codex R2-8) — a balance-sensitive test
      // whose script can be re-cut is trivially riggable. Re-pinning the OUTCOME to what the
      // sim produced is the repo's normal golden discipline; re-cutting the BUILD to flatter
      // the number is what is forbidden, and was not done.
      // M2-S10 P3, and this is a REAL measured outcome, not a truncation artifact — the
      // OUTCOME FLIPS 'won' → 'lost' (Story 10 Risk 1 ruling: reported for S11's balance
      // pass, never tuned away). This build's last life was already down to 1 by the old
      // M2-S7 terminal figure; wave index 6's `armored-flyer` — air domain, armor 5,
      // untouched by this all-ground build (six `venom` on the row-10/12 lane, two `basic`
      // at column 16, neither covers `air`) — leaks its very first creep, and that single
      // 1-cost leak is enough to drain the last life. The run FREEZES there, before wave
      // index 6 finishes and long before wave index 7 (the boss) ever launches.
      // Re-pinned M2-S11 P3 (measured). Same reason
      // as test 1 above: P1's ten-wave arc inserts a new wave 4 before `flying`, pushing
      // `armored-flyer` to index 7 and the boss to index 9. The specialist trade this test
      // exists to show (one leaked `swarm` on wave 1) is unaffected — the new wave 4 sits
      // AFTER it in the schedule. Re-measured final at P4b — unchanged from P3 (this build
      // never touches antiair/boss-escort mechanics, and survivalMul only affects the WON
      // score branch, which this run never reaches).
      console.log(
        `[story-armored-wave venom-heavy] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
          `leaked=${state.leakedCount} bounty=${state.bounty} hash=${hashSimState(state)} ` +
          `score=${deriveScore(state, ruleset)} stars=${deriveStars(state, ruleset)}`,
      );
      expect(state.phase).toBe('lost');
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
        true,
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
      expect(state.tick).toBe(2866);
      // cumulativeKillBounty re-measured at 101 (+18 over the pre-S11 83): the new wave 4
      // (12x`normal`+6x`swarm`) contributes its own kills; wave index 5's 8 `flying` are
      // leaked, not killed, and wave index 7's single observed leak before the freeze
      // contributes nothing either (same reasoning as test 1).
      expect(state.cumulativeKillBounty).toBe(101);
      // `bounty` re-measured at 144 (+24 over the pre-S11 120: +18 kill bounty, +6 the new
      // wave 4's own clear bonus). No wave past it ever pays a clear bonus.
      expect(state.bounty).toBe(144);
      expect(hashSimState(state)).toBe('53c1dae5');
      // Lost score formula: kill-bounty only — no early-call credit, no survival term.
      expect(deriveScore(state, ruleset)).toBe(101);
      expect(deriveStars(state, ruleset)).toBe(0);
    },
  );
});

// The four `stun` anchors for wave index 4 (M2-S6 P8 test 17), module scope for the
// same reason `basicAnchors`/`column16Anchors` are: `(1,7)`, `(3,7)`, `(5,7)`, `(7,7)`
// — NOT from the existing test's anchor list (all eight of those are occupied by the
// byte-identical wave-0-to-3 wall). A flanking line one lane ABOVE the descent, the
// same geometry `basicAnchors` uses at rows 10/12, and the footprints tile without
// overlap (each 2x2 anchor spans cols c..c+1: 1-2, 3-4, 5-6, 7-8).
//
// PLAN.md originally specified `(20,10)`/`(20,12)`/`(24,10)`/`(24,12)`. Those were
// probed only for PLACEMENT ACCEPTANCE, and all four do accept — but a probe of where
// `resolute` actually travels shows it NEVER PASSES COLUMN 13: `basic`'s 10 damage
// two-shots a 20-hp `resolute` in the columns 1-8 approach, so towers at columns
// 20/24 never get a live shot at wave index 4's own creeps. The engagement proof
// below (`sawLiveResoluteStun`) was false under those anchors — the exact "measurement
// passes while nothing happened" failure this test exists to rule out. Re-probed
// against the real sim: at rows 7 all four accept in sequence at ticks 1500-1530 with
// bounty to spare, and a `resolute` IS observed stunned.
const stunAnchors: { col: number; row: number }[] = [
  { col: 1, row: 7 },
  { col: 3, row: 7 },
  { col: 5, row: 7 },
  { col: 7, row: 7 },
];

describe('wave index 4 (`resolute` + `fast`) — a stun-holding build ahead of it, measured (M2-S6 P8 test 17)', () => {
  // Four `stun` towers — `resolute` at speed 44 is the fastest ground creep in the
  // catalog and one 25%/20-tick tower cannot hold it — anchored 100 ticks after the
  // `resolute` wave's OWN observed countdown start (located by creep id, never a
  // hardcoded index; S11 P2), after wave index 3 is under way and before the `resolute`
  // wave itself launches.
  // SHARED SCENARIO (S11 P2 completion) — same idiom as the two helpers above: the stun
  // build run to terminal ONCE, read by both the mechanism-proof test (stun engagement,
  // de-indexed) and its outcome-golden sibling (the full terminal state).
  let stunScriptResult: {
    ruleset: CompiledRuleset;
    state: SimState;
    resoluteWaveIndex: number;
    rngStateAtStart: number;
    sawLiveResoluteStun: boolean;
  } | null = null;

  function runStunScript() {
    if (stunScriptResult) return stunScriptResult;
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const armoredWaveIndex = waveIndexForCreep(ruleset, 'armored');
    const resoluteWaveIndex = waveIndexForCreep(ruleset, 'resolute');
    const basicWall = basicWallInputs();
    const venomWall = anchoredWallInputs(ruleset, armoredWaveIndex, column16Anchors, 'venom', 200);
    const stunWall = anchoredWallInputs(ruleset, resoluteWaveIndex, stunAnchors, 'stun', 100);
    function inputs(tick: number, state: SimState): SimInput[] {
      const out = basicWall(tick);
      out.push(...venomWall(tick, state));
      out.push(...stunWall(tick, state));
      return out;
    }

    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    const rngStateAtStart = state.rngState;
    let sawLiveResoluteStun = false;
    // M2-S7 P6: loop bound widened 1900 -> 2400, same reason as the other `phase`-asserting
    // tests in this file — the appended sixth wave (index 5, `flying`) has no `antiair`
    // in this build and leaks untouched, and `phase` only settles once it resolves too.
    // M2-S10 P3: same reason as the other `phase`-asserting tests — the bundle now
    // carries two more waves (index 6, 7), so the loop runs until terminal, capped at
    // `MAX_MATCH_TICKS`, never a hand-picked tick constant.
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
      state = step(state, ruleset, inputs(t, state));
      for (let i = 0; i < state.creeps.id.length; i++) {
        const stunUntilTick = state.creeps.stunUntilTick[i] as number;
        if (
          state.creeps.creepId[i] === 'resolute' &&
          stunUntilTick !== 0 &&
          stunUntilTick >= state.tick
        ) {
          sawLiveResoluteStun = true;
        }
      }
    }
    stunScriptResult = { ruleset, state, resoluteWaveIndex, rngStateAtStart, sawLiveResoluteStun };
    return stunScriptResult;
  }

  it(
    'the byte-identical wave-0-to-3 build, plus four stun towers, actually engages stun — proved, then measured',
    { timeout: 120_000 },
    () => {
      const { ruleset, state, resoluteWaveIndex, rngStateAtStart, sawLiveResoluteStun } =
        runStunScript();

      // PROOF THE FEATURE ENGAGED (M2-S6 P8 test 17), before any terminal measurement:
      // all four placements accepted (tower count AND bounty spent both match the
      // compiled catalog's cost, proving none silently no-op'd), and `rngState` moved
      // from its initial value (a genuine draw happened, not merely a compiled-but-
      // inert effect).
      expect(state.towers.towerId.filter((id) => id === 'basic')).toHaveLength(6);
      expect(state.towers.towerId.filter((id) => id === 'venom')).toHaveLength(2);
      expect(state.towers.towerId.filter((id) => id === 'stun')).toHaveLength(4);
      const basicCost = ruleset.towerById['basic']?.cost;
      const venomCost = ruleset.towerById['venom']?.cost;
      const stunCost = ruleset.towerById['stun']?.cost;
      if (basicCost === undefined || venomCost === undefined || stunCost === undefined) {
        throw new Error("expected 'basic'/'venom'/'stun' in the compiled catalog");
      }
      const totalSpend = state.towers.spend.reduce((a, b) => a + b, 0);
      expect(totalSpend).toBe(6 * basicCost + 2 * venomCost + 4 * stunCost);
      expect(state.rngState).not.toBe(rngStateAtStart); // some creep DID roll a stun chance

      // The load-bearing half of the engagement proof: a `resolute` — the creep this
      // story exists for, and the one immune to the slow tower that has answered fast
      // creeps since S3 — was actually observed HELD. Without this line the whole test
      // degrades to a wave-index-4 hash golden that would pass with the stun towers
      // deleted. It is asserted true because it MEASURES true, and it only measures
      // true because `stunAnchors` sits where a live `resolute` can be reached; see
      // that array's comment for the anchors this replaced and why they read false.
      expect(sawLiveResoluteStun).toBe(true);

      // THE S11 P2 MECHANISM CLAIM, de-indexed: wave index 4 (`resolute`+`fast`, located by
      // creep id) itself resolved clean, never leaked — the stun wall's own done-criterion,
      // independent of anything past it.
      expect(state.waveResolved[resoluteWaveIndex]).toBe(true);
      expect(state.waveLeaked[resoluteWaveIndex]).toBe(false);
    },
  );

  // OUTCOME GOLDEN (position-sensitive by nature, re-measured when the arc moves) — split
  // out of the mechanism-proof test above at S11 P2 completion. Same run as that test
  // (`runStunScript`'s module-level memo), same literals as before this split — nothing
  // here was re-measured, only re-homed.
  it(
    'the byte-identical wave-0-to-3 build, plus four stun towers — the full-game terminal state, outcome golden (position-sensitive by nature, re-measured when the arc moves)',
    { timeout: 120_000 },
    () => {
      const { ruleset, state } = runStunScript();

      // --- THE MEASUREMENT (M2-S6 P8 test 17) — measured, not invented. The fifth wave
      // clears: the stun towers hold `resolute`s on the approach, and the pre-existing
      // wall does the killing. Stun's contribution here is counterplay, not damage.
      //
      // M2-S7 P6, same story as every other test in this file: the bundle carried wave
      // index 5 (8x `flying`), and this build has no `antiair` (`stun` is ground-scoped
      // too, per its own catalog entry — untouched by this story) — every flyer crossed the
      // board untouched and leaked, but the game still WON.
      //
      // M2-S10 P3, same OUTCOME FLIP as every other `phase`-asserting test in this file
      // (Story 10 Risk 1 ruling: reported for S11's balance pass, never tuned away): wave
      // index 6's `armored-flyer` is also air-domain and untouched by `basic`/`venom`/
      // `stun` alike (none targets `air`), so it leaks too, and its first two leaks
      // (spaced 20 ticks apart) drain the last 2 lives to 0. The run FREEZES there, before
      // wave index 6 finishes and long before wave index 7 (the boss) ever launches. The
      // stun-holding proof above (`sawLiveResoluteStun`) is unaffected — it fires long
      // before wave index 6 even starts.
      // Re-pinned M2-S11 P3 (measured). Same reason
      // as tests 1/3 above: P1's ten-wave arc inserts a new wave 4 before `flying`,
      // pushing `resolute`+`fast` to index 6, `armored-flyer` to index 7, the boss to
      // index 9. The stun-engagement proof (`sawLiveResoluteStun`) fires long before any
      // of that and is unaffected. Re-measured final at P4b — unchanged from P3 (same
      // ground-only, antiair-free build as tests 1/3; arc tuning does not touch it).
      console.log(
        `[story-armored-wave #17] phase=${state.phase} tick=${state.tick} lives=${state.lives} ` +
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
      // `bounty` re-measured at 125 (+24 over the pre-S11 101: +18 kill bounty, +6 the new
      // wave 4's own clear bonus) — no wave past it ever pays a clear bonus (same
      // reasoning as the other three tests in this file).
      expect(state.bounty).toBe(125);
      expect(hashSimState(state)).toBe('95e90744');
      // Lost score formula: kill-bounty only — no early-call credit, no survival term.
      // Re-measured at 102 (+18 over the pre-S11 84), same derivation as test 1.
      expect(deriveScore(state, ruleset)).toBe(102);
      expect(deriveStars(state, ruleset)).toBe(0);
    },
  );
});
