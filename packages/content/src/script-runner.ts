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
//
// M3 story 1 (the balance checker) adds two things a reference build needs and nothing
// else: a step may wait for a tick (`notBeforeTick` — the step is not attempted before
// it), and a step may SELL the tower standing on an anchor. Both ride the same single
// cursor, so a script is still one ordered list and a step never runs ahead of the one
// before it. A plan with neither (every pre-M3 caller) runs exactly as it always did.
//
// A STEP IS CREDITED BY THE SIM'S OWN ACCEPTANCE, not by the tower count. The count
// lies once a `burst` tower (`mine`) is on the board: it removes itself in combat on the
// tick it detonates, so a count-based runner credits a sell nobody sent on that tick and
// misses a placement made on it (the count stays flat, and the cursor stalls forever).
// Instead each tick's command is put through `previewInputs` — the sim's read-only run of
// the very input phase `step()` opens with, on the same state — and its verdict is what
// `step()` then does. For a plan without burst towers the two rules agree exactly, which
// is what keeps every pre-M3 caller byte-identical.

import {
  createInitialState,
  previewInputs,
  step,
  MAX_MATCH_TICKS,
  type SimInput,
  type SimState,
  type StepEvents,
  type CompiledRuleset,
} from '@wynding/sim';

/** One scripted tower placement: a build script is a plan of these, in play order. */
export interface Placement {
  readonly kind?: 'place';
  readonly col: number;
  readonly row: number;
  readonly towerId: string;
  /** Not attempted before this tick; from it on, placed the first tick bounty covers it. */
  readonly notBeforeTick?: number;
}

/** One scripted sell: the tower anchored at `(col, row)`, sold the first tick it can be
 *  (and not before `notBeforeTick`). */
export interface Sell {
  readonly kind: 'sell';
  readonly col: number;
  readonly row: number;
  readonly notBeforeTick?: number;
}

/** One entry of a build script. */
export type ScriptStep = Placement | Sell;

/** What else happened on a tick, beside the placement `afterStep` already names. */
export interface ScriptTickDetail {
  /** The sell that advanced the cursor this tick, `undefined` if none did. */
  readonly sold: Sell | undefined;
  /** This tick's `StepEvents` — present only when the observer set `collectEvents`. */
  readonly events: StepEvents | undefined;
}

/** Per-tick hooks a caller wires its own instrumentation through — both optional, both
 *  called exactly once per tick, in this order. They observe; a hook that changed the
 *  state `step()` is about to consume would void the acceptance the runner read first. */
export interface ScriptRunObserver {
  /** Immediately BEFORE `step()` — `state` is still the PREVIOUS tick's terminal state
   *  (this tick has not been applied yet). */
  readonly beforeStep?: (state: SimState, ruleset: CompiledRuleset) => void;
  /** Immediately AFTER `step()` — `inputs` is exactly what was passed to `step()` this
   *  tick (empty unless the script placed or sold something this tick), and `placed` is
   *  the script entry that actually advanced the cursor this tick (`undefined` if none
   *  did — a placement can appear in `inputs` and still be rejected by the sim). */
  readonly afterStep?: (
    state: SimState,
    ruleset: CompiledRuleset,
    inputs: readonly SimInput[],
    placed: Placement | undefined,
    detail: ScriptTickDetail,
  ) => void;
  /** Pass a fresh `StepEvents` collector to every `step()` and hand it to `afterStep`.
   *  Events are never hash-relevant, so this changes what the caller sees, not the run. */
  readonly collectEvents?: boolean;
}

export interface ScriptRunResult {
  readonly state: SimState;
  /** The final cursor position — steps ACCEPTED by the sim, in script order. A
   *  rejected placement never advances the cursor, so for a placement-only plan this is
   *  the build that actually stood on the board (`story-showcase.test.ts`'s
   *  `BuildResult.placedCount`). */
  readonly placedCount: number;
  /** The step at the cursor when the run ended was sent and REJECTED by the sim at least
   *  once — blocked, not merely waiting for its tick or its bounty. */
  readonly stalled: boolean;
}

/** Whether the 2×2 footprint anchored at `(col, row)` is held only by burst towers that
 *  will clear it — two footprints overlap when their anchors are within one cell. A
 *  footprint held by any tower that stays (anything but a burst tower) is not worth
 *  waiting for: the placement is sent, the sim rejects it, and the run reads as stalled. */
function heldByBurstTowers(
  state: SimState,
  ruleset: CompiledRuleset,
  col: number,
  row: number,
): boolean {
  const towers = state.towers;
  let held = false;
  for (let i = 0; i < towers.id.length; i++) {
    if (Math.abs(towers.col[i]! - col) > 1 || Math.abs(towers.row[i]! - row) > 1) continue;
    if (ruleset.towerById[towers.towerId[i]!]?.attack?.mode !== 'burst') return false;
    held = true;
  }
  return held;
}

/** The input for a placement step this tick, or `null` while it waits — for its tick, for
 *  a burst tower still standing on its footprint to fire (a mine re-armed before the last
 *  one has), or for bounty. Waiting sends nothing, so it neither fills the input log nor
 *  reads as a rejection. Throws on a catalog-unknown tower id before anything else, so a
 *  fixture bug fails on the first tick rather than as a placement that silently never
 *  happens. */
function placementInput(
  state: SimState,
  ruleset: CompiledRuleset,
  next: Placement,
): SimInput | null {
  const cost = ruleset.towerById[next.towerId]?.cost;
  if (cost === undefined) {
    throw new Error(`unknown towerId '${next.towerId}' in a build script`);
  }
  if (next.notBeforeTick !== undefined && state.tick < next.notBeforeTick) return null;
  if (heldByBurstTowers(state, ruleset, next.col, next.row)) return null;
  if (state.bounty < cost) return null;
  return { kind: 'placeTower', anchor: { col: next.col, row: next.row }, towerId: next.towerId };
}

/** The input for a sell step this tick, or `null` while it waits for its tick. Throws if
 *  no tower stands on the anchor when the sell is due: the cursor only reaches a sell
 *  after every earlier step was accepted, so a missing tower is a script bug. */
function sellInput(state: SimState, next: Sell): SimInput | null {
  if (next.notBeforeTick !== undefined && state.tick < next.notBeforeTick) return null;
  const { id, col, row } = state.towers;
  for (let i = 0; i < id.length; i++) {
    if (col[i] === next.col && row[i] === next.row) return { kind: 'sellTower', tower: id[i]! };
  }
  throw new Error(`no tower anchored at (${next.col},${next.row}) to sell in a build script`);
}

function emptyEvents(): StepEvents {
  return { impactPoints: [], fired: [], leaked: [], killed: [] };
}

/**
 * Runs `plan` against `ruleset` from a fresh `createInitialState(seed, ruleset)`: while
 * the sim is `'running'` (capped at `MAX_MATCH_TICKS`), attempt `plan[cursor]` — a
 * placement the first tick its footprint is clear of towers and `state.bounty` covers its
 * cost, a sell the first tick it is due, neither before its `notBeforeTick` — and advance
 * `cursor` once the sim accepts it (a placement it rejects — e.g. one that would seal the
 * path — never advances it, and is sent again the next tick). This is the entire shared
 * core (#94) — every other measurement is a caller's own `observer`.
 */
export function runBuildScript(
  ruleset: CompiledRuleset,
  seed: number,
  plan: readonly ScriptStep[],
  observer?: ScriptRunObserver,
): ScriptRunResult {
  let state: SimState = createInitialState(seed, ruleset);
  let cursor = 0;
  let rejectedAtCursor = false;

  for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
    const inputs: SimInput[] = [];
    const next = cursor < plan.length ? plan[cursor]! : undefined;
    if (next !== undefined) {
      const input =
        next.kind === 'sell' ? sellInput(state, next) : placementInput(state, ruleset, next);
      if (input !== null) inputs.push(input);
    }
    // The sim's verdict on this tick's command, read before `step()` consumes the state.
    const accepted = inputs.length > 0 && previewInputs(state, ruleset, inputs).accepted[0]!;

    observer?.beforeStep?.(state, ruleset);

    const events = observer?.collectEvents === true ? emptyEvents() : undefined;
    state = step(state, ruleset, inputs, events);

    let placed: Placement | undefined;
    let sold: Sell | undefined;
    if (accepted && next !== undefined) {
      if (next.kind === 'sell') sold = next;
      else placed = next;
      cursor++;
      rejectedAtCursor = false;
    } else if (inputs.length > 0) {
      rejectedAtCursor = true;
    }

    observer?.afterStep?.(state, ruleset, inputs, placed, { sold, events });
  }

  return { state, placedCount: cursor, stalled: rejectedAtCursor };
}
