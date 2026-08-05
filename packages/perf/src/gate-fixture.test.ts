// gate-fixture.test.ts — the injected-regression fixture behind the gate's numerator
// statistic. Originally M2-S5b P11's p99 -> p95 switch (PLAN.md step 21); extended at
// M2-S6 for the p95 -> p50 switch, which it validates the same way.
//
// WHAT THIS FILE IS FOR. Switching the gate's numerator statistic is only defensible if the
// new statistic still catches the regression the gate exists to catch. Each move discards
// more of the upper tail than the last, and "discards more tail" and "discards more signal"
// are the same operation viewed from two sides — so a switch needs evidence, not an
// argument. The M2-S6 move is the sharpest case: a median is the statistic a reader most
// expects to be blind, which is precisely why it is measured here rather than asserted.
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
import { TOLERANCE, stressStat, stressStatP95, stressStatP99 } from './gate';
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
 * The `u1` thresholds that shape `dueBlasts`, as PINNED DECIMAL LITERALS.
 *
 * The shape is `1 + floor(-ln(u1) * 0.9)` clamped to 1..8. That map is monotone
 * decreasing and piecewise constant, so it is exactly equivalent to comparing `u1`
 * against its own step boundaries: the value is `m` iff `exp(-m/0.9) < u1 <=
 * exp(-(m-1)/0.9)`, and 8 iff `u1 <= exp(-7/0.9)`. These are those seven boundaries,
 * `exp(-m/0.9)` for m = 1..7.
 *
 * WHY LITERALS AND NOT THE FORMULA. ECMA-262 specifies both `Math.log` and `Math.exp` as
 * implementation-APPROXIMATED — their last bits are not portable across engines or engine
 * versions. `Math.floor` then quantises that value, so a one-ulp difference could move a
 * sample across an integer boundary and shift the counts this file pins by value
 * (`mean` `'1.4976'`, `selected` 4, `selected` 270, and every `ratio` pin, since the
 * injection is `k * dueBlasts[i]`). Decimal-literal-to-double conversion, by contrast, IS
 * exactly specified, and the comparison below is a plain `>`. So computing these cuts here
 * would reintroduce exactly the portability hole it exists to close: they are pinned.
 *
 * Verified equivalent to the `Math.log` form it replaces, not assumed: both constructions
 * agree on every one of this fixture's own 2,500 draws and across a 3,000,000-sample
 * independent sweep. The distribution is therefore unchanged and no pinned figure moved —
 * this is a portability fix, not a retune. (The distribution SHAPE is not what this file
 * asserts; reproducibility is. But changing it would have invalidated the pins, so it was
 * held fixed deliberately.)
 */
const DUE_BLAST_CUTS = [
  0.32919298780790557, // exp(-1/0.9)
  0.10836802322189587, // exp(-2/0.9)
  0.03567399334725241, // exp(-3/0.9)
  0.01174362845702136, // exp(-4/0.9)
  0.0038659201394728076, // exp(-5/0.9)
  0.0012726338013398092, // exp(-6/0.9)
  0.0004189421234483841, // exp(-7/0.9)
] as const;

/**
 * Builds `n` samples. TWO INDEPENDENT DRAWS PER SAMPLE, in the order `u1` then `u2` —
 * sharing one draw would correlate `dueBlasts` with `ms`, which changes the broad-injection
 * outcome (a correlated fixture makes the injection land preferentially on already-slow
 * samples, flattering whichever statistic sits higher).
 *
 * `dueBlasts` is an exponential-ish shape clamped to 1..8 (`DUE_BLAST_CUTS`), chosen to
 * resemble the real scene's per-tick blast count rather than a uniform draw. Base `ms` is
 * uniform on [0.100, 0.160).
 *
 * The HEAVY TAIL is the last 2% of samples generated, multiplied by 3.0 — standing in for
 * the GC/scheduler noise that `gate.ts`'s diagnosis names as the numerator's problem.
 *
 * 2%, NOT 1%, and this is exact rather than stylistic: `percentile` is nearest-rank, so at
 * n = 2500 p99 selects `ceil(0.99 * 2500) - 1` = index 2474. A 1% (25-sample) tail occupies
 * indices 2475..2499 — entirely ABOVE p99's rank, so p99 would never see the tail this
 * fixture exists to model. At 2% the tail spans 2450..2499: p99 lands INSIDE it and p95
 * (index 2374) sits BELOW it.
 *
 * That p99-versus-p95 placement is the M2-S5b rationale, INHERITED not restated: the
 * contrast under test at M2-S6 is p50 versus p95, and the gating median (index 1249) sits
 * far below the tail under either 1% or 2%. The 2% choice is kept because the fixture still
 * reports p99 for audit and the tail must remain visible to it — changing it now would
 * invalidate every pin in this file for no gain.
 */
function buildFixture(n: number): Fixture {
  const rand = mulberry32(FIXTURE_SEED);
  const dueBlasts: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = rand();
    const u2 = rand();
    // Exact arithmetic only — see `DUE_BLAST_CUTS`. `ms` is safe as written: `0.1 + u2 *
    // 0.06` uses IEEE add and multiply, both exactly specified.
    let blasts = 8;
    for (let m = 1; m <= DUE_BLAST_CUTS.length; m++) {
      // Non-null assertion, not a bug: `m` runs 1..length, but `noUncheckedIndexedAccess`
      // widens every computed index to `| undefined` regardless — `as const` pins the
      // tuple's values and length, it does not narrow a computed lookup.
      if (u1 > DUE_BLAST_CUTS[m - 1]!) {
        blasts = m;
        break;
      }
    }
    dueBlasts.push(blasts);
    ms.push(0.1 + u2 * 0.06);
  }
  const tailCount = Math.round(0.02 * n);
  for (let i = n - tailCount; i < n; i++) ms[i] = ms[i]! * 3.0;
  return { dueBlasts, ms };
}

/** Wraps a bare `ms` series as the `SampledTick[]` the SHIPPED gate functions take. Only
 *  `ms` is read by `stressStat`/`stressStatP95`/`stressStatP99`; the rest is inert filler. */
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

/** The statistics under comparison, called THROUGH `gate.ts`'s real exports rather than
 *  recomputed here.
 *
 *  This indirection is the whole reason this fixture can gate anything (QC round 1 — an
 *  earlier draft called `percentile(xs, 95)` directly and was PROVEN vacuous: the shipped
 *  statistic could be replaced wholesale and all ten tests stayed green. A fixture that
 *  re-declares the statistic it is meant to validate is testing its own arithmetic, not
 *  the shipped gate).
 *
 *  THE WITNESS FOR THAT CLAIM HAD TO BE REPLACED AT M2-S6, and the reason is worth stating
 *  rather than quietly swapping. The original witness was "replace `stressStat`'s body with
 *  a MEDIAN — the statistic maximally blind to any tail regression, which would destroy the
 *  gate outright". A median is now exactly what ships, so that mutation proves nothing; and
 *  the parenthetical was wrong on its own terms, since the regression this fixture injects
 *  is BROAD, not tail-concentrated, and a median sees a broad shift in full (the pinned
 *  ratios below: p50 moves 1.0550 / 1.1082 / 1.2140 across the three injection sizes).
 *  The live witness is `gating: p99` — restoring the pre-S5b statistic makes `kGating`
 *  `Infinity` at n = 2,500 and the GATED block fails. Verified by mutation, not assumed.
 *
 *  Every ratio below therefore measures the SENSITIVITY OF THE FUNCTION THAT SHIPS. Change
 *  `stressStat` to any statistic that discards this regression and the GATED block fails. */
const STATS = {
  gating: (ms: readonly number[]): number => stressStat(asSamples(ms)),
  auditP95: (ms: readonly number[]): number => stressStatP95(asSamples(ms)),
  auditP99: (ms: readonly number[]): number => stressStatP99(asSamples(ms)),
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

// REFINED at M2-S6 from [0.005, 0.01, 0.02]. The coarse grid was not neutral: on a
// continuous sweep (step 1e-5, n = 2,500) p50 fires at 0.00922 and p95 at 0.00745, which the
// old grid rounded into the SAME bucket, making the two statistics look equally sensitive
// when they are not. A comparison grid that cannot separate the things being compared
// reports a tie by construction, so the extra points exist to make the gap visible rather
// than to move it.
//
// THE ADDED 0.0075 POINT SITS CLOSE TO ITS CROSSING, and that is disclosed rather than
// tuned away: p95's ratio there is 1.1013 against `TOLERANCE` 1.10, a 0.12% margin (0.21% at
// n = 1,427, 0.37% at n = 500). So `expect(k95).toBe(0.0075)` below, and with it the
// `kGating > k95` price assertion, would flip if `TOLERANCE` moved even slightly upward.
// That is a real fragility and the honest response is to say so. It is NOT resolved by
// nudging the point to 0.008, which would be retuning an outcome-bearing parameter to buy
// margin — the thing this file's header forbids. If `TOLERANCE` changes, re-derive the grid
// deliberately and re-record these pins; do not adjust them to keep the test green.
//
// WHAT A GRID READING IS AND IS NOT. `firingK` returns the smallest GRID POINT at which a
// statistic fires, so it is an upper bound on the true threshold, not the threshold — p50's
// 0.0100 below is the grid's nearest point above a true 0.0092. That is the right shape for
// an ORDERING assertion (which is all this file gates on) and the wrong shape for a
// magnitude: quoting these buckets as thresholds is exactly how `gate.ts` briefly came to
// claim a 2.00x end-to-end gain for what is 1.67x. Magnitudes live in `gate.ts`'s
// `stressStat` doc and are swept, not gridded.
const KS = [0.005, 0.0075, 0.01, 0.015, 0.02] as const;

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

describe('GATED — a broad blast-cost regression must not be discarded by the gating statistic', () => {
  // A NECESSARY SCREEN, NOT THE DECIDING TEST — and the distinction is the whole reason
  // the M2-S6 switch needed evidence this file structurally cannot provide.
  //
  // What this block does decide: the gating statistic must not be one that discards a
  // broad blast-cost regression. It rejects p99, a constant, and `Math.min` outright.
  // A blast-cost regression is broad by nature — it raises the cost of every tick
  // carrying a due blast, which is every sample in this subset by construction, and
  // `ms += k * dueBlasts` is that shape.
  //
  // What it CANNOT decide is p50 versus p95, and an earlier draft of this comment claimed
  // otherwise ("the ONLY condition that can reverse a statistic switch"). At equal
  // tolerance p95 is the MORE sensitive of the two — it fires at a strictly smaller k, as
  // the assertion below now pins — so on this test alone the switch would be REJECTED.
  // The switch rests instead on run-to-run CI variance (`gate.ts`'s table: +/-2.8% for
  // p50/p50 against +/-15.5% for the previously shipped p95/p50), which a deliberately sim-free
  // fixture has no way to see. The causal chain is: p50's low noise makes `TOLERANCE`
  // 1.10 affordable, and the tighter tolerance is what buys back sensitivity — p95 cannot
  // run at 1.10, because its own noise exceeds that threshold and it would false-alarm.
  //
  // These `k` values are read at the CURRENT `TOLERANCE`, imported and never restated.
  for (const n of [N_FULL, N_SUBSET_MEASURED, N_SUBSET_FLOOR]) {
    it(`n=${n}: the gating p50 fires at the same k as the superseded statistics or smaller`, () => {
      const { dueBlasts, ms } = buildFixture(n);
      const broad = (k: number): number[] => ms.map((m, i) => m + k * dueBlasts[i]!);

      const kGating = firingK(KS, (k) => ratio(broad(k), ms, STATS.gating));
      const k95 = firingK(KS, (k) => ratio(broad(k), ms, STATS.auditP95));
      const k99 = firingK(KS, (k) => ratio(broad(k), ms, STATS.auditP99));

      // THE SCREEN — AND ITS LIMIT, MEASURED. The gating statistic must catch this
      // regression no later than the p99 that gated before M2-S5b. But at `TOLERANCE` 1.10
      // p99 does not fire ANYWHERE on this grid at the two larger sample counts (its ratio
      // maxes at 1.0651 / 1.0765), so `k99` is `Infinity` there and `kGating <= k99` is
      // `x <= Infinity` — vacuously true. Pinning `k99` makes that visible instead of
      // letting the comparison read as though it were doing work. QC round 1 proved the
      // point: mutating `stressStat` to p99 produces six failures and NOT ONE of them is
      // this line — the `toBe` pins below are what actually reject a bad statistic.
      //
      // The screen is kept anyway, and only because it stops being vacuous at n = 500,
      // where p99 does fire and the comparison has content. Read it as the floor it is,
      // not as the test that decided the statistic.
      expect(k99).toBe(n === N_SUBSET_FLOOR ? 0.02 : Infinity);
      expect(kGating).toBeLessThanOrEqual(k99);

      // THE PRICE, PINNED AS A TESTED FACT rather than left in prose: at equal tolerance
      // the superseded p95 fires STRICTLY EARLIER than the gating median. The `>` is the
      // assertion; the two `toBe`s below pin WHICH grid points, so a future change that
      // moves either statistic's sensitivity fails here rather than drifting. The swept
      // magnitude of the gap is ~24% (0.00745 vs 0.00922, `KS`'s header) — NOT the ~33% the
      // grid points alone would suggest, which is why the number belongs in `gate.ts` and
      // only the ordering belongs here. See this block's header for why the switch is still
      // correct despite the cost (in one line: p95 cannot be run at this tolerance).
      expect(kGating).toBeGreaterThan(k95);
      expect(kGating).toBe(0.01);
      expect(k95).toBe(0.0075);
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
    expect(ratio(broad(0.005), ms, STATS.gating).toFixed(4)).toBe('1.0550');
    expect(ratio(broad(0.01), ms, STATS.gating).toFixed(4)).toBe('1.1082');
    expect(ratio(broad(0.02), ms, STATS.gating).toFixed(4)).toBe('1.2140');
    expect(ratio(broad(0.005), ms, STATS.auditP95).toFixed(4)).toBe('1.0583');
    expect(ratio(broad(0.01), ms, STATS.auditP95).toFixed(4)).toBe('1.1377');
    expect(ratio(broad(0.02), ms, STATS.auditP95).toFixed(4)).toBe('1.3553');
    expect(ratio(broad(0.005), ms, STATS.auditP99).toFixed(4)).toBe('1.0129');
    expect(ratio(broad(0.01), ms, STATS.auditP99).toFixed(4)).toBe('1.0329');
    expect(ratio(broad(0.02), ms, STATS.auditP99).toFixed(4)).toBe('1.0651');
  });
});

// --- REPORTED, never gating: the declared blind spot ---------------------------------

describe('REPORTED, not gated — what the gating median gives up, measured rather than described', () => {
  // These cases are deliberately NOT gating. An earlier draft made a tail-only case a
  // rejection rule, and that rule was self-fulfilling: a top-2%-by-ms injection leaves p95
  // unchanged BY CONSTRUCTION (every injected sample already sits above p95's rank), so
  // "p99 fires and p95 does not" was guaranteed for any large enough injection. The rule
  // could only ever confirm itself. It is replaced by measurement.

  it('tail-only (top 2% by ms): the gating p50 is EXACTLY unchanged — the blind spot, stated numerically', () => {
    const { dueBlasts, ms } = buildFixture(N_FULL);
    const order = [...ms.keys()].sort((a, b) => ms[a]! - ms[b]!);
    const top = new Set(order.slice(Math.floor(N_FULL * 0.98)));
    // Same `k * dueBlasts` shape as the broad injection — only the SELECTION differs, so
    // the two cases isolate "where the cost lands" and nothing else.
    const tailOnly = (k: number): number[] =>
      ms.map((m, i) => (top.has(i) ? m + k * dueBlasts[i]! : m));

    for (const k of KS) {
      // Exactly 1.0000 — not "approximately". The injection lands entirely above the
      // gating rank, so the statistic cannot move by any amount of it. This is the honest
      // shape of the trade: insensitivity to tail-concentrated cost IS the property that
      // suppresses tail noise. No test design separates the two.
      //
      // Unchanged by the M2-S6 move, and that is the point worth pinning: p95 was ALREADY
      // exactly 1.0000 here, so a median gives up nothing on this case that p95 had not
      // already given up. The blind spot is inherited, not introduced.
      expect(ratio(tailOnly(k), ms, STATS.gating)).toBe(1);
      expect(ratio(tailOnly(k), ms, STATS.auditP95)).toBe(1);
      expect(fires(ratio(tailOnly(k), ms, STATS.auditP99))).toBe(false);
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
      expect(fires(ratio(hi(k), ms, STATS.auditP95))).toBe(false);
      expect(fires(ratio(hi(k), ms, STATS.auditP99))).toBe(false);
    }
  });

  it('workload-correlated at dueBlasts >= 3: THE PRICE OF THE M2-S6 MOVE — p95 catches it, the gating p50 does not', () => {
    // PLAN DEVIATION, and it is the most consequential finding in this file — now doubly
    // so, because it is the one case where the M2-S6 switch to a median LOSES real
    // coverage. It is pinned rather than softened so the loss can never be discovered by
    // accident later.
    //
    // The `>= 7` variant above selects 4 samples and demonstrates nothing. This variant
    // carries real mass (270 of 2,500, ~11%) and models a regression scaling with blast
    // MULTIPLICITY — an O(n^2) in blast membership scanning would look like this.
    //
    // Measured at k = 0.020: p95 moves +35.5%, the gating p50 moves +2.2%, p99 +1.9%.
    // Against each statistic's own measured CI noise (see `gate.ts`'s table: +/-16.4% for
    // p95, +/-2.8% for p50) that is a signal-to-noise of 2.2 for p95 and 0.8 for p50 — so
    // p95 can detect this and the gating median genuinely cannot.
    //
    // WHY THE TRADE WAS STILL TAKEN, in one line: on the BROAD regression this gate
    // primarily exists to catch, the ratio reverses — at k = 0.010 p50's signal-to-noise
    // is 3.9 and p95's is 0.8, i.e. the statistic that catches THIS case cannot reliably
    // catch the main one, and false-alarms on quiet runners besides (the M2-S6 CI failure
    // at R = 1.8348 on byte-identical work). A gate that reliably catches the common case
    // beats one that unreliably catches both. The uncovered case stays REPORTED —
    // `stressStatP95` rides in every `PERF-REPORT` — so it is visible to a human reading a
    // suspicious run even though it no longer decides pass/fail.
    const { dueBlasts, ms } = buildFixture(N_FULL);
    const selected = dueBlasts.filter((d) => d >= 3).length;
    expect(selected).toBe(270);
    const hi = (k: number): number[] =>
      ms.map((m, i) => (dueBlasts[i]! >= 3 ? m + k * dueBlasts[i]! : m));
    // The p95 figure here is BIT-IDENTICAL to the broad injection's p95 at the same k
    // (`1.355343307084382`, pinned above) — not a copy-paste slip. The element at p95's
    // rank carries `dueBlasts >= 3` under either injection, so at THAT rank the two are
    // the same measurement. It follows that this case is not an independent demonstration
    // of p95 detecting concentration; what it independently shows is the GATING statistic
    // failing to, which is the point being pinned.
    expect(ratio(hi(0.02), ms, STATS.gating).toFixed(4)).toBe('1.0222');
    expect(ratio(hi(0.02), ms, STATS.auditP95).toFixed(4)).toBe('1.3553');
    expect(ratio(hi(0.02), ms, STATS.auditP99).toFixed(4)).toBe('1.0192');
    // The blind spot, asserted as an OUTCOME rather than described: the gate does not
    // fire, the superseded p95 would have. If a future change makes the gating statistic
    // catch this again, this line fails and the trade gets re-examined deliberately.
    expect(fires(ratio(hi(0.02), ms, STATS.gating))).toBe(false);
    expect(ratio(hi(0.02), ms, STATS.auditP95)).toBeGreaterThan(TOLERANCE);
  });
});
