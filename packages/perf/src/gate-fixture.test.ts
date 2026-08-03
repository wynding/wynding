// gate-fixture.test.ts — the injected-regression fixture behind M2-S5b P11's switch of
// `stressStat` from p99 to p95 over the due-blast subset (PLAN.md step 21).
//
// WHAT THIS FILE IS FOR. Switching the gate's numerator statistic is only defensible if the
// new statistic still catches the regression the gate exists to catch. p95 discards more of
// the upper tail than p99 does, and "discards more tail" and "discards more signal" are the
// same operation viewed from two sides — so the switch needs evidence, not an argument.
// This fixture is that evidence: a pure, synthetic sample set with a KNOWN injected
// regression, run through both candidate statistics, with the comparison between them
// gated.
//
// It is deliberately sim-free. No replay, no harness, no `step()`. A real run cannot be
// asked "what would you look like with a 2% blast-cost regression?", so the regression has
// to be synthesised — and once it is synthetic, every parameter must be pinned in the file
// rather than tuned until the answer comes out right.
//
// EVERY PARAMETER BELOW WAS PINNED BEFORE THE RESULT WAS KNOWN, in PLAN.md step 21, which
// was itself reviewed across five adversarial rounds. Two deliberate deviations from the
// plan are marked `PLAN DEVIATION` and justified at their site. Do not retune anything here
// to change an outcome; the outcomes are assertions.

import { describe, it, expect } from 'vitest';
import { percentile } from './stats';
import { TOLERANCE, stressStat, stressStatP99 } from './gate';
import type { SampledTick } from './harness';

// --- The generator -----------------------------------------------------------------

/**
 * mulberry32, transcribed from its canonical form and pinned HERE rather than imported,
 * so this fixture cannot drift with a dependency. The plan pins it by pseudocode rather
 * than by name precisely so a mistranscription is catchable:
 *
 *     a = (a + 0x6D2B79F5) | 0
 *     t = imul(a ^ a>>>15, 1|a)
 *     t = (t + imul(t ^ t>>>7, 61|t)) ^ t
 *     return ((t ^ t>>>14) >>> 0) / 2**32
 *
 * Note the second line of `t`: the XOR is against the PREVIOUS `t`, not against `a`. That
 * is the exact spot a transcription goes wrong (it did, in an earlier draft of the plan's
 * own Python cross-check), which is why the seed-0 assertion below exists.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixture's own seed — arbitrary but FIXED, so every number in this file is
 *  reproducible by anyone who runs it. */
const FIXTURE_SEED = 0x5eedb1a5;

/** Sample count of the full sampled window (`harness.ts`'s `SAMPLE_TICKS`). */
const N_FULL = 2_500;
/** The CURRENT measured due-blast subset size, post-P9 (`pnpm run perf` reports 1427).
 *  PLAN DEVIATION: the plan says 1671, which was the PRE-P9 subset. P9 cut the
 *  AoE-producing tower population from 150 to 100, and the instrumented run now measures
 *  1427. The plan's own instruction was not to pin the post-P9 size until an instrumented
 *  run established it; it has, so this is that number rather than the stale one. */
const N_SUBSET_MEASURED = 1_427;
/** The oracle's permitted floor (`oracle.ts`'s `DUE_BLAST_SAMPLES_THRESHOLD`) — the
 *  smallest subset the gate is ever allowed to run on, exercised so the rule is tested at
 *  its worst legal sample size and not only at a comfortable one. */
const N_SUBSET_FLOOR = 500;

interface Fixture {
  readonly dueBlasts: readonly number[];
  readonly ms: readonly number[];
}

/**
 * Builds `n` samples. TWO INDEPENDENT DRAWS PER SAMPLE, in the order `u1` then `u2` —
 * sharing one draw would correlate `dueBlasts` with `ms`, which changes the broad-injection
 * outcome (a correlated fixture makes the injection land preferentially on already-slow
 * samples, flattering whichever statistic sits higher).
 *
 * `dueBlasts` is an exponential-ish shape clamped to 1..8, chosen to resemble the real
 * scene's per-tick blast count rather than a uniform draw. Base `ms` is uniform on
 * [0.100, 0.160).
 *
 * The HEAVY TAIL is the last 2% of samples generated, multiplied by 3.0 — standing in for
 * the GC/scheduler noise that `gate.ts`'s diagnosis names as the numerator's problem.
 *
 * 2%, NOT 1%, and this is exact rather than stylistic: `percentile` is nearest-rank, so at
 * n = 2500 p99 selects `ceil(0.99 * 2500) - 1` = index 2474. A 1% (25-sample) tail occupies
 * indices 2475..2499 — entirely ABOVE p99's rank, so p99 would never see the tail this
 * fixture exists to model. At 2% the tail spans 2450..2499: p99 lands INSIDE it and p95
 * (index 2374) sits BELOW it, which is exactly the contrast under test.
 */
function buildFixture(n: number): Fixture {
  const rand = mulberry32(FIXTURE_SEED);
  const dueBlasts: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = rand();
    const u2 = rand();
    const raw = 1 + Math.floor(-Math.log(Math.max(u1, 1e-9)) * 0.9);
    dueBlasts.push(Math.max(1, Math.min(8, raw)));
    ms.push(0.1 + u2 * 0.06);
  }
  const tailCount = Math.round(0.02 * n);
  for (let i = n - tailCount; i < n; i++) ms[i] = ms[i]! * 3.0;
  return { dueBlasts, ms };
}

/** Wraps a bare `ms` series as the `SampledTick[]` the SHIPPED gate functions take. Only
 *  `ms` is read by `stressStat`/`stressStatP99`; the rest is inert filler. */
function asSamples(ms: readonly number[]): SampledTick[] {
  return ms.map((m, i) => ({
    tick: i,
    ms: m,
    dueBlasts: 1,
    liveCreeps: 300,
    slowedCreeps: 100,
    phase: 'running' as const,
    dotTicks: 0,
    dotDropped: 0,
    dotRecords: 0,
    dotCarriers: 0,
    armoredLive: 0,
  }));
}

/** The two statistics under comparison, called THROUGH `gate.ts`'s real exports rather
 *  than recomputed here.
 *
 *  This indirection is the whole reason this fixture can gate anything (QC round 1 — an
 *  earlier draft of this file called `percentile(xs, 95)` directly and was PROVEN
 *  vacuous: replacing `stressStat`'s body with a MEDIAN — the statistic maximally blind
 *  to any tail regression, which would destroy the gate outright — left all ten tests in
 *  this file green. A fixture that re-declares the statistic it is meant to validate is
 *  testing its own arithmetic, not the shipped gate).
 *
 *  Every ratio below therefore measures the SENSITIVITY OF THE FUNCTION THAT SHIPS. Change
 *  `stressStat` to any statistic that discards this regression and the GATED block fails. */
const STATS = {
  gating: (ms: readonly number[]): number => stressStat(asSamples(ms)),
  audit: (ms: readonly number[]): number => stressStatP99(asSamples(ms)),
} as const;

/** `injected / baseline` for one of the two shipped statistics — the factor a regression
 *  multiplies it by. This IS the gate's own condition: `R = stressStat / controlStat`, so a
 *  regression scaling `stressStat` by X moves `R` from `R0` to `R0 * X`, and the gate fires
 *  when `X > TOLERANCE`. Nothing about `R0` enters, which is why this fixture can decide
 *  the statistic without knowing the baseline ratio. */
function ratio(
  injected: readonly number[],
  baseline: readonly number[],
  stat: (ms: readonly number[]) => number,
): number {
  return stat(injected) / stat(baseline);
}

/** `TOLERANCE` is imported from `gate.ts`, never hardcoded — if the gate's tolerance moves,
 *  this fixture's notion of "fires" must move with it or it stops testing the real gate. */
function fires(r: number): boolean {
  return r > TOLERANCE;
}

/** The smallest `k` in `ks` at which `stat` fires, or `Infinity` if it never does — so
 *  "p95 fires at the same k as p99 or a smaller one" is a plain `<=` on two numbers, with
 *  "never fires" ordering correctly as the worst possible sensitivity. */
function firingK(ks: readonly number[], ratioAt: (k: number) => number): number {
  for (const k of ks) if (fires(ratioAt(k))) return k;
  return Infinity;
}

const KS = [0.005, 0.01, 0.02] as const;

// --- The generator is what we think it is ------------------------------------------

describe('the generator itself, before anything is measured with it', () => {
  it('reproduces mulberry32 seed 0 — a mistranscription fails HERE, not silently downstream', () => {
    const rand = mulberry32(0);
    const seq = [rand(), rand(), rand()];
    // Verified in Node and independently reimplemented in Python; both agree to full
    // double precision (the third is 0.2232720274478197).
    //
    // PLAN DEVIATION: PLAN.md step 21 records the third value as `0.22327202731`. That is a
    // TYPO IN THE PLAN — the true value ends `...745`. The plan's literal was wrong in the
    // last two digits of the very assertion whose job is to catch wrong literals. Caught by
    // computing the sequence in two independent implementations before writing this test.
    expect(seq[0]!.toFixed(11)).toBe('0.26642920868');
    expect(seq[1]!.toFixed(11)).toBe('0.00032974570');
    expect(seq[2]!.toFixed(11)).toBe('0.22327202745');
  });

  it('produces the pinned fixture shape at the full sample count', () => {
    const { dueBlasts, ms } = buildFixture(N_FULL);
    expect(ms).toHaveLength(N_FULL);

    // Pinned as literals so a generator change that silently reshapes the fixture — a
    // different clamp, a shared draw, a moved tail — fails loudly instead of quietly
    // re-deciding the statistic.
    expect(percentile(ms, 50).toFixed(6)).toBe('0.130784');
    expect(percentile(ms, 95).toFixed(6)).toBe('0.158105');
    expect(percentile(ms, 99).toFixed(6)).toBe('0.388060');

    const mean = dueBlasts.reduce((a, b) => a + b, 0) / dueBlasts.length;
    expect(mean.toFixed(4)).toBe('1.4976');
    expect(Math.min(...dueBlasts)).toBe(1);
    expect(Math.max(...dueBlasts)).toBe(8);
  });

  it('places the heavy tail where p99 can see it and p95 cannot — the whole point of 2%', () => {
    const { ms } = buildFixture(N_FULL);
    // Nearest-rank ranks, recomputed here rather than asserted from memory.
    const p99Rank = Math.ceil(0.99 * N_FULL) - 1;
    const p95Rank = Math.ceil(0.95 * N_FULL) - 1;
    const tailStart = N_FULL - Math.round(0.02 * N_FULL);
    expect(p99Rank).toBe(2474);
    expect(p95Rank).toBe(2374);
    expect(tailStart).toBe(2450);
    // p99's rank sits INSIDE the tail's span; p95's sits below it. At a 1% tail
    // (tailStart 2475) p99's rank would fall below the tail and see nothing.
    expect(p99Rank).toBeGreaterThanOrEqual(tailStart);
    expect(p95Rank).toBeLessThan(tailStart);
    // And the tail is genuinely heavier: p99 lands in it, p95 does not.
    expect(percentile(ms, 99)).toBeGreaterThan(percentile(ms, 95) * 2);
  });
});

// --- GATED: the broad injection, the sole reversal condition -------------------------

describe('GATED — a broad blast-cost regression must not be discarded by p95', () => {
  // This is the ONLY condition that can reverse the p95 switch. A blast-cost regression is
  // broad by nature: it raises the cost of every tick that carries a due blast, which is
  // every sample in this subset by construction. `ms += k * dueBlasts` is that shape — cost
  // proportional to how much blast work the tick actually did.
  for (const n of [N_FULL, N_SUBSET_MEASURED, N_SUBSET_FLOOR]) {
    it(`n=${n}: p95 fires at the same k as p99 or smaller`, () => {
      const { dueBlasts, ms } = buildFixture(n);
      const broad = (k: number): number[] => ms.map((m, i) => m + k * dueBlasts[i]!);

      const k95 = firingK(KS, (k) => ratio(broad(k), ms, STATS.gating));
      const k99 = firingK(KS, (k) => ratio(broad(k), ms, STATS.audit));

      // THE REVERSAL CONDITION. If this fails, the switch is rejected and `stressStat`
      // stays p99 — it is not a threshold to relax.
      expect(k95).toBeLessThanOrEqual(k99);

      // And the measured outcome, pinned: p95 fires at k = 0.020 at EVERY subset size,
      // while p99 fires at NO tested k at ANY size. p95 is strictly MORE sensitive to this
      // regression, not less.
      expect(k95).toBe(0.02);
      expect(k99).toBe(Infinity);
    });
  }

  it('pins the actual ratios at the full sample count, so the margin is on record', () => {
    const { dueBlasts, ms } = buildFixture(N_FULL);
    const broad = (k: number): number[] => ms.map((m, i) => m + k * dueBlasts[i]!);
    // The mechanism, readable straight off these numbers: p99 sits INSIDE the 3x heavy tail
    // where the baseline is ~0.388ms, so an injection of at most 8 * 0.020 = 0.16ms is a
    // small relative move. p95 sits at ~0.158ms BELOW the tail, where the same absolute
    // cost is a much larger relative one. The tail does not just add noise to p99 — it
    // desensitises it.
    expect(ratio(broad(0.005), ms, STATS.gating).toFixed(4)).toBe('1.0583');
    expect(ratio(broad(0.01), ms, STATS.gating).toFixed(4)).toBe('1.1377');
    expect(ratio(broad(0.02), ms, STATS.gating).toFixed(4)).toBe('1.3553');
    expect(ratio(broad(0.005), ms, STATS.audit).toFixed(4)).toBe('1.0129');
    expect(ratio(broad(0.01), ms, STATS.audit).toFixed(4)).toBe('1.0329');
    expect(ratio(broad(0.02), ms, STATS.audit).toFixed(4)).toBe('1.0651');
  });
});

// --- REPORTED, never gating: the declared blind spot ---------------------------------

describe('REPORTED, not gated — what p95 gives up, measured rather than described', () => {
  // These cases are deliberately NOT gating. An earlier draft made a tail-only case a
  // rejection rule, and that rule was self-fulfilling: a top-2%-by-ms injection leaves p95
  // unchanged BY CONSTRUCTION (every injected sample already sits above p95's rank), so
  // "p99 fires and p95 does not" was guaranteed for any large enough injection. The rule
  // could only ever confirm itself. It is replaced by measurement.

  it('tail-only (top 2% by ms): p95 is EXACTLY unchanged — the blind spot, stated numerically', () => {
    const { dueBlasts, ms } = buildFixture(N_FULL);
    const order = [...ms.keys()].sort((a, b) => ms[a]! - ms[b]!);
    const top = new Set(order.slice(Math.floor(N_FULL * 0.98)));
    // Same `k * dueBlasts` shape as the broad injection — only the SELECTION differs, so
    // the two cases isolate "where the cost lands" and nothing else.
    const tailOnly = (k: number): number[] =>
      ms.map((m, i) => (top.has(i) ? m + k * dueBlasts[i]! : m));

    for (const k of KS) {
      // Exactly 1.0000 — not "approximately". The injection lands entirely above p95's
      // rank, so p95 cannot move by any amount of it. This is the honest shape of the
      // trade: p95's insensitivity to tail-concentrated cost IS the property that
      // suppresses tail noise. No test design separates the two.
      expect(ratio(tailOnly(k), ms, STATS.gating)).toBe(1);
      expect(fires(ratio(tailOnly(k), ms, STATS.audit))).toBe(false);
    }
  });

  it('workload-correlated at dueBlasts >= 7: near-vacuous, and the sample count says why', () => {
    const { dueBlasts, ms } = buildFixture(N_FULL);
    const selected = dueBlasts.filter((d) => d >= 7).length;
    // FOUR samples out of 2,500. The plan specified this threshold expecting it to model a
    // regression scaling with blast multiplicity, but the generator (and the real scene,
    // whose post-P9 max is 7) puts almost no mass up here. Reporting the SELECTED COUNT
    // beside the ratio is what makes the vacuity visible — a ratio near 1.0 alone would
    // read as "p95 is blind to this", when the truth is "this case tests almost nothing".
    expect(selected).toBe(4);
    const hi = (k: number): number[] =>
      ms.map((m, i) => (dueBlasts[i]! >= 7 ? m + k * dueBlasts[i]! : m));
    for (const k of KS) {
      expect(fires(ratio(hi(k), ms, STATS.gating))).toBe(false);
      expect(fires(ratio(hi(k), ms, STATS.audit))).toBe(false);
    }
  });

  it('workload-correlated at dueBlasts >= 3: p95 CATCHES it, p99 does not', () => {
    // PLAN DEVIATION, and it is the most consequential finding in this file. The plan
    // specifies only the `>= 7` variant above, which selects 4 samples and therefore
    // demonstrates nothing. This variant carries real mass (~11% of samples) and inverts
    // the plan's expectation: a workload-correlated regression concentrated on the
    // blast-heaviest ticks IS caught by p95, at k = 0.020, while p99 barely moves.
    //
    // So p95's blind spot is NARROWER than the plan assumed. It is specific to cost
    // concentrated in the top ~2% BY DURATION — i.e. co-located with the noise tail — and
    // not to workload-correlated regressions in general.
    const { dueBlasts, ms } = buildFixture(N_FULL);
    const selected = dueBlasts.filter((d) => d >= 3).length;
    expect(selected).toBe(270);
    const hi = (k: number): number[] =>
      ms.map((m, i) => (dueBlasts[i]! >= 3 ? m + k * dueBlasts[i]! : m));
    expect(ratio(hi(0.02), ms, STATS.gating).toFixed(4)).toBe('1.3553');
    expect(ratio(hi(0.02), ms, STATS.audit).toFixed(4)).toBe('1.0192');
    expect(fires(ratio(hi(0.02), ms, STATS.gating))).toBe(true);
    expect(fires(ratio(hi(0.02), ms, STATS.audit))).toBe(false);
  });
});
