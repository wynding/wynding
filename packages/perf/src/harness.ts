// harness.ts — drives the sim directly, tick by tick, timing each `step()` call (PLAN
// step 19). Deliberately NOT `@wynding/replay`'s `validate()`: that function is total
// in its result (ok/reason/score) but gives no per-tick instrumentation — no wall-clock,
// no due-blast count, no live-creep count, nothing this package's oracle (`oracle.ts`)
// or gate (`gate.ts`) needs. What IS reused from the replay path is the committed
// replay's `tickInputs` — the harness's only input source — so the measured run applies
// the exact same command log the real replay validator would, not a bespoke drive.
//
// `performance.now()` is legal in this file. `packages/perf/src/**` is deliberately
// OUTSIDE `eslint.config.mjs`'s determinism-boundary guard (which covers
// `engine`/`sim`/`replay`/`content` — the replay-verified core) — this package measures
// wall-clock on purpose and ships nowhere, so a later reader should not "fix" this file
// to route through the seeded `Rng` or otherwise remove `performance.now()`.

import {
  compileRuleset,
  createInitialState,
  step,
  countValidTowers,
  hashSimState,
  type CompiledRuleset,
  type SimPhase,
  type SimState,
  type StepEvents,
} from '@wynding/sim';
import type { Replay } from '@wynding/replay';
import type { Ruleset } from '@wynding/types';

// ADR 0005's measurement methodology, pinned here as named, exported constants —
// PLAN step 19, "it warms up, runs sustained".
/** Ticks 0..199 — the 50 build ticks (each carrying THREE `placeTower` inputs
 *  (`scenario.ts`'s `PLACEMENTS_PER_TICK`), each one triggering a grid-wide Dijkstra
 *  rebuild of the effective distance field) plus the rest of the 100-tick
 *  countdown and the wave's opening. Recorded (so a caller CAN inspect them) but
 *  excluded from every statistic the oracle/gate compute — the build/opening window
 *  is not representative of the sustained workload ADR 0005 budgets. */
export const WARMUP_TICKS = 200;
/** The sustained sampling window: ticks 200..2699 (2,500 ticks), the ticks every
 *  statistic in `oracle.ts`/`gate.ts` is computed over. */
export const SAMPLE_TICKS = 2_500;

/** One sampled tick's raw measurement — everything the oracle and gate need, and
 *  nothing derived (percentiles, subsetting, and pass/fail all happen downstream, in
 *  `stats.ts`/`oracle.ts`/`gate.ts`, so this stays a plain measurement record). */
export interface SampledTick {
  readonly tick: number;
  /** Wall-clock around `step()` ONLY — see `runSampled`'s loop body for why the fresh
   *  `StepEvents` collector is allocated OUTSIDE the timed region. */
  readonly ms: number;
  /** Count of `events.impactPoints` entries with `radiusFp > 0` this tick — a
   *  `targeted` impact (spark) reports `radiusFp === 0` (see `StepEvents`'s doc in
   *  `@wynding/sim`), so this counts blast impacts only, which is the workload the
   *  gate's due-blast subset (`gate.ts`) isolates. */
  readonly dueBlasts: number;
  /** `state.creeps.id.length` after this tick's `step()` — the live creep count. */
  readonly liveCreeps: number;
  /** Count of creeps with `slowMulFp !== 0` — an ACTIVE slow status, ADR 0005's
   *  "status effects live, per the active mix" requirement made countable. */
  readonly slowedCreeps: number;
  readonly phase: SimPhase;
  /** `StepEvents.dotTicks` read back for this tick — count of DoT ticks actually
   *  APPLIED this step (M2-S5b P10). Sourced from the UNTIMED pass's collector
   *  (see `runSampled` below): the timed pass's collector deliberately omits
   *  `dotTicks`, so this field is never available from the region whose wall-clock
   *  feeds the gate. */
  readonly dotTicks: number;
  /** `StepEvents.dotDropped` read back for this tick — count of DoT applications
   *  dropped this step for want of table capacity (`combat.ts`'s `applyDot`,
   *  `MAX_DOT_RECORDS`). Sourced from the TIMED pass's collector: production's real
   *  controller does supply `dotDropped` (unlike `dotTicks`), so carrying it there
   *  costs nothing beyond what a real run already pays. */
  readonly dotDropped: number;
  /** `state.dots.length` taken POST-`step()` — the count of resident DoT records
   *  this tick. Deliberately NOT sampled pre-step: a pre-step count would include
   *  records that are merely DUE, not ticks that actually happened (a creep can be
   *  killed by an impact earlier in the same combat phase), which overstates in
   *  exactly the way an oracle floor exists to catch. */
  readonly dotRecords: number;
  /** Distinct `targetId`s across `state.dots` POST-`step()`, counted in one pass
   *  (a `Set`) — the number of creeps CARRYING at least one DoT record this tick,
   *  as opposed to `dotRecords`, which counts the records themselves and can
   *  exceed it (several sources' records stacked on the same creep). */
  readonly dotCarriers: number;
  /** Count of live creeps whose CATALOG armor (`CompiledRuleset.creepById`) is
   *  nonzero, taken POST-`step()`. Resolved against an id -> armor lookup built
   *  ONCE outside the tick loop (see `runSampled`'s `armorByCreepId`), not
   *  re-derived per creep per tick. */
  readonly armoredLive: number;
}

/** The post-build facts the oracle needs beyond the sampled-tick series (PLAN step
 *  18's "accepted tower placements" and "leftover bounty" assertions) — snapshotted
 *  right after the replay's build-tick prefix resolves, before any creep spawns. */
export interface RunSampledResult {
  /** Every warm-up tick's measurement (ticks 0..`WARMUP_TICKS`-1), recorded for
   *  inspection but never fed into a statistic. */
  readonly warmup: readonly SampledTick[];
  /** The sustained sampling window's measurements — ticks `WARMUP_TICKS`..
   *  `WARMUP_TICKS + SAMPLE_TICKS - 1`. This is the array the oracle and gate read. */
  readonly samples: readonly SampledTick[];
  /** Valid tower rows immediately after the replay's build-tick prefix
   *  (`replay.tickInputs.length` ticks) resolves — PLAN step 18's "accepted tower
   *  placements" assertion reads this. */
  readonly towersPlacedAfterBuild: number;
  /** `state.bounty` at that same snapshot point — PLAN step 18's independent
   *  second oracle on placement acceptance (see `layout.ts`'s `towerIdAt` doc: 150
   *  placements × cost 12 exactly matches `startingBounty`, so any non-zero leftover
   *  means at least one placement was silently rejected). */
  readonly leftoverBountyAfterBuild: number;
  /** `StepEvents.dotDropped`, summed across EVERY tick of the run — warm-up AND
   *  sampled (M2-S5b P10). DoT activity begins inside `WARMUP_TICKS`, so a total
   *  computed only over `samples` would be blind to a drop during warm-up, which
   *  is the one thing this counter exists to make impossible. This is the field
   *  `oracle.ts`'s "dropped DoT applications" assertion gates — not any per-tick
   *  `SampledTick.dotDropped` value. */
  readonly dotDroppedTotal: number;
}

/**
 * Runs `replay.tickInputs` against `bundle` for `WARMUP_TICKS + SAMPLE_TICKS` ticks,
 * UNCONDITIONALLY — never stopping early at a terminal phase. This is the entire
 * point of the un-short-circuited loop: `step()` itself freezes on terminal
 * (`@wynding/sim`'s `index.ts`: `if (isTerminalPhase(state.phase)) return state`), so
 * a scenario that reaches `won`/`lost` inside the sampling window would otherwise have
 * every remaining sampled `step()` measure a trivial early return and report
 * superb-looking percentiles over a sim that had already stopped simulating anything.
 * By stepping the full window regardless, a real early termination leaves non-
 * `running` samples in `samples` for `oracle.ts`'s `phase === 'running'` assertion to
 * catch, rather than hiding it.
 *
 * `tickInputs` past the replay's own length are treated as empty — both committed
 * replays are shorter than `WARMUP_TICKS + SAMPLE_TICKS`, so almost the entire run
 * plays no further commands, exactly like the real replay path treats a log shorter
 * than the ticks it re-simulates.
 *
 * TWO PASSES over the same replay and bundle (M2-S5b P10), unconditionally — no
 * condition, no judgement call on whether instrumentation overhead is "big enough" to
 * bother splitting. The extra pass costs ~2.3s and deletes the whole question:
 *   - The TIMED pass feeds the gate and carries the MINIMAL gate collector:
 *     `impactPoints` (due-blast identification), `fired: []` (REQUIRED on
 *     `StepEvents` — no `?` — so a `{ impactPoints, dotDropped }` literal would not
 *     compile), and `dotDropped` (which production DOES supply). `dotTicks` is
 *     OMITTED, and that is the entire point: `combat.ts` only pays the
 *     `events.dotTicks++` cost when the field is present, so leaving it out of this
 *     pass's collector keeps that cost out of the wall-clock the gate reads. This is
 *     deliberately NOT called "production-shaped" — the gate needs `impactPoints`,
 *     which the production controller never supplies either, so that label would be
 *     false.
 *   - The UNTIMED pass re-runs the identical replay and collects every remaining
 *     oracle field — `dotTicks`, `dotRecords`, `dotCarriers`, `armoredLive` (plus a
 *     second `dotDropped`, carried so its total can be cross-checked against the
 *     timed pass's — see below). Its wall-clock is NEVER read.
 *   - Both passes traverse the same replay against the same bundle, so their sim
 *     state is byte-identical BY CONSTRUCTION — asserted here with a STATE-DERIVED
 *     comparison (the final world hash, `hashSimState`, plus terminal tick and
 *     phase), NOT `dotDropped`: that counter reads 0 in both passes on a healthy run,
 *     so it would agree even while the states had diverged. The two passes' summed
 *     `dotDropped` are compared too, but as an event result in its own right, never
 *     as the equality proof.
 */
export function runSampled(replay: Replay, bundle: Ruleset): RunSampledResult {
  const ruleset: CompiledRuleset = compileRuleset(bundle, replay.boardId);
  const totalTicks = WARMUP_TICKS + SAMPLE_TICKS;

  // id -> catalog armor, resolved ONCE here (`armoredLive`'s doc on `SampledTick`) —
  // not re-derived per creep per tick inside the untimed pass's loop below.
  const armorByCreepId = new Map<string, number>();
  for (const [id, creep] of Object.entries(ruleset.creepById)) {
    if (creep !== undefined) armorByCreepId.set(id, creep.armor);
  }

  // --- Pass 1: TIMED, minimal gate collector (dotTicks omitted). --------------
  let timedState: SimState = createInitialState(replay.seed, ruleset);
  const timedRecords: {
    tick: number;
    ms: number;
    dueBlasts: number;
    liveCreeps: number;
    slowedCreeps: number;
    phase: SimPhase;
    dotDropped: number;
  }[] = [];
  let towersPlacedAfterBuild = 0;
  // -1, NOT 0 (QC round 1). `LEFTOVER_BOUNTY_THRESHOLD` is 0 — the maze consumes the
  // bundle's entire starting bounty — so initialising this to 0 made the snapshot's own
  // ABSENCE indistinguishable from its success: a replay whose `tickInputs` never reach
  // the snapshot tick reported "leftover bounty: PASS" having never measured anything.
  // Verified: an empty-`tickInputs` replay failed the tower-count assertion (correctly)
  // while passing the bounty one. A sentinel no real bounty can take fails closed.
  let leftoverBountyAfterBuild = -1;
  let timedDotDroppedTotal = 0;

  for (let tick = 0; tick < totalTicks; tick++) {
    const inputs = replay.tickInputs[tick] ?? [];
    // Allocated OUTSIDE the timed region (below): `StepEvents`'s arrays/counters are
    // per-tick presentational out-params (`@wynding/sim`'s combat.ts), unrelated to
    // `step()`'s own cost — timing their allocation would measure this harness's
    // bookkeeping, not the workload ADR 0005 budgets.
    const events: StepEvents = { impactPoints: [], fired: [], dotDropped: 0 };
    const start = performance.now();
    timedState = step(timedState, ruleset, inputs, events);
    const ms = performance.now() - start;

    if (tick === replay.tickInputs.length - 1) {
      towersPlacedAfterBuild = countValidTowers(
        ruleset.board.grid,
        timedState.towers,
        ruleset.towerById,
      );
      leftoverBountyAfterBuild = timedState.bounty;
    }

    let dueBlasts = 0;
    for (const point of events.impactPoints) {
      if (point.radiusFp > 0) dueBlasts++;
    }
    let slowedCreeps = 0;
    for (const mul of timedState.creeps.slowMulFp) {
      if (mul !== 0) slowedCreeps++;
    }
    const dotDropped = events.dotDropped ?? 0;
    timedDotDroppedTotal += dotDropped;
    timedRecords.push({
      tick,
      ms,
      dueBlasts,
      liveCreeps: timedState.creeps.id.length,
      slowedCreeps,
      phase: timedState.phase,
      dotDropped,
    });
  }

  // --- Pass 2: UNTIMED, full DoT/armor collector. Wall-clock never read. ------
  let untimedState: SimState = createInitialState(replay.seed, ruleset);
  const untimedRecords: {
    dotTicks: number;
    dotDropped: number;
    dotRecords: number;
    dotCarriers: number;
    armoredLive: number;
  }[] = [];
  let untimedDotDroppedTotal = 0;

  for (let tick = 0; tick < totalTicks; tick++) {
    const inputs = replay.tickInputs[tick] ?? [];
    const events: StepEvents = { impactPoints: [], fired: [], dotTicks: 0, dotDropped: 0 };
    untimedState = step(untimedState, ruleset, inputs, events);

    const dotTicks = events.dotTicks ?? 0;
    const dotDropped = events.dotDropped ?? 0;
    untimedDotDroppedTotal += dotDropped;

    // `state.dots.length` taken POST-step — see `dotRecords`'s doc on `SampledTick`
    // for why a pre-step count would overstate.
    const dotRecords = untimedState.dots.length;
    // Distinct `targetId`s, one pass over `state.dots`.
    const carrierIds = new Set<number>();
    for (const dot of untimedState.dots) carrierIds.add(dot.targetId);
    const dotCarriers = carrierIds.size;

    let armoredLive = 0;
    for (const creepId of untimedState.creeps.creepId) {
      if ((armorByCreepId.get(creepId) ?? 0) !== 0) armoredLive++;
    }

    untimedRecords.push({ dotTicks, dotDropped, dotRecords, dotCarriers, armoredLive });
  }

  // --- Both passes traversed identical sim state: assert it, state-derived. ---
  const timedHash = hashSimState(timedState);
  const untimedHash = hashSimState(untimedState);
  if (
    timedHash !== untimedHash ||
    timedState.tick !== untimedState.tick ||
    timedState.phase !== untimedState.phase
  ) {
    throw new Error(
      `runSampled: the timed and untimed passes diverged — ` +
        `timed{hash=${timedHash}, tick=${timedState.tick}, phase=${timedState.phase}} vs ` +
        `untimed{hash=${untimedHash}, tick=${untimedState.tick}, phase=${untimedState.phase}}. ` +
        `Both passes run the identical replay against the identical bundle, so this can only ` +
        `mean the two collectors' differing shape changed sim behaviour — a StepEvents ` +
        `contract violation, not a measurement artifact.`,
    );
  }
  // Compared as an event result in its own right, NOT as the equality proof above —
  // `dotDropped` reads 0 in both passes on a healthy run and would agree even if the
  // states had diverged (this function's doc comment).
  if (timedDotDroppedTotal !== untimedDotDroppedTotal) {
    throw new Error(
      `runSampled: the timed pass's dotDropped total (${timedDotDroppedTotal}) does not match ` +
        `the untimed pass's (${untimedDotDroppedTotal}) despite identical final sim state.`,
    );
  }

  // --- Merge, index-aligned: both loops ran the identical `totalTicks` ticks. -
  const warmup: SampledTick[] = [];
  const samples: SampledTick[] = [];
  for (let tick = 0; tick < totalTicks; tick++) {
    const t = timedRecords[tick]!;
    const u = untimedRecords[tick]!;
    const record: SampledTick = {
      tick: t.tick,
      ms: t.ms,
      dueBlasts: t.dueBlasts,
      liveCreeps: t.liveCreeps,
      slowedCreeps: t.slowedCreeps,
      phase: t.phase,
      dotTicks: u.dotTicks,
      dotDropped: t.dotDropped,
      dotRecords: u.dotRecords,
      dotCarriers: u.dotCarriers,
      armoredLive: u.armoredLive,
    };
    if (tick < WARMUP_TICKS) {
      warmup.push(record);
    } else {
      samples.push(record);
    }
  }

  return {
    warmup,
    samples,
    towersPlacedAfterBuild,
    leftoverBountyAfterBuild,
    dotDroppedTotal: timedDotDroppedTotal,
  };
}
