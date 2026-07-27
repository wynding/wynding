// parity.test.ts — behavioral-parity goldens (PLAN M2-S1 §"The two invariants" / P4
// steps 12-13).
//
// The whole point of re-encoding the ruleset to v2 (schema-validated JSON, a
// capability profile, discriminated effect bundles) is that NOTHING about how the
// sim actually simulates the shipped M1 content may change. This file is the proof:
// load the bundled artifact through the real production path — the registry, then
// `compileRuleset` — and run it against two pre-verified golden scenarios (PLAN.md
// §"The two invariants"), asserting every observable of the terminal state
// (world-hash, per-tick trace digest, lives, terminal tick, score, stars) against
// literals computed BEFORE this file existed. If any assertion below fails, the
// compile mapping (or something upstream of it) changed BEHAVIOR — fix the code,
// never the literal (PLAN.md is explicit: these are pre-verified, not aspirational).
//
// Also pins the v2 `rulesetHash` of the shipped artifact itself (P4 step 13) — a
// content-identity digest, independent of the world-hash goldens above.

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

/** Shared fixed seed for both pinned scenarios (PLAN.md §"The two invariants"). */
const SCENARIO_SEED = 0x5eed;

/**
 * The canonical input log — a DELIBERATE ~15-line duplicate of
 * `packages/sim/src/determinism.test.ts`'s `canonicalInputs` (provenance: that file,
 * scenario A). Kept as a literal copy rather than a shared import because sim's
 * determinism suite builds its ruleset INLINE (no sim→content edge is permitted),
 * while this suite deliberately loads the SAME logical scenario through the real
 * content→sim registry+compile path — the two must exercise identical inputs for
 * their hashes to be comparable at all, so duplication here is the point, not
 * accidental drift.
 */
function canonicalInputs(tick: number): SimInput[] {
  if (tick === 0) return [{ kind: 'callWaveEarly' }]; // launch the wave now
  if (tick === 2) return [{ kind: 'placeTower', anchor: { col: 5, row: 10 } }];
  if (tick === 4) return [{ kind: 'placeTower', anchor: { col: 0, row: 0 } }]; // rejected (border)
  if (tick === 201) return [{ kind: 'sellTower', tower: 2 }];
  if (tick % 7 === 0) return [{ kind: 'noop' }];
  return [];
}

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

/** Run `ticks` steps of the bundled M1 ruleset from a fresh state, seeded and driven
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

describe('behavioral parity — v2-loaded M1 bundle vs. the pre-verified goldens', () => {
  it('scenario A (canonical inputs, 500 ticks) matches the pinned golden exactly', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const { state, trace } = runScenario(canonicalInputs, 500);

    expect(hashSimState(state)).toBe('d85297b0');
    expect(fnv1a(trace.join(':'))).toBe('e540a55a');
    expect(state.lives).toBe(2);
    expect(state.tick).toBe(446);
    expect(deriveScore(state, ruleset)).toBe(52);
    expect(deriveStars(state, ruleset)).toBe(1);
  });

  it('scenario B (hands-off, 1200 ticks) matches the pinned golden exactly', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const noInputs = (): SimInput[] => [];
    const { state, trace } = runScenario(noInputs, 1200);

    expect(hashSimState(state)).toBe('56c525ed');
    expect(fnv1a(trace.join(':'))).toBe('febebf60');
    expect(state.lives).toBe(0);
    expect(state.tick).toBe(946);
    expect(deriveScore(state, ruleset)).toBe(0);
    expect(deriveStars(state, ruleset)).toBe(0);
  });
});

// --- GOLDEN — the v2 rulesetHash of the shipped M1 artifact ---------------------
// Recompute with: pnpm --filter @wynding/content exec vitest run parity
// A change here means the shipped artifact's CONTENT changed (or its normalized
// encoding did) — not a behavior change per se, but every deployed replay/leaderboard
// entry binds to this exact digest (ADR 0007 §3), so a change is never silent.
const SHIPPED_RULESET_HASH = 'f6e3aa2903e19dc2343f66ba7c31af13c4153f90122a10bd6ec922e31409f2ba';
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
