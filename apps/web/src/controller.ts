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
  hashSimState,
  isTerminalPhase,
  MS_PER_TICK,
  SIM_VERSION,
  type SimState,
  type SimInput,
  type CompiledRuleset,
  type StepEvents,
  type PreviewState,
  type ReadonlyTowerArrays,
} from '@wynding/sim';
import {
  deriveViewModel,
  deriveHud,
  renderTimeOf,
  type RenderVM,
  type HudVM,
  type GhostVM,
  type SelectionVM,
  type TracerVM,
} from '@wynding/render';
import { validate, currentRulesetHash, MAX_INPUTS_PER_TICK, type Replay } from '@wynding/replay';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';

export type Speed = 1 | 2;

/**
 * The M1-local "armed tower type" identifier (PLAN.md P2). This is deliberately NOT
 * `@wynding/types`' `TowerKind`: that package is not a web dependency, and `placeTower`'s
 * `SimInput` carries no kind at all (M1 ships exactly one tower, so the sim never needed
 * to disambiguate). Supporting more than one placeable kind is a future `SimInput` schema
 * change, not a web-layer concern — this union stays a single literal until that lands.
 */
export type ArmedTower = 'basic';

/** A build/select target under the cursor: either an empty anchor with placement
 *  validity, or an existing tower to select. */
export interface AimResult {
  readonly kind: 'ghost' | 'tower' | 'blocked';
  readonly col: number;
  readonly row: number;
  readonly valid: boolean;
}

/** The last thing the armed/selection state machine did, for the `apps/web` assistive
 *  live region (PLAN.md P2) to announce. Rejection reasons are deliberately limited to
 *  what this layer can identify WITHOUT re-deriving `canPlaceTower()`'s sim-side logic:
 *  'bounty' (cost vs current bounty) and 'occupied' (an existing/Pending tower at the
 *  anchor) are locally checkable; every other rejection (blocked maze path, terrain,
 *  creep occupancy, a full input buffer) reports as 'other' (one generic localized
 *  "can't build there" string at the call site). */
export type PlacementOutcome =
  | { readonly kind: 'armed' }
  | { readonly kind: 'disarmed' }
  | { readonly kind: 'placed' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'bounty' | 'occupied' | 'other' | 'pendingCap';
    }
  | { readonly kind: 'sold'; readonly refund: number };

/** The observation path for the DOM overlay (Card/Panel/Dock, PLAN.md P2/P4): a plain
 *  snapshot of state that isn't already covered by `frame()`/`hud()`, read once per
 *  render when `uiRev()` has changed. `started` is the real advance gate (PLAN.md P4):
 *  `false` from a fresh run/Play-again until the player calls `start()`. */
export interface UiState {
  readonly started: boolean;
  readonly armed: ArmedTower | null;
  readonly selection: { readonly col: number; readonly row: number; readonly id: number } | null;
  readonly lastOutcome: PlacementOutcome | null;
  /** Bumped every time an outcome is RECORDED — even when it's identical in content to the
   *  previous one (e.g. rejecting the same occupied cell twice in a row). The live region
   *  (overlay.ts) keys its re-announcement on this identity, not on `lastOutcome` text
   *  equality, so two consecutive identical outcomes still both get announced. Reset to 0
   *  on `startRun()`. */
  readonly outcomeSeq: number;
}

/** What the renderer needs each frame: the last two view-models + alpha + overlay. */
export interface FrameSnapshot {
  readonly prevVm: RenderVM | null;
  readonly curVm: RenderVM;
  readonly alpha: number;
  readonly ghost: GhostVM | null;
  readonly selection: SelectionVM | null;
  /** Towers accepted into the tick buffer but not yet committed by a tick (the common
   *  case: paused planning) — anchor cells only, presentation reads them from the shared
   *  projection below, never by parsing raw commands. Empty whenever the buffer is empty
   *  (the hot 60 fps path — no allocation). */
  readonly pendingAdds: readonly { readonly col: number; readonly row: number }[];
  /** Committed towers whose sell is accepted into the buffer but not yet committed —
   *  presented as already-gone (hidden immediately), not merely "about to sell". */
  readonly pendingSells: readonly { readonly col: number; readonly row: number }[];
  /** Bumped whenever the tick buffer's pending commands change (queued or committed).
   *  Lets a consumer (main.ts's `hudKey`) detect a paused-planning economy change even
   *  though `curVm.tick` is frozen while paused. */
  readonly pendingRevision: number;
  /** Shots currently in flight (Tracer, #32/P6) — the controller's live tracer list,
   *  pruned as flights land or the run resets. Purely presentational. */
  readonly tracers: readonly TracerVM[];
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
  /** Toggle `kind` armed for placement (PLAN.md P2 table, row 1): arms it and clears any
   *  selection, or — if already armed — disarms. Mouse/keyboard-Card entry point. */
  armTower(kind: ArmedTower): void;
  /** Pointer/mouse click at a board cell — the armed/selection state machine (PLAN.md P2
   *  table): armed is placement-only (an occupied/unaffordable/blocked cell rejects with
   *  a persistent invalid ghost and stays armed; a valid cell places, disarms, and selects
   *  the new tower); unarmed is selection-only (a tower selects, anything else
   *  deselects). Distinct from `aimAt`, which keeps its pre-P2 build-or-select behavior
   *  for the keyboard cursor. */
  clickAt(col: number, row: number): void;
  /** Document-scope Escape (PLAN.md P2 table): closes one layer at a time — armed
   *  disarms; otherwise a selection deselects. No-op in neither state. Caller (overlay.ts)
   *  is responsible for not invoking this while a modal owns Escape. */
  escape(): void;
  /** A snapshot of state not already covered by `frame()`/`hud()` — read once per render
   *  when `uiRev()` changes. */
  uiState(): UiState;
  /** Monotonically increasing within a run; bumped on every `uiState()`-visible change
   *  (armed/disarmed, selection change, placement/sell outcome). Reset to 0 on
   *  `startRun()`. */
  uiRev(): number;
  /** Enqueue call-wave-early (pre-wave only; idempotent in the sim). Not wired to any UI
   *  control (PLAN.md P4: the pre-wave call-wave path is reachable only via `start()`) —
   *  kept as the shared primitive `start()` builds on, and exercised directly by tests. */
  callWaveEarly(): boolean;
  /** Player-started runs (PLAN.md P4): while `!started`, `advance()` never steps. Enqueues
   *  `callWaveEarly` and flips `started` to `true` ONLY once that enqueue is accepted —
   *  atomic, so a held run can never observe `started === true` without its launch
   *  command actually queued. A reserved buffer slot (see `enqueueVerdict`'s `cap`)
   *  guarantees the enqueue always succeeds while held, so `start()` can never deadlock.
   *  Idempotent: once `state.phase` has left `pre-wave` (this run is already under way —
   *  M1 ships exactly one wave, so that's for the rest of the run), this is a no-op. */
  start(): void;
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

/**
 * Classify a candidate command against the CURRENT tick's buffer, before it is queued.
 * Evaluation order matters: duplicate detection runs FIRST, the cap SECOND — a duplicate
 * in an already-full buffer is still `'duplicate'`, because that intent already *is* in
 * the buffer (idempotent success must survive a full buffer).
 *  - `'duplicate'`: the buffer already holds an equivalent command — any `callWaveEarly`
 *    for a `callWaveEarly` cmd; a `sellTower` with the SAME `tower` id (different ids
 *    still queue — selling several towers in one paused tick is legit gameplay).
 *    `placeTower` is deliberately NOT anchor-matched here (ship-review, post-#37+#27): a
 *    raw same-anchor scan cannot tell a still-pending build from one an INTERVENING
 *    `sellTower` in this same buffer already cancelled — flagging the latter case as
 *    'duplicate' would silently drop a legitimate sell-then-rebuild-while-still-pending
 *    (confirm() would report success but queue nothing). True duplicate-build prevention
 *    is `towerAt`'s job (reads the shared projection, controller.ts): while a placeTower
 *    is genuinely still live in the buffer, `aimAt` resolves that anchor to a TOWER
 *    selection, so `confirm()` never even reaches this classifier for it (the ghost is
 *    null). By the time we're here with a valid ghost, any same-anchor `placeTower`
 *    already in the buffer is necessarily a dead/cancelled one — never a live duplicate.
 *  - `'full'`: not a duplicate, and the buffer is already at `cap` (`MAX_INPUTS_PER_TICK`
 *    by default — the replay contract's exact per-tick limit, imported not duplicated, so
 *    the two can never drift). This is an intentional product limit, not a bug surface: it
 *    exists so no recorded tick can ever exceed the replay contract even via many
 *    *distinct* commands, and the DEFAULT cap is unreachable through normal M1 play (board
 *    geometry + bounty bound distinct legal commands well under 64) — refusal at the
 *    default cap is silent by design, no UI error state. `controller.ts` passes an
 *    explicit REDUCED cap (`MAX_INPUTS_PER_TICK - 1`) for build/sell commands while a run
 *    is held pre-start (PLAN.md P4), reserving one slot for `start()`'s own
 *    `callWaveEarly` so a held run's buffer can never deadlock Start — that reduced cap
 *    IS reachable in play (a persistent build/sell reshuffler), and IS surfaced to the
 *    player (a distinct 'pendingCap' outcome, not silent).
 *  - `'queue'`: otherwise — the command should be pushed.
 */
export function enqueueVerdict(
  buffer: readonly SimInput[],
  cmd: SimInput,
  cap: number = MAX_INPUTS_PER_TICK,
): 'queue' | 'duplicate' | 'full' {
  const duplicate = buffer.some((existing) => {
    switch (cmd.kind) {
      case 'callWaveEarly':
        return existing.kind === 'callWaveEarly';
      case 'sellTower':
        return existing.kind === 'sellTower' && existing.tower === cmd.tower;
      default:
        return false;
    }
  });
  if (duplicate) return 'duplicate';
  if (buffer.length >= cap) return 'full';
  return 'queue';
}

/**
 * Whether a completed run's live outcome matches its replay re-simulation (#41): score
 * AND stars AND the terminal world-hash. A pure, directly-testable helper — score/stars
 * alone can coincidentally agree while the world itself diverged (e.g. a different tower
 * layout reaching the same score), so `matchedLive` must also gate on `finalHash`.
 */
export function outcomesMatch(
  result: { readonly score?: number; readonly stars?: number; readonly finalHash?: string },
  liveScore: number,
  liveStars: number,
  liveFinalHash: string,
): boolean {
  return (
    result.score === liveScore && result.stars === liveStars && result.finalHash === liveFinalHash
  );
}

/** A tower-anchor cell (col,row) — the presentation unit for pending builds/sells. */
interface TowerAnchor {
  readonly col: number;
  readonly row: number;
}

/**
 * Pending additions/sells (#37+#27), derived by DIFFING the projected towers against the
 * committed towers — never by parsing raw `placeTower`/`sellTower` commands. This stays
 * correct for accepted sells, sell-then-rebuild, and rejected/no-op queued commands
 * (which the projection already resolves to "no change", so they diff to nothing).
 */
function diffPendingTowers(
  committed: SimState['towers'],
  projected: ReadonlyTowerArrays,
): { readonly additions: TowerAnchor[]; readonly sells: TowerAnchor[] } {
  const committedIds = new Set(committed.id);
  const projectedIds = new Set(projected.id);
  const additions: TowerAnchor[] = [];
  for (let i = 0; i < projected.id.length; i++) {
    if (!committedIds.has(projected.id[i] as number)) {
      additions.push({ col: projected.col[i] as number, row: projected.row[i] as number });
    }
  }
  const sells: TowerAnchor[] = [];
  for (let i = 0; i < committed.id.length; i++) {
    if (!projectedIds.has(committed.id[i] as number)) {
      sells.push({ col: committed.col[i] as number, row: committed.row[i] as number });
    }
  }
  return { additions, sells };
}

const NO_PENDING: readonly TowerAnchor[] = [];

/**
 * Deep-freeze an immutable copy of a tick's commands for the recorded log. The commands
 * are CLONED (the live buffer objects stay untouched for step()) and then frozen at every
 * level — the array, each command, and a `placeTower`'s nested `anchor` (the only nested
 * field in the SimInput union). Freezing only the array (the old approach) left the
 * command objects shared and mutable, so a consumer mutating a `buildReplay()` envelope
 * could silently corrupt the internal log and later `verifyRun()` results.
 */
function freezeRecorded(inputs: readonly SimInput[]): readonly SimInput[] {
  return Object.freeze(
    inputs.map((cmd): SimInput => {
      const copy: SimInput =
        cmd.kind === 'placeTower'
          ? { ...cmd, anchor: Object.freeze({ ...cmd.anchor }) }
          : { ...cmd };
      return Object.freeze(copy);
    }),
  );
}

/** Create the game controller for `seed`. Content/ruleset are fixed (M1 single board). */
export function createController(seed: number): Controller {
  const bundle = getBundledRuleset();
  const boardId = defaultBoardId(bundle);
  const ruleset = compileRuleset(bundle, boardId);
  const grid = ruleset.board.grid;
  const cols = grid.width;
  const rows = grid.height;

  let state: SimState;
  let runSeed: number; // the seed the current run was created from (stamps the replay)
  let loop: FixedLoop;
  let buffer: SimInput[]; // the CURRENT tick's commands, in issued order (fresh per tick)
  let tickInputs: (readonly SimInput[])[]; // recorded log (deep-frozen entries)
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
  // Live in-flight-shot list (Tracer, #32/P6): appended from each tick's drained `fired`
  // events, pruned in `frame()` once render time passes a flight's `impactTick` — no
  // tracer crosses run identity (cleared on `reset()`) or survives past terminal.
  let tracers: TracerVM[] = [];
  // Bumped on every command actually queued into `buffer` (never on a rejected/duplicate
  // enqueue) — the paused-planning presentation's second memo key alongside `state.tick`.
  let bufferRev = 0;
  // previewInputs() clones its towers container on every call (#30/P3), so both hot
  // paths memoize: aimAt caches the last placement-validity query (a pointermove that
  // stays in one cell re-uses it), and the refund is cached per selected tower id
  // (refund is tick-invariant) so the per-frame HUD read never re-clones.
  let aimMemoKey = '';
  let aimMemoValid = false;
  let refundCache = { id: -1, rev: -1, value: 0 };
  // The ONE shared paused-planning projection (#37+#27): previewInputs() run once per
  // (tick, bufferRev) pair, memoized, and reused by towerAt/hud/refund/frame — never
  // recomputed per reader. `null` whenever the buffer is empty (the 60 fps hot path stays
  // cheap: previewInputs() only deep-clones the towers container, #30/P3).
  let previewMemo: {
    tick: number;
    rev: number;
    preview: PreviewState;
    pendingAdds: TowerAnchor[];
    pendingSells: TowerAnchor[];
  } | null = null;
  // Armed/selection state machine (PLAN.md P2): `armed` is purely `apps/web` presentation
  // state — it never enters the sim or the replay log. `uiRev` is the DOM overlay's
  // observation key (bumped on every `uiState()`-visible change) and `lastOutcome` is what
  // the assistive live region announces next.
  let armed: ArmedTower | null = null;
  let uiRev = 0;
  let lastOutcome: PlacementOutcome | null = null;
  // Fix A: a separate identity counter for `lastOutcome`, bumped on every RECORDED outcome
  // (including a repeat of the same one) so the live region can re-announce a repeated
  // outcome that `uiRev` alone can't distinguish from a no-op re-render.
  let outcomeSeq = 0;
  // Player-started runs (PLAN.md P4): the real advance gate. `false` from a fresh run/
  // Play-again until `start()`'s enqueue is accepted; `advance()` is a no-op while this is
  // false, regardless of `paused`/speed — held runs never step. Never reset by anything
  // BUT `reset()` (a fresh run identity) — `start()` only ever flips it true.
  let started = false;
  const bumpUiRev = (): void => {
    uiRev++;
  };
  const setOutcome = (outcome: PlacementOutcome): void => {
    lastOutcome = outcome;
    outcomeSeq++; // identity bump — every recorded outcome, even a content-identical repeat
    bumpUiRev();
  };
  // The per-tick input cap in effect right now (PLAN.md P4): the full replay-contract
  // limit once running, or one slot short of it while held — the reserved slot Start's own
  // `callWaveEarly` always lands in, so a held run's buffer can never deadlock Start.
  const effectiveCap = (): number => (started ? MAX_INPUTS_PER_TICK : MAX_INPUTS_PER_TICK - 1);

  const onTick = (): void => {
    if (frozen) return; // terminal: freeze, record nothing past the resolving tick
    const inputs = buffer;
    tickInputs.push(freezeRecorded(inputs)); // deep-frozen clone at index = tick
    // Landed-impact + fired-shot events (#31/#32): the sim reports the exact points
    // where a shot hit a still-live target (BEFORE damage applies — a wasted/leaked-
    // target shot never appends) and every shot fired this tick (exact origin + the
    // target locked at fire time). Accumulate across a multi-tick catch-up frame so the
    // scene flashes every kill and shows every shot (it only sees the latest view-model
    // pair each animation frame).
    const events: StepEvents = { impactPoints: [], fired: [] };
    state = step(state, ruleset, inputs, events);
    buffer = []; // FRESH buffer — the just-recorded copy can never be mutated by reuse
    prevVm = curVm;
    curVm = deriveViewModel(state, ruleset);
    for (const pt of events.impactPoints) pendingSparks.push(pt);
    for (const f of events.fired) tracers.push(f);
    // Reconcile the selection with the post-step world: if the selected tower was sold or
    // destroyed this tick, drop the selection so the scene stops drawing a phantom range
    // ring and the Sell control disables (rather than selling a nonexistent id).
    if (selection !== null && towerAt(selection.col, selection.row)?.id !== selection.id) {
      selection = null;
      bumpUiRev(); // the Panel must close if a tick sold/destroyed the selected tower
    }
    if (isTerminalPhase(state.phase)) {
      frozen = true;
      tracers = []; // no tracer survives a resolved match
    }
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
    tracers = []; // no tracer crosses run identity
    bufferRev = 0;
    previewMemo = null;
    // Clear the per-run memo/caches — the next run reuses tick indices from 0, so a stale
    // (col,row,bufferLen,tick) verdict must never carry across a Play-again.
    aimMemoKey = '';
    aimMemoValid = false;
    refundCache = { id: -1, rev: -1, value: 0 };
    // A fresh run identity: no armed gesture or announcement carries across Play-again,
    // and the observation counter restarts (mirrors bufferRev's per-run reset above).
    armed = null;
    uiRev = 0;
    lastOutcome = null;
    outcomeSeq = 0;
    // Held at tick 0 (PLAN.md P4): every fresh run/Play-again starts unstarted — only
    // `start()` flips this.
    started = false;
  };
  reset(seed);

  // The shared projection (#37+#27): computed only while the buffer holds pending
  // commands, memoized on (tick, bufferRev) so a stable pause re-reads the same preview
  // object across many frames/readers instead of re-cloning SimState each time.
  const pendingProjection = (): typeof previewMemo => {
    if (buffer.length === 0) return null;
    if (previewMemo !== null && previewMemo.tick === state.tick && previewMemo.rev === bufferRev) {
      return previewMemo;
    }
    const { preview } = previewInputs(state, ruleset, buffer);
    const { additions, sells } = diffPendingTowers(state.towers, preview.towers);
    previewMemo = {
      tick: state.tick,
      rev: bufferRev,
      preview,
      pendingAdds: additions,
      pendingSells: sells,
    };
    return previewMemo;
  };

  /** The tower whose 2×2 footprint covers (col,row), or null. Reads the SHARED projection
   *  so a pending (not-yet-committed) build/sell is reflected in selection/hit-testing —
   *  e.g. `confirm()`'s post-queue re-aim selects the just-queued tower rather than
   *  showing an invalid ghost (#40), and a pending sell's cell stops resolving as a tower. */
  const towerAt = (col: number, row: number): { col: number; row: number; id: number } | null => {
    const towers = pendingProjection()?.preview.towers ?? state.towers;
    for (let i = 0; i < towers.id.length; i++) {
      const tc = towers.col[i] as number;
      const tr = towers.row[i] as number;
      if (col >= tc && col <= tc + 1 && row >= tr && row <= tr + 1) {
        return { col: tc, row: tr, id: towers.id[i] as number };
      }
    }
    return null;
  };

  const inBounds = (col: number, row: number): boolean =>
    col >= 0 && row >= 0 && col < cols && row < rows;

  // Placement validity of a build at (col,row) given the current buffer. Memoized on
  // (cell, buffer length, tick, started): a hover that stays in one cell (or repeated
  // frames) re-uses the last clone instead of deep-cloning SimState each event. Reflects
  // the PLAN.md P4 pre-start cap too — a cell that would otherwise build fine still shows
  // an invalid ghost once the buffer is at `effectiveCap()`, so the preview never promises
  // a placement that a subsequent confirm/click would then reject.
  const placementValid = (col: number, row: number): boolean => {
    const key = `${col},${row},${buffer.length},${state.tick},${started}`;
    if (key === aimMemoKey) return aimMemoValid;
    if (buffer.length >= effectiveCap()) {
      aimMemoKey = key;
      aimMemoValid = false;
      return false;
    }
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
      if (armed !== null) {
        // Armed: an existing tower is an occupied cell, not a selection target — mirrors
        // clickAt's occupied-cell rejection so the keyboard cursor can't silently arm
        // `selection` (enabling a stray Sell) while a Card is still armed for placement.
        ghost = { col, row, valid: false, rangeFp: RANGE_FP(ruleset) };
        bumpUiRev(); // keyboard-cursor aim is a discrete, user-driven event (PLAN.md P2)
        return { kind: 'blocked', col, row, valid: false };
      }
      ghost = null;
      selection = {
        col: existing.col,
        row: existing.row,
        rangeFp: RANGE_FP(ruleset),
        id: existing.id,
      };
      bumpUiRev(); // keyboard-cursor aim is a discrete, user-driven event (PLAN.md P2)
      return { kind: 'tower', col: existing.col, row: existing.row, valid: true };
    }
    selection = null; // a click/keyboard aim on an empty cell is a build intent — deselect
    const valid = placementValid(col, row);
    ghost = { col, row, valid, rangeFp: RANGE_FP(ruleset) };
    bumpUiRev(); // keyboard-cursor aim is a discrete, user-driven event (PLAN.md P2)
    return { kind: 'ghost', col, row, valid };
  };

  // Hover/adjust preview (desktop pointermove, and touch/pen via input.ts's
  // updateGhostFromPoint): update the build ghost but NEVER change the current selection — otherwise
  // moving the mouse across empty cells toward the Panel's Sell button would silently
  // deselect the tower before the click lands. PLAN.md P2's table restricts the ghost
  // preview to the ARMED state ("armed | pointer moves over board (mouse) | ghost previews
  // at cell"); unarmed is selection-only, so hovering does nothing at all.
  const previewAt = (col: number, row: number): void => {
    if (armed === null) return;
    if (!inBounds(col, row)) {
      ghost = null;
      return;
    }
    cur = { col, row };
    // Armed interaction is placement-only (PLAN.md P2 table): an in-grid cell ALWAYS yields
    // a ghost — valid where placeable, INVALID over an occupied/blocked/unaffordable cell —
    // never null and never a selection preview. An existing tower is an occupied cell
    // (mirrors clickAt's 'occupied' rejection), so hovering its footprint shows a PERSISTENT
    // invalid ghost rather than clearing it; previously the null-on-tower branch let the
    // slightest hover erase the rejection cue over the very footprint a click had rejected.
    if (towerAt(col, row) !== null) {
      ghost = { col, row, valid: false, rangeFp: RANGE_FP(ruleset) };
      return;
    }
    ghost = { col, row, valid: placementValid(col, row), rangeFp: RANGE_FP(ruleset) };
  };

  /** Mouse/pointer click at a board cell — the armed/selection state machine (PLAN.md P2
   *  table). Armed: placement-only — an occupied/unaffordable/blocked cell rejects
   *  (persistent invalid ghost, stays armed); a valid cell places, disarms, and selects the
   *  new tower (never re-arms). Unarmed: selection-only — a tower selects, anything else
   *  deselects; no ghost is ever shown while unarmed. */
  const clickAt = (col: number, row: number): void => {
    if (!inBounds(col, row)) return;
    cur = { col, row };
    if (armed !== null) {
      const existing = towerAt(col, row);
      if (existing !== null) {
        ghost = { col, row, valid: false, rangeFp: RANGE_FP(ruleset) };
        setOutcome({ kind: 'rejected', reason: 'occupied' });
        return;
      }
      // The PLAN.md P4 pre-start cap takes priority over bounty/other — a cell that's
      // otherwise perfectly buildable but arrives when the buffer is already at
      // `effectiveCap()` must report the CAP as the reason, not a misleading 'bounty'/
      // 'other'. Checked before `placementValid` (which itself folds the cap into its
      // memoized result) so this exact branch can attach the distinct outcome.
      if (buffer.length >= effectiveCap()) {
        ghost = { col, row, valid: false, rangeFp: RANGE_FP(ruleset) };
        setOutcome({ kind: 'rejected', reason: 'pendingCap' });
        return;
      }
      if (!placementValid(col, row)) {
        ghost = { col, row, valid: false, rangeFp: RANGE_FP(ruleset) };
        const bounty = pendingProjection()?.preview.bounty ?? state.bounty;
        setOutcome({ kind: 'rejected', reason: bounty < ruleset.tower.cost ? 'bounty' : 'other' });
        return;
      }
      // Valid placement. `enqueueVerdict` never reports 'duplicate' for `placeTower`
      // (it isn't anchor-matched — see the doc comment above); the cap check above
      // already ruled out 'full' at the CURRENT cap, so only 'queue' remains in the
      // common case — 'full' stays as a defensive fallback (silent, matching the
      // pre-P4 default-cap contract) in case the effective cap changed underneath us.
      const cmd: SimInput = { kind: 'placeTower', anchor: { col, row } };
      const verdict = enqueueVerdict(buffer, cmd, effectiveCap());
      if (verdict === 'full') {
        ghost = { col, row, valid: false, rangeFp: RANGE_FP(ruleset) };
        setOutcome({ kind: 'rejected', reason: 'other' });
        return;
      }
      buffer.push(cmd);
      bufferRev++;
      armed = null; // disarm BEFORE the outcome/re-aim below — never re-arms
      setOutcome({ kind: 'placed' });
      aimAt(col, row); // selects the just-placed (now-pending) tower
      return;
    }
    // Unarmed: selection-only. Clicking never places here — armed is placement-only, per
    // the table.
    const existing = towerAt(col, row);
    selection =
      existing === null
        ? null
        : { col: existing.col, row: existing.row, rangeFp: RANGE_FP(ruleset), id: existing.id };
    ghost = null;
    bumpUiRev();
  };

  /** Toggle `kind` armed (PLAN.md P2 table, row 1): arm it (clearing any selection), or —
   *  if already armed — disarm. */
  const armTower = (kind: ArmedTower): void => {
    if (armed === kind) {
      armed = null;
      ghost = null;
      setOutcome({ kind: 'disarmed' });
      return;
    }
    armed = kind;
    selection = null;
    ghost = null;
    setOutcome({ kind: 'armed' });
  };

  /** Document-scope Escape (PLAN.md P2 table): armed disarms; otherwise a selection
   *  deselects. No-op in neither state. */
  const escape = (): void => {
    if (armed !== null) {
      armed = null;
      ghost = null;
      setOutcome({ kind: 'disarmed' });
      return;
    }
    if (selection !== null) {
      selection = null;
      ghost = null;
      bumpUiRev();
    }
  };

  /** The refund the selected tower would return right now (0 if none selected) — a pure
   *  read against the SHARED projection, cached by (id, bufferRev) since a tower's refund
   *  is invariant for a given id but the base to preview against changes with the pending
   *  queue. Standalone (not just the exposed `refundForSelection` method) so `sellSelected`
   *  can capture the value BEFORE its own re-aim clears `selection`. */
  const computeRefund = (): number => {
    // No refund on a resolved match — the frozen step() would drop the sell (mirrors
    // previewInputs' terminal freeze; also stops the id-cache serving a stale pre-terminal
    // value once the game ends).
    if (selection === null || isTerminalPhase(state.phase)) return 0;
    if (refundCache.id === selection.id && refundCache.rev === bufferRev) {
      return refundCache.value;
    }
    const base = pendingProjection()?.preview ?? state;
    const { preview } = previewInputs(base, ruleset, [{ kind: 'sellTower', tower: selection.id }]);
    const value = Math.max(0, preview.bounty - base.bounty);
    refundCache = { id: selection.id, rev: bufferRev, value };
    return value;
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
  /** Enqueue call-wave-early (pre-wave only; idempotent in the sim — a duplicate already
   *  in the buffer is 'duplicate', not a second command). Uses the DEFAULT (full)
   *  `enqueueVerdict` cap, never `effectiveCap()`: this is the one command the PLAN.md P4
   *  pre-start build/sell cap reserves a slot FOR, so it must never itself be subject to
   *  the reduced cap. Shared by the public `callWaveEarly()` (kept for direct tests/
   *  internal reuse — PLAN.md P4 wires no UI control to it directly) and `start()`. */
  const doCallWaveEarly = (): boolean => {
    if (state.phase !== 'pre-wave') return false;
    const cmd: SimInput = { kind: 'callWaveEarly' };
    const verdict = enqueueVerdict(buffer, cmd);
    if (verdict === 'full') return false;
    if (verdict === 'queue') {
      buffer.push(cmd);
      bufferRev++;
    }
    return true;
  };

  const doBuildReplay = (): Replay => ({
    seed: runSeed,
    boardId,
    rulesetHash: currentRulesetHash(bundle),
    simVersion: SIM_VERSION,
    // Defensive, immutable envelope: the arrays are fresh frozen copies, and the command
    // objects they share with the internal log are themselves deep-frozen at record time
    // (freezeRecorded), so no mutation path into the recording exists at any level.
    tickInputs: Object.freeze(tickInputs.map((t) => Object.freeze([...t]))) as Replay['tickInputs'],
  });

  return {
    ruleset,
    advance(wallDtMs: number): void {
      // `started` is checked FIRST and independently of `paused`/`frozen` (PLAN.md P4):
      // a held run (fresh or Play-again'd, not yet `start()`ed) never steps no matter what
      // resume()/togglePause()/speed do meanwhile — those toggle `paused`/`spd` harmlessly,
      // but this gate alone decides whether a tick can ever fire.
      if (!started || paused || frozen) return;
      loop.advance(Math.max(0, wallDtMs) * spd);
    },
    frame(): FrameSnapshot {
      // Paused freezes creeps IN PLACE (the accumulator is stable while paused), so alpha
      // holds its current sub-tick value rather than collapsing to 0 (which would rewind
      // every creep to the previous tick boundary). Only a terminal freeze pins alpha to 0.
      const alpha = frozen ? 0 : loop.accumulatorMs / MS_PER_TICK;
      const pending = pendingProjection();
      // Prune landed flights (#32/P6): once render time passes a tracer's `impactTick`
      // it has visibly arrived, so it's dropped here rather than lingering until the
      // next real tick (which, while paused, might never come).
      if (tracers.length > 0) {
        const renderTime = renderTimeOf(prevVm, curVm, alpha);
        tracers = tracers.filter((t) => renderTime <= t.impactTick);
      }
      return {
        prevVm,
        curVm,
        alpha,
        ghost,
        selection: selectionOverlay(),
        pendingAdds: pending?.pendingAdds ?? NO_PENDING,
        pendingSells: pending?.pendingSells ?? NO_PENDING,
        pendingRevision: bufferRev,
        tracers,
      };
    },
    drainSparks(): { x: number; y: number }[] {
      if (pendingSparks.length === 0) return [];
      const out = pendingSparks;
      pendingSparks = [];
      return out;
    },
    // Reads the SHARED projection whenever the buffer is non-empty, so bounty (and, while
    // pre-wave, the countdown) presents the pending world during paused planning — the
    // committed HUD would otherwise show stale figures until the next tick commits.
    hud: () => deriveHud(pendingProjection()?.preview ?? state, ruleset),
    isPaused: () => paused,
    speed: () => spd,
    pause: doPause,
    resume: doResume,
    togglePause(): void {
      // Pre-start (PLAN.md P4), the Pause control is hidden, but the keyboard 'pause'
      // action still routes here — a no-op while `!started` (matching the pattern below:
      // resume()/speed can't un-hold either) so it can't leave `paused` invisibly true
      // and make the following Start press look dead once the Pause button appears.
      if (!started) return;
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
      // Unconditionally re-aim at the cursor before checking the ghost (#40): this
      // recomputes validity at the CURRENT tick every time (not just on the very first
      // confirm before anything was aimed) — e.g. a creep's advance can flip a cell's
      // maze-validity between a hover/tap and the confirm, and a stale-valid ghost must
      // not be trusted. A pointer/touch confirm has already aimed pre-confirm, so this is
      // a cheap no-op re-derivation for that path; the tower-cursor case still returns
      // false via `selection`.
      aimAt(cur.col, cur.row);
      if (ghost === null || !ghost.valid) {
        // A `ghost === null` here means aimAt selected an existing tower instead (unarmed
        // cursor landing on an occupied cell) — that's a selection, not a placement
        // attempt, so it stays silent. Any other invalid ghost IS a rejected placement
        // attempt and must announce to the live region (docs/accessibility-checklist.md),
        // mirroring clickAt's occupied/pendingCap/bounty/other reasons.
        if (ghost !== null) {
          if (armed !== null && towerAt(ghost.col, ghost.row) !== null) {
            setOutcome({ kind: 'rejected', reason: 'occupied' });
          } else if (buffer.length >= effectiveCap()) {
            setOutcome({ kind: 'rejected', reason: 'pendingCap' });
          } else {
            const bounty = pendingProjection()?.preview.bounty ?? state.bounty;
            setOutcome({
              kind: 'rejected',
              reason: bounty < ruleset.tower.cost ? 'bounty' : 'other',
            });
          }
        }
        return false;
      }
      const cmd: SimInput = { kind: 'placeTower', anchor: { col: ghost.col, row: ghost.row } };
      const verdict = enqueueVerdict(buffer, cmd, effectiveCap());
      if (verdict === 'full') return false;
      if (verdict === 'queue') {
        buffer.push(cmd);
        bufferRev++;
      }
      // Disarm on ANY successful placement, regardless of input path (PLAN.md P2 table,
      // "any | successful placement | never re-arms") — a keyboard-Enter build while a
      // Card is armed must leave the Card unarmed too, not just the mouse/Card path.
      if (armed !== null) {
        armed = null;
      }
      // Announce on ANY successful placement, not just the armed/Card path — the pure
      // keyboard cursor flow (arrow keys + Enter) builds without ever arming a Card, and
      // the live region must still announce success there too
      // (docs/accessibility-checklist.md).
      setOutcome({ kind: 'placed' });
      // Re-evaluate the ghost against the now-larger buffer (the just-queued build may
      // make this same cell invalid for a second placement while paused). `towerAt` now
      // reads the shared projection, so this resolves to a SELECTION on the just-queued
      // tower, not an invalid red ghost (#40).
      aimAt(ghost.col, ghost.row);
      return true;
    },
    sellSelected(): boolean {
      if (selection === null) return false;
      // Captured BEFORE re-aiming (which clears `selection`) — the refund the Panel/live
      // region reports is the value at the moment Sell was pressed.
      const refund = computeRefund();
      // The sold tower's anchor — captured before re-aiming, which may clear `selection`.
      const anchor = { col: selection.col, row: selection.row };
      const cmd: SimInput = { kind: 'sellTower', tower: selection.id };
      const verdict = enqueueVerdict(buffer, cmd, effectiveCap());
      if (verdict === 'full') {
        // Sells count against the same PLAN.md P4 pre-start cap as builds.
        if (!started) setOutcome({ kind: 'rejected', reason: 'pendingCap' });
        return false;
      }
      if (verdict === 'queue') {
        buffer.push(cmd);
        bufferRev++;
      }
      // Reconcile aim/selection on every buffer mutation: re-aim at the SOLD anchor (not
      // raw `cur`, which may sit on any of the four footprint cells) so sell-then-rebuild
      // resolves to a fresh build ghost at that anchor rather than a stale tower selection.
      // The shared projection now reflects the queued sell, so this already clears
      // `selection` (the anchor no longer resolves to a tower) — the Panel closes
      // immediately, no tick required.
      aimAt(anchor.col, anchor.row);
      setOutcome({ kind: 'sold', refund });
      return true;
    },
    refundForSelection: computeRefund,
    armTower,
    clickAt,
    escape,
    uiState(): UiState {
      return {
        started,
        armed,
        selection:
          selection === null ? null : { col: selection.col, row: selection.row, id: selection.id },
        lastOutcome,
        outcomeSeq,
      };
    },
    uiRev: () => uiRev,
    callWaveEarly: doCallWaveEarly,
    start(): void {
      // Atomic (PLAN.md P4): `started` flips ONLY once the enqueue is actually accepted.
      // `doCallWaveEarly` uses the DEFAULT (full) cap, not `effectiveCap()` — build/sell
      // commands are the ones capped one slot short pre-start specifically so THIS enqueue
      // always has room, so `start()` can never deadlock. Idempotent: once `state.phase`
      // has left 'pre-wave' (already started, or this run's one wave already launched),
      // `doCallWaveEarly` returns false and this is a no-op — matches "no-op after" for
      // the `start` keymap action/Dock button.
      if (doCallWaveEarly()) started = true;
    },
    startRun(nextSeed: number): void {
      reset(nextSeed);
    },
    isTerminal: () => isTerminalPhase(state.phase),
    buildReplay: doBuildReplay,
    verifyRun(): VerifyResult {
      // Terminal guard: validate() completes an unfinished log with empty ticks, so a
      // mid-run call would otherwise report a misleading hash/score mismatch. A distinct
      // not-terminal outcome — no mismatch claim, no mismatch message.
      if (!isTerminalPhase(state.phase)) return { ok: false, reason: 'not-terminal' };
      const replay = doBuildReplay();
      const result = validate(replay, bundle);
      if (!result.ok) return { ok: false, reason: result.reason };
      const liveScore = deriveScore(state, ruleset);
      const liveStars = deriveStars(state, ruleset);
      const liveFinalHash = hashSimState(state);
      return {
        ok: true,
        score: result.score,
        stars: result.stars,
        matchedLive: outcomesMatch(result, liveScore, liveStars, liveFinalHash),
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
