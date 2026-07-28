// parity.test.ts — behavioral-parity goldens (PLAN M2-S2 step 13).
//
// The whole point of re-encoding the ruleset to v2 (schema-validated JSON, a
// capability profile, discriminated effect bundles) is that NOTHING about how the
// sim actually simulates the shipped content may change out from under the content
// package. This file is the proof: load the bundled artifact through the real
// production path — the registry, then `compileRuleset` — and run it against two
// pre-verified golden scenarios (a hands-off loss and a full win), asserting every
// observable of the terminal state (world-hash, per-tick trace digest, lives,
// terminal tick, score, stars) against literals computed BEFORE this file existed,
// by running the untouched sim over the shipped bundle. If any assertion below
// fails, the compile mapping (or something upstream of it) changed BEHAVIOR — fix
// the code, never the literal.
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
 *  by `inputs`. Returns the terminal state and the per-tick world-hash trace. */
function runScenario(
  inputs: (tick: number) => SimInput[],
  ticks: number,
): { state: SimState; trace: string[] } {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state = createInitialState(SCENARIO_SEED, ruleset);
  const trace: string[] = [];
  for (let t = 0; t < ticks; t++) {
    state = step(state, ruleset, inputs(t));
    trace.push(hashSimState(state));
  }
  return { state, trace };
}

describe('behavioral parity — v2-loaded bundle vs. the pre-verified goldens', () => {
  it('hands-off loss (no inputs, 1200 ticks) matches the pinned golden exactly', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const noInputs = (): SimInput[] => [];
    const { state, trace } = runScenario(noInputs, 1200);

    expect(hashSimState(state)).toBe('22460978');
    expect(fnv1a(trace.join(':'))).toBe('a09f3865');
    expect(state.phase).toBe('lost');
    expect(state.lives).toBe(0);
    expect(state.tick).toBe(946);
    expect(deriveScore(state, ruleset)).toBe(0);
    expect(deriveStars(state, ruleset)).toBe(0);
  });

  it('winning scenario (early calls + placements, 1500 ticks) matches the pinned golden exactly', () => {
    // A wall of towers flanking the row-11 lane (row 10 and row 12, every third
    // column), placed one per tick as budget allows: enough total DPS to clear
    // all three waves outright. Wave 0 is early-called at tick 0 (paying the
    // early-call bounty/credit from the undecremented 500-tick countdown); wave 1
    // launches naturally at tick 300 (its countdown, not an early call, so it pays
    // no credit — `rem` is 0 at natural expiry); wave 2 is early-called at tick 550
    // (50 ticks before its natural expiry, paying a small bounty/credit); the
    // tick-1050 call is a deliberate no-op — every wave has already launched by
    // then, exercising `!launchPending`'s already-launched-cursor branch.
    const anchors: { col: number; row: number }[] = [];
    for (let col = 1; col <= 26; col += 3) {
      anchors.push({ col, row: 10 });
      anchors.push({ col, row: 12 });
    }
    let anchorIdx = 0;
    function inputs(tick: number): SimInput[] {
      const out: SimInput[] = [];
      if (anchorIdx < anchors.length) {
        out.push({ kind: 'placeTower', anchor: anchors[anchorIdx]! });
        anchorIdx++;
      }
      if (tick === 0) out.push({ kind: 'callWaveEarly' }); // wave 0
      if (tick === 550) out.push({ kind: 'callWaveEarly' }); // wave 2
      if (tick === 1050) out.push({ kind: 'callWaveEarly' }); // no-op: nothing left to launch
      return out;
    }

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const { state, trace } = runScenario(inputs, 1500);

    expect(hashSimState(state)).toBe('44cf9bd6');
    expect(fnv1a(trace.join(':'))).toBe('fbd4d46a');
    expect(state.phase).toBe('won');
    expect(state.lives).toBe(10);
    expect(state.tick).toBe(752);
    // Every wave cleared, and the game recognizes it: waveResolved is exhaustive,
    // waveCursor ran past the last wave.
    expect(state.waveResolved).toEqual([true, true, true]);
    expect(state.waveCursor).toBe(3);
    // Per-wave clear bonuses (4 each × 3 waves), kill bounty, and the two
    // early-call credits (⌊500/50⌋ at tick 0, ⌊50/50⌋ at tick 550 — wave 1's
    // natural launch pays nothing, its countdown having already reached 0) all
    // landed: cumulativeKillBounty is the SCORED kill-bounty channel (clear bonus
    // pays into `bounty`, the spendable economy, not the score), and the credit
    // channel is exactly the two early-call payouts.
    expect(state.cumulativeKillBounty).toBe(30);
    expect(state.cumulativeEarlyCallCredit).toBe(11);
    expect(state.bounty).toBe(53);
    // Win score formula: kill-bounty + early-call credit + lives × survivalMul.
    expect(deriveScore(state, ruleset)).toBe(30 + 11 + 10 * ruleset.scoring.survivalMul);
    expect(deriveScore(state, ruleset)).toBe(391);
    expect(deriveStars(state, ruleset)).toBe(3);
  });
});

// --- GOLDEN — the v2 rulesetHash of the shipped artifact -------------------------
// Recompute with: pnpm --filter @wynding/content exec vitest run parity
// A change here means the shipped artifact's CONTENT changed (or its normalized
// encoding did) — not a behavior change per se, but every deployed replay/leaderboard
// entry binds to this exact digest (ADR 0007 §3), so a change is never silent.
const SHIPPED_RULESET_HASH = '0c210f144d54728009726982e3cfa8813235d08b760bd05d860dd413a8fb1736';
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
