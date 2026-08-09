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
  MAX_MATCH_TICKS,
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

/** Run steps of the bundled ruleset from a fresh state, seeded and driven by
 *  `inputs`, continuing while `continueWhile(tick, state)` holds. Returns the
 *  terminal state and the per-tick world-hash trace. `probe`, if given, is called
 *  with the post-step state on every tick — used to observe transient per-tick
 *  facts (e.g. a slow status landing) that the terminal state alone cannot prove
 *  (Codex R2-3). */
function runScenario(
  inputs: (tick: number) => SimInput[],
  continueWhile: (tick: number, state: SimState) => boolean,
  probe?: (state: SimState) => void,
): { state: SimState; trace: string[] } {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state = createInitialState(SCENARIO_SEED, ruleset);
  const trace: string[] = [];
  for (let t = 0; continueWhile(t, state); t++) {
    state = step(state, ruleset, inputs(t));
    trace.push(hashSimState(state));
    probe?.(state);
  }
  return { state, trace };
}

/** Like `runScenario`, but runs a fixed number of `ticks` rather than a
 *  state-dependent stop condition. */
function runScenarioForTicks(
  inputs: (tick: number) => SimInput[],
  ticks: number,
  probe?: (state: SimState) => void,
): { state: SimState; trace: string[] } {
  return runScenario(inputs, (t) => t < ticks, probe);
}

/** Like `runScenario`, but runs until the sim reaches a terminal phase (`'won'` or
 *  `'lost'`) rather than a fixed tick count, capped at `MAX_MATCH_TICKS` — the sim's
 *  own compile-time bound, never a hand-picked constant. */
function runScenarioUntilTerminal(
  inputs: (tick: number) => SimInput[],
  probe?: (state: SimState) => void,
): { state: SimState; trace: string[] } {
  return runScenario(inputs, (t, state) => t < MAX_MATCH_TICKS && state.phase === 'running', probe);
}

describe('behavioral parity — v2-loaded bundle vs. the pre-verified goldens', () => {
  it('hands-off loss (no inputs, 1200 ticks) matches the pinned golden exactly', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    const noInputs = (): SimInput[] => [];
    const { state, trace } = runScenarioForTicks(noInputs, 1200);

    // Re-pinned M2-S5a P5: the appended `armored` wave (index 3) launches at
    // prefixCountdown 1,400 — this hands-off run loses at tick 946, well before
    // that wave ever spawns, so every OTHER assertion in this test is unchanged
    // from M2-S5a P2 and this is once again a hash-only move.
    // Re-pinned M2-S6 P5: the new `stunUntilTick` creep column (P1) widens every
    // creep's serialized shape, and the appended wave index 4 (`resolute`+`fast`)
    // launches even later than wave index 3 — this hands-off run still loses at
    // tick 946, before either new wave ever spawns, so this is again a hash-only
    // move; every other assertion in this test is unchanged.
    // Re-pinned M2-S7 P6: the bundle gains a SIXTH wave (index 5, `flying`), which widens
    // `waveResolved`/`waveLeaked` (etc.) by one entry from tick 0 — those arrays are sized
    // to the total wave count, not to how many have launched, so the hash moves even though
    // wave index 5's countdown never even starts here (it only begins once wave index 4
    // launches, which itself never happens in a hands-off run). Still a hash-only move:
    // every other assertion below is unchanged.
    // Re-pinned M2-S10 P3: the bundle gains a SEVENTH and EIGHTH wave (index 6
    // `armored-flyer`, index 7 `boss`+`normal`), which widen `waveResolved`/
    // `waveLeaked` (etc.) by two more entries from tick 0 — those arrays are sized to
    // the total wave count, not to how many have launched. Neither new wave's
    // countdown ever starts in a hands-off run (they chain off wave index 5, which
    // itself never launches naturally before this run's tick-946 loss), so this is
    // once again a hash-only move: every other assertion below is unchanged.
    expect(hashSimState(state)).toBe('3bc72d23');
    expect(fnv1a(trace.join(':'))).toBe('04528845');
    expect(state.phase).toBe('lost');
    expect(state.lives).toBe(0);
    expect(state.tick).toBe(946);
    expect(deriveScore(state, ruleset)).toBe(0);
    expect(deriveStars(state, ruleset)).toBe(0);
  });

  // Retitled M2-S10 P3: this build WON at six waves and no longer does at eight (it has no
  // `antiair`, so wave index 6's `armored-flyer` walks through it). Keeping "winning" in
  // the title while the body asserts `phase === 'lost'` would be a title dodging its own
  // claim — the flip is the measured, reported outcome per ruling 1, not a regression.
  it('the early-calls + two-`slow`-towers build — no longer winning at eight waves, run to terminal under MAX_MATCH_TICKS, matches the pinned golden exactly', () => {
    // A wall of `basic` towers flanking the row-11 lane (row 10 and row 12, every
    // third column), placed one per tick as budget allows: enough total DPS to
    // clear all three waves outright. Once the wall is fully placed, two `slow`
    // towers go up off-lane (rows 7 and 15, `slowAnchors` below) — proving the slow path
    // client/server-identically at content level (step 12). Wave 0 is
    // early-called at tick 0 (paying the early-call bounty/credit from the
    // undecremented 500-tick countdown); wave 1 launches naturally at tick 300
    // (its countdown, not an early call, so it pays no credit — `rem` is 0 at
    // natural expiry); wave 2 is early-called at tick 550 (50 ticks before its
    // natural expiry, paying a small bounty/credit); the tick-1050 call WAS a
    // deliberate no-op through M2-S5a — every wave had already launched by then,
    // exercising `!launchPending`'s already-launched-cursor branch.
    // M2-S6 P5: the bundle now carries a FIFTH wave (index 4, `resolute`+`fast`),
    // whose own countdown only starts once wave index 3 launches (naturally
    // landing around tick 1150) — so at tick 1050 it has NOT yet launched, and
    // this same call now LAUNCHES it early instead of no-opping. See the
    // re-pinned golden below for the measured before/after this produces.
    // M2-S7 P6: the bundle now also carries a SIXTH wave (index 5, 8 × `flying`),
    // whose countdown starts once wave index 4 launches (the tick-1050 early call
    // above) and runs within this scenario's window. This build has no `antiair` —
    // only the two `slow` towers (now both-domain) ever touch it, and their small
    // direct hit (2 damage) never kills one outright before it reaches the exit — so
    // wave index 5 leaks in full.
    // M2-S10 P3: the bundle now carries a SEVENTH wave (index 6, 6 × `armored-flyer`,
    // air domain, armor 5) and an EIGHTH (index 7, boss + 8 × `normal`). This run's
    // fixed 1750-tick window is no longer terminal (six countdowns' worth of ticks
    // does not cover eight), so it now runs to terminal under `MAX_MATCH_TICKS`
    // instead of a hand-picked constant. **Measured, not predicted**: wave index 5's
    // leaks already drain lives to 2 (same as before), and wave index 6's
    // `armored-flyer` is untouched by the `basic` wall (ground-only) and shrugs off
    // the `slow` towers' 2-point hit against armor 5 (net 0 damage) — so it leaks
    // too, and the SECOND `armored-flyer` leak (spaced 20 ticks apart, each a
    // separate-tick leak, not a same-tick aggregate) drives lives from 1 to −1... but
    // the freeze at `lives <= 0` catches it exactly at **0**, not negative, because
    // `armored-flyer`'s own `leakCost` is 1: 2 lives, two 1-cost leaks, lands on 0.
    // The scenario's outcome FLIPS 'won' → 'lost' at that point (Story 10 Risk 1
    // ruling — reported for S11's balance pass, not tuned away): wave index 7 (the
    // boss) never even launches. `waveCursor` reaches 7 (wave index 6 launched) but
    // `waveResolved[6]` stays `false` — the run freezes mid-wave, before its
    // resolution completes.
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
      if (tick === 1050) out.push({ kind: 'callWaveEarly' }); // M2-S6: launches wave index 4 early (was a no-op through M2-S5a)
      return out;
    }

    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    // Mid-trace probe (Codex R2-3): a self-consistent golden alone cannot certify
    // the `slow` commands actually landed — this asserts some creep really carried
    // an active slow status at some tick during the run.
    let sawSlowedCreep = false;
    const { state, trace } = runScenarioUntilTerminal(inputs, (s) => {
      sawSlowedCreep ||= s.creeps.slowMulFp.some((mulFp) => mulFp !== 0);
    });
    expect(sawSlowedCreep).toBe(true);
    console.log(
      'parity.test.ts winning scenario: hash',
      hashSimState(state),
      'trace',
      fnv1a(trace.join(':')),
      'phase',
      state.phase,
      'tick',
      state.tick,
      'lives',
      state.lives,
      'waveResolved',
      state.waveResolved,
      'waveCursor',
      state.waveCursor,
      'cumulativeKillBounty',
      state.cumulativeKillBounty,
      'cumulativeEarlyCallCredit',
      state.cumulativeEarlyCallCredit,
      'bounty',
      state.bounty,
      'score',
      deriveScore(state, ruleset),
      'stars',
      deriveStars(state, ruleset),
    );

    // Terminal proof the `slow` placements survived (not sim-silently no-op'd):
    // two rows still carry `towerId === 'slow'`.
    const slowTowerCount = state.towers.towerId.filter((id) => id === 'slow').length;
    expect(slowTowerCount).toBe(2);

    // Re-pinned M2-S5a P5: the appended `armored` wave (index 3, `6 × armored`)
    // is now part of "every wave cleared" — the `basic` wall's DPS also clears it
    // (armor 6 against `basic`'s 10 still nets 4/hit, per P1), so the scenario
    // still WINS, just later (the wall must also grind through wave 3's armor).
    //
    // Re-pinned M2-S6 P5 — a SEMANTIC move, not a hash-only one. The bundle gains
    // a fifth wave (index 4: 6 × `resolute` + 6 × `fast`, clearBonus 7), and the
    // tick-1050 `callWaveEarly` above now launches it early instead of no-opping
    // (see the comment there). The `basic` wall also clears this wave (`resolute`
    // and `fast` both carry 0 armor, like `normal`/`fast`/`swarm` — `armored` is the
    // one pre-S6 exception, at armor 6), so
    // the scenario still WINS. Measured before (M2-S5a P5) → after (M2-S6 P5):
    //   tick                       1168 → 1198
    //   waveResolved.length           4 → 5   (both all-`true`)
    //   waveCursor                    4 → 5
    //   cumulativeKillBounty          60 → 84  (+24: wave index 4's 6×`resolute` + 6×`fast`, bounty 2 each)
    //   cumulativeEarlyCallCredit     11 → 13  (+2: the tick-1050 call's early-call credit, ⌊rem/50⌋)
    //   bounty                        73 → 106 (+24 kill bounty, +7 wave index 4's clearBonus, +2 early-call bounty)
    //   score                        421 → 447
    //   lives (unchanged)             10 → 10
    //   stars (unchanged)              3 → 3
    //
    // Re-pinned M2-S7 P6 — a SEMANTIC move, not a hash-only one (superseding the
    // hash-only note this comment used to carry, written before wave index 5 existed
    // in the bundle). The bundle gains a sixth wave (index 5: 8 × `flying`, clearBonus
    // 6), and its countdown starts once wave index 4 launches (the tick-1050 early
    // call), landing well inside this scenario's now-1750-tick window. This build has
    // no `antiair`; the two `slow` towers are the only thing in range that can touch
    // an air-domain creep at all (S7 widened `slow` to both-domain), and their 2-point
    // direct hit is nowhere near enough to kill an 18-HP `flying` creep before it
    // reaches the exit — so all 8 leak, costing 8 lives. The scenario still WINS
    // (every wave resolves — leaked counts as resolved, same as a kill), just on far
    // fewer lives. Measured before (M2-S6 P5) → after (M2-S7 P6):
    //   tick                       1198 → 1691
    //   waveResolved.length            5 → 6   (both all-`true`)
    //   waveCursor                     5 → 6
    //   cumulativeKillBounty          84 → 84  (unchanged: wave index 5 is leaked, not
    //                                            killed, so it contributes 0 kills)
    //   cumulativeEarlyCallCredit     13 → 13  (unchanged: no new early call — the
    //                                            tick-1050 call already spent itself
    //                                            launching wave index 4)
    //   bounty                       106 → 106 (unchanged: wave index 5's clear bonus
    //                                            is withheld because it leaked)
    //   lives                          10 → 2   (-8, one per leaked `flying` creep)
    //   score                         447 → 167  (84 + 13 + 2×35, down from 84+13+10×35)
    //   stars                          3 → 1
    // Re-pinned M2-S10 P3 — a SEMANTIC move, the outcome FLIP the packet's plan
    // warned about (Story 10 Risk 1 ruling: reported for S11's balance pass, never
    // tuned away). Measured, not predicted: wave index 6's `armored-flyer` — air
    // domain, armor 5, untouched by the ground-only `basic` wall and shrugging off
    // the `slow` towers' 2-point hit (net 0 damage against armor 5) — leaks in full,
    // same as wave index 5's `flying` before it. Lives are already down to 2 when
    // wave index 6 starts; its first two `armored-flyer` leaks (spaced 20 ticks
    // apart, each a separate-tick leak) drain lives 2 → 1 → 0, and the run FREEZES at
    // that instant (`lives <= 0` evaluated in RESOLUTION, `index.ts:1090`; every
    // later step is a no-op, `:857`) — before wave index 6 finishes launching its
    // remaining four `armored-flyer`, and long before wave index 7 (the boss) ever
    // launches. `waveResolved[6]` therefore stays `false` even though `waveCursor`
    // has advanced past it, and `waveResolved[7]` stays `false` too. `phase` flips
    // 'won' → 'lost': `cumulativeEarlyCallCredit` is forfeited under the lost-branch
    // score formula (kill-bounty only), so `deriveScore` drops from 167 to 84 even
    // though `cumulativeKillBounty` itself is unchanged (wave index 6 contributed 0
    // kills either way — it leaked, not died, under both the old 'won' outcome and
    // this one). Measured before (M2-S7 P6, 1750-tick fixed window) → after (M2-S10
    // P3, run to terminal under MAX_MATCH_TICKS):
    //   phase                        won → lost
    //   tick                        1691 → 1956
    //   waveResolved.length            6 → 8   ([t,t,t,t,t,t,f,f])
    //   waveCursor                     6 → 7
    //   cumulativeKillBounty           84 → 84  (unchanged: wave index 6 is leaked, not
    //                                             killed, so it contributes 0 kills)
    //   cumulativeEarlyCallCredit      13 → 13  (unchanged pre-terminal, but FORFEITED
    //                                             by the lost-branch score formula)
    //   bounty                        106 → 106 (unchanged: no clear bonus for a
    //                                             wave that leaked)
    //   lives                           2 → 0   (-2, two of wave index 6's six
    //                                             `armored-flyer` leak before freeze)
    //   score                         167 → 84  (kill-bounty only; the lost branch
    //                                             forfeits early-call credit and pays
    //                                             no survival term at all)
    //   stars                           1 → 0
    expect(hashSimState(state)).toBe('64880500');
    expect(fnv1a(trace.join(':'))).toBe('0437f228');
    expect(state.phase).toBe('lost');
    expect(state.lives).toBe(0);
    expect(state.tick).toBe(1956);
    // The run freezes mid-wave: wave index 6 (`armored-flyer`) launched (`waveCursor`
    // advanced past it) but never finished resolving, and wave index 7 (the boss)
    // never launched at all.
    expect(state.waveResolved).toEqual([true, true, true, true, true, true, false, false]);
    expect(state.waveCursor).toBe(7);
    // cumulativeKillBounty is unchanged from M2-S7 P6 (84): wave index 6 leaked, not
    // killed, same as wave index 5 before it. cumulativeEarlyCallCredit is also
    // unchanged pre-terminal (13, the same three early calls as before), but the
    // lost-branch score formula forfeits it entirely — see `deriveScore` below.
    expect(state.cumulativeKillBounty).toBe(84);
    expect(state.cumulativeEarlyCallCredit).toBe(13);
    expect(state.bounty).toBe(106);
    // Lost score formula: kill-bounty ONLY — no early-call credit, no survival term.
    expect(deriveScore(state, ruleset)).toBe(84);
    expect(deriveStars(state, ruleset)).toBe(0);
  });
});

// --- GOLDEN — the v2 rulesetHash of the shipped artifact -------------------------
// Recompute with: pnpm --filter @wynding/content exec vitest run parity
// A change here means the shipped artifact's CONTENT changed (or its normalized
// encoding did) — not a behavior change per se, but every deployed replay/leaderboard
// entry binds to this exact digest (ADR 0007 §3), so a change is never silent.
// Re-pinned M2-S9 P4: the shipped catalog gained the `mine` — a BURST tower, the first
// catalog entry whose `attack` carries a trigger range and no cadence at all. That is the
// ONLY bundle change in this story: no creep, wave or balance edit rides with it, and the
// mine is player-built so it cannot ship dark. A content-identity digest, so it moves
// whenever the bundle intentionally changes — independent of the world-hash goldens above,
// which do NOT move here (nothing in `SimState` or `Impact` changed shape at sv13).
// Re-pinned M2-S10 P3: the shipped catalog gains the `armored-flyer` and `boss` creeps,
// the `frost-splash` tower, and waves index 6/7 — the finale content. Moves for the same
// content-identity reason as every prior catalog addition.
const SHIPPED_RULESET_HASH = '310720258d380afa8e9472d11bba90dc09e72aa49180d6d78a7a9b68e48b552e';
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
