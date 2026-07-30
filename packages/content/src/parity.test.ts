// parity.test.ts — an S3-shipped-content snapshot (PLAN M2-S3 step 13).
//
// Through M2-S1/S2 this file's charter was "behavior must not change / literals are
// never updated" — a TS-era-format-migration parity proof. That charter is retired
// as of M2-S3: this story DELIBERATELY changes the shipped bundle (the `slow` tower,
// the `fast` creep, wave 2's re-composition), so the literals below are NOT frozen —
// they are a snapshot of what the shipped content actually does, re-pinned every
// time the bundle intentionally changes. Old-behavior CONTINUITY (proving the v7 sim
// reproduces pre-S3 outcomes) lives exclusively in the sim package's own continuity
// witnesses (PLAN.md step 11), not here.
//
// This file still loads the bundled artifact through the real production path — the
// registry, then `compileRuleset` — and pins every observable of two scenarios (a
// hands-off loss and a full win, the latter now exercising the `slow` tower) against
// literals computed by running the untouched sim over the shipped bundle. The
// winning scenario also PROVES its `slow` placements landed (Codex R2-3): a
// self-consistent golden alone cannot certify that new commands weren't silent
// no-ops, so the terminal state is asserted to hold surviving `slow` towers, and a
// mid-trace probe asserts some creep carried a nonzero `slowMulFp` at some tick.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run parity
// after temporarily logging the values from the scenarios (see git history of this
// file for the harness used to derive them) — never hand-compute a golden.
//
// Also pins the v2 `rulesetHash` of the shipped artifact itself — a content-identity
// digest, independent of the world-hash goldens above.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  compileRuleset,
  rulesetDigest,
  deriveScore,
  deriveStars,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';

/** Shared fixed seed for both pinned scenarios. */
const SCENARIO_SEED = 0x5eed;

/**
 * FNV-1a over a string — an 8-line INLINE duplicate of `@wynding/engine`'s
 * `fnv1a` (packages/engine/src/hash.ts), provenance-commented per PLAN.md P4 step
 * 12 ("import from @wynding/sim's re-exports if available, else inline"): `@wynding/sim`
 * does not re-export `fnv1a`, and importing `@wynding/engine` directly here would add
 * a runtime dependency edge this package doesn't otherwise need. Fast, deterministic,
 * NOT cryptographic — identical algorithm, identical output to the engine original.
 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Run `ticks` steps of the bundled ruleset from a fresh state, seeded and driven
 *  by `inputs`. Returns the terminal state and the per-tick world-hash trace.
 *  `probe`, if given, is called with the post-step state on every tick — used to
 *  observe transient per-tick facts (e.g. a slow status landing) that the terminal
 *  state alone cannot prove (Codex R2-3). */
function runScenario(
  inputs: (tick: number) => SimInput[],
  ticks: number,
  probe?: (state: SimState) => void,
): { state: SimState; trace: string[] } {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state = createInitialState(SCENARIO_SEED, ruleset);
  const trace: string[] = [];
  for (let t = 0; t < ticks; t++) {
    state = step(state, ruleset, inputs(t));
    trace.push(hashSimState(state));
    probe?.(state);
  }
  return { state, trace };
}

describe('behavioral parity — v2-loaded bundle vs. the pre-verified goldens', () => {
  it('hands-off loss (no inputs, 1200 ticks) matches the pinned golden exactly', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const noInputs = (): SimInput[] => [];
    const { state, trace } = runScenario(noInputs, 1200);

    expect(hashSimState(state)).toBe('f230e4b1');
    expect(fnv1a(trace.join(':'))).toBe('81b792f2');
    expect(state.phase).toBe('lost');
    expect(state.lives).toBe(0);
    expect(state.tick).toBe(946);
    expect(deriveScore(state, ruleset)).toBe(0);
    expect(deriveStars(state, ruleset)).toBe(0);
  });

  it('winning scenario (early calls + placements, incl. two `slow` towers, 1500 ticks) matches the pinned golden exactly', () => {
    // A wall of `basic` towers flanking the row-11 lane (row 10 and row 12, every
    // third column), placed one per tick as budget allows: enough total DPS to
    // clear all three waves outright. Once the wall is fully placed, two `slow`
    // towers go up off-lane (rows 7 and 15, `slowAnchors` below) — proving the slow path
    // client/server-identically at content level (step 12). Wave 0 is
    // early-called at tick 0 (paying the early-call bounty/credit from the
    // undecremented 500-tick countdown); wave 1 launches naturally at tick 300
    // (its countdown, not an early call, so it pays no credit — `rem` is 0 at
    // natural expiry); wave 2 is early-called at tick 550 (50 ticks before its
    // natural expiry, paying a small bounty/credit); the tick-1050 call is a
    // deliberate no-op — every wave has already launched by then, exercising
    // `!launchPending`'s already-launched-cursor branch.
    const anchors: { col: number; row: number }[] = [];
    for (let col = 1; col <= 26; col += 3) {
      anchors.push({ col, row: 10 });
      anchors.push({ col, row: 12 });
    }
    // Rows 7 and 15 — within the `slow` tower's 4-cell range of the row-11 lane,
    // clear of the row-10/row-12 basic wall's 2×2 footprints (so no placement
    // overlap) — placed once bounty has recovered from the wall build.
    const slowAnchors: { col: number; row: number }[] = [
      { col: 2, row: 7 },
      { col: 5, row: 15 },
    ];
    let anchorIdx = 0;
    function inputs(tick: number): SimInput[] {
      const out: SimInput[] = [];
      if (anchorIdx < anchors.length) {
        out.push({ kind: 'placeTower', anchor: anchors[anchorIdx]!, towerId: 'basic' });
        anchorIdx++;
      }
      if (tick === 600) {
        out.push({ kind: 'placeTower', anchor: slowAnchors[0]!, towerId: 'slow' });
      }
      if (tick === 610) {
        out.push({ kind: 'placeTower', anchor: slowAnchors[1]!, towerId: 'slow' });
      }
      if (tick === 0) out.push({ kind: 'callWaveEarly' }); // wave 0
      if (tick === 550) out.push({ kind: 'callWaveEarly' }); // wave 2
      if (tick === 1050) out.push({ kind: 'callWaveEarly' }); // no-op: nothing left to launch
      return out;
    }

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    // Mid-trace probe (Codex R2-3): a self-consistent golden alone cannot certify
    // the `slow` commands actually landed — this asserts some creep really carried
    // an active slow status at some tick during the run.
    let sawSlowedCreep = false;
    const { state, trace } = runScenario(inputs, 1500, (s) => {
      sawSlowedCreep ||= s.creeps.slowMulFp.some((mulFp) => mulFp !== 0);
    });
    expect(sawSlowedCreep).toBe(true);

    // Terminal proof the `slow` placements survived (not sim-silently no-op'd):
    // two rows still carry `towerId === 'slow'`.
    const slowTowerCount = state.towers.towerId.filter((id) => id === 'slow').length;
    expect(slowTowerCount).toBe(2);

    expect(hashSimState(state)).toBe('f81cc6b6');
    expect(fnv1a(trace.join(':'))).toBe('fd5504cb');
    expect(state.phase).toBe('won');
    expect(state.lives).toBe(10);
    expect(state.tick).toBe(697);
    // Every wave cleared, and the game recognizes it: waveResolved is exhaustive,
    // waveCursor ran past the last wave.
    expect(state.waveResolved).toEqual([true, true, true]);
    expect(state.waveCursor).toBe(3);
    // Per-wave clear bonuses (4/4/5 across the three waves), kill bounty (wave 1's
    // re-composition to 16 × `swarm` — M2-S4a step 9 — adds 6 more 1-bounty kills over
    // the old 10 × `normal`), and the two early-call credits (⌊500/50⌋ at tick 0,
    // ⌊51/50⌋ at tick 550 (the call tick skips its own decrement, so the sampled
    // remainder is 51) — wave 1's natural launch pays nothing, its countdown having
    // already reached 0) all landed: cumulativeKillBounty is the SCORED kill-bounty
    // channel (clear bonus pays into `bounty`, the spendable economy, not the score),
    // and the credit channel is exactly the two early-call payouts.
    expect(state.cumulativeKillBounty).toBe(42);
    expect(state.cumulativeEarlyCallCredit).toBe(11);
    expect(state.bounty).toBe(50);
    // Win score formula: kill-bounty + early-call credit + lives × survivalMul.
    expect(deriveScore(state, ruleset)).toBe(42 + 11 + 10 * ruleset.scoring.survivalMul);
    expect(deriveScore(state, ruleset)).toBe(403);
    expect(deriveStars(state, ruleset)).toBe(3);
  });
});

// --- GOLDEN — the v2 rulesetHash of the shipped artifact -------------------------
// Recompute with: pnpm --filter @wynding/content exec vitest run parity
// A change here means the shipped artifact's CONTENT changed (or its normalized
// encoding did) — not a behavior change per se, but every deployed replay/leaderboard
// entry binds to this exact digest (ADR 0007 §3), so a change is never silent.
const SHIPPED_RULESET_HASH = 'd1cd587d0c9e6a3d1fbdd0c8a8f9fda38ea08464e43d573b0009ac5353810e67';
// ---------------------------------------------------------------------------------

describe('digest goldens — the shipped artifact content-hash is pinned and stable', () => {
  it('matches the committed rulesetHash literal', () => {
    const bundle = getBundledRuleset();
    expect(rulesetDigest(bundle)).toBe(SHIPPED_RULESET_HASH);
  });

  it('is stable across two independent loads of the registry', () => {
    const first = rulesetDigest(getBundledRuleset());
    const second = rulesetDigest(getBundledRuleset());
    expect(first).toBe(second);
    expect(first).toBe(SHIPPED_RULESET_HASH);
  });
});
