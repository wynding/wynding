// story-armored-wave.test.ts — the M2-S5a P8 pinned wave-4 measurement (PLAN.md step 38).
//
// LOCATION NOTE (deviation from PLAN.md's file list): the plan names
// `packages/sim/src/story-armored-wave.test.ts`, but `packages/sim`'s dependencies are
// `@wynding/engine` and `@wynding/types` only (see `determinism.test.ts`'s own header) — it
// cannot import `@wynding/content`, and a test built there would have to hand-assemble a
// wave-4 ruleset inline rather than load the real shipped `wynding-core` bundle. That would
// measure a REPLICA of wave 4, not the shipped wave 4, which is exactly what this
// measurement must not do. This file lives beside `parity.test.ts` instead, which already
// runs the real shipped bundle through `compileRuleset` → `step()` — the same idiom this
// file follows.
//
// PURPOSE: m2.md's `armored` creep design intent is that flat armor blanks small direct
// hits, and only armor-bypassing DoT (or a big enough hit) gets through. Wave 4 (index 3,
// `6 x armored`, appended in P5) is the first wave that actually tests this. The grill's
// arithmetic predicted one `venom` deals ~30 DoT damage to a 36 HP `armored` creep on a
// single pass, so a PAIR of towers was wanted. This test does not trust that prediction —
// it scripts a sane, modest build (a small `basic` wall for the three earlier, unarmored
// waves, plus a `venom` PAIR built ahead of wave 4) and pins whatever the sim actually
// produces: the exact leak count, lives remaining, and terminal outcome.
//
// AND THE PREDICTION WAS OPTIMISTIC — which is exactly why it is measured (QC round 1).
// The pinned 26 DoT ticks across six `armored` creeps is 52 damage total, ~9 per creep,
// not the ~30 per creep the arithmetic suggested: a creep is only in a venom tower's
// range for part of its pass, so most records expire unfinished. DoT is decisive here
// regardless — the second test below removes the venom pair and the wave leaks — but the
// margin comes from the pair plus the basic wall together, not from DoT alone.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run story-armored-wave
// after temporarily logging the values (see parity.test.ts's header for the harness
// pattern) — never hand-compute a golden.

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  step,
  hashSimState,
  compileRuleset,
  deriveScore,
  deriveStars,
  type SimInput,
  type SimState,
  type StepEvents,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';

/** Fixed seed — same convention as parity.test.ts. */
const SCENARIO_SEED = 0x5eed;

describe('wave 4 (the appended `armored` wave) — a pinned, scripted-build measurement', () => {
  it('a small basic wall for waves 0-2, plus a venom pair built ahead of wave 4, clears the whole game', () => {
    // --- The scripted build, stated so the scenario is reproducible by reading it ---
    //
    // A `basic` pair at columns 2, 6 and 10 (rows 10 and 12, flanking the row-11 lane,
    // the same flanking geometry parity.test.ts uses) — six towers total, cost 30 of the
    // starting 80 bounty. This is a deliberately modest wall: enough `basic` DPS (10 damage,
    // armor-0 against every creep in waves 0-2) to handle the three unarmored waves, not an
    // overbuilt wall sized to also brute-force the armored wave on its own.
    const basicAnchors: { col: number; row: number }[] = [
      { col: 2, row: 10 },
      { col: 2, row: 12 },
      { col: 6, row: 10 },
      { col: 6, row: 12 },
      { col: 10, row: 10 },
      { col: 10, row: 12 },
    ];
    // The `venom` PAIR (the grill's arithmetic, PLAN.md step 38) — column 16, rows 10 and
    // 12, the same flanking geometry. Built at ticks 1300/1310, well ahead of wave 4's
    // natural launch at tick 1400 (countdowns 500+300+300+300), so both towers have
    // established their fire cadence before the first `armored` creep is in range.
    // `basic`'s own 10 damage nets only 4/hit against `armored`'s armor 6 (P1's formula);
    // `venom`'s direct 2 nets 0 — the DoT is what has to do the real work here.
    const venomAnchors: { col: number; row: number }[] = [
      { col: 16, row: 10 },
      { col: 16, row: 12 },
    ];

    let nextBasic = 0;
    function inputs(tick: number): SimInput[] {
      const out: SimInput[] = [];
      // One `basic` placed every 10 ticks, in anchor order, starting at tick 0 — an
      // unhurried early build, not a first-tick rush.
      if (tick % 10 === 0 && nextBasic < basicAnchors.length) {
        out.push({ kind: 'placeTower', anchor: basicAnchors[nextBasic]!, towerId: 'basic' });
        nextBasic++;
      }
      if (tick === 1300) {
        out.push({ kind: 'placeTower', anchor: venomAnchors[0]!, towerId: 'venom' });
      }
      if (tick === 1310) {
        out.push({ kind: 'placeTower', anchor: venomAnchors[1]!, towerId: 'venom' });
      }
      return out;
    }

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    // A reused, mutable `StepEvents` collector (combat.ts's documented contract: the two
    // DoT counters are mutable and NOT reset per-call) — accumulates `dotTicks`/`dotDropped`
    // across the whole run, proving DoT actually engaged rather than merely being present
    // in the bundle.
    const events: StepEvents = { impactPoints: [], fired: [], dotTicks: 0, dotDropped: 0 };
    let sawLiveDotRecord = false;
    for (let t = 0; t < 1900; t++) {
      state = step(state, ruleset, inputs(t), events);
      sawLiveDotRecord ||= state.dots.length > 0;
    }

    // Proof the DoT mechanic actually fired against the armored wave (not a self-consistent
    // golden alone — Codex R2-3's precedent, applied here to DoT rather than slow): the
    // venom pair is placed at tick 1300/1310 and only wave 4's `armored` creeps (spawning
    // from tick 1400) are ever in range of it, so every tick counted here is wave-4 DoT.
    expect(sawLiveDotRecord).toBe(true);
    // 26, not the 27 this originally pinned (QC round 1): the first draft's DoT tick step
    // re-checked liveness only when the traversal list was built, so a record whose target
    // an EARLIER record in the same bucket had already killed still counted a tick that
    // dealt no damage. Fixing that removed exactly one phantom from this run — a small
    // number, but it was a wrong one baked into a golden.
    expect(events.dotTicks).toBe(26);
    expect(events.dotDropped).toBe(0);

    // Terminal proof the placements survived (not silently no-op'd): six `basic` and both
    // `venom` towers still stand.
    expect(state.towers.towerId.filter((id) => id === 'basic').length).toBe(6);
    expect(state.towers.towerId.filter((id) => id === 'venom').length).toBe(2);

    // --- THE MEASUREMENT (PLAN.md step 38) ---
    //
    // Wave 4 is CLEARABLE with this sane build: every wave (including the appended
    // `armored` wave) resolves with zero leaks, and the game is won outright with every
    // starting life intact.
    expect(state.phase).toBe('won');
    expect(state.tick).toBe(1835);
    expect(state.lives).toBe(10);
    expect(state.leakedCount).toBe(0);
    expect(state.waveResolved).toEqual([true, true, true, true]);
    expect(state.waveLeaked).toEqual([false, false, false, false]);
    expect(state.waveCursor).toBe(4);
    // Kill-bounty proof every creep across all four waves was killed, not leaked: 10 ×
    // `normal` (1) + 16 × `swarm` (1) + 8 × `fast` (2) + 6 × `armored` (3) = 60, matching a
    // zero-leak run exactly (10 + 16 + 16 + 18).
    expect(state.cumulativeKillBounty).toBe(60);
    expect(state.bounty).toBe(110);
    expect(hashSimState(state)).toBe('2ed4d52e');
    expect(deriveScore(state, ruleset)).toBe(410);
    expect(deriveStars(state, ruleset)).toBe(3);
  });

  // The COUNTERFACTUAL (QC round 1). The test above pins that the build clears wave 4,
  // but on its own it cannot show the venom pair is what does it — a balance change
  // making DoT irrelevant would simply require re-pinning `dotTicks`/`tick`/the hash,
  // which is precisely the failure mode this file exists to guard against. So: the same
  // script, same seed, same basic wall, with ONLY the venom pair removed.
  it('the same build WITHOUT the venom pair leaks the armored wave — DoT is what clears it', () => {
    const basicAnchors: { col: number; row: number }[] = [
      { col: 2, row: 10 },
      { col: 2, row: 12 },
      { col: 6, row: 10 },
      { col: 6, row: 12 },
      { col: 10, row: 10 },
      { col: 10, row: 12 },
    ];
    let nextBasic = 0;
    function inputs(tick: number): SimInput[] {
      const out: SimInput[] = [];
      if (tick % 10 === 0 && nextBasic < basicAnchors.length) {
        out.push({ kind: 'placeTower', anchor: basicAnchors[nextBasic]!, towerId: 'basic' });
        nextBasic++;
      }
      return out;
    }

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    const events: StepEvents = { impactPoints: [], fired: [], dotTicks: 0, dotDropped: 0 };
    for (let t = 0; t < 1900; t++) {
      state = step(state, ruleset, inputs(t), events);
    }

    // No venom tower stands, so no DoT record is ever created — the armor-bypass channel
    // is entirely absent, and `basic`'s 10 damage nets only 4/hit against armor 6.
    expect(events.dotTicks).toBe(0);
    expect(state.dots).toEqual([]);
    // The armored wave now leaks. This is the assertion that makes the first test mean
    // something: the venom pair is worth exactly these leaks.
    expect(state.leakedCount).toBe(4);
    expect(state.waveLeaked).toEqual([false, false, false, true]);
    expect(state.lives).toBe(6);
  });
});
