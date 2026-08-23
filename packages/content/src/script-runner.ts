// script-runner.ts — G1-b (#94): the shared greedy-placement script-runner core.
//
// Three files each grew their own copy of the SAME loop — place `plan[cursor]` the first
// tick its cost is covered by the running `bounty`, advance the cursor once the tower
// count actually increases, stop the instant the sim leaves `'running'` (or hits
// `MAX_MATCH_TICKS`): `story-showcase.test.ts`'s `runBuild` (per-tower damage/status
// attribution), `m2-golden.test.ts`'s `runGolden` (hash trace + mid-run boss probe), and
// `apps/server/src/replay-parity.test.ts`'s `runScript` (the concrete per-tick input log
// a real client would submit). If the affordability rule ever changed, three copies would
// diverge while each kept passing its own pins — this is the one place it lives now.
//
// ONLY the loop moves here. What each caller measures per tick is nothing alike — `runBuild`
// replays damage resolution from observable state, `runGolden` tracks boss hp and a hash
// trace, `runScript` just logs the raw input log — so every bit of that stays exactly where
// it was, wired in through `beforeStep`/`afterStep`: `beforeStep` runs immediately before
// `step()` (so a caller can snapshot the state `step()` is about to consume, the way
// `runBuild`'s damage-attribution replay snapshots pre-impact hp), `afterStep` runs
// immediately after, carrying the tick's own `inputs` (what `runScript` logs verbatim) and
// `placed` — the script entry that actually advanced the cursor this tick, `undefined` if
// none did (what `runBuild` attributes spend to).

import {
  createInitialState,
  step,
  MAX_MATCH_TICKS,
  type SimInput,
  type SimState,
  type CompiledRuleset,
} from '@wynding/sim';
import type { Placement } from './showcase-builds';

/** Per-tick hooks a caller wires its own instrumentation through — both optional, both
 *  called exactly once per tick, in this order. */
export interface ScriptRunObserver {
  /** Immediately BEFORE `step()` — `state` is still the PREVIOUS tick's terminal state
   *  (this tick has not been applied yet). */
  readonly beforeStep?: (state: SimState, ruleset: CompiledRuleset) => void;
  /** Immediately AFTER `step()` — `inputs` is exactly what was passed to `step()` this
   *  tick (empty unless the script placed something this tick), and `placed` is the
   *  script entry that actually advanced the cursor this tick (`undefined` if none did —
   *  a placement can appear in `inputs` and still be rejected by the sim). */
  readonly afterStep?: (
    state: SimState,
    ruleset: CompiledRuleset,
    inputs: readonly SimInput[],
    placed: Placement | undefined,
  ) => void;
}

export interface ScriptRunResult {
  readonly state: SimState;
  /** The final cursor position — placements ACCEPTED by the sim, in script order. A
   *  rejected placement never advances the cursor, so this is the build that actually
   *  stood on the board (`story-showcase.test.ts`'s `BuildResult.placedCount`). */
  readonly placedCount: number;
}

/**
 * Runs `plan` against `ruleset` from a fresh `createInitialState(seed, ruleset)`: while
 * the sim is `'running'` (capped at `MAX_MATCH_TICKS`), greedily place `plan[cursor]` the
 * first tick `state.bounty` covers its cost, and advance `cursor` once the tower count
 * actually increases (a placement the sim rejects — e.g. an occupied anchor — never
 * advances it). This is the entire shared core (#94) — every other measurement is a
 * caller's own `observer`.
 */
export function runBuildScript(
  ruleset: CompiledRuleset,
  seed: number,
  plan: readonly Placement[],
  observer?: ScriptRunObserver,
): ScriptRunResult {
  let state: SimState = createInitialState(seed, ruleset);
  let cursor = 0;

  for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
    const inputs: SimInput[] = [];
    if (cursor < plan.length) {
      const next = plan[cursor]!;
      const cost = ruleset.towerById[next.towerId]?.cost;
      if (cost === undefined) {
        throw new Error(`unknown towerId '${next.towerId}' in a build script`);
      }
      if (state.bounty >= cost) {
        inputs.push({
          kind: 'placeTower',
          anchor: { col: next.col, row: next.row },
          towerId: next.towerId,
        });
      }
    }
    const towersBefore = state.towers.id.length;

    observer?.beforeStep?.(state, ruleset);

    state = step(state, ruleset, inputs);

    const placed =
      state.towers.id.length > towersBefore && cursor < plan.length ? plan[cursor] : undefined;
    if (placed) cursor++;

    observer?.afterStep?.(state, ruleset, inputs, placed);
  }

  return { state, placedCount: cursor };
}
