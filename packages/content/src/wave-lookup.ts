// wave-lookup.ts — M2-S11 P2: shared test-support module, NOT part of this package's
// public API (not re-exported from `./index.ts`). It exists so the five story test files
// that pin mechanism proofs against a specific wave (`story-flying-wave`,
// `story-armored-wave`, `story-support`, `story-mine`, `story-finale`) never hardcode a
// wave INDEX — ruling 1 of the S11 plan forbids it, because P1 renumbers every wave, and a
// literal like `ruleset.waves[3]` would silently retarget onto whatever wave happens to
// land at index 3 after the renumber, with no test failure to flag it.
//
// Two orthogonal jobs live here:
//   1. LOCATION — "which wave, in the COMPILED schedule, first spawns creep id X" — a
//      pure function of the compiled ruleset, decided at authoring time.
//   2. TICK ANCHORING — a command scheduled ahead of a wave's launch (a placement, an
//      early call) cannot depend on a transition observed after it, so it anchors to the
//      wave's OBSERVED countdown start (already true when the command is decided) plus
//      the script's own early-call decisions. `SimState.waveLaunchTick` already records
//      exactly this, per-wave, as the sim runs — this module reads it, never derives it
//      from static content.

import type { CompiledRuleset, SimInput, SimState } from '@wynding/sim';

/**
 * The first wave index, in the COMPILED schedule (`ruleset.waves`, never raw JSON
 * authoring order), that spawns at least one creep of `creepId`. Throws rather than
 * returning -1: a mechanism proof asking for a wave that spawns nothing of the given id
 * is a fixture bug, not a legitimate "not found" the caller should silently handle.
 */
export function waveIndexForCreep(ruleset: CompiledRuleset, creepId: string): number {
  const index = ruleset.waves.findIndex((wave) => wave.spawns.some((s) => s.creepId === creepId));
  if (index === -1) {
    throw new Error(`wave-lookup: no wave in the compiled schedule spawns creep id '${creepId}'`);
  }
  return index;
}

/**
 * The OBSERVED tick `waveIndex`'s own countdown started counting down, given the CURRENT
 * `state` mid-run (or `createInitialState`'s own starting state) — `null` if it has not
 * started yet. Wave 0's countdown always starts at tick 0 (`createInitialState`'s own
 * contract). Every later wave's countdown starts the instant the previous wave launches
 * (`index.ts`'s wave-lifecycle step resets `countdownRemaining` in the same step call that
 * sets `waveLaunchTick[k - 1]`), so it is read directly off `waveLaunchTick[waveIndex - 1]`
 * — never computed from `CompiledWave.countdownTicks` prefix sums, which is exactly the
 * static-content shortcut that makes launch ticks wrong once an early call is in play.
 */
export function waveCountdownStartTick(state: SimState, waveIndex: number): number | null {
  if (waveIndex === 0) return 0;
  return state.waveLaunchTick[waveIndex - 1] ?? null;
}

/**
 * The OBSERVED tick `waveIndex` itself launched — `null` before that happens. A thin,
 * named alias over `state.waveLaunchTick[waveIndex]` so call sites read as "observed
 * launch", matching the plan's own vocabulary, rather than reaching into the SoA column
 * directly at every use.
 */
export function waveLaunchTickObserved(state: SimState, waveIndex: number): number | null {
  return state.waveLaunchTick[waveIndex] ?? null;
}

/**
 * Builds a stateful `(tick, state) => SimInput[]` placement schedule anchored to
 * `waveIndex`'s OBSERVED countdown start, never a static tick literal: once
 * `waveCountdownStartTick` first reports non-null, this arms itself at
 * `observedStart + leadTicks` and then places one tower per `anchors` entry, in order,
 * every `spacingTicks` ticks from there. `leadTicks`/`spacingTicks` are the script's OWN
 * early-call-style timing decisions (ruling: "the script's own early-call decisions, which
 * the script owns and therefore knows") — the only thing actually OBSERVED at runtime is
 * the countdown-start tick itself. Before the target wave's countdown has started, this
 * produces no inputs. Returns a NEW closure (its own cursor/arming state) on every call,
 * so callers never share placement state even when they build on the same anchor array
 * (mirrors `story-armored-wave.test.ts`'s existing `anchorWallInputs` convention).
 */
export function anchoredWallInputs(
  ruleset: CompiledRuleset,
  waveIndex: number,
  anchors: readonly { readonly col: number; readonly row: number }[],
  towerId: string,
  leadTicks: number,
  spacingTicks = 10,
): (tick: number, state: SimState) => SimInput[] {
  // Bounds-check up front: a wave index outside the compiled schedule would otherwise
  // just never arm (waveCountdownStartTick stays null) and the wall would silently never
  // build — the exact quiet failure this module exists to prevent.
  if (waveIndex < 0 || waveIndex >= ruleset.waves.length) {
    throw new Error(
      `anchoredWallInputs: wave index ${waveIndex} outside the compiled schedule (0..${ruleset.waves.length - 1})`,
    );
  }
  // Same up-front-throw philosophy as the bounds check: a non-positive spacing would
  // make the modulo gate below unsatisfiable (or divide by zero) and the wall would
  // silently never place — the exact quiet failure this module exists to prevent.
  if (spacingTicks <= 0) {
    throw new Error(`anchoredWallInputs: spacingTicks must be positive, got ${spacingTicks}`);
  }
  let next = 0;
  let armedAt: number | null = null;
  return (tick: number, state: SimState): SimInput[] => {
    const out: SimInput[] = [];
    if (armedAt === null) {
      const start = waveCountdownStartTick(state, waveIndex);
      if (start !== null) armedAt = start + leadTicks;
    }
    if (
      armedAt !== null &&
      tick >= armedAt &&
      (tick - armedAt) % spacingTicks === 0 &&
      next < anchors.length
    ) {
      out.push({ kind: 'placeTower', anchor: anchors[next]!, towerId });
      next++;
    }
    return out;
  };
}
