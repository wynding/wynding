// story-swarm.test.ts — M2 Story 11 P4: the RE-RULED swarm-clear criterion, pinned in
// BOTH directions against the shipped bundle.
//
// THE RULING (S11 ruling 8, dated 2026-08-08). The original criterion — "one `splash`
// clears the swarm wave" — was withdrawn as WRONG, not as unmeetable: satisfying it needs
// a `splash` cadence that also perturbs waves 2, 5 and 9, and a wave 2 that one tower
// clears is a wave that teaches nothing. It is replaced by:
//
//     the swarm wave is CLEARABLE WITH AoE and NOT CLEARABLE WITHOUT it.
//
// Both halves are measured here, at a MATCHED TWO-TOWER BUDGET, because two towers is
// where the separation actually lives: an exhaustive single-anchor sweep (all 521 legal
// anchors on the shipped board, every catalog tower id) clears the wave with ZERO builds —
// AoE included — so one tower separates nothing.
//
// THE PLACEMENT SWEEP, on the `story-aoe.test.ts` precedent (whose own 521-anchor sweep
// is likewise a sweep of BUILDS, not of one fixture): the "without AoE" half is proved by
// running every build in a declared family and finding none that clears — see the sweep
// test at the foot of this file for exactly which family, and how many of its builds the
// sim actually accepted.
//
// What this FILE runs is the affordable, exhaustive-over-a-declared-family form of the
// same two facts: a pinned `splash` witness with a mechanism probe, and a sweep of every
// vertically-flanking pair on the board for every non-AoE attacking id.
//
// Regenerate every literal with:
//   pnpm --filter @wynding/content exec vitest run story-swarm

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  step,
  MAX_MATCH_TICKS,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { waveIndexForCreep } from './wave-lookup';

const SCENARIO_SEED = 0x5eed;

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
/** The swarm wave, LOCATED by creep id in the compiled schedule (ruling 1) — never an
 *  index literal, so this survives any future renumber unedited. */
const SWARM_WAVE = waveIndexForCreep(ruleset, 'swarm');

interface WaveOutcome {
  /** Every scripted placement was ACCEPTED — a build the sim refused proves nothing. */
  readonly built: boolean;
  /** The swarm wave settled with no creep of it ever reaching the exit. */
  readonly cleared: boolean;
  /** Largest number of `swarm` creeps that died on ONE tick — the AoE mechanism probe. */
  readonly maxSwarmKillsInOneTick: number;
}

/** Run the real bundle from tick 0 with `anchors` built in order (one attempt per tick,
 *  the first tick the treasury can afford it) and report what the SWARM wave did. Stops
 *  the moment that wave's verdict is in — its first leak, or its resolution — so a sweep
 *  over hundreds of builds stays affordable. */
function runSwarmWave(
  anchors: readonly { readonly col: number; readonly row: number }[],
  towerId: string,
  probeSimultaneousKills = false,
): WaveOutcome {
  let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
  const cost = ruleset.towerById[towerId]?.cost;
  if (cost === undefined) throw new Error(`unknown towerId '${towerId}'`);
  let placed = 0;
  let maxSwarmKillsInOneTick = 0;
  for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
    const inputs: SimInput[] = [];
    if (placed < anchors.length && state.bounty >= cost) {
      inputs.push({ kind: 'placeTower', anchor: anchors[placed]!, towerId });
    }
    const towersBefore = state.towers.id.length;
    // The simultaneous-kill probe costs a per-tick Set, so it is opt-in: the witness run
    // needs it, the several-thousand-build sweep does not.
    const liveSwarmBefore = new Set<number>();
    if (probeSimultaneousKills) {
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'swarm' && state.creeps.hp[i]! > 0) {
          liveSwarmBefore.add(state.creeps.id[i]!);
        }
      }
    }
    const livesBefore = state.lives;
    state = step(state, ruleset, inputs);
    if (state.towers.id.length > towersBefore) placed++;
    // A swarm row that vanished on a tick which cost no lives died; one that vanished on
    // a tick that DID cost lives may have leaked, so those ticks are excluded from the
    // simultaneous-kill probe rather than guessed at.
    if (probeSimultaneousKills && state.lives === livesBefore) {
      const stillLive = new Set(state.creeps.id);
      let gone = 0;
      for (const id of liveSwarmBefore) if (!stillLive.has(id)) gone++;
      if (gone > maxSwarmKillsInOneTick) maxSwarmKillsInOneTick = gone;
    }
    if (state.waveLeaked[SWARM_WAVE]) {
      return { built: placed === anchors.length, cleared: false, maxSwarmKillsInOneTick };
    }
    if (state.waveResolved[SWARM_WAVE]) {
      return { built: placed === anchors.length, cleared: true, maxSwarmKillsInOneTick };
    }
  }
  return { built: placed === anchors.length, cleared: false, maxSwarmKillsInOneTick };
}

/** The AoE witness: a `splash` pair flanking the lane at column 4. Two towers, 24 gold —
 *  the budget every arm below is matched against. */
const AOE_WITNESS: readonly { col: number; row: number }[] = [
  { col: 4, row: 8 },
  { col: 4, row: 10 },
];

/** Every attacking catalog id that is not a CADENCED AoE tower — i.e. everything the
 *  "without AoE" arm has to rule out. `beacon` is excluded because it has no `attack` at
 *  all (it can never clear anything, so including it would pad the sweep with a vacuous
 *  pass); `antiair` IS included even though it is air-domain and `swarm` is ground, and
 *  `mine` IS included even though its one discharge is a blast — a criterion that quietly
 *  skipped the ids that trivially fail would be choosing its own evidence. */
const NON_AOE_IDS = ['basic', 'slow', 'venom', 'stun', 'antiair', 'mine'] as const;

describe('M2-S11 P4 — the re-ruled swarm criterion: clearable with AoE, not clearable without it', () => {
  it('the catalog agrees on which ids are AoE — the split this whole file rests on', () => {
    // Fixed by the COMPILED bundle, never by a hand-kept list: an `aoe` effect is what
    // makes a tower fire a blast (`combat.ts`'s `blastRadiusOf`), and a CADENCED attack is
    // what lets it do so more than once. `mine` carries an `aoe` effect too but fires
    // exactly once ever (`attack.mode === 'burst'`), so it is not an AoE TOWER in the
    // sense this criterion is about — a one-shot cannot answer a sixteen-creep wave by
    // construction, and it is swept below on those terms rather than quietly reclassified.
    const hasAoeEffect = (id: string): boolean =>
      (ruleset.towerById[id]?.effects ?? []).some((e) => e.kind === 'aoe');
    const isBurst = (id: string): boolean => ruleset.towerById[id]?.attack?.mode === 'burst';
    expect(hasAoeEffect('splash')).toBe(true);
    expect(isBurst('splash')).toBe(false);
    expect(hasAoeEffect('frost-splash')).toBe(true);
    expect(isBurst('frost-splash')).toBe(false);
    expect(hasAoeEffect('mine')).toBe(true);
    expect(isBurst('mine')).toBe(true); // an AoE effect, but one discharge, ever
    for (const id of NON_AOE_IDS) {
      if (id === 'mine') continue;
      expect(hasAoeEffect(id)).toBe(false);
    }
  });

  it('WITH AoE: two `splash` towers clear the swarm wave outright — and a single blast is what does it', () => {
    const r = runSwarmWave(AOE_WITNESS, 'splash', true);
    console.log(
      `[story-swarm] splash witness ${JSON.stringify(AOE_WITNESS)}: built=${r.built} ` +
        `cleared=${r.cleared} maxSwarmKillsInOneTick=${r.maxSwarmKillsInOneTick}`,
    );
    // PROVE THE FEATURE ENGAGED before the outcome: both towers really stood, and at
    // least one tick killed MULTIPLE swarm creeps at once. A single-target build cannot
    // produce that, so this is the AoE mechanism itself — not merely a build that
    // happened to win. Pinned at the MEASURED 3, not a `>= 2` lower bound.
    expect(r.built).toBe(true);
    expect(r.maxSwarmKillsInOneTick).toBe(3);

    // THE MEASUREMENT: zero of the wave's 16 `swarm` reached the exit.
    expect(r.cleared).toBe(true);
  });

  it('WITHOUT AoE: the same 24-gold, two-tower budget clears nothing, on any id', () => {
    for (const id of NON_AOE_IDS) {
      const r = runSwarmWave(AOE_WITNESS, id);
      console.log(
        `[story-swarm] non-AoE at the witness anchors — ${id}: built=${r.built} cleared=${r.cleared}`,
      );
      expect(r.built).toBe(true); // it really was built; it simply did not clear
      expect(r.cleared).toBe(false);
    }
  });

  it('WITHOUT AoE: an exhaustive sweep of every vertically-flanking pair on the board clears nothing, on any id', async () => {
    // The declared family: `(col, row)` + `(col, row + 2)` — the lane-flanking geometry
    // every story file in this repo builds with, swept over EVERY column and row where
    // both placements are legal. 475 candidate pairs per id; the ones the sim refuses
    // (off-board footprint, sealed maze) are skipped rather than counted as passes.
    const results: Record<string, { built: number; cleared: number }> = {};
    for (const id of NON_AOE_IDS) {
      let built = 0;
      let cleared = 0;
      for (let col = 1; col <= 25; col++) {
        // Yield between columns: minutes of back-to-back synchronous sims starve the
        // vitest worker's RPC heartbeat under a contended `verify` run.
        //
        // The determinism zone bans schedulers because wall-clock timing inside the sim
        // breaks replay byte-identity. Nothing crosses this yield: each `runSwarmWave`
        // below is a complete, self-contained synchronous run, and the yield sits BETWEEN
        // runs purely so the test runner can breathe. Site-local and deliberate rather
        // than an exemption in the rule, so the guard stays strict everywhere else.
        // eslint-disable-next-line no-restricted-globals -- yield between runs, not inside one
        await new Promise((resolve) => setImmediate(resolve));
        for (let row = 1; row <= 19; row++) {
          const r = runSwarmWave(
            [
              { col, row },
              { col, row: row + 2 },
            ],
            id,
          );
          if (!r.built) continue;
          built++;
          if (r.cleared) cleared++;
        }
      }
      results[id] = { built, cleared };
    }
    console.log(`[story-swarm] non-AoE flanking-pair sweep: ${JSON.stringify(results)}`);
    for (const id of NON_AOE_IDS) {
      expect(results[id]!.built).toBeGreaterThan(100); // the sweep really ran real builds
      expect(results[id]!.cleared).toBe(0);
    }

    // ...and the same sweep DOES find clearing builds for `splash`, so the zeroes above
    // are a property of the non-AoE ids rather than of the sweep or the wave.
    let splashCleared = 0;
    for (let col = 1; col <= 25; col++) {
      // eslint-disable-next-line no-restricted-globals -- yield between runs, not inside one
      await new Promise((resolve) => setImmediate(resolve)); // same heartbeat yield as above
      for (let row = 1; row <= 19; row++) {
        const r = runSwarmWave(
          [
            { col, row },
            { col, row: row + 2 },
          ],
          'splash',
        );
        if (r.built && r.cleared) splashCleared++;
      }
    }
    console.log(`[story-swarm] splash flanking-pair sweep: cleared=${splashCleared}`);
    expect(splashCleared).toBeGreaterThan(0);
  }, 300_000);
});
