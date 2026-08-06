// @wynding/sim — the headless deterministic simulation.
//
// A tick is a pure function of (previous state, ruleset, inputs). No wall-clock, no
// floats, no Math.random — randomness comes only from the seeded RNG carried in
// the state. This is what lets the server re-simulate a replay and derive the
// same score the client saw. Kept renderer-agnostic: no Phaser, no DOM.
//
// The sim reads ALL sim-affecting tuning from the ruleset bundle (ADR 0007) — never
// a hardcoded constant — and NEVER imports `@wynding/content`: the caller compiles a
// bundle with `compileRuleset` and threads the branded `CompiledRuleset` into `step`.

import { hashState, Rng } from '@wynding/engine';
import type { Seed } from '@wynding/types';
import { advanceCreep, cellCenterX, cellCenterY, deriveValidCreepPosition } from './movement';
import {
  runCombat,
  emptyCreeps,
  satAdd,
  satMul,
  type Impact,
  type DotRecord,
  type EffectPrimitive,
  type StepEvents,
} from './combat';
import { resolveCreepDomain } from './domain';
import type { Grid } from './board';
import { computeDistanceField, type DistanceField } from './pathfinding';
import {
  MAX_TOWERS,
  canPlaceTower,
  countValidTowers,
  emptyTowers,
  findValidTowerIndex,
  forEachValidTower,
  materializeTowerMask,
  safeCombatColumn,
  type TowerArrays,
  refundFor,
} from './tower';
import { assertRuleset, type CompiledRuleset } from './ruleset';
import { SIM_VERSION, effectiveSpeedFp } from './ruleset-shared';

/** Simulation cadence: 20 Hz. Must match the render loop's tick duration. */
export const MS_PER_TICK = 50;

/** Behavior version stamped into replays — single-sourced on `ruleset-shared.ts`
 *  (the dependency-free leaf, M2-S2) and re-exported here so the public API
 *  (`import { SIM_VERSION } from '@wynding/sim'`) is unchanged. See that module for
 *  the bump history. */
export { SIM_VERSION };

/** The game lifecycle phase: `'running'` covers the whole multi-wave run (waiting
 *  on the first countdown through the last wave's clear) — the pre-S2 `'pre-wave'`/
 *  `'active'` split doesn't generalize past wave 1 (there is no single "the wave
 *  hasn't launched yet" phase once earlier waves may already be resolved while a
 *  later one still counts down), so per-wave lifecycle now lives entirely in the
 *  per-wave state arrays (`waveLaunchTick`/`waveResolved`/...) instead of `phase`. */
export type SimPhase = 'running' | 'won' | 'lost';

/** True once a match has resolved (won/lost). The single predicate for "terminal" — the
 *  sim, replay, controller, and view-model all use it so a future terminal phase is a
 *  one-line change here rather than a hunt across packages. */
export function isTerminalPhase(phase: SimPhase): boolean {
  return phase === 'won' || phase === 'lost';
}

/**
 * Structure-of-arrays creep storage — cheap to iterate and serialize. Movement is
 * POINT-AUTHORITATIVE (Story 4, closes #17): a creep carries a fixed-point segment
 * start point `(fromX,fromY)`, a waypoint cell `(headCol,headRow)` whose centre is
 * the segment end, and `progress` (arc-length travelled toward that centre). Its
 * Euclidean point and the cell it occupies are DERIVED, not stored. `bounty` and
 * `speed` are resolved from the creep's catalog kind AT SPAWN (Story 5) and carried
 * through movement/combat by source row — the catalog is the single stat authority,
 * so mixed-kind waves score and move correctly with no global constant.
 *
 * `wave` (M2-S2) carries the creep's owning wave index (its position in
 * `ruleset.waves`) — set at spawn, threaded by source row through every
 * movement/combat rebuild like any other column. There is deliberately NO
 * alive-counter state anywhere in `SimState`: the resolution phase derives each
 * wave's alive count from this column every tick (step 9), so no removal path
 * (leak, sweep, a future drop) can desynchronize a counter from reality.
 *
 * `creepId`/`slowMulFp`/`slowUntilTick` (M2-S3) are appended AFTER `wave` — hash-
 * load-bearing position, mirrored in `combat.ts`'s `CombatCreeps`/`emptyCreeps()`
 * and this file's `ReadonlyCreepArrays`/`PreviewState`. `creepId` is the CATALOG id
 * resolved at spawn (matching `ScheduledSpawn.creepId`/`PreviewEntryVM.creepId` —
 * NOT `kind`, which M2-S1 deliberately renamed away); the render VM's per-creep max
 * HP and silhouette both join on it. `slowMulFp`/`slowUntilTick` are the per-creep
 * slow-status column pair (`slowMulFp === 0` ⟺ no active slow, the full model —
 * strongest-wins non-stacking means at most one live slow per creep). `stunUntilTick`
 * (M2-S6) is appended immediately AFTER `slowUntilTick` (same hash-load-bearing
 * position rule) — `0` means not stunned, with no paired magnitude column (stun is
 * binary; the `slowMulFp === 0 ⟺ slowUntilTick === 0` biconditional has no analogue).
 */
export interface CreepArrays {
  id: number[];
  hp: number[];
  bounty: number[]; // kill bounty, resolved from kind at spawn
  speed: number[]; // travel budget/tick (fixed-point), resolved from kind at spawn
  fromX: number[]; // fixed-point segment start point (x)
  fromY: number[]; // fixed-point segment start point (y)
  headCol: number[]; // waypoint cell (sentinel: == cellContaining(from) at rest)
  headRow: number[];
  progress: number[]; // fixed-point arc-length travelled from `from`, in [0, edgeLen)
  wave: number[]; // owning wave index, resolved at spawn (M2-S2)
  creepId: string[]; // catalog id, resolved at spawn (M2-S3)
  slowMulFp: number[]; // 0 = no active slow (M2-S3)
  slowUntilTick: number[]; // 0 = no active slow, paired with slowMulFp (M2-S3)
  stunUntilTick: number[]; // 0 = not stunned (M2-S6, no paired magnitude column)
}

/**
 * Complete simulation state for one match. Fully serializable.
 *
 * The wave-lifecycle block (`waveCursor` … `cumulativeEarlyCallCredit`) replaces
 * Story 5's single-wave `launchAtTick`/`launchTick`/`spawnCursor` — every array in
 * it is sized `ruleset.waves.length`, index-parallel to `ruleset.waves`. Key order
 * here is LOAD-BEARING (the world-hash is `fnv1a(JSON.stringify(state))`) and is
 * mirrored exactly in `PreviewState` and `partialCloneForPreview`.
 */
export interface SimState {
  tick: number;
  rngState: number;
  lives: number;
  bounty: number;
  nextEntityId: number; // shared entity-id space: creeps and towers
  phase: SimPhase;
  /** Index of the next wave to launch — `waves.length` once every wave has
   *  launched. Waves `[0, waveCursor)` are launched; `[waveCursor, waves.length)`
   *  are not yet. */
  waveCursor: number;
  /** Ticks left on `waves[waveCursor]`'s countdown (undefined once `waveCursor ===
   *  waves.length`, held at 0). Sampled at launch for the early-call reward. */
  countdownRemaining: number;
  /** A buffered `callWaveEarly` this tick, consumed (→ launch) by the wave phase.
   *  Mode-split in `coerceSoa`: forced `false` on every real `step()` (consumed
   *  within its own tick), but preserved by the PREVIEW normalization path so a
   *  paused, queued call still reads as pending across a chained preview. */
  launchPending: boolean;
  /** Per wave: the tick it actually launched, or `null` before launch. */
  waveLaunchTick: (number | null)[];
  /** Per wave: index of the next spawn in `waves[k].spawns` to drain. */
  waveSpawnCursor: number[];
  /** Per wave: whether any of its creeps leaked (forfeits its clear bonus). */
  waveLeaked: boolean[];
  /** Per wave: whether it has been settled (launched, spawns exhausted, 0 alive). */
  waveResolved: boolean[];
  /** Monotonic Σ early-call SCORE credit (forfeited entirely on a loss — `deriveScore`
   *  reads it only in the `running`/`won` branches). */
  cumulativeEarlyCallCredit: number;
  cumulativeKillBounty: number; // monotonic Σ kill-bounties — the score accumulator
  leakedCount: number; // monotonic leak count (every wave) — presentation/telemetry
  creeps: CreepArrays;
  towers: TowerArrays;
  impacts: Impact[]; // in-flight scheduled combat impacts (Story 4)
  dots: DotRecord[]; // resident DoT records, one per (targetId, sourceId) pair (M2-S5a)
}

/** Per-tick inputs (the replayable command log). Creep spawns come from the ruleset
 *  wave schedule, NOT the log (ADR 0006) — there is no manual spawn command.
 *  `placeTower.towerId` (M2-S3) names the CATALOG tower to build (ADR 0006 §4: a
 *  catalog-unknown or malformed `towerId` is structurally malformed input that
 *  invalidates the replay at the replay-validator layer; the sim itself stays
 *  total with a defensive no-op — see `applyInputPhase`). */
export type SimInput =
  | {
      readonly kind: 'placeTower';
      readonly anchor: { readonly col: number; readonly row: number };
      readonly towerId: string;
    }
  | { readonly kind: 'sellTower'; readonly tower: number } // EntityId of the tower
  | { readonly kind: 'callWaveEarly' } // buffer an early launch of the current wave
  | { readonly kind: 'noop' };

// The effective distance field is a pure function of `(grid, tower mask)`, so it
// can be reused across ticks until the mask changes — a hit is byte-identical to
// a cold recompute (see the WeakMap cache below; keyed on the immutable `grid`,
// validated by FULL mask equality, so a stale or colliding entry can never serve).
const fieldCache = new WeakMap<
  Grid,
  { readonly mask: Uint8Array; readonly field: DistanceField }
>();

function maskEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The exit-sourced distance field for `grid` under the current tower SoA, reusing
 *  the cached field while the materialized mask is unchanged. Pure in its result. */
function effectiveField(
  grid: Grid,
  towers: TowerArrays,
  towerById: CompiledRuleset['towerById'],
): DistanceField {
  const mask = materializeTowerMask(grid, towers, towerById); // O(towers), never throws
  const memo = fieldCache.get(grid);
  if (memo !== undefined && maskEquals(memo.mask, mask)) return memo.field;
  const field = computeDistanceField(grid, mask);
  fieldCache.set(grid, { mask, field });
  return field;
}

/** Per-wave alive counts derived from a (wave-column-clean) creep SoA `wave` column —
 *  the SINGLE implementation `coerceSoa` and the resolution phase share (CodeRabbit
 *  PR #68: both feed `waveResolved`; two hand-rolled copies must never drift). */
function deriveAliveByWave(creepWave: readonly number[], waveCount: number): number[] {
  const counts = new Array<number>(waveCount).fill(0);
  for (const w of creepWave) counts[w]!++;
  return counts;
}

/** `coerceSoa`'s two call sites need different `launchPending` handling (see the
 *  field's own doc on `SimState`): the real `step()` entry is AUTHORITATIVE (a
 *  buffered call is consumed within its own tick, so a `true` surviving to the next
 *  boundary is a forgery and is forced `false`); `previewInputs`'s clone is a
 *  PREVIEW (a real buffered call legitimately needs to read back as pending across
 *  a chained preview, so the value — once coerced to an exact boolean — survives). */
type CoerceMode = 'authoritative' | 'preview';

/**
 * Totality guard (ADR 0006 §4): a restored or forged state may be missing whole SoA
 * containers, individual columns, or lifecycle fields — and, since M2-S2 grew the
 * lifecycle from one flat wave to an N-wave RELATIONAL structure, independent
 * per-field clamps alone would still admit impossible cross-field states (a forged
 * `resolved` before launch, a future launch tick suppressing spawns forever,
 * `waveCursor === N` with null launch ticks). This repairs the wave-lifecycle block
 * as a coherent whole, in the fixed order below, every `step()`/`previewInputs`
 * entry. For a well-formed state this reads every field, repairs nothing, and
 * copies nothing (see the COPY-ON-WRITE note above the wave-lifecycle block).
 */
function coerceSoa(state: SimState, ruleset: CompiledRuleset, mode: CoerceMode): void {
  if (state.creeps == null || typeof state.creeps !== 'object') {
    state.creeps = emptyCreeps();
  }
  const c = state.creeps;
  if (!Array.isArray(c.id)) c.id = [];
  if (!Array.isArray(c.hp)) c.hp = [];
  if (!Array.isArray(c.bounty)) c.bounty = [];
  if (!Array.isArray(c.speed)) c.speed = [];
  if (!Array.isArray(c.fromX)) c.fromX = [];
  if (!Array.isArray(c.fromY)) c.fromY = [];
  if (!Array.isArray(c.headCol)) c.headCol = [];
  if (!Array.isArray(c.headRow)) c.headRow = [];
  if (!Array.isArray(c.progress)) c.progress = [];
  if (!Array.isArray(c.wave)) c.wave = [];
  if (!Array.isArray(c.creepId)) c.creepId = [];
  if (!Array.isArray(c.slowMulFp)) c.slowMulFp = [];
  if (!Array.isArray(c.slowUntilTick)) c.slowUntilTick = [];
  if (!Array.isArray(c.stunUntilTick)) c.stunUntilTick = [];

  const waveCount = ruleset.waves.length;
  const { creepById } = ruleset;

  // Creep `wave`/`creepId` column totality (M2-S3 generalizes the M2-S2 `wave`-only
  // rule): a row whose wave id isn't a safe int in [0, waveCount), OR whose
  // `creepId` doesn't resolve in the compiled catalog, can never be attributed to a
  // real spawn — dropped here (the existing invalid-row policy) so the resolution
  // phase's per-wave alive histogram (derived from this very column) is never
  // polluted, and the render VM's per-creep max-HP join (`creepById[creepId].hp`)
  // never sees an unresolvable id. Any row whose OTHER columns are ragged (a length
  // mismatch elsewhere) is left for the per-phase ragged-row policy downstream
  // (movement's existing guard); this pass only ever narrows by `wave`/`creepId`
  // validity. Any of `wave`/`creepId`/`slowMulFp`/`slowUntilTick` LONGER than `id`
  // also trips the rebuild (CodeRabbit PR #68, extended): `id` is the row
  // authority, and a trailing tail beyond it would otherwise ride into the hash
  // untouched — the rebuild below iterates `id`'s length, so the tail simply
  // doesn't survive (and the rebuild allocates fresh arrays, so the shared-column
  // preview contract is preserved).
  let sawInvalidRow =
    c.wave.length > c.id.length ||
    c.creepId.length > c.id.length ||
    c.slowMulFp.length > c.id.length ||
    c.slowUntilTick.length > c.id.length ||
    c.stunUntilTick.length > c.id.length;
  for (let i = 0; i < c.id.length && !sawInvalidRow; i++) {
    const w = c.wave[i];
    const cid = c.creepId[i];
    if (
      !Number.isSafeInteger(w) ||
      (w as number) < 0 ||
      (w as number) >= waveCount ||
      typeof cid !== 'string' ||
      creepById[cid] === undefined
    ) {
      sawInvalidRow = true;
    }
  }
  if (sawInvalidRow) {
    const filtered: CreepArrays = emptyCreeps();
    for (let i = 0; i < c.id.length; i++) {
      const w = c.wave[i];
      const cid = c.creepId[i];
      if (
        !Number.isSafeInteger(w) ||
        (w as number) < 0 ||
        (w as number) >= waveCount ||
        typeof cid !== 'string' ||
        creepById[cid] === undefined
      ) {
        continue;
      }
      filtered.id.push(c.id[i] as number);
      filtered.hp.push(c.hp[i] as number);
      filtered.bounty.push(c.bounty[i] as number);
      filtered.speed.push(c.speed[i] as number);
      filtered.fromX.push(c.fromX[i] as number);
      filtered.fromY.push(c.fromY[i] as number);
      filtered.headCol.push(c.headCol[i] as number);
      filtered.headRow.push(c.headRow[i] as number);
      filtered.progress.push(c.progress[i] as number);
      filtered.wave.push(w as number);
      filtered.creepId.push(cid);
      // Slow-pair/stun VALUE repair runs below, on the (now row-clean) filtered
      // result — carry the raw values through here; the value repair passes
      // normalize them.
      filtered.slowMulFp.push(c.slowMulFp[i] as number);
      filtered.slowUntilTick.push(c.slowUntilTick[i] as number);
      filtered.stunUntilTick.push(c.stunUntilTick[i] as number);
    }
    state.creeps = filtered;
  }

  // Slow-pair VALUE repair (M2-S3, Codex R1-1/G13): a row survives the drop pass
  // above but its `(slowMulFp, slowUntilTick)` pair may still be forged. Valid iff
  // `slowMulFp` is 0 or a safe int in 1..255, `slowUntilTick` a non-negative safe
  // int, `slowMulFp === 0 ⟺ slowUntilTick === 0`, AND the record is not already
  // EXPIRED (`slowMulFp !== 0 && slowUntilTick < repairTick` is cleared too — a
  // forged/restored expired record must not slow the entry tick's movement, since
  // movement runs before this tick's own expiry sweep; a GENUINE boundary state
  // always carries `slowUntilTick >= tick`, since the sweep removes records at
  // their final tick's combat close, so `=== repairTick` is live and preserved).
  // Any violation resets the pair to `(0, 0)`. Writes go through the S2 `cow`
  // copy-on-write cells below (the preview clone SHARES creep column arrays — an
  // in-place repair would otherwise mutate live state through that reference); the
  // well-formed hot path repairs nothing and copies nothing.
  {
    const repairTick = Number.isSafeInteger(state.tick) && state.tick >= 0 ? state.tick : 0;
    const cc = state.creeps;
    let mulOwned: number[] | null = null;
    let untilOwned: number[] | null = null;
    const ownMul = (): number[] => {
      if (mulOwned === null) mulOwned = cc.slowMulFp.slice();
      return mulOwned;
    };
    const ownUntil = (): number[] => {
      if (untilOwned === null) untilOwned = cc.slowUntilTick.slice();
      return untilOwned;
    };
    for (let i = 0; i < cc.id.length; i++) {
      const rawMul = cc.slowMulFp[i];
      const rawUntil = cc.slowUntilTick[i];
      const mulValid =
        rawMul === 0 ||
        (Number.isSafeInteger(rawMul) && (rawMul as number) >= 1 && (rawMul as number) <= 255);
      const untilValid = Number.isSafeInteger(rawUntil) && (rawUntil as number) >= 0;
      const pairShapeOk = mulValid && untilValid && (rawMul === 0) === (rawUntil === 0);
      const expired = pairShapeOk && rawMul !== 0 && (rawUntil as number) < repairTick;
      if (!pairShapeOk || expired) {
        if (cc.slowMulFp[i] !== 0) ownMul()[i] = 0;
        if (cc.slowUntilTick[i] !== 0) ownUntil()[i] = 0;
      }
    }
    if (mulOwned !== null) cc.slowMulFp = mulOwned;
    if (untilOwned !== null) cc.slowUntilTick = untilOwned;
  }

  // Stun VALUE repair (M2-S6), mirroring the slow-pair repair above exactly —
  // including its copy-on-write discipline (a third `owned` cell beside `mulOwned`/
  // `untilOwned`, since the preview clone SHARES creep column arrays and an
  // in-place write would mutate live state through that reference). Valid iff
  // `stunUntilTick` is a non-negative safe integer AND the record is not already
  // EXPIRED (`stunUntilTick !== 0 && stunUntilTick < repairTick` is cleared too — a
  // restored expired stun must not halt the entry tick's movement, since movement
  // runs before this tick's own expiry sweep). There is no paired magnitude column
  // to cross-check against — stun is binary. Any violation resets the value to `0`.
  {
    const repairTick = Number.isSafeInteger(state.tick) && state.tick >= 0 ? state.tick : 0;
    const cc = state.creeps;
    let stunOwned: number[] | null = null;
    const ownStun = (): number[] => {
      if (stunOwned === null) stunOwned = cc.stunUntilTick.slice();
      return stunOwned;
    };
    for (let i = 0; i < cc.id.length; i++) {
      const rawStun = cc.stunUntilTick[i];
      const stunValid = Number.isSafeInteger(rawStun) && (rawStun as number) >= 0;
      const expired = stunValid && rawStun !== 0 && (rawStun as number) < repairTick;
      if (!stunValid || expired) {
        if (cc.stunUntilTick[i] !== 0) ownStun()[i] = 0;
      }
    }
    if (stunOwned !== null) cc.stunUntilTick = stunOwned;
  }

  // `rngState` TYPE repair (M2-S6, Codex P2). `Rng`'s constructor self-heals any NUMBER
  // via `>>> 0` — that is ADR 0010's documented posture and has its own test — but a
  // forged state carrying a NON-number (a BigInt or Symbol from a hand-built or
  // deserialized `SimState`) makes `>>>` THROW, and `step()` now constructs an `Rng`
  // unconditionally. Before M2-S6 the field was inert, so nothing dereferenced it and the
  // sim's "forged state degrades deterministically, never throws" posture held for free.
  // Activating the RNG is what put that at risk, so the repair belongs with the
  // activation. Deliberately narrow: only non-numbers and non-finite values are reset,
  // leaving every numeric value to `Rng`'s own coercion so the documented `>>> 0`
  // behaviour stays the single source of truth for numbers.
  if (typeof state.rngState !== 'number' || !Number.isFinite(state.rngState)) {
    state.rngState = 0;
  }

  if (state.towers == null || typeof state.towers !== 'object') {
    state.towers = emptyTowers();
  }
  const t = state.towers;
  if (!Array.isArray(t.id)) t.id = [];
  if (!Array.isArray(t.col)) t.col = [];
  if (!Array.isArray(t.row)) t.row = [];
  if (!Array.isArray(t.spend)) t.spend = [];
  if (!Array.isArray(t.targetId)) t.targetId = [];
  if (!Array.isArray(t.nextFireTick)) t.nextFireTick = [];
  if (!Array.isArray(t.towerId)) t.towerId = [];
  // Column ALIGNMENT to the row authority (`id`) — QC round 1: row VALIDITY stays lazy in
  // `forEachValidTower` (a padded row's `towerId` of `''` never resolves, so it is
  // invisible and unsellable exactly like today's forged rows), but the LENGTHS must
  // agree before any `placeTower` push appends at each column's own tail: a restored
  // container with a short `towerId` column would otherwise land the new row's catalog id
  // at index 0 while its id/col/row land at index N — reviving a dead row at its old
  // coordinates (a "zombie" wall the sim itself re-validates as live) while the paid-for
  // row stays invalid. Deterministic pad/truncate; padded values are inert under the lazy
  // rule. (Tower columns need no copy-on-write: `partialCloneForPreview` deep-clones the
  // whole towers container via `structuredClone`.)
  {
    const rowCount = t.id.length;
    // Pad `col`/`row` with -1, NOT 0 (QC round 2): 0 is a REAL coordinate — a forged
    // state with intact towerId/spend columns but a short `col` column would otherwise
    // materialize a live tower at (0,0). -1 fails `footprintBuildable`'s bounds check,
    // so a padded row is invalid no matter what its other columns claim.
    const PAD = -1;
    const numericCols = [t.col, t.row, t.spend, t.targetId, t.nextFireTick];
    for (const colArr of numericCols) {
      while (colArr.length < rowCount) colArr.push(PAD);
      if (colArr.length > rowCount) colArr.length = rowCount;
    }
    while (t.towerId.length < rowCount) t.towerId.push('');
    if (t.towerId.length > rowCount) t.towerId.length = rowCount;
  }

  if (!Array.isArray(state.impacts)) state.impacts = [];
  if (!Array.isArray(state.dots)) state.dots = [];

  // Lifecycle fields — coerce a pre-v6 / forged snapshot to safe defaults.
  if (state.phase !== 'running' && state.phase !== 'won' && state.phase !== 'lost') {
    state.phase = 'running';
  }
  if (!Number.isSafeInteger(state.cumulativeKillBounty)) state.cumulativeKillBounty = 0;
  if (!Number.isSafeInteger(state.leakedCount)) state.leakedCount = 0;
  if (
    !Number.isSafeInteger(state.cumulativeEarlyCallCredit) ||
    state.cumulativeEarlyCallCredit < 0
  ) {
    state.cumulativeEarlyCallCredit = 0;
  }

  // --- The wave-lifecycle block: RELATIONALLY COHERENT repair, in this order. ---
  //
  // COPY-ON-WRITE (#30's optimization, extended here): `partialCloneForPreview`
  // shares these four arrays with the source state via a plain `{...state}`
  // spread (only `towers` is deep-cloned there; `creeps`'s CONTAINER is fresh but
  // its column arrays are shared too). So a repair WRITE below must clone its
  // target array before mutating it — otherwise a preview's repair would mutate
  // the live state's array in place through the shared reference. The clone is
  // lazy (only on an actual write), so the well-formed hot path (every real
  // frame) never allocates here.
  let waveCursor = Number.isSafeInteger(state.waveCursor) ? state.waveCursor : 0;
  waveCursor = Math.max(0, Math.min(waveCursor, waveCount));
  state.waveCursor = waveCursor;

  // One generic copy-on-write cell per lifecycle array (CodeRabbit PR #68: four
  // hand-rolled copies of this block must never drift): `.arr` is the current
  // (possibly still shared) array; `own()` clones it on the first WRITE only, so
  // the well-formed hot path never allocates. A non-array input is replaced with a
  // fresh (already-owned) empty array up front.
  const cow = <T>(raw: unknown): { arr: T[]; own: () => T[] } => {
    let arr: T[] = Array.isArray(raw) ? (raw as T[]) : [];
    let owned = !Array.isArray(raw);
    return {
      get arr() {
        return arr;
      },
      own: () => {
        if (!owned) {
          arr = arr.slice();
          owned = true;
        }
        return arr;
      },
    };
  };
  const launchTickCow = cow<number | null>(state.waveLaunchTick);
  const spawnCursorCow = cow<number>(state.waveSpawnCursor);
  const leakedCow = cow<boolean>(state.waveLeaked);
  const resolvedCow = cow<boolean>(state.waveResolved);
  const ownWaveLaunchTick = launchTickCow.own;
  const ownWaveSpawnCursor = spawnCursorCow.own;
  const ownWaveLeaked = leakedCow.own;
  const ownWaveResolved = resolvedCow.own;

  // Per-wave alive count, derived from the (already wave-column-clean) surviving
  // creep SoA — O(creeps), the same derivation the resolution phase uses (step 9),
  // computed here too since a repaired `waveResolved` needs it.
  const aliveByWave = deriveAliveByWave(state.creeps.wave, waveCount);

  // The repair SOURCE itself must be clean (CodeRabbit PR #68): `coerceSoa` runs
  // BEFORE step()'s tick-totality guard, so an unclamped forged `state.tick`
  // (NaN/negative) would flow INTO every "repaired" launch tick — poisoned arrays
  // that survive the subsequent no-op early-return into the hash/serializer. (An
  // unclamped NaN would also make the write unrecognizable to the identity checks
  // below — `NaN !== NaN` — re-triggering copy-on-write clones on every pass of a
  // poisoned state: the hash would NOT move, but the repairs-nothing/copies-
  // nothing hot-path property would be gone. Local QC round 2 pinned the precise
  // property.) A poisoned tick clamps to 0 here; the totality guard still no-ops
  // the step itself right after. With the clamp in place, `repairTick` is always
  // a non-negative safe integer, so the `!== repairTick` write-avoidance guards
  // below can only be false for a value that was already valid — they are kept
  // for symmetry with the sibling branches, not because a NaN can reach them.
  const repairTick = Number.isSafeInteger(state.tick) && state.tick >= 0 ? state.tick : 0;

  for (let k = 0; k < waveCount; k++) {
    if (k < waveCursor) {
      // LAUNCHED wave: its launch tick, if present, must be a safe int in
      // [0, repairTick]; otherwise it is repaired to `repairTick` AND CASCADES —
      // a repaired launch tick beside an exhausted spawn cursor would otherwise
      // resolve a wave that spawned nothing, so the cursor resets to 0 and
      // `resolved` to false alongside it.
      const rawTick = launchTickCow.arr[k];
      const tickValid =
        Number.isSafeInteger(rawTick) &&
        (rawTick as number) >= 0 &&
        (rawTick as number) <= repairTick;
      let launchTickRepaired = false;
      if (!tickValid) {
        if (launchTickCow.arr[k] !== repairTick) {
          ownWaveLaunchTick()[k] = repairTick;
        }
        launchTickRepaired = true;
      }

      const spawnCap = ruleset.waves[k]!.spawns.length;
      const rawCursor = spawnCursorCow.arr[k];
      const cursorValid =
        Number.isSafeInteger(rawCursor) &&
        (rawCursor as number) >= 0 &&
        (rawCursor as number) <= spawnCap;
      let effectiveCursor: number;
      if (launchTickRepaired) {
        if (spawnCursorCow.arr[k] !== 0) ownWaveSpawnCursor()[k] = 0;
        effectiveCursor = 0;
      } else if (!cursorValid) {
        if (spawnCursorCow.arr[k] !== 0) ownWaveSpawnCursor()[k] = 0;
        effectiveCursor = 0;
      } else {
        effectiveCursor = rawCursor as number;
      }

      const exhausted = effectiveCursor === spawnCap;
      const zeroAlive = (aliveByWave[k] ?? 0) === 0;
      const desiredResolved = !launchTickRepaired && exhausted && zeroAlive;
      const rawResolved = resolvedCow.arr[k];
      if (typeof rawResolved !== 'boolean' || rawResolved !== desiredResolved) {
        ownWaveResolved()[k] = desiredResolved;
      }

      const rawLeaked = leakedCow.arr[k];
      if (typeof rawLeaked !== 'boolean') ownWaveLeaked()[k] = false;
    } else {
      // UNLAUNCHED wave: pinned to its exact defaults.
      if (launchTickCow.arr[k] !== null) ownWaveLaunchTick()[k] = null;
      if (spawnCursorCow.arr[k] !== 0) ownWaveSpawnCursor()[k] = 0;
      if (resolvedCow.arr[k] !== false) ownWaveResolved()[k] = false;
      if (leakedCow.arr[k] !== false) ownWaveLeaked()[k] = false;
    }
  }
  // Truncate a forged/legacy array longer than `waveCount` — a stray trailing
  // element would otherwise survive into the hash untouched.
  if (launchTickCow.arr.length !== waveCount) ownWaveLaunchTick().length = waveCount;
  if (spawnCursorCow.arr.length !== waveCount) ownWaveSpawnCursor().length = waveCount;
  if (leakedCow.arr.length !== waveCount) ownWaveLeaked().length = waveCount;
  if (resolvedCow.arr.length !== waveCount) ownWaveResolved().length = waveCount;

  state.waveLaunchTick = launchTickCow.arr;
  state.waveSpawnCursor = spawnCursorCow.arr;
  state.waveLeaked = leakedCow.arr;
  state.waveResolved = resolvedCow.arr;

  // countdownRemaining: while a wave is still pending, a safe int clamped into
  // [1, waves[waveCursor].countdownTicks] (a forged oversized value must not mint
  // outsized early-call rewards; a forged 0 violates "never 0 before launch");
  // pinned to 0 once every wave has launched.
  if (waveCursor < waveCount) {
    const ceiling = ruleset.waves[waveCursor]!.countdownTicks;
    const raw = state.countdownRemaining;
    const clamped = Number.isSafeInteger(raw) ? Math.max(1, Math.min(raw, ceiling)) : ceiling;
    state.countdownRemaining = clamped;
  } else {
    state.countdownRemaining = 0;
  }

  // launchPending: MODE-SPLIT (see `CoerceMode`'s doc above).
  const pendingBool = state.launchPending === true;
  state.launchPending = mode === 'authoritative' ? false : pendingBool;

  // nextEntityId totality: a restored/forged state may carry a missing, non-integer,
  // zero/negative, or stale (colliding) counter. Scan the (already-coerced) id columns
  // for the highest positive safe-integer id present — a purely numeric conservative
  // scan, no semantic liveness check, no ruleset needed. Repair whenever the counter is
  // not a positive safe integer strictly greater than that maximum.
  let maxId = 0;
  for (const id of state.creeps.id) {
    if (Number.isSafeInteger(id) && (id as number) > 0 && (id as number) > maxId)
      maxId = id as number;
  }
  for (const id of state.towers.id) {
    if (Number.isSafeInteger(id) && (id as number) > 0 && (id as number) > maxId)
      maxId = id as number;
  }
  if (
    !Number.isSafeInteger(state.nextEntityId) ||
    state.nextEntityId <= 0 ||
    state.nextEntityId <= maxId
  ) {
    state.nextEntityId = maxId < Number.MAX_SAFE_INTEGER ? maxId + 1 : Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Saturating entity-id allocator (ADR 0006 §4 totality): shared by tower and creep
 * spawn allocation. Fails (returns `null`, does not increment `nextEntityId`) once the
 * counter has reached the exhausted sentinel `Number.MAX_SAFE_INTEGER`, so that
 * sentinel value is itself never handed out as a live id. A failed allocation performs
 * no partial mutation — callers must not push any column before calling this.
 */
function allocEntityId(state: SimState): number | null {
  if (state.nextEntityId >= Number.MAX_SAFE_INTEGER) return null;
  return state.nextEntityId++;
}

/** Build a fresh match state for a given seed against a compiled ruleset. Sizes
 *  every per-wave lifecycle array to `ruleset.waves.length` and starts the first
 *  wave's countdown; the starting economy comes from the ruleset's balance block. */
export function createInitialState(seed: Seed | number, ruleset: CompiledRuleset): SimState {
  assertRuleset(ruleset);
  const waveCount = ruleset.waves.length;
  return {
    tick: 0,
    rngState: seed >>> 0,
    lives: ruleset.balance.startingLives,
    bounty: ruleset.balance.startingBounty,
    nextEntityId: 1,
    phase: 'running',
    waveCursor: 0,
    countdownRemaining: ruleset.waves[0]!.countdownTicks, // start tick is 0
    launchPending: false,
    waveLaunchTick: new Array<number | null>(waveCount).fill(null),
    waveSpawnCursor: new Array<number>(waveCount).fill(0),
    waveLeaked: new Array<boolean>(waveCount).fill(false),
    waveResolved: new Array<boolean>(waveCount).fill(false),
    cumulativeEarlyCallCredit: 0,
    cumulativeKillBounty: 0,
    leakedCount: 0,
    creeps: emptyCreeps(),
    towers: emptyTowers(),
    impacts: [],
    dots: [],
  };
}

/**
 * INPUT PHASE (Story 6): apply the per-tick player command log against evolving state,
 * in array order, each command re-validated. Mutates `state.towers`/`bounty`/
 * `nextEntityId`/`launchPending`. Returns a per-command **acceptance** array — `true`
 * where a command produced a state change (a build placed, a sell refunded, an early
 * call BUFFERED — not yet launched, see step 7's wave phase), `false` for a no-op
 * (illegal, unaffordable, idempotent, malformed).
 *
 * This is the single authority for command legality: `step()` calls it (ignoring the
 * result) and `previewInputs()` calls it on a clone (using the result), so a client's
 * ghost/placement preview can never disagree with what a real tick will do.
 */
function applyInputPhase(
  state: SimState,
  ruleset: CompiledRuleset,
  inputs: readonly SimInput[],
): boolean[] {
  const { board, towerById, balance, creepById } = ruleset;
  const { grid } = board;
  const accepted: boolean[] = [];

  for (const input of inputs as readonly unknown[]) {
    if (input === null || typeof input !== 'object') {
      accepted.push(false);
      continue;
    }
    const kind = (input as { kind?: unknown }).kind;

    if (kind === 'placeTower') {
      const anchor = (input as { anchor?: unknown }).anchor;
      // A non-string or catalog-unresolved `towerId` is the sim-total BACKSTOP
      // no-op (ADR 0006 §4): the replay validator owns the structural rejection of
      // a malformed/unknown towerId; the sim never throws on it.
      const catalogTowerId = (input as { towerId?: unknown }).towerId;
      if (typeof catalogTowerId !== 'string') {
        accepted.push(false);
        continue;
      }
      const def = towerById[catalogTowerId];
      if (def === undefined) {
        accepted.push(false);
        continue;
      }
      // Sim-owned cap: a build past MAX_TOWERS is a deterministic no-op, so the
      // in-flight impact queue stays bounded for every step() caller.
      if (
        state.towers.id.length >= MAX_TOWERS &&
        countValidTowers(grid, state.towers, towerById) >= MAX_TOWERS
      ) {
        accepted.push(false);
        continue;
      }
      const towerMask = materializeTowerMask(grid, state.towers, towerById);
      if (
        !canPlaceTower(grid, towerMask, anchor, state.creeps, state.bounty, def.cost, creepById)
      ) {
        accepted.push(false);
        continue;
      }
      const cell = anchor as { col: number; row: number };
      const newTowerId = allocEntityId(state);
      if (newTowerId === null) {
        accepted.push(false); // exhausted entity-id space — no partial mutation
        continue;
      }
      state.towers.id.push(newTowerId);
      state.towers.col.push(cell.col);
      state.towers.row.push(cell.row);
      state.towers.spend.push(def.cost);
      state.towers.targetId.push(0); // no lock
      state.towers.nextFireTick.push(0); // no warm-up — may fire this tick
      state.towers.towerId.push(catalogTowerId);
      state.bounty -= def.cost;
      accepted.push(true);
    } else if (kind === 'sellTower') {
      const entityId = (input as { tower?: unknown }).tower;
      if (!Number.isSafeInteger(entityId)) {
        accepted.push(false);
        continue;
      } // malformed id — no-op
      if (!Number.isSafeInteger(state.bounty) || state.bounty < 0) {
        accepted.push(false);
        continue;
      } // corrupt bounty — no-op
      const index = findValidTowerIndex(grid, state.towers, entityId as number, towerById);
      if (index === -1) {
        accepted.push(false);
        continue;
      } // unknown, corrupt, or shadowed tower — no-op
      const refund = refundFor(
        state.towers.spend[index] as number,
        balance.refundNum,
        balance.refundDen,
      );
      if (state.bounty > Number.MAX_SAFE_INTEGER - refund) {
        accepted.push(false);
        continue;
      } // refund would overflow — no-op
      state.bounty += refund;
      // Compact via the same canonical rule that materialized the mask, dropping the
      // sold row and carrying combat columns BY SOURCE ROW (a sell never resets a
      // survivor's target lock or cooldown).
      const src = state.towers;
      const compacted: TowerArrays = emptyTowers();
      forEachValidTower(grid, src, towerById, (i, id, col, row) => {
        if (i === index) return;
        compacted.id.push(id);
        compacted.col.push(col);
        compacted.row.push(row);
        compacted.spend.push(src.spend[i] as number);
        compacted.targetId.push(safeCombatColumn(src.targetId[i]));
        compacted.nextFireTick.push(safeCombatColumn(src.nextFireTick[i]));
        compacted.towerId.push(src.towerId[i] as string);
      });
      state.towers = compacted;
      accepted.push(true);
    } else if (kind === 'callWaveEarly') {
      // BUFFER an early launch of the current wave — no economy mutation here
      // (preview-safe): the reward is sampled from the undecremented countdown
      // at the ACTUAL launch, in the wave phase (step 7), so a queued-but-not-yet-
      // launched call previews identically to what step() will do. Accepted iff
      // still running, a wave remains to launch, and none is already buffered
      // (idempotent: a same-tick or already-pending second call is a no-op).
      if (
        state.phase === 'running' &&
        state.waveCursor < ruleset.waves.length &&
        !state.launchPending
      ) {
        state.launchPending = true;
        accepted.push(true);
      } else {
        accepted.push(false);
      }
    } else {
      accepted.push(false); // 'noop' and any unknown kind: nothing.
    }
  }
  return accepted;
}

/**
 * Advance the simulation by exactly one tick. Mutates and returns `state`.
 * Deterministic: identical (state, ruleset, inputs) always yield identical output.
 *
 * Phases: INPUT (build/sell/call-early, array order, each re-validated) → WAVE
 * (launch the current wave on its countdown or a buffered early call; drain every
 * launched wave's due spawns) → derive the effective field once → MOVEMENT (leaks
 * cost `leakCost` lives, bump `leakedCount`/`waveLeaked[wave]`) → COMBAT (resolve
 * impacts, sweep kills → per-creep bounty + `cumulativeKillBounty`, fire) →
 * RESOLUTION (settle every launched-exhausted-empty wave — pay its clear bonus
 * unless leaked — THEN terminal: loss if lives ≤ 0, else win once every wave is
 * resolved; settlement always precedes terminal, uniformly, so a wave completing
 * on the final tick pays either way) → guarded `tick++`. Once terminal (`won`/
 * `lost`) `step` is a total NO-OP, so a replay padded past resolution can never
 * change the final hash or score. `step` never throws on forged input.
 *
 * `events` (optional, #31): an append-only `StepEvents` collector the caller owns —
 * NOT part of `SimState`/the world hash. A terminal or no-op early-return path (below)
 * appends nothing, so a pre-populated collector passed through either is unchanged.
 */
export function step(
  state: SimState,
  ruleset: CompiledRuleset,
  inputs: readonly SimInput[],
  events?: StepEvents,
): SimState {
  assertRuleset(ruleset); // memoized; rejects a forged/uncompiled ruleset loudly, once
  coerceSoa(state, ruleset, 'authoritative'); // totality + relational lifecycle repair

  // TICK TOTALITY: a forged non-safe/negative tick, or one so large `tick + 1` leaves
  // the safe-integer range, makes the whole step a deterministic terminal no-op.
  if (
    !Number.isSafeInteger(state.tick) ||
    state.tick < 0 ||
    state.tick + 1 > Number.MAX_SAFE_INTEGER
  ) {
    return state;
  }

  // FREEZE ON TERMINAL: a resolved match no longer advances — trailing log/empty
  // ticks cannot change the final world-hash or score (re-derivation is stable).
  if (isTerminalPhase(state.phase)) return state;

  const { board, towerById, balance, scoring, waves, creepById } = ruleset;
  const { grid } = board;
  const { entrance } = grid;
  const waveCount = waves.length;

  // 1) INPUT PHASE — array order; each command re-validated against evolving state.
  //    Shared with previewInputs() so a client's placement preview cannot diverge from
  //    the authoritative rule here (Story 6). step() ignores the acceptance result.
  applyInputPhase(state, ruleset, inputs);

  // 2) WAVE PHASE (G1/G2/G4). If a wave remains to launch: a buffered early call, OR
  //    (once past this wave's flip tick) the countdown reaching 0, launches it NOW.
  //    A wave never decrements on its own flip tick — wave 1's flip tick is run
  //    start (`tick > 0` below), so a genuine `countdownTicks`-tick countdown still
  //    launches at tick === countdownTicks (M1 continuity); later waves need no
  //    guard, since their flip tick already ran the launch branch that set them up.
  if (state.waveCursor < waveCount) {
    let launchNow = state.launchPending;
    if (!launchNow && state.tick > 0) {
      state.countdownRemaining -= 1;
      if (state.countdownRemaining <= 0) launchNow = true;
    }
    if (launchNow) {
      const k = state.waveCursor;
      const rem = state.countdownRemaining; // sampled BEFORE any reset below
      if (balance.earlyCallBountyDivisor > 0) {
        state.bounty = satAdd(state.bounty, Math.floor(rem / balance.earlyCallBountyDivisor));
      }
      if (scoring.earlyCallScoreDivisor > 0) {
        state.cumulativeEarlyCallCredit = satAdd(
          state.cumulativeEarlyCallCredit,
          Math.floor(rem / scoring.earlyCallScoreDivisor),
        );
      }
      state.waveLaunchTick[k] = state.tick;
      state.launchPending = false;
      state.waveCursor += 1;
      // An early-called FINAL wave must not strand a stale positive countdown (the
      // boundary invariant: countdownRemaining is 0 once every wave has launched).
      state.countdownRemaining =
        state.waveCursor < waveCount ? waves[state.waveCursor]!.countdownTicks : 0;
    }
  }
  // Spawn drain: every launched wave, in index order (earlier-launched wave first;
  // within a wave, its pre-sorted spawn list) — creeps carry `wave = k`.
  for (let k = 0; k < waveCount; k++) {
    const launchTick = state.waveLaunchTick[k]!; // coerceSoa sized this array to waveCount
    if (launchTick === null) continue;
    const spawns = waves[k]!.spawns;
    for (;;) {
      const cursor = state.waveSpawnCursor[k]!;
      const entry = cursor < spawns.length ? spawns[cursor] : undefined;
      if (entry === undefined || launchTick + entry.offsetTicks > state.tick) break;
      const def = creepById[entry.creepId];
      if (def !== undefined) {
        const newCreepId = allocEntityId(state);
        // Exhausted entity-id space: the scheduled spawn is still consumed (cursor
        // advances below) but no creep columns or economy are mutated — guarantees
        // loop termination and never retries the same cursor.
        if (newCreepId !== null) {
          state.creeps.id.push(newCreepId);
          state.creeps.hp.push(def.hp);
          state.creeps.bounty.push(def.bounty);
          state.creeps.speed.push(def.speedFp);
          state.creeps.fromX.push(cellCenterX(entrance.col)); // rest on the entrance centre
          state.creeps.fromY.push(cellCenterY(entrance.row));
          state.creeps.headCol.push(entrance.col); // sentinel — heading derived at movement
          state.creeps.headRow.push(entrance.row);
          state.creeps.progress.push(0);
          state.creeps.wave.push(k);
          state.creeps.creepId.push(entry.creepId);
          state.creeps.slowMulFp.push(0); // fresh spawn — never slowed yet
          state.creeps.slowUntilTick.push(0);
          state.creeps.stunUntilTick.push(0); // fresh spawn — never stunned yet
        }
      }
      state.waveSpawnCursor[k] = cursor + 1;
    }
  }

  // 3) DERIVE the effective field once for this tick from the final tower SoA.
  const field =
    state.towers.id.length === 0 ? board.field : effectiveField(grid, state.towers, towerById);

  // 4) MOVEMENT PHASE — advance each creep at its own speed over the post-input field.
  //    A creep reaching the exit leaks (costs `leakCost` lives, bumps `leakedCount`
  //    and its owning wave's `waveLeaked`); a corrupt row is dropped (no life lost).
  //    Rebuild to compact both removals — `wave`/`creepId`/`slowMulFp`/`slowUntilTick`
  //    thread through by source row like any other column. The per-row travel budget
  //    is the SLOW-AWARE `effectiveSpeedFp` (ruleset-shared.ts) — THE single
  //    implementation shared verbatim with the compile-time bound gate (Codex R2-4):
  //    a live (non-expired-by-entry-coercion) slow multiplies the base speed down,
  //    floored by the ruleset's slow floor, never below 1.
  const src = state.creeps;
  const next: CreepArrays = emptyCreeps();
  for (let i = 0; i < src.id.length; i++) {
    // Ragged-row policy: a creep whose bounty/speed column is out of sync (a forged
    // or partially-restored SoA) is dropped, like a missing position column — no life
    // lost, never a crash. A genuine row always carries safe-integer bounty and speed.
    if (!Number.isSafeInteger(src.bounty[i]) || !Number.isSafeInteger(src.speed[i])) continue;
    const speed = src.speed[i] as number;
    const wave = src.wave[i] as number; // coerceSoa already dropped any invalid-wave row
    const creepId = src.creepId[i] as string; // coerceSoa already dropped any unresolvable-id row
    const slowMulFp = Number.isSafeInteger(src.slowMulFp[i]) ? (src.slowMulFp[i] as number) : 0;
    const slowUntilTick = Number.isSafeInteger(src.slowUntilTick[i])
      ? (src.slowUntilTick[i] as number)
      : 0;
    const stunUntilTick = Number.isSafeInteger(src.stunUntilTick[i])
      ? (src.stunUntilTick[i] as number)
      : 0;
    // Inclusive boundary, matching the expiry sweep's `<= tick`: a stun applied
    // through tick T (stunUntilTick === T) still holds movement at tick T; the
    // sweep at the close of THIS tick's combat phase then clears it, so movement
    // resumes at T+1.
    const stunned = stunUntilTick !== 0 && stunUntilTick >= state.tick;
    const effSpeed = stunned
      ? 0
      : effectiveSpeedFp(speed, slowMulFp, balance.slowFloorNum, balance.slowFloorDen);
    // Domain (M2-S7 P2) — the shared resolver (domain.ts), same `?? 'ground'`
    // totality rail every other call site uses: an unresolved `creepId` never
    // reaches this loop (coerceSoa already dropped it), but the resolver is used
    // uniformly regardless.
    const domain = resolveCreepDomain(creepById, creepId);
    const outcome = advanceCreep(
      field,
      src.id[i],
      src.hp[i],
      src.fromX[i],
      src.fromY[i],
      src.headCol[i],
      src.headRow[i],
      src.progress[i],
      effSpeed,
      domain,
    );
    if (outcome.kind === 'drop') continue;
    if (outcome.kind === 'leak') {
      // Guarded: a non-safe `lives` or one at MIN_SAFE_INTEGER removes the creep but
      // leaves `lives` unchanged; otherwise subtract `leakCost`. No low clamp — win/
      // loss resolution reads `lives <= 0`. `leakedCount` is presentation/telemetry;
      // `waveLeaked[wave]` is the per-wave clear-bonus forfeit authority.
      if (Number.isSafeInteger(state.leakedCount) && state.leakedCount < Number.MAX_SAFE_INTEGER) {
        state.leakedCount += 1;
      }
      state.waveLeaked[wave] = true;
      if (
        Number.isSafeInteger(state.lives) &&
        state.lives - balance.leakCost > Number.MIN_SAFE_INTEGER
      ) {
        state.lives -= balance.leakCost;
      }
      continue;
    }
    next.id.push(src.id[i] as number);
    next.hp.push(src.hp[i] as number);
    next.bounty.push(src.bounty[i] as number);
    next.speed.push(speed);
    next.fromX.push(outcome.fromX);
    next.fromY.push(outcome.fromY);
    next.headCol.push(outcome.headCol);
    next.headRow.push(outcome.headRow);
    next.progress.push(outcome.progress);
    next.wave.push(wave);
    next.creepId.push(creepId);
    next.slowMulFp.push(slowMulFp);
    next.slowUntilTick.push(slowUntilTick);
    next.stunUntilTick.push(stunUntilTick);
  }
  state.creeps = next;

  // 5) COMBAT PHASE (Story 4 + M2-S3's status framework, M2-S6 the RNG seam) — over
  //    the POST-MOVE world: resolve due impacts (direct → death check → slow/stun/
  //    dot), sweep dead creeps and credit per-creep bounty, then hold/acquire + fire,
  //    then the expiry sweep. The kill bounty this tick also feeds the monotonic
  //    score accumulator. `wave`/`creepId`/`slowMulFp`/`slowUntilTick`/`stunUntilTick`
  //    thread through the combat survivor compaction like any other column
  //    (combat.ts). `rng` is constructed fresh from `state.rngState` ONCE per tick
  //    (never a module-level singleton, never lazy — `rng.ts`'s header is normative)
  //    and its post-combat state written back UNCONDITIONALLY below, whether or not
  //    anything drew this tick — that write, paid on every advancing tick, is exactly
  //    what makes a stun-free run's `rngState` still round-trip byte-identically.
  const rng = new Rng(state.rngState);
  const combat = runCombat(
    state.creeps,
    state.towers,
    state.impacts,
    state.dots,
    state.tick,
    state.bounty,
    field,
    grid,
    towerById,
    creepById,
    balance.slowFloorNum,
    balance.slowFloorDen,
    rng,
    events,
  );
  state.creeps = combat.creeps;
  state.impacts = combat.impacts;
  state.dots = combat.dots;
  state.bounty = combat.bounty;
  state.cumulativeKillBounty = satAdd(state.cumulativeKillBounty, combat.killBounty);
  state.rngState = rng.getState();

  // 6) RESOLUTION (G8) — settlement precedes terminal, UNIFORMLY: a wave completing
  //    on the final tick pays, win or loss. Per-wave alive counts are DERIVED from
  //    the surviving creep SoA's `wave` column — O(creeps), immune by construction
  //    to every removal path (no counter to desynchronize).
  const aliveByWave = deriveAliveByWave(state.creeps.wave, waveCount);
  for (let k = 0; k < waveCount; k++) {
    if (
      state.waveLaunchTick[k] !== null &&
      !state.waveResolved[k] &&
      state.waveSpawnCursor[k] === waves[k]!.spawns.length &&
      aliveByWave[k] === 0
    ) {
      state.waveResolved[k] = true;
      if (!state.waveLeaked[k]) {
        state.bounty = satAdd(state.bounty, waves[k]!.clearBonus);
      }
    }
  }
  // Terminal: loss takes priority (lives ≤ 0 is terminal regardless of wave state);
  // otherwise a win once every wave has resolved.
  if (state.lives <= 0) {
    state.phase = 'lost';
  } else if (state.waveResolved.every((resolved) => resolved)) {
    state.phase = 'won';
  }

  state.tick += 1; // guarded at entry — `tick + 1` is in the safe-integer range here
  return state;
}

/**
 * The authoritative numeric score, a pure function of state + ruleset weights
 * (ADR 0006 — server-re-derivable), OUTCOME-DEPENDENT (G9 — the scorer is the
 * single grading function for both the live HUD and either terminal contract):
 *   - `running` — Σ kill-bounties + Σ early-call credit (the live readout).
 *   - `won`     — Σ kill-bounties + Σ early-call credit + max(0, lives) × survivalMul.
 *   - `lost`    — Σ kill-bounties ONLY: the early-call credit (and any live-readout
 *     value it contributed) is forfeited entirely on a loss, by design — a loss can
 *     land below the last live readout.
 * Every term saturates (`satAdd`/`satMul`) rather than wraps.
 */
export function deriveScore(state: SimState | PreviewState, ruleset: CompiledRuleset): number {
  const kb = Number.isSafeInteger(state.cumulativeKillBounty) ? state.cumulativeKillBounty : 0;
  if (state.phase === 'lost') return kb;
  const credit = Number.isSafeInteger(state.cumulativeEarlyCallCredit)
    ? state.cumulativeEarlyCallCredit
    : 0;
  const running = satAdd(kb, credit);
  if (state.phase !== 'won') return running;
  const lives = Number.isSafeInteger(state.lives) && state.lives > 0 ? state.lives : 0;
  return satAdd(running, satMul(lives, ruleset.scoring.survivalMul));
}

/** The casual star grade from lives remaining (a win only; a loss earns 0). */
export function deriveStars(state: SimState | PreviewState, ruleset: CompiledRuleset): number {
  if (state.phase !== 'won') return 0;
  const [t1, t2, t3] = ruleset.scoring.starThresholds;
  const lives = Number.isSafeInteger(state.lives) ? state.lives : 0; // guard, like deriveScore
  if (lives >= t3) return 3;
  if (lives >= t2) return 2;
  if (lives >= t1) return 1;
  return 0;
}

/** Deterministic content-hash of the world — the per-tick determinism checksum. */
export function hashSimState(state: SimState | PreviewState): string {
  return hashState(state);
}

/** Deep-readonly view of `CreepArrays` — every column exposed as `readonly number[]`,
 *  so it is structurally incompatible with the mutable `CreepArrays` a real tick's
 *  MOVEMENT/COMBAT phases write into. */
export interface ReadonlyCreepArrays {
  readonly id: readonly number[];
  readonly hp: readonly number[];
  readonly bounty: readonly number[];
  readonly speed: readonly number[];
  readonly fromX: readonly number[];
  readonly fromY: readonly number[];
  readonly headCol: readonly number[];
  readonly headRow: readonly number[];
  readonly progress: readonly number[];
  readonly wave: readonly number[];
  readonly creepId: readonly string[];
  readonly slowMulFp: readonly number[];
  readonly slowUntilTick: readonly number[];
  readonly stunUntilTick: readonly number[];
}

/** Deep-readonly view of `TowerArrays` — see `ReadonlyCreepArrays`. */
export interface ReadonlyTowerArrays {
  readonly id: readonly number[];
  readonly col: readonly number[];
  readonly row: readonly number[];
  readonly spend: readonly number[];
  readonly targetId: readonly number[];
  readonly nextFireTick: readonly number[];
  readonly towerId: readonly string[];
}

/**
 * Deep-readonly view of `Impact` — `Impact.effects` is a mutable `EffectPrimitive[]` in
 * `SimState` (combat.ts still writes it), but `PreviewState.impacts` shares its impact
 * objects with the live state (see `partialCloneForPreview`), so a bare `readonly
 * Impact[]` would leave `preview.impacts[0].effects` mutable and let a "read-only"
 * preview mutate the live simulation through it. `effects` is re-typed `readonly` here;
 * every other `Impact` field is already readonly.
 *
 * `Impact` is a DISCRIMINATED UNION (`targeted` | `blast`, combat.ts) — a plain
 * `Omit<Impact, 'effects'>` distributes over neither branch; it collapses to the
 * fields common to BOTH members (dropping `targetId` from `targeted` and `x`/`y`/
 * `radiusFp` from `blast` alike), and a hand-built object like `{ kind: 'blast',
 * impactTick: 0, effects: [] }` — missing every coordinate — would then wrongly
 * typecheck as a `ReadonlyImpact`. `WithReadonlyEffects` instead maps DISTRIBUTIVELY
 * (the `I extends unknown ? … : never` conditional forces the compiler to apply
 * `Omit`/intersection to each union member separately, then re-union the results),
 * so `ReadonlyImpact` stays the true union of a readonly-effects `targeted` and a
 * readonly-effects `blast`, each still carrying its own discriminant-specific fields.
 */
type WithReadonlyEffects<I> = I extends unknown
  ? Omit<I, 'effects'> & { readonly effects: readonly EffectPrimitive[] }
  : never;
export type ReadonlyImpact = WithReadonlyEffects<Impact>;

/**
 * The read-only result of `previewInputs` (#30/P3). Structurally a deep-readonly view
 * of `SimState` — every array-bearing field is `readonly`, which makes `PreviewState`
 * INCOMPATIBLE with `step()`'s mutable `SimState` parameter: `step(preview)` fails to
 * typecheck (`readonly number[]` is not assignable to `number[]`), so the read-only
 * contract is enforced by the typechecker, not by a runtime `Object.freeze` (which
 * can't apply to non-empty typed arrays or plain arrays a caller could still reassign
 * onto without freezing the container).
 */
export interface PreviewState {
  readonly tick: number;
  readonly rngState: number;
  readonly lives: number;
  readonly bounty: number;
  readonly nextEntityId: number;
  readonly phase: SimPhase;
  readonly waveCursor: number;
  readonly countdownRemaining: number;
  readonly launchPending: boolean;
  readonly waveLaunchTick: readonly (number | null)[];
  readonly waveSpawnCursor: readonly number[];
  readonly waveLeaked: readonly boolean[];
  readonly waveResolved: readonly boolean[];
  readonly cumulativeEarlyCallCredit: number;
  readonly cumulativeKillBounty: number;
  readonly leakedCount: number;
  readonly creeps: ReadonlyCreepArrays;
  readonly towers: ReadonlyTowerArrays;
  readonly impacts: readonly ReadonlyImpact[];
  readonly dots: readonly DotRecord[];
}

/** Build the mutable working clone `previewInputs` runs `applyInputPhase` against.
 *  Only `towers` is deep-cloned — the sole SoA `applyInputPhase` mutates (writes touch
 *  only towers columns, `bounty`, `nextEntityId`, and now `launchPending`, all
 *  scalars/towers copied by the `{...state}` spread or the explicit `structuredClone`
 *  below). `creeps` gets a shallow CONTAINER copy sharing the column arrays —
 *  load-bearing: `coerceSoa`'s repair writes (`c.id = []` etc.) assign onto this new
 *  container object, never onto the source's, while the column arrays themselves are
 *  never written to by the input phase and so are safely shared, not copied.
 *  `impacts` is a shared reference for the same reason (the input phase never touches
 *  it) — `dots` (M2-S5a) is a shared reference for the identical reason: the input
 *  phase never touches DoT state either. The four wave-lifecycle arrays
 *  (`waveLaunchTick`/`waveSpawnCursor`/`waveLeaked`/`waveResolved`) are likewise
 *  SHARED by this `{...state}` spread (a scalar-level copy of the array REFERENCE,
 *  not its contents) — `coerceSoa`'s own copy-on-write discipline is what keeps a
 *  preview repair from mutating the live state's array through that shared
 *  reference (see its doc comment).
 *
 *  Guarantee scope: today a forged state with a non-cloneable value (function/symbol)
 *  ANYWHERE throws from a blanket `structuredClone`; after this only the towers
 *  container keeps that rejection — non-cloneable garbage in creeps/impacts/dots now
 *  flows through untouched (coerceSoa's shape guards still apply to it; the hash
 *  invariant holds trivially since those arrays are shared, not copied). */
function partialCloneForPreview(state: SimState | PreviewState): SimState {
  const s = state as SimState;
  return {
    ...s,
    towers: structuredClone(s.towers) as TowerArrays,
    creeps: { ...s.creeps } as CreepArrays,
    impacts: s.impacts as Impact[],
    dots: s.dots as DotRecord[],
  };
}

/**
 * Read-only placement/command preview (Story 6). Clones only what the input phase can
 * mutate (see `partialCloneForPreview`) and runs ONLY that phase (no tick advance, no
 * wave/movement/combat) against the clone, returning per-command acceptance and the
 * resulting `PreviewState`. The source `state` is **never mutated** — a client can test
 * a pending command queue in issued order and know exactly which builds/sells `step()`
 * will apply, with the ghost's validity derived from the same authority (shared
 * `applyInputPhase`). Guaranteed: `hashSimState(state)` is byte-identical before and
 * after this call.
 *
 * Accepts either a real `SimState` or a previously-returned `PreviewState` — the
 * controller's refund path legitimately chains a preview back into a second call — and
 * never mutates whichever it's given.
 *
 * Mirrors step()'s FREEZE-ON-TERMINAL guard: on a resolved match (`won`/`lost`) step()
 * no-ops every command, so the preview reports all commands rejected (and an unchanged
 * clone) — otherwise a client would show an actionable Sell/refund on a finished game
 * whose `sellTower` the real frozen `step()` silently drops.
 */
export function previewInputs(
  state: SimState | PreviewState,
  ruleset: CompiledRuleset,
  commands: readonly SimInput[],
): { accepted: boolean[]; preview: PreviewState } {
  assertRuleset(ruleset);
  const preview = partialCloneForPreview(state);
  // The clone gets the same totality guarantees as a real step() — but in PREVIEW
  // mode, so a genuinely buffered `launchPending` survives a chained preview call
  // instead of being force-cleared (see `CoerceMode`'s doc).
  coerceSoa(preview, ruleset, 'preview');
  // Mirror BOTH of step()'s pre-input guards so preview can never disagree with a real
  // tick: the tick-totality no-op (a forged/near-overflow tick) and the terminal freeze.
  const tickBroken =
    !Number.isSafeInteger(preview.tick) ||
    preview.tick < 0 ||
    preview.tick + 1 > Number.MAX_SAFE_INTEGER;
  if (tickBroken || isTerminalPhase(preview.phase)) {
    return { accepted: commands.map(() => false), preview };
  }
  const accepted = applyInputPhase(preview, ruleset, commands);
  return { accepted, preview };
}

/**
 * The derived fixed-point point `{x,y}` of creep row `i`, or `null` if the row is
 * non-canonical (a forged/ragged SoA). Presentation reads this for rendering — the sim
 * stores a segment start + progress, never the point (Story 4) — reusing the movement
 * derivation so the drawn position matches the simulated one exactly.
 */
export function projectCreep(
  creeps: CreepArrays,
  i: number,
  bounds: { readonly width: number; readonly height: number },
): { x: number; y: number } | null {
  const geo = deriveValidCreepPosition(
    creeps.fromX[i],
    creeps.fromY[i],
    creeps.headCol[i],
    creeps.headRow[i],
    creeps.progress[i],
    bounds,
  );
  return geo === null ? null : { x: geo.point.x, y: geo.point.y };
}

/** Fixed-point centre of a cell — presentation projects towers/board from these. */
export { cellCenterX, cellCenterY } from './movement';

// Board model (grid + pathfinding, M1 Story 1).
export { buildGrid, neighbors, GridError } from './board';
export type { CellClass, GridSpec, Grid } from './board';
export { computeDistanceField, isReachable, shortestPath } from './pathfinding';
export type { DistanceField } from './pathfinding';
export { loadBoard } from './context';
export type { BoardContext } from './context';
// Landed-impact events (M1 Story 8, #31): an optional out-param on `step()` — never
// part of `SimState`, never hash-relevant.
export type { StepEvents } from './combat';
// DoT records + the resident-queue caps (M2-S5a, #77): `packages/perf` consumes
// both through this barrel (P4's `dot-bench.ts`). `MAX_IN_FLIGHT_IMPACTS` was not
// previously re-exported — added here alongside its DoT analogue.
// The ONE fixed-point diagonal edge length. Shared so `compileRuleset`'s traversal
// bound and actual movement can never disagree (CodeRabbit, PR #78 — they were two
// private copies of 362, with nothing enforcing that they matched).
export { DIAG_LEN } from './movement';
export {
  type DotRecord,
  MAX_DOT_RECORDS,
  MAX_DOT_CADENCE_TICKS,
  MAX_IN_FLIGHT_IMPACTS,
} from './combat';
// Ruleset bundle (M1 Story 5, re-encoded to v2 in M2-S1): compilation, the content
// digest, and the boundary guard.
export {
  compileRuleset,
  rulesetDigest,
  assertRuleset,
  RulesetError,
  MAX_MATCH_TICKS,
  type CompiledRuleset,
  type CompiledBalance,
  type CompiledScoring,
  type CompiledTower,
  type CompiledEffect,
  type CompiledCreep,
  type CompiledWave,
  type ScheduledSpawn,
} from './ruleset';
// The v2 structural validator + JSON parser (M2-S1) — `@wynding/content`'s registry
// needs `parseRulesetJson` directly (the sanctioned `content → sim` edge).
export { validateRulesetShape, parseRulesetJson, MAX_RULESET_TEXT_UNITS } from './ruleset-schema';
// The per-`simVersion` capability profile (M2-S1).
export { capabilityProfile, type CapabilityProfile } from './capability';
// Tower SoA + the canonical row-validity walk (M2-S3, Codex R3-2): `forEachValidTower`
// joins the barrel so presentation (the render VM's tower projection, the
// controller's `towerAt`/hit-testing) classifies rows by the SAME rule the sim
// itself uses for the mask/sell/combat — a sim-invisible row (unknown `towerId`,
// spend↔towerId mismatch) can never be drawn, selectable, or placement-blocking.
export {
  forEachValidTower,
  materializeTowerMask,
  findValidTowerIndex,
  countValidTowers,
  canPlaceTower,
  MAX_TOWERS,
  type TowerArrays,
  type TowerValidityView,
  type TowerCostLookup,
} from './tower';
