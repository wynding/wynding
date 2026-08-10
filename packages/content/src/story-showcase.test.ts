// story-showcase.test.ts — M2 Story 11 P4: the balance pass's centre.
//
// Two WINNING builds, structurally distinct by construction, plus one selected LOSING
// build, all three run as pinned input scripts against the REAL shipped `wynding-core`
// bundle (`compileRuleset` -> `createInitialState` -> `step`) — never a hand-assembled
// replica. Same LOCATION reasoning as `story-finale.test.ts`'s own header: this file
// lives beside `parity.test.ts` because `packages/sim` cannot import `@wynding/content`.
//
// WHAT THIS FILE CLAIMS (S11 ruling 3, the four measurable balance criteria):
//   - both winners reach wave 10 and KILL the boss (phase 'won');
//   - STRUCTURAL DIVERSITY — no tower id appears in both winners' top-two spend, and
//     each winner's own top-two ids each account for >= 25% of that winner's spend;
//   - MATERIALITY on each used tower id's PRE-MAPPED channel (fixed by id below,
//     never by inspecting what the tower does);
//   - a >= 9-lives winner exists — asserted from a real run, BEFORE any star threshold
//     is read, because lowering 3* is the owner's re-ruling and never a tuning move;
//   - one losing build that engages the arc rather than declining to play.
//
// Every numeric literal asserted below is MEASURED and `console.log`'d on every run —
// regenerate with:
//   pnpm --filter @wynding/content exec vitest run story-showcase
//
// NO BARE TICK LITERALS, NO WAVE INDICES. The build scripts are wave-relative in the
// only way that matters to a player: each places its next tower the first tick the
// treasury can afford it, in authored order. That is a total function of the run's own
// economy, so it needs neither a tick anchor nor a wave index (ruling 1) — and it is
// what makes these scripts survive a schedule edit rather than silently sliding off it.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  step,
  deriveScore,
  deriveStars,
  MAX_MATCH_TICKS,
  type SimInput,
  type SimState,
  type CompiledRuleset,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { waveIndexForCreep } from './wave-lookup';
import { WINNER_A, type Placement } from './showcase-builds';

const SCENARIO_SEED = 0x5eed;

/** The CONTRIBUTION CHANNEL each catalog tower id is judged on — fixed per id (ruling
 *  3), so a tower that both damages and applies status (`slow` deals 2, `stun` deals 4)
 *  is judged on exactly one channel, by id, never by inspection of its effect list. */
const CHANNEL: Readonly<Record<string, 'damage' | 'status' | 'support'>> = {
  basic: 'damage',
  splash: 'damage',
  venom: 'damage',
  antiair: 'damage',
  mine: 'damage',
  'frost-splash': 'damage',
  slow: 'status',
  stun: 'status',
  beacon: 'support',
};

/** The proposed floors (ruling 3). Named rather than inlined so a failure names the
 *  criterion it broke, and so the owner's numbers sit in one place. */
const DAMAGE_SHARE_FLOOR = 0.15; // per damage-channel id, of the BUILD's total damage
const STATUS_APPLICATION_FLOOR = 100; // per status-channel id, successful applications
const SUPPORT_SHARE_FLOOR = 0.1; // beacon's support-ADDED damage, of the build's total
const TOP_TWO_SPEND_SHARE_FLOOR = 0.25; // each of a build's own top-two ids, of its spend
const THREE_STAR_LIVES_FLOOR = 9; // ruling 3: at least one winner finishes on >= 9 lives

interface BuildResult {
  readonly state: SimState;
  readonly ruleset: CompiledRuleset;
  /** Placements ACCEPTED by the sim, in script order — a rejected placement never
   *  advances the cursor, so this is the build that actually stood on the board. */
  readonly placedCount: number;
  readonly spendById: Readonly<Record<string, number>>;
  /** Source-attributed, armor-adjusted HP ACTUALLY REMOVED, per tower id (overkill
   *  excluded; DoT ticks attributed to their source tower). */
  readonly damageById: Readonly<Record<string, number>>;
  readonly totalDamage: number;
  /** Successful status APPLICATIONS per status tower id — landings, not attempts. */
  readonly statusById: Readonly<Record<string, number>>;
  /** Sigma over every buffed hit of [HP removed] - [HP the unbuffed amount would have
   *  removed, armor-adjusted, capped at the target's pre-impact HP]. */
  readonly supportAdded: number;
  readonly kills: number;
  readonly leaksByWave: readonly number[];
  readonly bossKilled: boolean;
  readonly sawFullHpBoss: boolean;
  /** The attribution harness's own SELF-CHECK — see `runBuild`'s header. */
  readonly attributionExact: boolean;
}

/**
 * Run one build script and attribute every point of damage to the tower that dealt it.
 *
 * THE MEASUREMENT, and why it is exact rather than estimated. "Damage" means
 * source-attributed, armor-adjusted HP ACTUALLY REMOVED — a 10-damage hit on a creep
 * with 5 hp left counts 5, not 10. That cannot be read off any single field, so this
 * REPLAYS each tick's damage resolution from OBSERVABLE state and then CHECKS the
 * replay against what the sim actually did:
 *
 *   1. Before each `step`, snapshot every creep's hp, and collect the impacts and DoT
 *      records DUE this tick. Combat runs at the PRE-increment tick (`index.ts` step 5;
 *      `state.tick += 1` is the last thing a step does), so "due" is `impactTick <=
 *      state.tick` / `nextTickTick <= state.tick <= untilTick` read BEFORE the step.
 *   2. Apply them in the sim's own order — impacts in queue order (`runCombat` step 1),
 *      then DoT ticks (step 2) — each capped at the target's remaining hp, each direct
 *      effect reduced by the target's armor, each DoT tick bypassing armor entirely
 *      (`combat.ts`'s deliberate literal `0` armor argument on the DoT path).
 *   3. CHECK: every surviving creep's replayed hp must equal its observed hp, and the
 *      replayed kill bounty must equal the observed `cumulativeKillBounty` delta. A
 *      single disagreement anywhere in the run sets `attributionExact` false, and every
 *      test below asserts it — so these shares can never quietly become estimates.
 *
 * The confound the plan warns about (several sources landing on one creep on one tick)
 * is handled by the ordering in (2) plus the cap: the same discipline
 * `story-finale.test.ts`'s `otherDotDamageAt` uses to isolate one source's contribution,
 * generalized from the boss to every creep. BLAST impacts are deliberately NOT modelled
 * — neither showcase build places an `aoe` or `burst` tower, and a blast reaching this
 * harness flips `attributionExact` false rather than being silently approximated.
 */
function runBuild(plan: readonly Placement[]): BuildResult {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
  let cursor = 0;

  // The UNBUFFED authored amount per tower id, read off the compiled catalog — the
  // baseline the beacon's support-added damage is measured against. A fire-time
  // snapshot carries the BUFFED amount (`combat.ts`'s `snapshotEffects`), so the
  // unbuffed counterfactual has to come from the catalog, never from the impact.
  const baseDirect: Record<string, number> = {};
  const baseDot: Record<string, number> = {};
  for (const tower of Object.values(ruleset.towerById)) {
    if (!tower) continue;
    for (const e of tower.effects) {
      if (e.kind === 'direct' || e.kind === 'aoe') baseDirect[tower.id] = e.amount;
      if (e.kind === 'dot') baseDot[tower.id] = e.amount;
    }
  }

  const towerKindById = new Map<number, string>();
  const spendById: Record<string, number> = {};
  const damageById: Record<string, number> = {};
  const statusById: Record<string, number> = {};
  const leaksByWave = new Array<number>(ruleset.waves.length).fill(0);
  let supportAdded = 0;
  let kills = 0;
  let bossKilled = false;
  let sawFullHpBoss = false;
  let attributionExact = true;
  const bossHp = ruleset.creepById['boss']?.hp;

  for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
    const inputs: SimInput[] = [];
    if (cursor < plan.length) {
      const next = plan[cursor]!;
      const cost = ruleset.towerById[next.towerId]?.cost;
      if (cost === undefined)
        throw new Error(`unknown towerId '${next.towerId}' in a build script`);
      if (state.bounty >= cost) {
        inputs.push({
          kind: 'placeTower',
          anchor: { col: next.col, row: next.row },
          towerId: next.towerId,
        });
      }
    }
    const towersBefore = state.towers.id.length;

    const preHp = new Map<number, number>();
    const preKind = new Map<number, string>();
    const preWave = new Map<number, number>();
    const preSlowUntil = new Map<number, number>();
    const preStunUntil = new Map<number, number>();
    for (let i = 0; i < state.creeps.id.length; i++) {
      const id = state.creeps.id[i]!;
      preHp.set(id, state.creeps.hp[i]!);
      preKind.set(id, state.creeps.creepId[i]!);
      preWave.set(id, state.creeps.wave[i]!);
      preSlowUntil.set(id, state.creeps.slowUntilTick[i]!);
      preStunUntil.set(id, state.creeps.stunUntilTick[i]!);
    }
    const tickNow = state.tick;
    const dueImpacts = state.impacts.filter((im) => im.impactTick <= tickNow);
    const dueDots = state.dots.filter((d) => d.nextTickTick <= tickNow && d.untilTick >= tickNow);
    const preKillBounty = state.cumulativeKillBounty;

    state = step(state, ruleset, inputs);

    if (state.towers.id.length > towersBefore && cursor < plan.length) {
      const placed = plan[cursor]!;
      spendById[placed.towerId] =
        (spendById[placed.towerId] ?? 0) + (ruleset.towerById[placed.towerId]?.cost ?? 0);
      cursor++;
    }
    for (let r = 0; r < state.towers.id.length; r++) {
      towerKindById.set(state.towers.id[r]!, state.towers.towerId[r]!);
    }

    // --- replay this tick's damage resolution (see the header) ---------------------
    const remaining = new Map<number, number>(preHp);
    const hits: { creep: number; source: number; amount: number; added: number }[] = [];
    for (const im of dueImpacts) {
      if (im.kind !== 'targeted') {
        attributionExact = false; // a blast impact: not modelled, never approximated
        continue;
      }
      const preImpactHp = remaining.get(im.targetId);
      if (preImpactHp === undefined || preImpactHp <= 0) continue; // wasted shot
      const def = ruleset.creepById[preKind.get(im.targetId)!];
      const armor = def?.armor ?? 0;
      const kind = towerKindById.get(im.sourceId);
      let left = preImpactHp;
      for (const e of im.effects) {
        if (e.kind !== 'direct') continue;
        const actual = Math.min(left, Math.max(0, e.amount - armor));
        const base = kind === undefined ? undefined : baseDirect[kind];
        // The unbuffed counterfactual is capped at the target's PRE-IMPACT hp, per the
        // plan's own definition of support-added damage.
        const unbuffed =
          base !== undefined && e.amount > base
            ? Math.min(preImpactHp, Math.max(0, base - armor))
            : actual;
        left -= actual;
        hits.push({
          creep: im.targetId,
          source: im.sourceId,
          amount: actual,
          added: actual - unbuffed,
        });
      }
      remaining.set(im.targetId, left);
    }
    for (const d of dueDots) {
      const preTickHp = remaining.get(d.targetId);
      if (preTickHp === undefined || preTickHp <= 0) continue; // a corpse does not tick
      const actual = Math.min(preTickHp, d.amount); // DoT bypasses armor entirely
      const kind = towerKindById.get(d.sourceId);
      const base = kind === undefined ? undefined : baseDot[kind];
      const unbuffed = base !== undefined && d.amount > base ? Math.min(preTickHp, base) : actual;
      remaining.set(d.targetId, preTickHp - actual);
      hits.push({
        creep: d.targetId,
        source: d.sourceId,
        amount: actual,
        added: actual - unbuffed,
      });
    }

    // --- reconcile the replay against what the sim actually did --------------------
    const postHp = new Map<number, number>();
    for (let i = 0; i < state.creeps.id.length; i++)
      postHp.set(state.creeps.id[i]!, state.creeps.hp[i]!);
    let replayedKillBounty = 0;
    const leakedIds = new Set<number>();
    for (const [id, hpBefore] of preHp) {
      const observed = postHp.get(id);
      const replayed = remaining.get(id)!;
      if (observed === undefined) {
        if (replayed <= 0) {
          // killed this tick — credit its own bounty, exactly as the sweep does
          replayedKillBounty += ruleset.creepById[preKind.get(id)!]?.bounty ?? 0;
          kills++;
          if (preKind.get(id) === 'boss') bossKilled = true;
        } else {
          // gone with hp to spare: a LEAK, which happens in movement BEFORE combat, so
          // this tick's shots at it were wasted and attribute nothing.
          leakedIds.add(id);
          leaksByWave[preWave.get(id)!]!++;
        }
      } else if (observed !== replayed) {
        attributionExact = false;
      }
      void hpBefore;
    }
    if (replayedKillBounty !== state.cumulativeKillBounty - preKillBounty) attributionExact = false;

    for (const hit of hits) {
      if (leakedIds.has(hit.creep)) continue;
      const kind = towerKindById.get(hit.source);
      if (kind === undefined) continue;
      damageById[kind] = (damageById[kind] ?? 0) + hit.amount;
      supportAdded += hit.added;
    }

    // --- successful status APPLICATIONS, observed on the real SoA status columns ----
    // A landing is a creep whose `slowUntilTick`/`stunUntilTick` MOVED FORWARD this
    // tick: `applySlow` writes the pair only when the incoming slow is at least as
    // strong, and `applyStun` only when the roll came up, so a forward move IS a
    // successful application. Conservative by construction — two same-kind landings on
    // one creep on one tick collapse into a single observation — which is the safe
    // direction against an absolute floor.
    for (let i = 0; i < state.creeps.id.length; i++) {
      const id = state.creeps.id[i]!;
      if (state.creeps.slowUntilTick[i]! > (preSlowUntil.get(id) ?? 0)) {
        statusById['slow'] = (statusById['slow'] ?? 0) + 1;
      }
      if (state.creeps.stunUntilTick[i]! > (preStunUntil.get(id) ?? 0)) {
        statusById['stun'] = (statusById['stun'] ?? 0) + 1;
      }
      if (state.creeps.creepId[i] === 'boss' && state.creeps.hp[i] === bossHp) sawFullHpBoss = true;
    }
  }

  let totalDamage = 0;
  for (const v of Object.values(damageById)) totalDamage += v;

  return {
    state,
    ruleset,
    placedCount: cursor,
    spendById,
    damageById,
    totalDamage,
    statusById,
    supportAdded,
    kills,
    leaksByWave,
    bossKilled,
    sawFullHpBoss,
    attributionExact,
  };
}

/** The build's tower ids ordered by total gold spent on that id, descending; ties break
 *  on the id so the ordering is total and reproducible rather than insertion-ordered. */
function idsBySpend(spendById: Readonly<Record<string, number>>): string[] {
  return Object.keys(spendById).sort((a, b) => spendById[b]! - spendById[a]! || a.localeCompare(b));
}

function totalSpend(spendById: Readonly<Record<string, number>>): number {
  return Object.values(spendById).reduce((sum, v) => sum + v, 0);
}

function report(label: string, r: BuildResult): void {
  const spend = totalSpend(r.spendById);
  const order = idsBySpend(r.spendById);
  console.log(
    `[story-showcase ${label}] phase=${r.state.phase} tick=${r.state.tick} lives=${r.state.lives} ` +
      `score=${deriveScore(r.state, r.ruleset)} stars=${deriveStars(r.state, r.ruleset)} ` +
      `kills=${r.kills} placed=${r.placedCount} spend=${spend} ${JSON.stringify(r.spendById)} ` +
      `spendShares=${JSON.stringify(order.map((id) => [id, (r.spendById[id]! / spend).toFixed(3)]))} ` +
      `damage=${JSON.stringify(r.damageById)} totalDamage=${r.totalDamage} ` +
      `damageShares=${JSON.stringify(
        Object.keys(r.damageById).map((id) => [id, (r.damageById[id]! / r.totalDamage).toFixed(3)]),
      )} ` +
      `status=${JSON.stringify(r.statusById)} supportAdded=${r.supportAdded} ` +
      `supportShare=${(r.supportAdded / r.totalDamage).toFixed(3)} ` +
      `leaksByWave=${JSON.stringify(r.leaksByWave)} bossKilled=${r.bossKilled} ` +
      `attributionExact=${r.attributionExact}`,
  );
}

/** Assert every floor ruling 3 puts on ONE build, from that build's own measured run. */
function assertChannelFloors(r: BuildResult): void {
  for (const id of Object.keys(r.spendById)) {
    const channel = CHANNEL[id];
    expect(channel, `tower id '${id}' has no pre-mapped channel`).toBeDefined();
    if (channel === 'damage') {
      expect(
        (r.damageById[id] ?? 0) / r.totalDamage,
        `damage-channel id '${id}' below the materiality floor`,
      ).toBeGreaterThanOrEqual(DAMAGE_SHARE_FLOOR);
    } else if (channel === 'status') {
      expect(
        r.statusById[id] ?? 0,
        `status-channel id '${id}' below the application floor`,
      ).toBeGreaterThanOrEqual(STATUS_APPLICATION_FLOOR);
    } else {
      expect(
        r.supportAdded / r.totalDamage,
        `support id '${id}' below the support-added floor`,
      ).toBeGreaterThanOrEqual(SUPPORT_SHARE_FLOOR);
    }
  }
}

// ---------------------------------------------------------------------------------
// THE BUILDS. Both winners share one shape — a lattice of 2x2 footprints on even
// columns that turns the open 28x24 board into a single long corridor — and differ in
// what stands on it, which is what makes them structurally distinct BY CONSTRUCTION
// rather than by a coincidence the floors happen to certify.
//
// WINNER A — "the poisoner" — lives in `./showcase-builds.ts` (M2-S11 P5): the same
// script is reused, unduplicated, by `m2-golden.test.ts`'s close-out determinism
// golden, so both files place the same towers on the same cells in the same order.
// ---------------------------------------------------------------------------------
// WINNER B — "the control lattice". No `venom` at all: the boss dies to beacon-buffed
// `basic` (10 x 1.5 = 15 nominal, 15 - 8 = 7 net — the armor-piercing route
// `story-finale.test.ts` pins), and it only gets there because `slow` doubles how long
// everything spends inside the wall.
//
// THE ROW-15 SLOW BAND IS GEOMETRY, NOT DECORATION. `slow` is a BOTH-domain tower, so
// a slow tower near the row-11 flight line would chip air creeps and eat into
// `antiair`'s own damage share. A tower anchored at row 15 fires from y = 16 x 256 =
// 4096 fp; the air line sits at y = 11 x 256 + 128 = 2944 fp, a gap of 1152 fp against
// `slow`'s 1024 fp range — so it is arithmetically incapable of touching a flyer, while
// still covering the row-14 ground corridor 384 fp away. That is what keeps `antiair`
// the sole source of air damage in this build, and it is asserted below rather than
// asserted about.
// ---------------------------------------------------------------------------------
const WINNER_B: readonly Placement[] = [
  { col: 2, row: 10, towerId: 'basic' },
  { col: 4, row: 10, towerId: 'basic' },
  { col: 6, row: 10, towerId: 'basic' },
  { col: 8, row: 10, towerId: 'basic' },
  { col: 2, row: 12, towerId: 'beacon' },
  { col: 10, row: 10, towerId: 'basic' },
  { col: 12, row: 10, towerId: 'basic' },
  { col: 6, row: 12, towerId: 'beacon' },
  { col: 14, row: 10, towerId: 'basic' },
  { col: 16, row: 10, towerId: 'basic' },
  { col: 2, row: 8, towerId: 'antiair' },
  { col: 6, row: 8, towerId: 'antiair' },
  { col: 10, row: 12, towerId: 'beacon' },
  { col: 18, row: 10, towerId: 'basic' },
  { col: 20, row: 10, towerId: 'basic' },
  { col: 2, row: 15, towerId: 'slow' },
  { col: 4, row: 15, towerId: 'slow' },
  { col: 6, row: 15, towerId: 'slow' },
  { col: 8, row: 15, towerId: 'slow' },
  { col: 10, row: 8, towerId: 'antiair' },
  { col: 14, row: 8, towerId: 'antiair' },
  { col: 14, row: 12, towerId: 'beacon' },
  { col: 22, row: 10, towerId: 'basic' },
  { col: 24, row: 10, towerId: 'basic' },
  { col: 10, row: 15, towerId: 'slow' },
  { col: 12, row: 15, towerId: 'slow' },
  { col: 14, row: 15, towerId: 'slow' },
  { col: 16, row: 15, towerId: 'slow' },
  { col: 18, row: 8, towerId: 'antiair' },
  { col: 22, row: 8, towerId: 'antiair' },
  { col: 18, row: 12, towerId: 'beacon' },
  { col: 22, row: 12, towerId: 'beacon' },
  { col: 4, row: 12, towerId: 'basic' },
  { col: 8, row: 12, towerId: 'basic' },
  { col: 12, row: 12, towerId: 'basic' },
  { col: 20, row: 12, towerId: 'basic' },
  { col: 18, row: 15, towerId: 'slow' },
  { col: 20, row: 15, towerId: 'slow' },
  { col: 22, row: 15, towerId: 'slow' },
  { col: 24, row: 15, towerId: 'slow' },
];

// ---------------------------------------------------------------------------------
// THE LOSER — authored AFTER the last tuning change, per ruling 3, so it is measured
// against the FINAL numbers rather than an earlier draft of them. It is a build that
// ENGAGES the arc and loses: a real ground wall (`basic` + `venom`) with `slow` for
// control and no answer whatsoever to the `air` domain, which is what eventually kills
// it — not a build that declines to play.
// ---------------------------------------------------------------------------------
const LOSER: readonly Placement[] = [
  { col: 2, row: 10, towerId: 'basic' },
  { col: 2, row: 12, towerId: 'basic' },
  { col: 6, row: 10, towerId: 'basic' },
  { col: 6, row: 12, towerId: 'basic' },
  { col: 10, row: 10, towerId: 'basic' },
  { col: 10, row: 12, towerId: 'basic' },
  { col: 14, row: 10, towerId: 'venom' },
  { col: 14, row: 12, towerId: 'venom' },
  { col: 18, row: 10, towerId: 'slow' },
  { col: 18, row: 12, towerId: 'slow' },
  { col: 22, row: 10, towerId: 'venom' },
  { col: 22, row: 12, towerId: 'venom' },
];

describe('M2-S11 P4 — the showcase run: two winners, structurally distinct, and one selected loser', () => {
  const a = runBuild(WINNER_A);
  const b = runBuild(WINNER_B);
  report('WINNER A', a);
  report('WINNER B', b);

  it(
    'WINNER A — the poisoner reaches wave 10, kills the boss, and wins the arc outright',
    { timeout: 120_000 },
    () => {
      // PROVE THE FEATURE ENGAGED, before any terminal assertion: the attribution
      // harness's own self-check passed (so every share below is exact, not estimated),
      // a live `boss` was observed at full hp (the finale really launched), and the boss
      // DIED rather than leaked.
      expect(a.attributionExact).toBe(true);
      expect(a.sawFullHpBoss).toBe(true);
      expect(a.bossKilled).toBe(true);
      expect(a.state.waveResolved[waveIndexForCreep(a.ruleset, 'boss')]).toBe(true);

      // THE MEASUREMENT — every literal measured and `console.log`'d by `report` above.
      expect(a.state.phase).toBe('won');
      expect(a.state.lives).toBe(10); // a clean run: not one creep of the ten-wave arc leaks
      expect(a.leaksByWave.every((n) => n === 0)).toBe(true);
      expect(a.state.tick).toBe(4070);
      // Every scheduled creep in the arc died: pinned at the MEASURED 117 and, beside it,
      // DERIVED from the compiled schedule so a wave edit moves what this computes rather
      // than only what it happens to match.
      const scheduled = a.ruleset.waves.reduce((n, w) => n + w.spawns.length, 0);
      expect(a.kills).toBe(117);
      expect(a.kills).toBe(scheduled);
    },
  );

  it(
    'WINNER B — the control lattice reaches wave 10 and kills the boss with no `venom` at all',
    { timeout: 120_000 },
    () => {
      expect(b.attributionExact).toBe(true);
      expect(b.sawFullHpBoss).toBe(true);
      expect(b.bossKilled).toBe(true);
      expect(Object.keys(b.spendById)).not.toContain('venom');

      expect(b.state.phase).toBe('won');
      expect(b.state.lives).toBe(10);
      expect(b.leaksByWave.every((n) => n === 0)).toBe(true);
      expect(b.state.tick).toBe(4062);
      expect(b.kills).toBe(117);
      expect(b.kills).toBe(b.ruleset.waves.reduce((n, w) => n + w.spawns.length, 0));
    },
  );

  it('the two winners are STRUCTURALLY DISTINCT — disjoint top-two spend, each top-two id >= 25% of its own build', () => {
    const topA = idsBySpend(a.spendById).slice(0, 2);
    const topB = idsBySpend(b.spendById).slice(0, 2);
    console.log(
      `[story-showcase] top-two A=${JSON.stringify(topA)} (${topA.map((id) => a.spendById[id]).join('/')} of ${totalSpend(a.spendById)}) ` +
        `top-two B=${JSON.stringify(topB)} (${topB.map((id) => b.spendById[id]).join('/')} of ${totalSpend(b.spendById)})`,
    );
    // Disjoint by id — computed from the runs, never restated.
    expect(topA.filter((id) => topB.includes(id))).toEqual([]);
    for (const [r, top] of [
      [a, topA],
      [b, topB],
    ] as const) {
      const spend = totalSpend(r.spendById);
      for (const id of top) {
        expect(r.spendById[id]! / spend).toBeGreaterThanOrEqual(TOP_TWO_SPEND_SHARE_FLOOR);
      }
    }
  });

  it('every tower id each winner uses clears the materiality floor on its PRE-MAPPED channel', () => {
    expect(a.attributionExact).toBe(true);
    expect(b.attributionExact).toBe(true);
    assertChannelFloors(a);
    assertChannelFloors(b);

    // The same floors, spelled out as measured numbers so a regression names the id
    // that moved rather than only the generic loop above.
    expect(a.damageById['venom']! / a.totalDamage).toBeGreaterThanOrEqual(DAMAGE_SHARE_FLOOR);
    expect(a.damageById['antiair']! / a.totalDamage).toBeGreaterThanOrEqual(DAMAGE_SHARE_FLOOR);
    expect(a.damageById['basic']! / a.totalDamage).toBeGreaterThanOrEqual(DAMAGE_SHARE_FLOOR);
    expect(b.damageById['basic']! / b.totalDamage).toBeGreaterThanOrEqual(DAMAGE_SHARE_FLOOR);
    expect(b.damageById['antiair']! / b.totalDamage).toBeGreaterThanOrEqual(DAMAGE_SHARE_FLOOR);
    expect(b.statusById['slow']!).toBeGreaterThanOrEqual(STATUS_APPLICATION_FLOOR);
    expect(b.supportAdded / b.totalDamage).toBeGreaterThanOrEqual(SUPPORT_SHARE_FLOOR);
  });

  it("WINNER B's row-15 `slow` band is arithmetically out of reach of the flight line — `antiair` is the sole source of air damage", () => {
    // The geometric claim in WINNER B's own header, measured rather than asserted
    // about: `slow` deals 2 direct damage and IS air-capable by domain, so if any slow
    // tower could see the flight line this build's air damage would be split and
    // `antiair`'s share would fall. Measured: it is not split at all.
    const slowRange = b.ruleset.towerById['slow']?.attack?.rangeFp;
    expect(slowRange).toBe(1024);
    const airLineY = 11 * 256 + 128; // entrance and exit both sit on row 11
    for (const p of WINNER_B) {
      if (p.towerId !== 'slow') continue;
      const towerY = (p.row + 1) * 256; // the 2x2 footprint's centre (combat.ts)
      expect(Math.abs(towerY - airLineY)).toBeGreaterThan(slowRange!);
    }
  });

  it('a >= 9-lives winner EXISTS — measured from a real run, before any star threshold is read', () => {
    // ORDER IS LOAD-BEARING (ruling 3): this asserts the arc can be finished on >= 9
    // lives BEFORE reading `starThresholds`, so a failure here is a balance finding for
    // the owner and never an invitation to lower 3*.
    const bestLives = Math.max(a.state.lives, b.state.lives);
    console.log(
      `[story-showcase] best winner lives=${bestLives} (floor ${THREE_STAR_LIVES_FLOOR})`,
    );
    expect(bestLives).toBeGreaterThanOrEqual(THREE_STAR_LIVES_FLOOR);

    // ...and only now: the shipped 3* threshold is still reachable, so it stands
    // unchanged at 9 (P4 tuned neither it nor the 2*/1* thresholds below it — the
    // winners land at 10 and the selected loser at 0, which the shipped 1/6/9 ladder
    // already grades correctly).
    expect(a.ruleset.scoring.starThresholds).toEqual([1, 6, 9]);
    expect(deriveStars(a.state, a.ruleset)).toBe(3);
    expect(deriveStars(b.state, b.ruleset)).toBe(3);
  });

  it(
    'the selected LOSING build engages the arc and loses — spend, ids, kills and depth all above their floors',
    { timeout: 120_000 },
    () => {
      const l = runBuild(LOSER);
      report('LOSER', l);
      expect(l.attributionExact).toBe(true);

      // PROVE IT PLAYED: it reached at least wave 6 (0-indexed 5 — LOCATED by creep id,
      // never a hardcoded index) with a real, diverse build behind it.
      const sixthWaveIndex = waveIndexForCreep(l.ruleset, 'flying'); // arc row 6
      expect(l.state.waveLaunchTick[sixthWaveIndex]).not.toBeNull();
      expect(totalSpend(l.spendById)).toBeGreaterThanOrEqual(60);
      expect(Object.keys(l.spendById).length).toBeGreaterThanOrEqual(3);
      expect(l.kills).toBeGreaterThanOrEqual(40);

      // ...AND LOST.
      expect(l.state.phase).toBe('lost');
      expect(l.state.lives).toBe(0);
      expect(deriveStars(l.state, l.ruleset)).toBe(0);
    },
  );
});
