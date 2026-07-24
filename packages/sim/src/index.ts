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

import { hashState } from '@wynding/engine';
import type { CreepKind, Seed } from '@wynding/types';
import { advanceCreep, cellCenterX, cellCenterY, deriveValidCreepPosition } from './movement';
import { runCombat, emptyCreeps, safeAdd, type Impact, type StepEvents } from './combat';
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

/** Simulation cadence: 20 Hz. Must match the render loop's tick duration. */
export const MS_PER_TICK = 50;

/** Behavior version stamped into replays; bump on any determinism-affecting change.
 *  Story 5 (wave lifecycle, win/loss, score, per-creep columns) bumped 4 → 5. */
export const SIM_VERSION = 5;

/** The game lifecycle phase (win/loss resolution + wave launch gating). */
export type SimPhase = 'pre-wave' | 'active' | 'won' | 'lost';

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
}

/** Complete simulation state for one match. Fully serializable. */
export interface SimState {
  tick: number;
  rngState: number;
  lives: number;
  bounty: number;
  nextEntityId: number; // shared entity-id space: creeps and towers
  phase: SimPhase;
  launchAtTick: number; // the tick the wave auto-launches (init: countdownTicks)
  launchTick: number | null; // the tick the wave actually launched (null pre-launch)
  spawnCursor: number; // index of the next scheduled spawn
  cumulativeKillBounty: number; // monotonic Σ kill-bounties — the score accumulator
  leakedCount: number; // monotonic leak count — the wave-clear forfeit authority
  creeps: CreepArrays;
  towers: TowerArrays;
  impacts: Impact[]; // in-flight scheduled combat impacts (Story 4)
}

/** Per-tick inputs (the replayable command log). Creep spawns come from the ruleset
 *  wave schedule, NOT the log (ADR 0006) — there is no manual spawn command. */
export type SimInput =
  | { readonly kind: 'placeTower'; readonly anchor: { readonly col: number; readonly row: number } }
  | { readonly kind: 'sellTower'; readonly tower: number } // EntityId of the tower
  | { readonly kind: 'callWaveEarly' } // launch the wave now (pre-wave only)
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
function effectiveField(grid: Grid, towers: TowerArrays, cost: number): DistanceField {
  const mask = materializeTowerMask(grid, towers, cost); // O(towers), never throws
  const memo = fieldCache.get(grid);
  if (memo !== undefined && maskEquals(memo.mask, mask)) return memo.field;
  const field = computeDistanceField(grid, mask);
  fieldCache.set(grid, { mask, field });
  return field;
}

/**
 * Totality guard (ADR 0006 §4): a restored or forged state may be missing whole SoA
 * containers, individual columns, or the Story-5 lifecycle fields. Coerce any absent
 * container/column to an empty array and any missing/forged lifecycle field to a safe
 * default so every downstream read is well-defined instead of dereferencing
 * `undefined`. For a well-formed state this is a no-op.
 */
function coerceSoa(state: SimState): void {
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

  if (!Array.isArray(state.impacts)) state.impacts = [];

  // Lifecycle fields (Story 5): coerce a pre-v5 / forged snapshot to safe defaults.
  if (
    state.phase !== 'pre-wave' &&
    state.phase !== 'active' &&
    state.phase !== 'won' &&
    state.phase !== 'lost'
  ) {
    state.phase = 'pre-wave';
  }
  // A forged/legacy state missing its deadline stays inert (never auto-launches) —
  // a genuine state always carries a real safe-integer launchAtTick, so this only
  // affects forged input and avoids a spurious wave launch from a restored snapshot.
  if (!Number.isSafeInteger(state.launchAtTick)) state.launchAtTick = Number.MAX_SAFE_INTEGER;
  if (state.launchTick !== null && !Number.isSafeInteger(state.launchTick)) state.launchTick = null;
  if (!Number.isSafeInteger(state.spawnCursor) || state.spawnCursor < 0) state.spawnCursor = 0;
  if (!Number.isSafeInteger(state.cumulativeKillBounty)) state.cumulativeKillBounty = 0;
  if (!Number.isSafeInteger(state.leakedCount)) state.leakedCount = 0;

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

/** Build a fresh match state for a given seed against a compiled ruleset. Reads the
 *  starting economy and the countdown deadline from the ruleset's balance block. */
export function createInitialState(seed: Seed | number, ruleset: CompiledRuleset): SimState {
  assertRuleset(ruleset);
  return {
    tick: 0,
    rngState: seed >>> 0,
    lives: ruleset.balance.startingLives,
    bounty: ruleset.balance.startingBounty,
    nextEntityId: 1,
    phase: 'pre-wave',
    launchAtTick: ruleset.balance.countdownTicks, // start tick is 0
    launchTick: null,
    spawnCursor: 0,
    cumulativeKillBounty: 0,
    leakedCount: 0,
    creeps: emptyCreeps(),
    towers: emptyTowers(),
    impacts: [],
  };
}

/**
 * INPUT PHASE (Story 6): apply the per-tick player command log against evolving state,
 * in array order, each command re-validated. Mutates `state.towers`/`bounty`/
 * `nextEntityId`/`launchAtTick`. Returns a per-command **acceptance** array — `true`
 * where a command produced a state change (a build placed, a sell refunded, an early
 * call launched), `false` for a no-op (illegal, unaffordable, idempotent, malformed).
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
  const { board, tower, balance } = ruleset;
  const { grid } = board;
  const cost = tower.cost;
  const accepted: boolean[] = [];

  for (const input of inputs as readonly unknown[]) {
    if (input === null || typeof input !== 'object') {
      accepted.push(false);
      continue;
    }
    const kind = (input as { kind?: unknown }).kind;

    if (kind === 'placeTower') {
      const anchor = (input as { anchor?: unknown }).anchor;
      // Sim-owned cap: a build past MAX_TOWERS is a deterministic no-op, so the
      // in-flight impact queue stays bounded for every step() caller.
      if (
        state.towers.id.length >= MAX_TOWERS &&
        countValidTowers(grid, state.towers, cost) >= MAX_TOWERS
      ) {
        accepted.push(false);
        continue;
      }
      const towerMask = materializeTowerMask(grid, state.towers, cost);
      if (!canPlaceTower(grid, towerMask, anchor, state.creeps, state.bounty, cost)) {
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
      state.towers.spend.push(cost);
      state.towers.targetId.push(0); // no lock
      state.towers.nextFireTick.push(0); // no warm-up — may fire this tick
      state.bounty -= cost;
      accepted.push(true);
    } else if (kind === 'sellTower') {
      const towerId = (input as { tower?: unknown }).tower;
      if (!Number.isSafeInteger(towerId)) {
        accepted.push(false);
        continue;
      } // malformed id — no-op
      if (!Number.isSafeInteger(state.bounty) || state.bounty < 0) {
        accepted.push(false);
        continue;
      } // corrupt bounty — no-op
      const index = findValidTowerIndex(grid, state.towers, towerId as number, cost);
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
      forEachValidTower(grid, src, cost, (i, id, col, row) => {
        if (i === index) return;
        compacted.id.push(id);
        compacted.col.push(col);
        compacted.row.push(row);
        compacted.spend.push(src.spend[i] as number);
        compacted.targetId.push(safeCombatColumn(src.targetId[i]));
        compacted.nextFireTick.push(safeCombatColumn(src.nextFireTick[i]));
      });
      state.towers = compacted;
      accepted.push(true);
    } else if (kind === 'callWaveEarly') {
      // Launch now — but only while still pre-wave and not already pulled forward to
      // this tick (idempotent: repeated calls this tick, or after launch, no-op). The
      // early-call bonus (0 at M1) is credited once, on the transition.
      if (state.phase === 'pre-wave' && state.launchAtTick > state.tick) {
        state.launchAtTick = state.tick;
        state.bounty = safeAdd(state.bounty, balance.earlyCallBonus);
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
 * (launch on the deadline or an early call; spawn due creeps from the schedule) →
 * derive the effective field once → MOVEMENT (leaks cost `leakCost` lives and bump
 * `leakedCount`) → COMBAT (resolve impacts, sweep kills → per-creep bounty +
 * `cumulativeKillBounty`, fire) → RESOLUTION (loss if lives ≤ 0; win when the
 * schedule is exhausted and no creep remains) → guarded `tick++`. Once terminal
 * (`won`/`lost`) `step` is a total NO-OP, so a replay padded past resolution can
 * never change the final hash or score. `step` never throws on forged input.
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
  coerceSoa(state); // totality: never dereference a missing SoA container/column/field

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

  const { board, tower, balance, scoring: _scoring, schedule, creepByKind } = ruleset;
  const { grid } = board;
  const { entrance } = grid;
  const cost = tower.cost;

  // 1) INPUT PHASE — array order; each command re-validated against evolving state.
  //    Shared with previewInputs() so a client's placement preview cannot diverge from
  //    the authoritative rule here (Story 6). step() ignores the acceptance result.
  applyInputPhase(state, ruleset, inputs);

  // 2) WAVE PHASE — launch on the deadline (test-before-act: launches at tick ===
  //    launchAtTick, e.g. 500, not 499), then spawn every creep whose scheduled tick
  //    has arrived. Spawns read stats from the creep catalog (single authority).
  if (state.phase === 'pre-wave' && state.tick >= state.launchAtTick) {
    state.phase = 'active';
    state.launchTick = state.tick;
  }
  if (state.phase === 'active' && state.launchTick !== null) {
    const launch = state.launchTick;
    for (;;) {
      const entry = state.spawnCursor < schedule.length ? schedule[state.spawnCursor] : undefined;
      if (entry === undefined || launch + entry.offsetTicks > state.tick) break;
      const kindOf: CreepKind = entry.kind;
      const def = creepByKind[kindOf];
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
        }
      }
      state.spawnCursor++;
    }
  }

  // 3) DERIVE the effective field once for this tick from the final tower SoA.
  const field =
    state.towers.id.length === 0 ? board.field : effectiveField(grid, state.towers, cost);

  // 4) MOVEMENT PHASE — advance each creep at its own speed over the post-input field.
  //    A creep reaching the exit leaks (costs `leakCost` lives, bumps `leakedCount`);
  //    a corrupt row is dropped (no life lost). Rebuild to compact both removals.
  const src = state.creeps;
  const next: CreepArrays = emptyCreeps();
  for (let i = 0; i < src.id.length; i++) {
    // Ragged-row policy: a creep whose bounty/speed column is out of sync (a forged
    // or partially-restored SoA) is dropped, like a missing position column — no life
    // lost, never a crash. A genuine row always carries safe-integer bounty and speed.
    if (!Number.isSafeInteger(src.bounty[i]) || !Number.isSafeInteger(src.speed[i])) continue;
    const speed = src.speed[i] as number;
    const outcome = advanceCreep(
      field,
      src.id[i],
      src.hp[i],
      src.fromX[i],
      src.fromY[i],
      src.headCol[i],
      src.headRow[i],
      src.progress[i],
      speed,
    );
    if (outcome.kind === 'drop') continue;
    if (outcome.kind === 'leak') {
      // Guarded: a non-safe `lives` or one at MIN_SAFE_INTEGER removes the creep but
      // leaves `lives` unchanged; otherwise subtract `leakCost`. No low clamp — win/
      // loss resolution reads `lives <= 0`. `leakedCount` is the forfeit authority.
      if (Number.isSafeInteger(state.leakedCount) && state.leakedCount < Number.MAX_SAFE_INTEGER) {
        state.leakedCount += 1;
      }
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
  }
  state.creeps = next;

  // 5) COMBAT PHASE (Story 4) — over the POST-MOVE world: resolve due impacts, sweep
  //    dead creeps and credit per-creep bounty, then hold/acquire + fire. The kill
  //    bounty this tick also feeds the monotonic score accumulator.
  const combat = runCombat(
    state.creeps,
    state.towers,
    state.impacts,
    state.tick,
    state.bounty,
    field,
    grid,
    tower,
    events,
  );
  state.creeps = combat.creeps;
  state.impacts = combat.impacts;
  state.bounty = combat.bounty;
  state.cumulativeKillBounty = safeAdd(state.cumulativeKillBounty, combat.killBounty);

  // 6) RESOLUTION — loss takes priority (lives ≤ 0 is terminal regardless of phase);
  //    otherwise a win when the schedule is exhausted and no creep remains alive.
  if (state.lives <= 0) {
    state.phase = 'lost';
  } else if (
    state.phase === 'active' &&
    state.spawnCursor >= schedule.length &&
    state.creeps.id.length === 0
  ) {
    state.phase = 'won';
    // Wave-clear bonus (0 at M1): paid once, forfeited if any creep leaked.
    if (state.leakedCount === 0) {
      state.bounty = safeAdd(state.bounty, balance.waveClearBonus);
    }
  }

  state.tick += 1; // guarded at entry — `tick + 1` is in the safe-integer range here
  return state;
}

/**
 * The authoritative numeric score, a pure function of terminal state + ruleset
 * weights (ADR 0006 — server-re-derivable): Σ kill-bounties + max(0, lives) ×
 * survivalMul. Bonuses credit spendable bounty only, never the score.
 */
export function deriveScore(state: SimState, ruleset: CompiledRuleset): number {
  const kb = Number.isSafeInteger(state.cumulativeKillBounty) ? state.cumulativeKillBounty : 0;
  const lives = Number.isSafeInteger(state.lives) && state.lives > 0 ? state.lives : 0;
  return kb + lives * ruleset.scoring.survivalMul;
}

/** The casual star grade from lives remaining (a win only; a loss earns 0). */
export function deriveStars(state: SimState, ruleset: CompiledRuleset): number {
  if (state.phase !== 'won') return 0;
  const [t1, t2, t3] = ruleset.scoring.starThresholds;
  const lives = Number.isSafeInteger(state.lives) ? state.lives : 0; // guard, like deriveScore
  if (lives >= t3) return 3;
  if (lives >= t2) return 2;
  if (lives >= t1) return 1;
  return 0;
}

/** Deterministic content-hash of the world — the per-tick determinism checksum. */
export function hashSimState(state: SimState): string {
  return hashState(state);
}

/**
 * Read-only placement/command preview (Story 6). **Deep-clones** `state` and runs ONLY
 * the input phase (no tick advance, no wave/movement/combat) against the clone,
 * returning per-command acceptance and the resulting preview state. The source `state`
 * is **never mutated** — a client can test a pending command queue in issued order and
 * know exactly which builds/sells `step()` will apply, with the ghost's validity derived
 * from the same authority (shared `applyInputPhase`). Guaranteed: `hashSimState(state)`
 * is byte-identical before and after this call.
 *
 * Mirrors step()'s FREEZE-ON-TERMINAL guard: on a resolved match (`won`/`lost`) step()
 * no-ops every command, so the preview reports all commands rejected (and an unchanged
 * clone) — otherwise a client would show an actionable Sell/refund on a finished game
 * whose `sellTower` the real frozen `step()` silently drops.
 */
export function previewInputs(
  state: SimState,
  ruleset: CompiledRuleset,
  commands: readonly SimInput[],
): { accepted: boolean[]; preview: SimState } {
  assertRuleset(ruleset);
  const preview = structuredClone(state) as SimState;
  coerceSoa(preview); // the clone gets the same totality guarantees as a real step()
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
// Ruleset bundle (M1 Story 5): compilation, the content digest, and the boundary guard.
export {
  compileRuleset,
  rulesetDigest,
  assertRuleset,
  RulesetError,
  MAX_MATCH_TICKS,
  type CompiledRuleset,
  type ScheduledSpawn,
} from './ruleset';
