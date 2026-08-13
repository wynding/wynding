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
  buildAuraIndex,
  auraMulFor,
  createInitialState,
  compileRuleset,
  step,
  previewInputs,
  deriveScore,
  deriveStars,
  hashSimState,
  isTerminalPhase,
  forEachValidTower,
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
import { getBundledRuleset, defaultBoardId, type Ruleset } from '@wynding/content';

export type Speed = 1 | 2;

/**
 * The armed-tower identifier (M2-S3): a compiled-catalog tower id (`ruleset.towerById`
 * resolves it), validated at the `armTower` call site rather than by the type — the
 * closed `'basic'`-only union dies here, since `SimInput.placeTower.towerId` (and the
 * compiled catalog it names) is now genuinely open (sv7 compiles up to `MAX_TOWERS`
 * distinct kinds, and a modded bundle's set is not this module's to enumerate).
 */
export type ArmedTower = string;

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
  | { readonly kind: 'armed'; readonly towerId: string }
  | { readonly kind: 'disarmed'; readonly towerId: string }
  | { readonly kind: 'placed'; readonly towerId: string }
  | {
      readonly kind: 'rejected';
      readonly reason: 'bounty' | 'occupied' | 'other' | 'pendingCap';
    }
  | { readonly kind: 'sold'; readonly refund: number }
  /** The selected tower stopped existing without the player asking (M2-S9: a `mine`
   *  detonates and deletes its own row at its fire tick). Carries no id — the Panel is
   *  already closing, and the announcement's job is to say the thing happened at all. */
  | { readonly kind: 'destroyed' };

/** The observation path for the DOM overlay (Card/Panel/Dock, PLAN.md P2/P4): a plain
 *  snapshot of state that isn't already covered by `frame()`/`hud()`, read once per
 *  render when `uiRev()` has changed. `started` is the real advance gate (PLAN.md P4):
 *  `false` from a fresh run/Play-again until the player calls `start()`. */
export interface UiState {
  readonly started: boolean;
  readonly armed: ArmedTower | null;
  readonly selection: {
    readonly col: number;
    readonly row: number;
    readonly id: number;
    readonly towerId: string;
    /** The support multiplier currently reaching this tower (×/256; 256 = unbuffed) —
     *  M2-S8, so the Panel shows the tower's REAL damage rather than the catalog's base
     *  (ruling 3: "omit lies, show the live buffed value"). */
    readonly buffMulFp: number;
  } | null;
  readonly lastOutcome: PlacementOutcome | null;
  /** Bumped every time an outcome is RECORDED — even when it's identical in content to the
   *  previous one (e.g. rejecting the same occupied cell twice in a row). The live region
   *  (overlay.ts) keys its re-announcement on this identity, not on `lastOutcome` text
   *  equality, so two consecutive identical outcomes still both get announced. Reset to 0
   *  on `startRun()`. */
  readonly outcomeSeq: number;
  /** Bumped every time a POINTER click lands on a tower (`clickAt`'s unarmed selection
   *  branch — the player's deliberate "inspect this" act), including re-clicking the
   *  already-selected tower. The Panel's auto-reveal keys on this identity (overlay.ts);
   *  keyboard cursor-steps also select (`aimAt` via `moveCursor`) but are navigation and
   *  never bump it. Reset to 0 on `startRun()`. */
  readonly inspectSeq: number;
  /** Whether pressing the morphed primary control right now (once `started`) would
   *  actually queue a `callWaveEarly` (PLAN.md P3 step 15) — folds `HudVM.callable`
   *  (sim semantics: running, a wave left to call, no call already pending) together
   *  with tick-buffer capacity, which is presentation-only and out of `@wynding/render`'s
   *  scope. With the pre-start reservation gone, a full 64-command buffer would otherwise
   *  make an "enabled" control silently no-op — this is what lets the overlay disable it
   *  proactively instead. */
  readonly callWaveReady: boolean;
}

/** What the renderer needs each frame: the last two view-models + alpha + overlay. */
export interface FrameSnapshot {
  readonly prevVm: RenderVM | null;
  readonly curVm: RenderVM;
  readonly alpha: number;
  readonly ghost: GhostVM | null;
  readonly selection: SelectionVM | null;
  /** Towers accepted into the tick buffer but not yet committed by a tick (the common
   *  case: paused planning) — anchor cells + the queued tower's catalog id (M2-S3),
   *  presentation reads them from the shared projection below, never by parsing raw
   *  commands. Empty whenever the buffer is empty (the hot 60 fps path — no allocation). */
  readonly pendingAdds: readonly {
    readonly col: number;
    readonly row: number;
    readonly towerId: string;
  }[];
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
  /** Impact points resolved since the last call, then cleared. Accumulated per sim tick
   *  so a multi-tick catch-up frame still flashes every kill. `radiusFp` is `0` for a
   *  `targeted` impact (a spark) or a `blast`'s true radius (M2-S4a step 11, an
   *  expanding-and-fading ring — `scene.ts`). */
  drainSparks(): { x: number; y: number; radiusFp: number }[];
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
  /** Toggle `towerId` armed for placement (PLAN.md P2 table, row 1; M2-S3: a no-op unless
   *  it resolves in the compiled catalog): arms it and clears any selection, or — if
   *  already armed — disarms. Mouse/keyboard-Card entry point. */
  armTower(towerId: ArmedTower): void;
  /** Pointer/mouse click at a board cell — the armed/selection state machine (PLAN.md P2
   *  table): armed is placement-only (an occupied/unaffordable/blocked cell rejects with
   *  a persistent invalid ghost and stays armed; a valid cell places, disarms, and selects
   *  the new tower); unarmed is selection-only (a tower selects, anything else
   *  deselects). Distinct from `aimAt`, which keeps its pre-P2 build-or-select behavior
   *  for the keyboard cursor. */
  clickAt(col: number, row: number): void;
  /** Board-origin touch/pen release (P2 review round, #115): input.ts forwards the raw
   *  (unoffset) pointer-UP cell — the finger's actual release point, the player's
   *  INTENT — the offset ghost-anchor cell placement targets (PLAN.md P3's ghost never
   *  sits under the finger), and `tap` (ENDPOINTS-ONLY: the release landed in the
   *  press's cell or within the tap pixel threshold of the press point — a
   *  wander-and-return still reads as a tap). `towerAt` is private and pending-aware, so
   *  the classification has to live here, not in input.ts:
   *   1. armed && tap && a tower under INTENT → inspect (disarm-and-select,
   *      `reveal=true`, and the keyboard cursor is planted on the INTENT cell so a
   *      follow-up `confirm()` can't re-derive over stale ground and drop the
   *      selection). A deliberate TAP on a tower is inspect even over a valid anchor.
   *   2. armed && NOT (1) && a tower under ANCHOR → the occupied rejection (persistent
   *      invalid ghost, stays armed) — a DRAG whose anchor lands on a tower the finger
   *      never touched is a rejection, not inspect intent.
   *   3. armed otherwise → `clickAt`'s placement logic at the ANCHOR, unchanged.
   *   4. unarmed (defensive — input.ts only calls this while armed) → `clickAt` at the
   *      INTENT cell (the finger), not the anchor — the offset is an armed-only concept.
   *  Card-origin drags ALSO call this (`tap=false`, `intent===anchor`) so an anchor
   *  landing on a tower resolves through (2)'s occupied rejection rather than (1)'s
   *  inspect branch; input.ts's `onCardPointerUp` keeps the cancel-and-disarm contract
   *  itself, converting that still-armed rejection into a disarm. */
  touchConfirmAt(
    intentCol: number,
    intentRow: number,
    anchorCol: number,
    anchorRow: number,
    tap: boolean,
  ): void;
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
  /** Enqueue call-wave-early: accepted while a wave is left to call (idempotent in the
   *  sim — a duplicate already in the buffer is a no-op success, not a second command).
   *  Wired to the morphed primary control (PLAN.md P3 step 15) once `started` — the
   *  Start→Call-wave decouple means this is now a genuine UI-reachable action, not just
   *  the shared primitive `start()` builds on. */
  callWaveEarly(): boolean;
  /** Player-started runs (PLAN.md P4, decoupled further at P3 step 15): while `!started`,
   *  `advance()` never steps. `start()` now ONLY flips `started` to `true` — it no longer
   *  enqueues `callWaveEarly` (Start ≠ claiming the first wave early, PLAN.md's `S2`
   *  headline decouple): once started, the sim's own wave-1 countdown begins ticking, and
   *  an early launch is a deliberate `callWaveEarly()` press like any other wave's. A
   *  trivial flag flip, so it's unconditionally idempotent — a repeat press mid-run is a
   *  harmless no-op. */
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

/** A tower's attack range (fixed-point sim units), by catalog id (M2-S3 — replaces the
 *  M1-era single-tower `ruleset.tower.rangeFp`). RANGE_FP-consuming sites re-key on the
 *  ACTING id: the armed id for the aim/build ghost, the selection's own id for its range
 *  ring — never a single ruleset-wide constant. `null` for an unresolved id (defensive; a
 *  validated armed/selection id always resolves) AND for an ATTACKLESS tower — M2-S8's
 *  `beacon` has no attack at all, so it has no range. `null` rather than `0` because
 *  every consumer is a ring draw: a zero-radius circle is a dot the player must decode,
 *  and the GHOST path is the one that bites first (arming the beacon to place it is the
 *  very first thing anyone does with it). */
const RANGE_FP = (r: CompiledRuleset, towerId: string): number | null =>
  r.towerById[towerId]?.attack?.rangeFp ?? null;

/** A tower's cost, by catalog id — the affordability comparisons' single source (M2-S3
 *  replaces `ruleset.tower.cost`). `Number.MAX_SAFE_INTEGER` for an unresolved id, so an
 *  invalid armed id can never read as affordable by accident. */
const COST_FP = (r: CompiledRuleset, towerId: string): number =>
  r.towerById[towerId]?.cost ?? Number.MAX_SAFE_INTEGER;

/** A tower's AoE blast radius (fixed-point sim units), by catalog id — `null` for a
 *  single-target tower (no `aoe` effect) or an unresolved id (M2-S4a step 14). Feeds
 *  BOTH `GhostVM.blastRadiusFp`, so an armed ghost previews its blast alongside its range
 *  ring, and (M2-S9) `SelectionVM.blastRadiusFp`, which is what makes `board-draw.ts`
 *  draw the committed tower's blast spokes. The two draw on the SAME condition by ruling
 *  (Rob, 2026-08-07) — narrowing or moving this derivation moves both surfaces, so change
 *  them together or neither. The radius-uniform gate — `checkCapabilityGlobal` in
 *  `packages/sim/src/ruleset.ts`, NOT `capability.ts`'s profile, which only supplies the
 *  allow-lists it reads — guarantees at most one radius among a tower's `aoe` effects, so
 *  the first match is unambiguous. (`combat.ts`'s twin of this comment was corrected in QC
 *  round 3; this was the copy it missed.) */
const BLAST_RADIUS_FP = (r: CompiledRuleset, towerId: string): number | null =>
  r.towerById[towerId]?.effects.find((e) => e.kind === 'aoe')?.radiusFp ?? null;

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
 *  - `'full'`: not a duplicate, and the buffer is already at `MAX_INPUTS_PER_TICK` (the
 *    replay contract's exact per-tick limit, imported not duplicated, so the two can
 *    never drift). This is an intentional product limit, not a bug surface: it exists so
 *    no recorded tick can ever exceed the replay contract even via many *distinct*
 *    commands. It is ONE cap, held or not — the P4-era pre-start reservation (a reduced
 *    cap holding a slot for `start()`'s own `callWaveEarly`) was retired at M2-S2 when
 *    the S2 decouple made `start()` enqueue nothing — and while reaching it takes
 *    deliberate play, it IS reachable (32 same-tick build/sell cycles fill all 64 slots
 *    from starting bounty — the regression test does exactly that) and hitting it is
 *    NOT silent: every reachable cap hit is
 *    surfaced to the player as a 'pendingCap' rejection. Mechanism per site: the sell
 *    and callWaveEarly sites route a 'full' verdict to 'pendingCap' directly; the two
 *    PLACEMENT sites announce 'pendingCap' from their own cap pre-checks BEFORE this
 *    function runs (`clickAt`'s explicit check and `placementValid`'s cap fold), which
 *    leaves their 'full' branches as defensive fallbacks a player cannot reach
 *    ('other' / a bare `false`).
 *  - `'queue'`: otherwise — the command should be pushed.
 */
export function enqueueVerdict(
  buffer: readonly SimInput[],
  cmd: SimInput,
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
  if (buffer.length >= MAX_INPUTS_PER_TICK) return 'full';
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

/** A tower-anchor cell (col,row) + its catalog id — the presentation unit for pending
 *  builds/sells (M2-S3: `towerId` threads through so a queued slow tower keeps its
 *  shape-distinct identity, Codex R1-7). */
interface TowerAnchor {
  readonly col: number;
  readonly row: number;
  readonly towerId: string;
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
      additions.push({
        col: projected.col[i] as number,
        row: projected.row[i] as number,
        towerId: projected.towerId[i] as string,
      });
    }
  }
  const sells: TowerAnchor[] = [];
  for (let i = 0; i < committed.id.length; i++) {
    if (!projectedIds.has(committed.id[i] as number)) {
      sells.push({
        col: committed.col[i] as number,
        row: committed.row[i] as number,
        towerId: committed.towerId[i] as string,
      });
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

/**
 * PERF-ONLY injection seam (M2-S4b, PLAN step 22): lets a caller hand in an
 * already-parsed bundle and the board id to compile it against, bypassing the bundled
 * registry entirely. The stress bundle is deliberately absent from
 * `@wynding/content`'s registry (it must never reach the client build — see
 * `packages/content/src/stress.ts`), so the browser perf harness (`apps/web/perf`)
 * could not otherwise load it at all. Same spirit as `AppDeps.sceneFactory`/
 * `controllerFactory` in `main.ts`: an injectable seam that production code never
 * supplies. The production call site (`main.ts`'s `boot()`) passes nothing.
 */
export interface ControllerContent {
  readonly bundle: Ruleset;
  readonly boardId: string;
}

/**
 * PERF-ONLY instrumentation seam (M2-S10 P8, the ADR 0005 frame-time diagnosis). The
 * controller's public surface is `advance()`; `step` and `deriveViewModel` are private
 * inside `onTick`, so a wrapper around the returned `Controller` cannot bracket them —
 * this optional hook pair is the only way to time the two spans without exposing them.
 * Same spirit as {@link ControllerContent} and `AppDeps.sceneFactory`: an injectable
 * seam that production code never supplies (`main.ts`'s `boot()` passes nothing, so
 * production pays 4 optional-chain checks per tick and nothing else). The perf harness
 * (`apps/web/perf/main-perf.ts`) passes `performance.mark`/`measure`-emitting hooks so
 * a DevTools trace carries `wy:step`/`wy:derive` spans via `blink.user_timing`.
 */
export interface ControllerHooks {
  begin(span: 'step' | 'derive'): void;
  end(span: 'step' | 'derive'): void;
}

/** Create the game controller for `seed`. Content/ruleset are fixed (M1 single board)
 *  UNLESS `content` is supplied (perf-only, see {@link ControllerContent}) — omitting
 *  it is byte-identical in behaviour to before this seam existed:
 *  `getBundledRuleset()` then `defaultBoardId(bundle)`. `hooks` is a second perf-only
 *  seam (see {@link ControllerHooks}); production passes neither. */
export function createController(
  seed: number,
  content?: ControllerContent,
  hooks?: ControllerHooks,
): Controller {
  const bundle = content?.bundle ?? getBundledRuleset();
  const boardId = content?.boardId ?? defaultBoardId(bundle);
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
  let pendingSparks: { x: number; y: number; radiusFp: number }[]; // impact points resolved since the last drain
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
  // One HudVM per (tick, bufferRev) — `hud()` and `uiState().callWaveReady` are the two
  // readers and must never derive it separately (deriveHud runs deriveScore/deriveStars/
  // derivePreview, and main.ts's refreshHud() calls both back-to-back on every refresh).
  let hudMemo: { tick: number; rev: number; vm: HudVM } | null = null;
  /** The support-aura index for the current `(tick, bufferRev)` (M2-S8) — see
   *  `selectionBuffMulFp` below for why it is memoized. Declared HERE, with its sibling
   *  memos, rather than beside its reader: `reset()` clears all four, and `reset()` runs
   *  during `createController`, so a declaration below that point is in the temporal dead
   *  zone and throws on the very first construction. */
  let auraMemo: { tick: number; rev: number; index: Map<number, number> | null } | null = null;
  // The valid-tower hit-test index behind `towerAt` (CodeRabbit #73): `forEachValidTower`
  // allocates scratch (a Set + a grid-sized Uint8Array) per walk, and `towerAt` sits on
  // the pointermove hot path — so the walk runs once per (tick, bufferRev) and hit-tests
  // scan the cached entries. Same key as `previewMemo`/`hudMemo`, and the same Play-again
  // rule: tick indices restart at 0 across `reset()`, so the index clears there too.
  // The `tick` leg WAS defense-in-depth (QC r3), written for "the first mechanic that
  // mutates towers OUTSIDE the input phase (destruction, upgrades)". M2-S9 is that
  // mechanic and the leg is now load-bearing: `bufferRev` only advances when the
  // committed buffer was non-empty, so on a tick where a `mine` detonates with no
  // player input `rev` does not move and `tick` is the ONLY thing invalidating this
  // memo. `onTick`'s own selection reconciliation reads `towerAt` through it, so
  // without the `tick` leg a player whose selected mine just detonated would keep a
  // phantom Panel and range ring, and Sell would target an id that no longer exists.
  let towerIndexMemo: {
    tick: number;
    rev: number;
    entries: {
      readonly col: number;
      readonly row: number;
      readonly id: number;
      readonly towerId: string;
    }[];
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
  // The deliberate-inspect counter (#69): bumped ONLY when a pointer click lands on a
  // tower (`clickAt`'s unarmed selection). Same identity discipline as `outcomeSeq` — the
  // Panel's auto-reveal (overlay.ts) keys on the bump, not on selection equality, so
  // re-clicking the already-selected tower re-reveals. Reset to 0 on `startRun()`.
  let inspectSeq = 0;
  // Player-started runs (PLAN.md P4): the real advance gate. `false` from a fresh run/
  // Play-again until `start()` flips it (a bare flag flip — the S2 decouple retired
  // start()'s enqueue); `advance()` is a no-op while this is false, regardless of
  // `paused`/speed — held runs never step. Never reset by anything BUT `reset()` (a
  // fresh run identity) — `start()` only ever flips it true.
  let started = false;
  const bumpUiRev = (): void => {
    uiRev++;
  };
  const setOutcome = (outcome: PlacementOutcome): void => {
    lastOutcome = outcome;
    outcomeSeq++; // identity bump — every recorded outcome, even a content-identical repeat
    bumpUiRev();
  };

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
    // `dotDropped` is collected here (M2-S5a, QC round 1) even though nothing renders
    // it. `applyDot` silently discards a new DoT record once the table hits
    // `MAX_DOT_RECORDS`, which is the rail's one dangerous direction: set too low, real
    // DoT applications silently become no-ops.
    // Shipping the only instrument for detecting it switched off would mean the first
    // report is a player saying poison sometimes stops working, with nothing to look at.
    // Unreachable today (the cap is 9,000 against real peaks in the low hundreds), so
    // this is a tripwire for a future story that widens a DoT duration, not a live
    // concern. `impactPoints`/`fired` stay as they were; the counter is a scalar and
    // costs an increment only on the drop path.
    const events: StepEvents = { impactPoints: [], fired: [], dotDropped: 0 };
    hooks?.begin('step');
    state = step(state, ruleset, inputs, events);
    hooks?.end('step');
    if (import.meta.env.DEV && (events.dotDropped ?? 0) > 0) {
      console.warn(
        `sim: ${String(events.dotDropped)} DoT application(s) dropped this tick — the ` +
          `record table hit MAX_DOT_RECORDS. DoT is silently no-opping for some creeps.`,
      );
    }
    buffer = []; // FRESH buffer — the just-recorded copy can never be mutated by reuse
    // Committing a non-empty buffer CHANGES the pending set (pending → committed), so it
    // bumps the revision — `pendingRevision`'s documented contract ("queued or
    // committed") now holds at the commit boundary too (QC r3), and the memo keys no
    // longer depend on `step` always advancing the tick.
    if (inputs.length > 0) bufferRev += 1;
    prevVm = curVm;
    hooks?.begin('derive');
    curVm = deriveViewModel(state, ruleset);
    hooks?.end('derive');
    for (const pt of events.impactPoints) pendingSparks.push(pt);
    for (const f of events.fired) tracers.push(f);
    // Reconcile the selection with the post-step world: if the selected tower was sold or
    // destroyed this tick, drop the selection so the scene stops drawing a phantom range
    // ring and the Sell control disables (rather than selling a nonexistent id).
    if (selection !== null && towerAt(selection.col, selection.row)?.id !== selection.id) {
      // M2-S9: DESTRUCTION is now reachable — a `mine` deletes its own row at its fire
      // tick, entirely outside the input phase. It announced nothing at all before this,
      // which left a screen-reader user's Panel silently vanishing with no signal that
      // anything had happened — the one event that most needs saying, since the board's
      // own cue for it is "a tower is no longer drawn".
      //
      // Unconditional, deliberately: this branch can ONLY be a destruction. `sellSelected`
      // is the sole path that queues a `sellTower`, and it re-aims at the sold anchor
      // immediately (its own comment: "the Panel closes immediately, no tick required"),
      // so a sell has already nulled `selection` synchronously and never reaches here.
      // An earlier revision guarded this with a `soldThisTick` check against the committed
      // buffer to avoid double-announcing a sell; ship-review proved that predicate can
      // never be true, and inert code that reads as load-bearing protection is worse than
      // none — so the reasoning lives here instead of in a branch nothing can take.
      selection = null;
      // `setOutcome` ends in `bumpUiRev()`, so the Panel closes on this write alone —
      // no separate bump (this branch carried one before M2-S9, when it had no outcome
      // to record; every other branch in this file reaches `setOutcome` unaccompanied).
      setOutcome({ kind: 'destroyed' });
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
    hudMemo = null;
    towerIndexMemo = null;
    auraMemo = null; // M2-S8, same `(tick, bufferRev)` key as its three siblings above
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
    inspectSeq = 0;
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

  // The shared HudVM (above `hudMemo`'s declaration): computed once per (tick, bufferRev)
  // and reused by both `hud()` and `uiState().callWaveReady` rather than each re-running
  // `deriveHud` (and everything it derives) independently.
  const currentHud = (): HudVM => {
    if (hudMemo !== null && hudMemo.tick === state.tick && hudMemo.rev === bufferRev) {
      return hudMemo.vm;
    }
    const vm = deriveHud(pendingProjection()?.preview ?? state, ruleset);
    hudMemo = { tick: state.tick, rev: bufferRev, vm };
    return vm;
  };

  /** The tower whose 2×2 footprint covers (col,row), or null. Reads the SHARED projection
   *  so a pending (not-yet-committed) build/sell is reflected in selection/hit-testing —
   *  e.g. `confirm()`'s post-queue re-aim selects the just-queued tower rather than
   *  showing an invalid ghost (#40), and a pending sell's cell stops resolving as a tower.
   *  Re-implemented over the CANONICAL `forEachValidTower` walk (Codex R3-2, M2-S3): an
   *  invalid row (unknown `towerId`, spend↔towerId mismatch) is not hit-testable/
   *  selectable, matching the sim and the render VM exactly. */
  const validTowerEntries = (): readonly {
    readonly col: number;
    readonly row: number;
    readonly id: number;
    readonly towerId: string;
  }[] => {
    if (
      towerIndexMemo !== null &&
      towerIndexMemo.tick === state.tick &&
      towerIndexMemo.rev === bufferRev
    ) {
      return towerIndexMemo.entries;
    }
    const towers = pendingProjection()?.preview.towers ?? state.towers;
    const entries: {
      readonly col: number;
      readonly row: number;
      readonly id: number;
      readonly towerId: string;
    }[] = [];
    forEachValidTower(grid, towers, ruleset.towerById, (i, id, tc, tr) => {
      entries.push({ col: tc, row: tr, id, towerId: towers.towerId[i] as string });
    });
    towerIndexMemo = { tick: state.tick, rev: bufferRev, entries };
    return entries;
  };
  // The support multiplier reaching the tower anchored at `(col,row)` (M2-S8), memoized
  // on `(state.tick, bufferRev)` like every other derived value in this file
  // (`previewMemo`, `hudMemo`, `towerIndexMemo`, `refundCache`). Without the memo,
  // `uiState()` — called once per frame from `refreshHud` plus several times per input
  // gesture — re-walked the tower SoA and allocated both a `Map` and, inside
  // `forEachValidTower`, a fresh `Uint8Array(width · height)` every time, to read ONE
  // cell. `buildAuraIndex` short-circuits to `null` on a beacon-free board, so the memo
  // matters exactly when a beacon is placed, which is when the Panel is most likely open.
  const selectionBuffMulFp = (col: number, row: number): number => {
    if (auraMemo === null || auraMemo.tick !== state.tick || auraMemo.rev !== bufferRev) {
      auraMemo = {
        tick: state.tick,
        rev: bufferRev,
        index: buildAuraIndex(ruleset.board.grid, state.towers, ruleset.towerById),
      };
    }
    return auraMulFor(auraMemo.index, ruleset.board.grid, col, row);
  };

  // The RETURN is a shared cached entry (pre-memo each call minted a fresh object).
  // The `readonly` typing makes a DIRECT write through it a compile error — not a
  // runtime guarantee (a widening assignment or `Object.assign` still compiles); no
  // caller writes today, and a per-walk `Object.freeze` would buy that guarantee at an
  // allocation cost nothing currently needs (QC r3).
  const towerAt = (
    col: number,
    row: number,
  ): {
    readonly col: number;
    readonly row: number;
    readonly id: number;
    readonly towerId: string;
  } | null => {
    for (const e of validTowerEntries()) {
      if (col >= e.col && col <= e.col + 1 && row >= e.row && row <= e.row + 1) return e;
    }
    return null;
  };

  const inBounds = (col: number, row: number): boolean =>
    col >= 0 && row >= 0 && col < cols && row < rows;

  // Placement validity of a build at (col,row) given the current buffer. Memoized on
  // (cell, buffer length, tick): a hover that stays in one cell (or repeated frames)
  // re-uses the last clone instead of deep-cloning SimState each event. A cell that would
  // otherwise build fine still shows an invalid ghost once the buffer is at
  // `MAX_INPUTS_PER_TICK` (the replay contract's per-tick limit — PLAN.md P3 step 15
  // drops the P4-era pre-start reservation, so this is the one cap now, held or not), so
  // the preview never promises a placement that a subsequent confirm/click would reject.
  const placementValid = (col: number, row: number, towerId: string): boolean => {
    const key = `${col},${row},${buffer.length},${state.tick},${towerId}`;
    if (key === aimMemoKey) return aimMemoValid;
    if (buffer.length >= MAX_INPUTS_PER_TICK) {
      aimMemoKey = key;
      aimMemoValid = false;
      return false;
    }
    const candidate: SimInput = { kind: 'placeTower', anchor: { col, row }, towerId };
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
        // Armed: the confirm/step split (#115). This function is the STEP half — every
        // arrow-key cursor move routes through `moveCursor` into here — and a tower under
        // the cursor stays a blocked cell exactly as before #115: merely passing OVER a
        // tower must never itself select it (that would let a stray Sell fire from bare
        // navigation) or yank the player out of armed mode, so it keeps rendering the
        // rejected-placement red ghost and staying armed. The CONFIRM half (Enter, or a
        // click/touch release landing directly on the tower) is a deliberate act on this
        // same blocked cell and is handled separately — by `confirm()` and `clickAt`/
        // `touchConfirmAt` — as inspect intent (disarm-and-select via the shared
        // `selectTower` helper). `aimAt` itself is otherwise unchanged.
        ghost = {
          col,
          row,
          valid: false,
          rangeFp: RANGE_FP(ruleset, armed),
          blastRadiusFp: BLAST_RADIUS_FP(ruleset, armed),
        };
        bumpUiRev(); // keyboard-cursor aim is a discrete, user-driven event (PLAN.md P2)
        return { kind: 'blocked', col, row, valid: false };
      }
      ghost = null;
      selection = {
        col: existing.col,
        row: existing.row,
        rangeFp: RANGE_FP(ruleset, existing.towerId),
        blastRadiusFp: BLAST_RADIUS_FP(ruleset, existing.towerId),
        id: existing.id,
        towerId: existing.towerId,
      };
      bumpUiRev(); // keyboard-cursor aim is a discrete, user-driven event (PLAN.md P2)
      return { kind: 'tower', col: existing.col, row: existing.row, valid: true };
    }
    selection = null; // a click/keyboard aim on an empty cell is a build intent — deselect
    if (armed === null) {
      // Unarmed: with `towerId` now required there is no honest candidate command to
      // preview (PLAN.md P3 step 16, Codex R1-4) — no ghost, no verdict.
      ghost = null;
      bumpUiRev();
      return { kind: 'blocked', col, row, valid: false };
    }
    const valid = placementValid(col, row, armed);
    ghost = {
      col,
      row,
      valid,
      rangeFp: RANGE_FP(ruleset, armed),
      blastRadiusFp: BLAST_RADIUS_FP(ruleset, armed),
    };
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
    // never null and never a selection preview. HOVERING an existing tower's footprint
    // (unlike a CLICK/confirm/touch landing on one — inspect intent since #115) shows a
    // PERSISTENT invalid ghost rather than clearing it; previously the null-on-tower branch
    // let the slightest hover erase the rejection cue over the very footprint a click used
    // to reject.
    if (towerAt(col, row) !== null) {
      ghost = {
        col,
        row,
        valid: false,
        rangeFp: RANGE_FP(ruleset, armed),
        blastRadiusFp: BLAST_RADIUS_FP(ruleset, armed),
      };
      return;
    }
    ghost = {
      col,
      row,
      valid: placementValid(col, row, armed),
      rangeFp: RANGE_FP(ruleset, armed),
      blastRadiusFp: BLAST_RADIUS_FP(ruleset, armed),
    };
  };

  /** The ONE path every mode selects a tower through (#115): mouse click, keyboard
   *  Enter-confirm, and touch inspect all route here rather than each assigning
   *  `selection` independently, so the three can't drift apart. `reveal` is the ONLY
   *  axis they differ on — bumping `inspectSeq` (the Rail's auto-reveal key, #95) is
   *  pointer intent (mouse click, touch release: `reveal=true`); a keyboard Enter-
   *  confirm selects the SAME way but leaves the reveal key untouched (`reveal=false`,
   *  Codex R1-5) since the Rail reveal stays pointer-intent-keyed exactly as #95 pinned
   *  it. `aimAt`'s own arrow-key tower-selection (unarmed cursor landing on a tower) is
   *  DELIBERATELY NOT routed through here — that path predates #115 and never bumped
   *  `inspectSeq` either, so leaving it untouched is byte-identical behavior, not an
   *  inconsistency. */
  const selectTower = (
    existing: {
      readonly col: number;
      readonly row: number;
      readonly id: number;
      readonly towerId: string;
    },
    reveal: boolean,
  ): void => {
    if (reveal) inspectSeq++;
    selection = {
      col: existing.col,
      row: existing.row,
      rangeFp: RANGE_FP(ruleset, existing.towerId),
      blastRadiusFp: BLAST_RADIUS_FP(ruleset, existing.towerId),
      id: existing.id,
      towerId: existing.towerId,
    };
    ghost = null;
    bumpUiRev();
  };

  /** Mouse/pointer click at a board cell — the armed/selection state machine (PLAN.md P2
   *  table, revised #115). Armed: a cell blocked by an EXISTING TOWER (committed or
   *  pending — `towerAt` reads the pending projection) is inspect intent, not a
   *  rejection — disarm the Card and select that tower via `selectTower`'s `reveal=true`
   *  (the Panel opening IS the feedback; no rejection outcome fires). Every OTHER
   *  blocker (path/terrain/bounty/cap) keeps the persistent-invalid-ghost rejection
   *  unchanged, and never disarms. A valid cell places, disarms, and selects the new
   *  tower (never re-arms). Unarmed: selection-only — a tower selects (via the same
   *  `selectTower`, `reveal=true`), anything else deselects; no ghost is ever shown
   *  while unarmed. */
  const clickAt = (col: number, row: number): void => {
    if (!inBounds(col, row)) return;
    cur = { col, row };
    if (armed !== null) {
      const towerId = armed;
      const existing = towerAt(col, row);
      if (existing !== null) {
        // Inspect intent (#115): disarm BEFORE selecting (mirrors the valid-placement
        // branch below — never re-arms), and no rejection outcome fires on this path.
        armed = null;
        selectTower(existing, true);
        setOutcome({ kind: 'disarmed', towerId });
        return;
      }
      // The per-tick buffer cap takes priority over bounty/other — a cell that's
      // otherwise perfectly buildable but arrives when the buffer is already at
      // `MAX_INPUTS_PER_TICK` must report the CAP as the reason, not a misleading
      // 'bounty'/'other'. Checked before `placementValid` (which itself folds the cap
      // into its memoized result) so this exact branch can attach the distinct outcome.
      if (buffer.length >= MAX_INPUTS_PER_TICK) {
        ghost = {
          col,
          row,
          valid: false,
          rangeFp: RANGE_FP(ruleset, towerId),
          blastRadiusFp: BLAST_RADIUS_FP(ruleset, towerId),
        };
        setOutcome({ kind: 'rejected', reason: 'pendingCap' });
        return;
      }
      if (!placementValid(col, row, towerId)) {
        ghost = {
          col,
          row,
          valid: false,
          rangeFp: RANGE_FP(ruleset, towerId),
          blastRadiusFp: BLAST_RADIUS_FP(ruleset, towerId),
        };
        const bounty = pendingProjection()?.preview.bounty ?? state.bounty;
        setOutcome({
          kind: 'rejected',
          reason: bounty < COST_FP(ruleset, towerId) ? 'bounty' : 'other',
        });
        return;
      }
      // Valid placement. `enqueueVerdict` never reports 'duplicate' for `placeTower`
      // (it isn't anchor-matched — see the doc comment above); the cap check above
      // already ruled out 'full' at the CURRENT cap, so only 'queue' remains in the
      // common case — 'full' stays as a defensive fallback in case the buffer changed
      // underneath us between the check and here.
      const cmd: SimInput = { kind: 'placeTower', anchor: { col, row }, towerId };
      const verdict = enqueueVerdict(buffer, cmd);
      if (verdict === 'full') {
        ghost = {
          col,
          row,
          valid: false,
          rangeFp: RANGE_FP(ruleset, towerId),
          blastRadiusFp: BLAST_RADIUS_FP(ruleset, towerId),
        };
        setOutcome({ kind: 'rejected', reason: 'other' });
        return;
      }
      buffer.push(cmd);
      bufferRev++;
      armed = null; // disarm BEFORE the outcome/re-aim below — never re-arms
      setOutcome({ kind: 'placed', towerId });
      aimAt(col, row); // selects the just-placed (now-pending) tower
      return;
    }
    // Unarmed: selection-only. Clicking never places here — armed is placement-only, per
    // the table. The deliberate-inspect act (#69/#115): a pointer click that LANDS on a
    // tower selects it through the shared `selectTower` helper (`reveal=true`), which
    // bumps `inspectSeq` even on a re-click of the already-selected tower (mirrors
    // `outcomeSeq`'s recorded-not-changed discipline).
    const existing = towerAt(col, row);
    if (existing !== null) {
      selectTower(existing, true);
      return;
    }
    selection = null;
    ghost = null;
    bumpUiRev();
  };

  /** Board-origin ARMED touch/pen release (P2 review round, #115) — see the `Controller`
   *  interface doc for the full contract. `intent` is the raw (unoffset) pointer-UP
   *  cell; `anchor` is the offset ghost anchor the ARMED preview has been showing; `tap`
   *  is ENDPOINTS-ONLY — release in the press's cell or within the tap pixel threshold
   *  of the press point (input.ts computes it; a wander-and-return reads as a tap).
   *  Four-way table:
   *   1. armed && tap && a tower under INTENT → inspect: disarm, plant the keyboard
   *      cursor on the INTENT cell (so a stale `cur` at the offset anchor can't make
   *      `confirm()`'s post-inspect `aimAt` re-derive over empty ground and null the
   *      selection it just set), `selectTower(existing, true)`. A deliberate TAP on a
   *      tower is inspect even if the offset anchor happens to be a valid placement.
   *   2. armed && NOT (1) && a tower under ANCHOR → the pre-#115 occupied rejection,
   *      owned here (not delegated to `clickAt`, so a DRAG whose anchor lands on a
   *      tower can't be mistaken for inspect intent — the finger never touched that
   *      cell): persistent invalid ghost at the anchor, `{kind:'rejected',
   *      reason:'occupied'}`, stays armed.
   *   3. armed otherwise → `clickAt(anchor)` — valid anchors place; other invalid
   *      anchors reject exactly as `clickAt` always has. (`clickAt`'s own tower-inspect
   *      branch still exists for MOUSE clicks; touch can no longer reach it here since
   *      (2) pre-handles every touch anchor-on-tower case.)
   *   4. unarmed (defensive — input.ts only ever calls this while armed) → `clickAt(intent)`:
   *      an unarmed tap-select targets where the finger actually is, not the offset
   *      anchor (the offset is an armed-only ghost concept). */
  const touchConfirmAt = (
    intentCol: number,
    intentRow: number,
    anchorCol: number,
    anchorRow: number,
    tap: boolean,
  ): void => {
    if (armed !== null) {
      if (tap) {
        const existing = towerAt(intentCol, intentRow);
        if (existing !== null) {
          const towerId = armed;
          armed = null;
          cur = { col: intentCol, row: intentRow };
          selectTower(existing, true);
          setOutcome({ kind: 'disarmed', towerId });
          return;
        }
      }
      const towerId = armed;
      const atAnchor = towerAt(anchorCol, anchorRow);
      if (atAnchor !== null) {
        // Plant the cursor at the rejected anchor like every other pointer entry point
        // (clickAt writes `cur` on entry) — keyboard continuity after a touch rejection.
        cur = { col: anchorCol, row: anchorRow };
        ghost = {
          col: anchorCol,
          row: anchorRow,
          valid: false,
          rangeFp: RANGE_FP(ruleset, towerId),
          blastRadiusFp: BLAST_RADIUS_FP(ruleset, towerId),
        };
        setOutcome({ kind: 'rejected', reason: 'occupied' });
        return;
      }
      clickAt(anchorCol, anchorRow);
      return;
    }
    clickAt(intentCol, intentRow);
  };

  /** Arm `towerId` for placement (PLAN.md P2 table, row 1; M2-S3): a no-op unless it
   *  resolves in the compiled catalog (`ruleset.towerById`) — armed always names a real,
   *  buildable tower or nothing. `armed === towerId` toggles off (disarm); a DIFFERENT
   *  id switches in one action (clearing any board selection, today's rule — never both
   *  armed and selected at once). */
  const armTower = (towerId: string): void => {
    if (ruleset.towerById[towerId] === undefined) return; // unresolved catalog id — no-op
    if (armed === towerId) {
      armed = null;
      ghost = null;
      setOutcome({ kind: 'disarmed', towerId });
      return;
    }
    armed = towerId;
    selection = null;
    ghost = null;
    setOutcome({ kind: 'armed', towerId });
  };

  /** Document-scope Escape (PLAN.md P2 table): armed disarms; otherwise a selection
   *  deselects. No-op in neither state. */
  const escape = (): void => {
    if (armed !== null) {
      const towerId = armed;
      armed = null;
      ghost = null;
      setOutcome({ kind: 'disarmed', towerId });
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
  /** Enqueue call-wave-early — accepted while a wave is left to call and the run isn't
   *  terminal (idempotent in the sim: a duplicate already in the buffer is a no-op
   *  success, not a second command). Wired to the morphed primary control once `started`
   *  (PLAN.md P3 step 15) — the fast-path guard mirrors `HudVM.callable`'s sim half
   *  (`running && waveCursor < waveCount`) so a doomed call never even reaches
   *  `enqueueVerdict`; `launchPending` needs no separate check here — it only ever
   *  observably persists within `previewInputs`' projection (the real `step()` consumes
   *  it the same tick it's set), so a same-tick duplicate is already what
   *  `enqueueVerdict`'s buffer scan catches. On a full buffer, announces the SAME
   *  'pendingCap' outcome build/sell rejections use — the buffer-capacity fold the
   *  primary control's enabled state (`UiState.callWaveReady`) already applies makes
   *  this the rare edge-case path, not the common one. */
  const doCallWaveEarly = (): boolean => {
    if (isTerminalPhase(state.phase)) return false;
    if (state.waveCursor >= ruleset.waves.length) return false; // no more waves to call
    const cmd: SimInput = { kind: 'callWaveEarly' };
    const verdict = enqueueVerdict(buffer, cmd);
    if (verdict === 'full') {
      setOutcome({ kind: 'rejected', reason: 'pendingCap' });
      return false;
    }
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
    drainSparks(): { x: number; y: number; radiusFp: number }[] {
      if (pendingSparks.length === 0) return [];
      const out = pendingSparks;
      pendingSparks = [];
      return out;
    },
    // Reads the SHARED projection whenever the buffer is non-empty, so bounty (and, while
    // still counting down, the countdown) presents the pending world during paused
    // planning — the committed HUD would otherwise show stale figures until the next tick
    // commits.
    hud: currentHud,
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
        // A `ghost === null` here means aimAt either selected an existing tower instead
        // (unarmed cursor landing on an occupied cell) or the cursor is UNARMED over an
        // empty cell (M2-S3: no honest candidate to preview) — neither is a rejected
        // placement attempt, so both stay silent. Any other invalid ghost (armed) is
        // either the confirm half of the #115 confirm/step split (a tower under the
        // cursor — inspect intent, not a rejection) or a genuinely rejected placement
        // attempt, and either way must announce to the live region
        // (docs/accessibility-checklist.md), mirroring clickAt's occupied/pendingCap/
        // bounty/other reasons.
        if (ghost !== null && armed !== null) {
          const towerId = armed;
          const existing = towerAt(ghost.col, ghost.row);
          if (existing !== null) {
            // Keyboard CONFIRM on a tower-blocked cell (#115): disarm-and-select like a
            // click, via the SAME shared helper — but `reveal=false` (Codex R1-5): the
            // Rail's auto-reveal stays pointer-intent-keyed exactly as #95 pinned it, so
            // `inspectSeq` is NOT bumped here. No command was enqueued, so this returns
            // `false` just like any other non-placing confirm.
            armed = null;
            selectTower(existing, false);
            setOutcome({ kind: 'disarmed', towerId });
            return false;
          }
          if (buffer.length >= MAX_INPUTS_PER_TICK) {
            setOutcome({ kind: 'rejected', reason: 'pendingCap' });
          } else {
            const bounty = pendingProjection()?.preview.bounty ?? state.bounty;
            setOutcome({
              kind: 'rejected',
              reason: bounty < COST_FP(ruleset, towerId) ? 'bounty' : 'other',
            });
          }
        }
        return false;
      }
      // `ghost.valid` is only ever true while ARMED (aimAt never sets a truthy verdict
      // while unarmed, M2-S3) — `armed` hasn't changed since the aimAt() call above.
      const towerId = armed;
      if (towerId === null) return false; // defensive — unreachable given aimAt's contract
      const cmd: SimInput = {
        kind: 'placeTower',
        anchor: { col: ghost.col, row: ghost.row },
        towerId,
      };
      const verdict = enqueueVerdict(buffer, cmd);
      if (verdict === 'full') return false;
      if (verdict === 'queue') {
        buffer.push(cmd);
        bufferRev++;
      }
      // Disarm on ANY successful placement (PLAN.md P2 table, "any | successful
      // placement | never re-arms").
      armed = null;
      // Announce on ANY successful placement — the pure keyboard cursor flow (arrow keys
      // + Enter, now requiring an armed Card first) still gets its own announcement here
      // (docs/accessibility-checklist.md).
      setOutcome({ kind: 'placed', towerId });
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
      const verdict = enqueueVerdict(buffer, cmd);
      if (verdict === 'full') {
        // Sells count against the same per-tick buffer cap as builds and calls.
        setOutcome({ kind: 'rejected', reason: 'pendingCap' });
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
    touchConfirmAt,
    escape,
    uiState(): UiState {
      return {
        started,
        armed,
        selection:
          selection === null
            ? null
            : {
                col: selection.col,
                row: selection.row,
                id: selection.id,
                towerId: selection.towerId,
                // Read LIVE, never captured at selection time (M2-S8): a beacon built or
                // sold beside this tower while it stays selected must move the Panel's
                // damage row. Making that true ON SCREEN is `overlay.ts`'s job and it
                // does NOT do it by keying the Panel on this value — it re-renders the
                // stat rows in place, deliberately, because re-keying would tear the
                // subtree down and move keyboard focus off the open Panel. Stated here
                // because an earlier version of this comment claimed the opposite, and a
                // reader who "restored" the key-based form would reintroduce that
                // regression. `buildAuraIndex` short-circuits to `null` on a board with
                // no support tower placed, so this costs a `towerId`-column scan in the
                // ordinary case.
                //
                // Sourced from COMMITTED `state.towers`, deliberately NOT the pending
                // projection that `towerAt` and the refund read — and the asymmetry is
                // the point, not an oversight. Those two answer questions about the
                // PLAN ("which tower is under this cell", "what would selling return"),
                // where a queued build is part of the answer. This row answers a
                // question about the SIM ("what damage does this tower deal"), and a
                // queued beacon deals nothing yet: the sim still fires 10, and
                // `deriveViewModel` draws neither its shell nor the recipient's ✦ from
                // committed state. Projecting it here made the Panel the only surface of
                // three claiming otherwise — for as long as the command sat in the
                // buffer, which before Start is unbounded.
                //
                // THE MIRROR CASE IS DELIBERATELY LEFT ALONE, since the two directions
                // are not symmetric in truth-value. `selection` comes from `towerAt`,
                // which DOES read the projection, so a just-queued tower can be selected
                // and — if a COMMITTED beacon is edge-adjacent — its Panel reads
                // "(boosted)". That is a forward-looking statement about a tower which is
                // itself entirely forward-looking (it does not exist in the sim yet, and
                // every other row shown for it is likewise what it WILL be), and it comes
                // true on the commit tick. The case rejected above is different: there,
                // the recipient exists and is firing its base damage right now, so
                // projecting a queued beacon onto it would misdescribe a live tower.
                buffMulFp: selectionBuffMulFp(selection.col, selection.row),
              },
        lastOutcome,
        outcomeSeq,
        inspectSeq,
        // `deriveHud`'s `callable` already reads the shared preview projection (so a
        // paused, buffered call surfaces as `launchPending` — PLAN.md P3 step 16); the
        // buffer-capacity half is web-only and folded in here, not in `@wynding/render`.
        // Shares `currentHud()` with `hud()` above — one derivation per (tick, bufferRev),
        // not two.
        callWaveReady: currentHud().callable && buffer.length < MAX_INPUTS_PER_TICK,
      };
    },
    uiRev: () => uiRev,
    callWaveEarly: doCallWaveEarly,
    start(): void {
      // Decoupled (PLAN.md P3 step 15 — the S2 headline decouple): Start no longer
      // enqueues `callWaveEarly`. A trivial flag flip is unconditionally idempotent, so a
      // repeat press mid-run is a harmless no-op — no acceptance to gate on.
      started = true;
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
          : {
              col: selection.col,
              row: selection.row,
              rangeFp: selection.rangeFp,
              blastRadiusFp: selection.blastRadiusFp,
              towerId: selection.towerId,
            };
    }
    return selOverlay;
  }
}
