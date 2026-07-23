// controller.ts — the platform-side game orchestration (allowed wall-clock, but no
// Phaser/DOM here — those are the scene + overlay). It drives the deterministic sim on
// the fixed loop, turns player intent into `SimInput` commands, records the tick-input
// log for replay verification, and owns the pause/speed + Play-again lifecycle. Every
// branch here is unit-tested; the only untestable glue (Phaser, rAF) lives in the scene
// and main.ts.
//
// Determinism invariants honoured here:
//  - a FRESH command buffer per tick (never a reused array), so recording an immutable
//    copy can't be retroactively mutated (PLAN §6);
//  - recording STOPS at the terminal transition, so the produced log validates via
//    @wynding/replay (which rejects any tick logged past termination);
//  - speed/pause are presentation-only (they scale wall-clock, never enter the log).

import { createFixedLoop, type FixedLoop } from '@wynding/engine';
import {
  createInitialState,
  compileRuleset,
  step,
  previewInputs,
  deriveScore,
  deriveStars,
  isTerminalPhase,
  MS_PER_TICK,
  SIM_VERSION,
  type SimState,
  type SimInput,
  type CompiledRuleset,
} from '@wynding/sim';
import {
  deriveViewModel,
  deriveHud,
  resolvedImpactPoints,
  type RenderVM,
  type HudVM,
  type GhostVM,
  type SelectionVM,
} from '@wynding/render';
import { validate, currentRulesetHash, type Replay } from '@wynding/replay';
import { m1Ruleset, M1_BOARD_ID } from '@wynding/content';

export type Speed = 1 | 2;

/** A build/select target under the cursor: either an empty anchor with placement
 *  validity, or an existing tower to select. */
export interface AimResult {
  readonly kind: 'ghost' | 'tower' | 'blocked';
  readonly col: number;
  readonly row: number;
  readonly valid: boolean;
}

/** What the renderer needs each frame: the last two view-models + alpha + overlay. */
export interface FrameSnapshot {
  readonly prevVm: RenderVM | null;
  readonly curVm: RenderVM;
  readonly alpha: number;
  readonly ghost: GhostVM | null;
  readonly selection: SelectionVM | null;
}

/** Outcome of the dev-only replay self-check. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly score?: number;
  readonly stars?: number;
  /** Whether the re-simulated score/stars matched what the HUD showed. */
  readonly matchedLive?: boolean;
}

export interface Controller {
  readonly ruleset: CompiledRuleset;
  /** Feed wall-clock ms since the last frame; scales by speed unless paused. */
  advance(wallDtMs: number): void;
  /** The interpolation snapshot for the current frame. */
  frame(): FrameSnapshot;
  /** Impact-spark points resolved since the last call, then cleared. Accumulated per sim
   *  tick so a multi-tick catch-up frame still flashes every kill. */
  drainSparks(): { x: number; y: number }[];
  /** Derived HUD fields for the DOM overlay. */
  hud(): HudVM;
  isPaused(): boolean;
  speed(): Speed;
  pause(): void;
  resume(): void;
  togglePause(): void;
  cycleSpeed(): void;
  /** Point the cursor at a board cell; resolves to a ghost, a tower selection, or a
   *  blocked cell, and updates the overlay. */
  aimAt(col: number, row: number): AimResult;
  /** Hover preview (desktop pointermove): update the build ghost without changing the
   *  current tower selection. */
  previewAt(col: number, row: number): void;
  /** Move the keyboard cursor by a delta (clamped to the board), re-aiming. */
  moveCursor(dCol: number, dRow: number): AimResult;
  cursor(): { col: number; row: number };
  /** Confirm at the cursor: enqueue a build if a valid ghost is shown. Returns true if
   *  a command was enqueued. */
  confirm(): boolean;
  /** Sell the currently-selected tower. Returns true if a command was enqueued. */
  sellSelected(): boolean;
  /** The refund the selected tower would return right now (0 if none selected). */
  refundForSelection(): number;
  /** Enqueue call-wave-early (pre-wave only; idempotent in the sim). */
  callWaveEarly(): boolean;
  /** Reset everything for a new run (Play-again / boot). */
  startRun(seed: number): void;
  /** True once the match is won or lost. */
  isTerminal(): boolean;
  /** Assemble the recorded replay envelope. */
  buildReplay(): Replay;
  /** Dev-only: re-simulate the recorded log and confirm it reproduces the live score. */
  verifyRun(): VerifyResult;
}

const RANGE_FP = (r: CompiledRuleset): number => r.tower.rangeFp;

/** Create the game controller for `seed`. Content/ruleset are fixed (M1 single board). */
export function createController(seed: number): Controller {
  const bundle = m1Ruleset;
  const ruleset = compileRuleset(bundle, M1_BOARD_ID);
  const grid = ruleset.board.grid;
  const cols = grid.width;
  const rows = grid.height;

  let state: SimState;
  let runSeed: number; // the seed the current run was created from (stamps the replay)
  let loop: FixedLoop;
  let buffer: SimInput[]; // the CURRENT tick's commands, in issued order (fresh per tick)
  let tickInputs: SimInput[][]; // recorded log
  let prevVm: RenderVM | null;
  let curVm: RenderVM;
  let paused: boolean;
  let spd: Speed;
  let frozen: boolean; // set on the terminal transition — stops recording/stepping
  let cur: { col: number; row: number };
  let ghost: GhostVM | null;
  let selection: (SelectionVM & { id: number }) | null;
  // Cache the derived SelectionVM keyed on the current `selection` reference, so frame()
  // (called ~60×/s) doesn't allocate a fresh object every frame while a tower stays
  // selected — `selection` is only reassigned on aim/tick.
  let selOverlaySrc: (SelectionVM & { id: number }) | null = null;
  let selOverlay: SelectionVM | null = null;
  let pendingSparks: { x: number; y: number }[]; // impact points resolved since the last drain
  // previewInputs() deep-clones SimState, so both hot paths memoize: aimAt caches the last
  // placement-validity query (a pointermove that stays in one cell re-uses it), and the
  // refund is cached per selected tower id (refund is tick-invariant) so the per-frame HUD
  // read never re-clones.
  let aimMemoKey = '';
  let aimMemoValid = false;
  let refundCache = { id: -1, value: 0 };

  const onTick = (): void => {
    if (frozen) return; // terminal: freeze, record nothing past the resolving tick
    const inputs = buffer;
    tickInputs.push(Object.freeze([...inputs]) as SimInput[]); // immutable copy at index = tick
    state = step(state, ruleset, inputs);
    buffer = []; // FRESH buffer — the just-recorded copy can never be mutated by reuse
    prevVm = curVm;
    curVm = deriveViewModel(state, ruleset);
    // Accumulate this tick's resolved impact points so the scene flashes every kill, even
    // when several ticks run in one catch-up frame (the scene only sees the latest pair).
    for (const pt of resolvedImpactPoints(prevVm, curVm)) pendingSparks.push(pt);
    // Reconcile the selection with the post-step world: if the selected tower was sold or
    // destroyed this tick, drop the selection so the scene stops drawing a phantom range
    // ring and the Sell control disables (rather than selling a nonexistent id).
    if (selection !== null && towerAt(selection.col, selection.row)?.id !== selection.id) {
      selection = null;
    }
    if (isTerminalPhase(state.phase)) frozen = true;
  };

  const reset = (nextSeed: number): void => {
    runSeed = nextSeed >>> 0;
    state = createInitialState(runSeed, ruleset);
    loop = createFixedLoop(onTick, { msPerTick: MS_PER_TICK });
    buffer = [];
    tickInputs = [];
    prevVm = null;
    curVm = deriveViewModel(state, ruleset);
    paused = false;
    spd = 1;
    frozen = isTerminalPhase(state.phase);
    cur = {
      col: Math.min(grid.entrance.col, cols - 1),
      row: Math.min(grid.entrance.row, rows - 1),
    };
    ghost = null;
    selection = null;
    pendingSparks = [];
    // Clear the per-run memo/caches — the next run reuses tick indices from 0, so a stale
    // (col,row,bufferLen,tick) verdict must never carry across a Play-again.
    aimMemoKey = '';
    aimMemoValid = false;
    refundCache = { id: -1, value: 0 };
  };
  reset(seed);

  /** The tower whose 2×2 footprint covers (col,row), or null. */
  const towerAt = (col: number, row: number): { col: number; row: number; id: number } | null => {
    for (let i = 0; i < state.towers.id.length; i++) {
      const tc = state.towers.col[i] as number;
      const tr = state.towers.row[i] as number;
      if (col >= tc && col <= tc + 1 && row >= tr && row <= tr + 1) {
        return { col: tc, row: tr, id: state.towers.id[i] as number };
      }
    }
    return null;
  };

  const inBounds = (col: number, row: number): boolean =>
    col >= 0 && row >= 0 && col < cols && row < rows;

  // Placement validity of a build at (col,row) given the current buffer. Memoized on
  // (cell, buffer length, tick): a hover that stays in one cell (or repeated frames)
  // re-uses the last clone instead of deep-cloning SimState each event.
  const placementValid = (col: number, row: number): boolean => {
    const key = `${col},${row},${buffer.length},${state.tick}`;
    if (key === aimMemoKey) return aimMemoValid;
    const candidate: SimInput = { kind: 'placeTower', anchor: { col, row } };
    const { accepted } = previewInputs(state, ruleset, [...buffer, candidate]);
    const valid = accepted[accepted.length - 1] === true;
    aimMemoKey = key;
    aimMemoValid = valid;
    return valid;
  };

  const aimAt = (col: number, row: number): AimResult => {
    if (!inBounds(col, row)) return { kind: 'blocked', col, row, valid: false };
    cur = { col, row };
    const existing = towerAt(col, row);
    if (existing !== null) {
      ghost = null;
      selection = {
        col: existing.col,
        row: existing.row,
        rangeFp: RANGE_FP(ruleset),
        id: existing.id,
      };
      return { kind: 'tower', col: existing.col, row: existing.row, valid: true };
    }
    selection = null; // a click/keyboard aim on an empty cell is a build intent — deselect
    const valid = placementValid(col, row);
    ghost = { col, row, valid, rangeFp: RANGE_FP(ruleset) };
    return { kind: 'ghost', col, row, valid };
  };

  // Hover-only preview (desktop pointermove): update the build ghost but NEVER change the
  // current selection — otherwise moving the mouse across empty cells toward the DOM Sell
  // button would silently deselect the tower before the click lands.
  const previewAt = (col: number, row: number): void => {
    if (!inBounds(col, row)) {
      ghost = null;
      return;
    }
    cur = { col, row };
    if (towerAt(col, row) !== null) {
      ghost = null; // no build ghost over an existing tower; selection left untouched
      return;
    }
    ghost = { col, row, valid: placementValid(col, row), rangeFp: RANGE_FP(ruleset) };
  };

  const doPause = (): void => {
    paused = true;
  };
  const doResume = (): void => {
    if (!paused) return;
    paused = false;
    // Do NOT reset the loop accumulator here: while paused, advance() is skipped so the
    // accumulator (and thus the interpolation alpha) is already frozen at its pause-moment
    // value, and the app feeds only per-frame deltas — there is no accumulated burst to
    // drop. Resuming continues from that exact sub-tick position, so creeps neither snap
    // backward on pause nor jump on resume.
  };
  const doBuildReplay = (): Replay => ({
    seed: runSeed,
    boardId: M1_BOARD_ID,
    rulesetHash: currentRulesetHash(bundle),
    simVersion: SIM_VERSION,
    // Frozen snapshot copies: the envelope is a defensive, immutable view of the log —
    // a consumer cannot mutate it, and it cannot alias the internal recording.
    tickInputs: Object.freeze(tickInputs.map((t) => Object.freeze([...t]))) as Replay['tickInputs'],
  });

  return {
    ruleset,
    advance(wallDtMs: number): void {
      if (paused || frozen) return;
      loop.advance(Math.max(0, wallDtMs) * spd);
    },
    frame(): FrameSnapshot {
      // Paused freezes creeps IN PLACE (the accumulator is stable while paused), so alpha
      // holds its current sub-tick value rather than collapsing to 0 (which would rewind
      // every creep to the previous tick boundary). Only a terminal freeze pins alpha to 0.
      const alpha = frozen ? 0 : loop.accumulatorMs / MS_PER_TICK;
      return { prevVm, curVm, alpha, ghost, selection: selectionOverlay() };
    },
    drainSparks(): { x: number; y: number }[] {
      if (pendingSparks.length === 0) return [];
      const out = pendingSparks;
      pendingSparks = [];
      return out;
    },
    hud: () => deriveHud(state, ruleset),
    isPaused: () => paused,
    speed: () => spd,
    pause: doPause,
    resume: doResume,
    togglePause(): void {
      if (paused) doResume();
      else doPause();
    },
    cycleSpeed(): void {
      spd = spd === 1 ? 2 : 1;
    },
    aimAt,
    previewAt,
    moveCursor(dCol: number, dRow: number): AimResult {
      const col = Math.max(0, Math.min(cols - 1, cur.col + dCol));
      const row = Math.max(0, Math.min(rows - 1, cur.row + dRow));
      return aimAt(col, row);
    },
    cursor: () => ({ ...cur }),
    confirm(): boolean {
      // Keyboard confirm may fire before any hover/move populated the ghost — aim at the
      // cursor first so the very first Enter on a focused board acts on the cursor cell
      // (which may resolve to a build ghost or a tower selection), not a no-op.
      if (ghost === null && selection === null) aimAt(cur.col, cur.row);
      if (ghost === null || !ghost.valid) return false;
      buffer.push({ kind: 'placeTower', anchor: { col: ghost.col, row: ghost.row } });
      // Re-evaluate the ghost against the now-larger buffer (the just-queued build may
      // make this same cell invalid for a second placement while paused).
      aimAt(ghost.col, ghost.row);
      return true;
    },
    sellSelected(): boolean {
      if (selection === null) return false;
      buffer.push({ kind: 'sellTower', tower: selection.id });
      return true;
    },
    refundForSelection(): number {
      // No refund on a resolved match — the frozen step() would drop the sell (mirrors
      // previewInputs' terminal freeze; also stops the id-cache serving a stale pre-terminal
      // value once the game ends).
      if (selection === null || isTerminalPhase(state.phase)) return 0;
      // A tower's refund is refundFor(spend, …) — a function of its fixed spend and the
      // constant balance, so it is INVARIANT for a given tower id (ids are never reused).
      // Cache by id alone: at most one clone per distinct selection, never per tick/frame.
      if (refundCache.id === selection.id) return refundCache.value;
      const { preview } = previewInputs(state, ruleset, [
        { kind: 'sellTower', tower: selection.id },
      ]);
      const value = Math.max(0, preview.bounty - state.bounty);
      refundCache = { id: selection.id, value };
      return value;
    },
    callWaveEarly(): boolean {
      if (state.phase !== 'pre-wave') return false;
      buffer.push({ kind: 'callWaveEarly' });
      return true;
    },
    startRun(nextSeed: number): void {
      reset(nextSeed);
    },
    isTerminal: () => isTerminalPhase(state.phase),
    buildReplay: doBuildReplay,
    verifyRun(): VerifyResult {
      const replay = doBuildReplay();
      const result = validate(replay, bundle);
      if (!result.ok) return { ok: false, reason: result.reason };
      const liveScore = deriveScore(state, ruleset);
      const liveStars = deriveStars(state, ruleset);
      return {
        ok: true,
        score: result.score,
        stars: result.stars,
        matchedLive: result.score === liveScore && result.stars === liveStars,
      };
    },
  };

  function selectionOverlay(): SelectionVM | null {
    if (selection !== selOverlaySrc) {
      selOverlaySrc = selection;
      selOverlay =
        selection === null
          ? null
          : { col: selection.col, row: selection.row, rangeFp: selection.rangeFp };
    }
    return selOverlay;
  }
}
