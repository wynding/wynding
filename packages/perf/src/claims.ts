// claims.ts — the canonical table of perf-gate claims that exist in more than one file.
//
// WHY THIS EXISTS. `gate.ts`'s doc comments assert figures that are also copied into ADR
// 0005, `performance-spike.md`, `m2.md` and this package's tests. There was no canonical
// source for what those claims ARE — the prose was the source, in five copies — so a fix
// applied to one copy and not the others was a defect the maintainer had to catch by
// reading. Three of the seven P1s that motivated issue #86 were exactly that, and one
// cross-file pointer had already rotted in the wild before the issue was filed.
//
// WHAT THIS IS. One row per claim: the value, the basis it rests on, and every SITE that
// states it. `claims.test.ts` resolves every site, extracts the value stated there, and
// compares it to the row. Disagreement is a test failure; so is a site whose anchor no
// longer resolves. Anchor rot has to be LOUD, or the check itself rots vacuous.
//
// THE COVERAGE CONTRACT, stated as the obligation it is rather than as a hope. EVERY figure
// that appears in more than one of the guarded files belongs to a row, and EVERY occurrence
// of a rowed figure is a site of that row. A rowed claim with an unguarded restatement is
// the same defect as no row at all — the stale copy is exactly the one nobody edits. Review
// found both shapes present on the first pass (ten enumerated multi-file figures with no
// row, and five rowed figures whose second and third copies were unguarded); the fix was to
// close the gap, never to soften this paragraph to match it. A figure that genuinely lives
// in one file only is out of scope: the table exists for claims with copies.
//
// HOW TO CHANGE A NUMBER. Edit the row here, then every site it lists — the test tells you
// when you have missed one. Adding a new copy of an existing claim means adding a site to
// its row, not writing the number down twice.
//
// WHAT THIS IS NOT. It is not an input to the gate. `gate.ts` does not import this module
// and must not: the table READS the gate's world, it never influences it. `TOLERANCE` and
// `R0` remain the executable constants; their rows here are checked AGAINST them, so a
// divergence between the constant and the prose fails rather than silently redefining
// either.
//
// TURBO MUST SEE THE DOCS. A guard that reads files the build system does not hash is
// disarmed by its own cache: `@wynding/perf#test` declares the three doc paths in its
// `inputs` (root `turbo.json`) precisely so a docs-only edit busts this task's hash. Task-
// scoped, not `globalDependencies`, which would bust every task in the repo on any docs
// edit. If a doc path is added to a site below, add it there too.
//
// ANCHORS ARE NAMES, NEVER LINE NUMBERS. Line-number citations are this file set's
// demonstrated rot vector: ADR 0005 cited `gate.ts:917-923` for a block that had moved to
// 945-951 within the same PR that wrote the citation. Every site here names a block, a
// heading, or a distinctive phrase, and the anchor must occur EXACTLY ONCE in its file — an
// ambiguous anchor fails the same way a missing one does.

/** One place a claim is stated.
 *
 *  `anchor` must appear exactly once in `file`; the search for `pattern` starts at the end
 *  of that occurrence and runs for `within` characters (default below). `pattern` is a
 *  regular expression with exactly one capture group, which must capture the stated value
 *  and nothing else. */
export interface ClaimSite {
  /** Repo-relative path, POSIX separators. */
  readonly file: string;
  /** A stable, unique landmark in `file` — a block name, heading, or distinctive phrase. */
  readonly anchor: string;
  /** Regex source with exactly one capture group, applied after the anchor. */
  readonly pattern: string;
  /** Characters after the anchor to search. Defaults to `DEFAULT_SITE_WINDOW`. */
  readonly within?: number;
}

/** A single canonical claim and everywhere it is stated. */
export interface Claim {
  /** Stable identifier, used in test names and mutation diagnostics. */
  readonly id: string;
  /** What the claim says, in one line. */
  readonly claim: string;
  /** The canonical value, as the table holds it. */
  readonly value: string;
  /** Set when the claim is a quantity: sites are then compared NUMERICALLY, so `1.1` and
   *  `1.10` agree. Omitted for identifiers (run ids, commit heads, image names, block
   *  names), which are compared as exact strings. */
  readonly numeric?: number;
  /** What the value rests on — the measurement, derivation, or declaration behind it. */
  readonly basis: string;
  /** Every site that states this claim. */
  readonly sites: readonly ClaimSite[];
}

/** How far past an anchor a site's pattern is searched, when the site does not say. */
export const DEFAULT_SITE_WINDOW = 2500;

const GATE = 'packages/perf/src/gate.ts';
const GATE_TEST = 'packages/perf/src/gate.test.ts';
const FIXTURE_TEST = 'packages/perf/src/gate-fixture.test.ts';
const ORACLE = 'packages/perf/src/oracle.ts';
const ADR = 'docs/adr/0005-performance-budgets.md';
const SPIKE = 'docs/design-notes/performance-spike.md';
const M2 = 'docs/milestones/m2.md';

export const CLAIMS: readonly Claim[] = [
  // ---------------------------------------------------------------------------------------
  // THE GATE'S COMMITTED CONSTANTS
  // ---------------------------------------------------------------------------------------
  {
    id: 'tolerance',
    claim: '`TOLERANCE` — the multiplier applied to `R0` to form the ceiling',
    value: '1.10',
    numeric: 1.1,
    basis:
      "declared before the baseline was recorded, from the statistic's measured +/- 2.8% run-to-run spread",
    sites: [
      { file: GATE, anchor: 'export const TOLERANCE =', pattern: '^\\s*([\\d.]+);', within: 40 },
      {
        file: GATE_TEST,
        anchor: "describe\\('TOLERANCE'",
        pattern: 'expect\\(TOLERANCE\\)\\.toBe\\(([\\d.]+)\\)',
      },
      {
        file: ADR,
        anchor: '\\*\\*`TOLERANCE` 1\\.25 .',
        pattern: '\\s*([\\d.]+), declared before',
      },
      {
        file: SPIKE,
        anchor: 'the numerator moved again to',
        pattern: '`TOLERANCE` tightened \\*\\*1\\.25 . ([\\d.]+)\\*\\*',
      },
      { file: M2, anchor: 'The numerator is now', pattern: '`TOLERANCE` is ([\\d.]+)' },
    ],
  },
  {
    id: 'r0',
    claim: '`R0` — the committed baseline ratio',
    value: '1.00',
    numeric: 1.0,
    basis: 'the median of the 17-attempt cohort, rounded DOWN to the nearer hundredth',
    sites: [
      {
        file: GATE,
        anchor: 'export const R0: number \\| null =',
        pattern: '^\\s*([\\d.]+);',
        within: 40,
      },
      {
        file: GATE_TEST,
        anchor: 'not the stale 1\\.42 from the superseded',
        pattern: 'expect\\(R0\\)\\.toBe\\(([\\d.]+)\\)',
      },
      {
        file: ADR,
        anchor: '\\*\\*RECORDED 2026-08-05:',
        pattern: '`R0` = ([\\d.]+) \\(PROVISIONAL\\)',
      },
      {
        file: SPIKE,
        anchor: 'the numerator moved again to',
        pattern: '`R0` re-recorded at\\s*\\n\\*\\*([\\d.]+)\\*\\*',
      },
      { file: M2, anchor: 'The numerator is now', pattern: '`R0` is ([\\d.]+)' },
    ],
  },
  {
    id: 'ceiling',
    claim: 'the gate ceiling — the largest `R` that passes',
    value: '1.1000',
    numeric: 1.1,
    basis: '`R0` x `TOLERANCE`, computed by `evaluateGate`',
    sites: [
      { file: GATE, anchor: 'giving a ceiling of', pattern: '\\*\\*([\\d.]+)\\*\\*' },
      {
        file: GATE,
        anchor: 'against a\\s*\\n \\*     ceiling of',
        pattern: '\\*\\*([\\d.]+)\\*\\*',
      },
      {
        file: GATE_TEST,
        anchor: 'with TOLERANCE, yields the',
        pattern: '([\\d.]+) ceiling the provenance doc records',
        within: 80,
      },
      { file: ADR, anchor: '\\*\\*RECORDED 2026-08-05:', pattern: 'ceiling \\*\\*([\\d.]+)\\*\\*' },
      {
        file: ADR,
        anchor: 'purely descriptive margin',
        pattern: 'against a \\*\\*([\\d.]+)\\*\\* ceiling',
      },
      {
        file: ADR,
        anchor: 'though not _forced_, since any sample above',
        pattern: '\\s*([\\d.]+)',
      },
      {
        file: ADR,
        anchor: 'moved the numerator to p50, `TOLERANCE` to 1\\.10',
        pattern: '\\(ceiling ([\\d.]+)\\)',
      },
      {
        file: ADR,
        anchor: 'is now p50, `TOLERANCE` is 1\\.10, and `R0` is 1\\.00',
        pattern: '\\(ceiling ([\\d.]+),',
      },
      {
        file: ADR,
        anchor: 'let the CI perf job on the PR be the real gate',
        pattern: 'ceiling `([\\d.]+)`',
      },
      {
        file: ADR,
        anchor: '\\*\\*The smoke run, 2026-08-06, local:\\*\\*',
        pattern: 'against the ([\\d.]+) ceiling',
      },
      {
        file: ADR,
        anchor: 'and `R0`, `TOLERANCE` \\(1\\.10\\), and the ceiling',
        pattern: '\\(([\\d.]+)\\)',
      },
      {
        file: SPIKE,
        anchor: 'the numerator moved again to',
        pattern: '\\(ceiling \\*\\*([\\d.]+)\\*\\*',
      },
      {
        file: SPIKE,
        anchor: 'was re-recorded at \\*\\*1\\.00\\*\\* \\(ceiling',
        pattern: '\\s*\\n([\\d.]+)\\)',
      },
      { file: M2, anchor: 'The numerator is now', pattern: '\\(ceiling ([\\d.]+),' },
      {
        file: M2,
        anchor: '`TOLERANCE` \\(1\\.10\\), and the ceiling',
        pattern: '\\s*\\n\\s*\\(([\\d.]+)\\)',
      },
    ],
  },
  {
    id: 'due-blast-floor',
    claim: 'the minimum number of due-blast samples the statistic requires',
    value: '500',
    numeric: 500,
    basis: 'predeclared before any measurement, alongside both statistics and the tolerance',
    sites: [
      {
        file: ORACLE,
        anchor: 'export const DUE_BLAST_SAMPLES_THRESHOLD =',
        pattern: '^\\s*(\\d+);',
        within: 40,
      },
      {
        file: GATE,
        anchor: 'an empty subset is an oracle failure',
        pattern: '`DUE_BLAST_SAMPLES_THRESHOLD`, (\\d+)\\)',
      },
      {
        file: FIXTURE_TEST,
        anchor: "The oracle's permitted floor",
        pattern: 'N_SUBSET_FLOOR = (\\d+)',
      },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE FOUR-RUN DIAGNOSTIC COHORT — what the STATISTIC and TOLERANCE rest on
  // ---------------------------------------------------------------------------------------
  {
    id: 'half-spread-p50',
    claim: "the ratio's half-spread over four byte-identical CI runs with MATCHED MEDIANS",
    value: '2.8',
    numeric: 2.8,
    basis: 'measured; the figure the 1.10 tolerance is chosen against',
    sites: [
      {
        file: GATE,
        anchor: '\\| p50\\(subset\\) / p50\\(control\\) \\|',
        pattern: '\\+/-\\s*([\\d.]+)%',
      },
      { file: GATE, anchor: 'rests on\\s*\\n \\*  the', pattern: '\\+/- ([\\d.]+)% row' },
      { file: GATE, anchor: 'because matched medians swing', pattern: '\\+/- ([\\d.]+)%' },
      {
        file: GATE,
        anchor: '\\(four rows, all n = 4\\); comparing its',
        pattern: '\\s*([\\d.]+)%',
      },
      { file: ADR, anchor: 'so do not read 31\\.1% against', pattern: '.([\\d.]+)%' },
      { file: ADR, anchor: 'matched medians give', pattern: '\\*\\*.([\\d.]+)%\\*\\* half-spread' },
      {
        file: ADR,
        anchor: 'must be derived from the\\s*\\n\\s*unrounded 2\\.758%, not the published',
        pattern: '\\s*([\\d.]+)%',
      },
      {
        file: SPIKE,
        anchor: 'the difference is the point: measured over four',
        pattern: 'and .([\\d.]+)% with matched medians',
      },
      {
        file: SPIKE,
        anchor: 'the limit that move REDUCES',
        pattern: '([\\d.]+)% is a much smaller residue',
      },
      {
        file: SPIKE,
        anchor: 'Measured over four consecutive byte-identical CI runs',
        pattern: 'and .([\\d.]+)% with matched medians',
      },
      {
        file: M2,
        anchor: 'four byte-identical runs, `R` swings',
        pattern: 'and .([\\d.]+)% under p50/p50',
      },
      {
        file: FIXTURE_TEST,
        anchor: "run-to-run CI variance \\(`gate\\.ts`'s table:",
        pattern: '\\+/-([\\d.]+)% for',
      },
      {
        file: FIXTURE_TEST,
        anchor: "own measured CI noise \\(see `gate\\.ts`'s table:",
        pattern: 'p95, \\+/-([\\d.]+)% for p50',
      },
    ],
  },
  {
    id: 'half-spread-p95-p50',
    claim: "the ratio's half-spread over the same four runs under the SUPERSEDED p95/p50 pairing",
    value: '15.5',
    numeric: 15.5,
    basis: 'measured; the noise level that made a 1.25 tolerance necessary',
    sites: [
      {
        file: GATE,
        anchor: '\\| p95\\(subset\\) / p50\\(control\\) \\|',
        pattern: '\\+/-\\s*([\\d.]+)%',
      },
      { file: ADR, anchor: 'over the same four runs, against', pattern: '.([\\d.]+)%' },
      {
        file: SPIKE,
        anchor: 'the difference is the point: measured over four',
        pattern: '.([\\d.]+)% with a tail numerator',
      },
      {
        file: SPIKE,
        anchor: 'Measured over four consecutive byte-identical CI runs',
        pattern: '.([\\d.]+)% with a tail',
      },
      {
        file: M2,
        anchor: 'four byte-identical runs, `R` swings',
        pattern: '.([\\d.]+)% under p95/p50',
      },
      {
        file: FIXTURE_TEST,
        anchor: "run-to-run CI variance \\(`gate\\.ts`'s table:",
        pattern: 'against \\+/-([\\d.]+)% for the previously shipped',
      },
    ],
  },
  {
    id: 'half-spread-p95-p95',
    claim: "the ratio's half-spread over the same four runs under a like-for-like p95/p95 pairing",
    value: '16.4',
    numeric: 16.4,
    basis: 'measured; why matching percentiles is not what makes the ratio quiet',
    sites: [
      {
        file: GATE,
        anchor: '\\| p95\\(subset\\) / p95\\(control\\) \\|',
        pattern: '\\+/-\\s*([\\d.]+)%',
      },
      { file: ADR, anchor: 'is \\*\\*p95/p95 against p99/p99\\*\\*', pattern: '\\(([\\d.]+)% vs' },
      {
        file: ADR,
        anchor: 'for the previously shipped p95/p50 and',
        pattern: '.([\\d.]+)% for a like-for-like',
      },
      {
        file: ADR,
        anchor: 'p95 cannot be run at 1\\.10, because its own',
        pattern: '.([\\d.]+)% spread exceeds',
      },
      {
        file: SPIKE,
        anchor: 'nearest offering, p95/p95 against p99/p99',
        pattern: '\\(([\\d.]+)% vs',
      },
      { file: M2, anchor: 'nearest offering \\(p95/p95', pattern: '\\s*([\\d.]+)% against' },
      {
        file: FIXTURE_TEST,
        anchor: "own measured CI noise \\(see `gate\\.ts`'s table:",
        pattern: '\\+/-([\\d.]+)% for',
      },
    ],
  },
  {
    id: 'half-spread-p99-p99',
    claim: "the ratio's half-spread over the same four runs under a like-for-like p99/p99 pairing",
    value: '11.7',
    numeric: 11.7,
    basis: 'measured; it refutes the earlier "a p99/p99 ratio swings only +/- 0.7%" claim',
    sites: [
      {
        file: GATE,
        anchor: '\\| p99\\(subset\\) / p99\\(control\\) \\|',
        pattern: '\\+/-\\s*([\\d.]+)%',
      },
      { file: ADR, anchor: 'is \\*\\*p95/p95 against p99/p99\\*\\*', pattern: 'vs ([\\d.]+)%\\)' },
      {
        file: SPIKE,
        anchor: 'nearest offering, p95/p95 against p99/p99',
        pattern: 'vs ([\\d.]+)%\\)',
      },
      { file: M2, anchor: 'nearest offering \\(p95/p95', pattern: 'p99/p99 ([\\d.]+)%' },
    ],
  },
  {
    id: 'p50-ratio-min',
    claim: 'the smallest `R` in the four-run diagnostic cohort under p50/p50',
    value: '0.9938',
    numeric: 0.9938,
    basis: "run 2's stress p50 over its control p50; the low end of the +/- 2.8% half-spread",
    sites: [
      {
        file: GATE,
        anchor: '\\| p50\\(subset\\) / p50\\(control\\) \\|',
        pattern: '[\\d.]+ ([\\d.]+) [\\d.]+ [\\d.]+',
      },
      { file: ADR, anchor: 'matched medians give', pattern: 'half-spread \\(([\\d.]+)' },
    ],
  },
  {
    id: 'observed-max',
    claim: 'the largest `R` ever observed under the p50/p50 statistic, across both cohorts',
    value: '1.0493',
    numeric: 1.0493,
    basis: "the four diagnostic runs of 2026-08-03/05, whose max exceeds the 17-attempt cohort's",
    sites: [
      {
        file: GATE,
        anchor: '\\| p50\\(subset\\) / p50\\(control\\) \\|',
        pattern: '[\\d.]+ [\\d.]+ [\\d.]+ ([\\d.]+)',
      },
      {
        file: GATE,
        anchor: 'purely descriptive margin',
        pattern: 'across BOTH readings on record, is \\*\\*([\\d.]+)\\*\\*',
      },
      {
        file: ADR,
        anchor: 'matched medians give',
        pattern: 'half-spread \\([\\d.]+ . ([\\d.]+)\\)',
      },
      {
        file: ADR,
        anchor: 'purely descriptive margin',
        pattern: 'across BOTH readings on record, is \\*\\*([\\d.]+)\\*\\*',
      },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE FOUR-RUN PER-ARM TABLE — the eight endpoints the reconstruction is pinned by,
  // and the per-arm dispersion figures ADR 0005 derives from them.
  // ---------------------------------------------------------------------------------------
  {
    id: 'arm-control-p50-min',
    claim: 'control p50 minimum across the four diagnostic runs (run 4)',
    value: '0.3128',
    numeric: 0.3128,
    basis: 'one of the eight recorded endpoints that pin the per-arm reconstruction',
    sites: [
      { file: GATE, anchor: '\\|  4  \\|', pattern: '\\s*([\\d.]+)\\s*\\|' },
      { file: ADR, anchor: '\\| control p50\\s+\\|', pattern: '\\s*([\\d.]+) .' },
    ],
  },
  {
    id: 'arm-control-p50-max',
    claim: 'control p50 maximum across the four diagnostic runs (run 2)',
    value: '0.4102',
    numeric: 0.4102,
    basis: 'one of the eight recorded endpoints that pin the per-arm reconstruction',
    sites: [
      { file: GATE, anchor: '\\|  2  \\|', pattern: '\\s*([\\d.]+)\\s*\\|' },
      { file: ADR, anchor: '\\| control p50\\s+\\|', pattern: '[\\d.]+ . ([\\d.]+)' },
    ],
  },
  {
    id: 'arm-stress-p50-min',
    claim: 'stress p50 minimum across the four diagnostic runs (run 4)',
    value: '0.3282',
    numeric: 0.3282,
    basis: 'one of the eight recorded endpoints that pin the per-arm reconstruction',
    sites: [
      {
        file: GATE,
        anchor: '\\|  4  \\|',
        pattern: '\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)\\s*\\|',
      },
      { file: ADR, anchor: '\\| stress p50\\s+\\|', pattern: '\\s*([\\d.]+) .' },
    ],
  },
  {
    id: 'arm-stress-p50-max',
    claim: 'stress p50 maximum across the four diagnostic runs (run 3)',
    value: '0.4114',
    numeric: 0.4114,
    basis: 'one of the eight recorded endpoints that pin the per-arm reconstruction',
    sites: [
      {
        file: GATE,
        anchor: '\\|  3  \\|',
        pattern: '\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)\\s*\\|',
      },
      { file: ADR, anchor: '\\| stress p50\\s+\\|', pattern: '[\\d.]+ . ([\\d.]+)' },
    ],
  },
  {
    id: 'arm-control-p95-min',
    claim: 'control p95 minimum across the four diagnostic runs (run 4)',
    value: '0.6824',
    numeric: 0.6824,
    basis: 'one of the eight recorded endpoints that pin the per-arm reconstruction',
    sites: [
      { file: GATE, anchor: '\\|  4  \\|', pattern: '\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)\\s*\\|' },
      { file: ADR, anchor: '\\| control p95\\s+\\|', pattern: '\\s*([\\d.]+) .' },
    ],
  },
  {
    id: 'arm-stress-p95-min',
    claim: 'stress p95 minimum across the four diagnostic runs (run 1)',
    value: '0.5193',
    numeric: 0.5193,
    basis: 'one of the eight recorded endpoints that pin the per-arm reconstruction',
    sites: [
      {
        file: GATE,
        anchor: '\\|  1  \\|',
        pattern: '\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)\\s*\\|',
      },
      { file: ADR, anchor: '\\| stress p95\\s+\\|', pattern: '\\s*([\\d.]+) .' },
    ],
  },
  {
    id: 'arm-stress-p95-max',
    claim: 'stress p95 maximum across the four diagnostic runs (run 2)',
    value: '0.7188',
    numeric: 0.7188,
    basis: 'one of the eight recorded endpoints that pin the per-arm reconstruction',
    sites: [
      {
        file: GATE,
        anchor: '\\|  2  \\|',
        pattern: '\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)\\s*\\|',
      },
      { file: ADR, anchor: '\\| stress p95\\s+\\|', pattern: '[\\d.]+ . ([\\d.]+)' },
    ],
  },
  {
    id: 'arm-control-p95-max-recorded',
    claim: 'control p95 maximum AS RECORDED — the endpoint the reconstruction misses',
    value: '1.1747',
    numeric: 1.1747,
    basis:
      "ADR 0005's per-arm range table; `gate.ts`'s per-run cell is the reconstruction, not this",
    sites: [
      { file: GATE, anchor: 'comes out 1\\.17462 against a recorded', pattern: '\\s*([\\d.]+)' },
      { file: ADR, anchor: '\\| control p95\\s+\\|', pattern: '[\\d.]+ . ([\\d.]+)' },
      { file: ADR, anchor: "this table's control-p95 max,", pattern: '\\s*([\\d.]+),' },
    ],
  },
  {
    id: 'arm-control-p95-max-reconstructed',
    claim: 'control p95 maximum AS RECONSTRUCTED — one in the last place off the recorded value',
    value: '1.17462',
    numeric: 1.17462,
    basis: 'what independently rounding three 4 dp inputs costs; worst endpoint error 7.6e-5',
    sites: [
      { file: GATE, anchor: "p95's max, comes out", pattern: '\\s*([\\d.]+) against' },
      {
        file: ADR,
        anchor: 'the reconstruction misses one endpoint',
        pattern: 'comes\\s*\\n\\s*out ([\\d.]+)\\)',
      },
    ],
  },
  {
    id: 'arm-stress-p95-run3',
    claim: "the numerator before the M2-S6 CI failure — run 3's stress p95",
    value: '0.5753',
    numeric: 0.5753,
    basis: 'the pair that showed the numerator barely moved while the denominator ran 23% faster',
    sites: [
      {
        file: GATE,
        anchor: '\\|  3  \\|',
        pattern: '\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)\\s*\\|',
      },
      { file: ADR, anchor: 'and the numerator barely moved \\(', pattern: '([\\d.]+) .' },
      { file: SPIKE, anchor: 'the numerator unmoved \\(', pattern: '([\\d.]+) .' },
    ],
  },
  {
    id: 'arm-stress-p95-run4',
    claim: "the numerator after the M2-S6 CI failure — run 4's stress p95",
    value: '0.5739',
    numeric: 0.5739,
    basis: 'the same pair, read on the failing run',
    sites: [
      {
        file: GATE,
        anchor: '\\|  4  \\|',
        pattern: '\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)\\s*\\|',
      },
      {
        file: ADR,
        anchor: 'and the numerator barely moved \\(',
        pattern: '[\\d.]+ . ([\\d.]+)\\)',
      },
      { file: SPIKE, anchor: 'the numerator unmoved \\(', pattern: '[\\d.]+ . ([\\d.]+)\\)' },
    ],
  },
  {
    id: 'per-arm-half-spread-control-p50',
    claim: "control p50's per-arm half-spread under this file's declared convention",
    value: '12.31',
    numeric: 12.31,
    basis: 'computed from the per-run table on a median basis, not a midpoint one',
    sites: [
      {
        file: GATE,
        anchor: 'the per-arm figures are control\\s*\\n \\*  p50',
        pattern: '\\s*([\\d.]+)%',
      },
      { file: ADR, anchor: 'against control p50', pattern: '\\s*([\\d.]+)%' },
    ],
  },
  {
    id: 'per-arm-half-spread-control-p95',
    claim: "control p95's per-arm half-spread under the same convention",
    value: '31.41',
    numeric: 31.41,
    basis: 'computed from the per-run table on a median basis, not a midpoint one',
    sites: [
      { file: GATE, anchor: 'p50 12\\.31%, control p95', pattern: '\\s*([\\d.]+)%' },
      { file: ADR, anchor: 'the per-arm half-spread \\(control p95', pattern: '\\s*([\\d.]+)%' },
    ],
  },
  {
    id: 'per-arm-half-spread-stress-p50',
    claim: "stress p50's per-arm half-spread under the same convention",
    value: '10.50',
    numeric: 10.5,
    basis: 'computed from the per-run table on a median basis, not a midpoint one',
    sites: [
      { file: GATE, anchor: 'control p95 31\\.41%, stress p50', pattern: '\\s*([\\d.]+)%' },
      { file: ADR, anchor: 'against stress p50', pattern: '\\s*([\\d.]+)%' },
    ],
  },
  {
    id: 'per-arm-half-spread-stress-p95',
    claim: "stress p95's per-arm half-spread under the same convention",
    value: '17.35',
    numeric: 17.35,
    basis: 'unrounded; off the printed 4 dp cells it computes to 17.36, which is the caveat',
    sites: [
      {
        file: GATE,
        anchor: "stress p95's per-arm half-spread is",
        pattern: '\\s*([\\d.]+)% unrounded',
      },
      { file: GATE, anchor: 'stress p50 10\\.50%, stress p95', pattern: '\\s*([\\d.]+)%' },
      { file: ADR, anchor: '; stress p95', pattern: '\\s*([\\d.]+)%' },
    ],
  },
  {
    id: 'tail-multiplier-lo',
    claim: 'the low end of how much larger the tails are than the medians, per arm',
    value: '1.65',
    numeric: 1.65,
    basis: 'control p50 12.31% against stress p95 17.35%, on the declared convention',
    sites: [
      { file: GATE, anchor: 'stress p95 17\\.35% — tails', pattern: '\\s*([\\d.]+)x' },
      { file: ADR, anchor: 'so more survives the division —', pattern: '\\*\\*([\\d.]+).' },
      { file: SPIKE, anchor: 'while the tails are', pattern: '\\s*([\\d.]+).' },
    ],
  },
  {
    id: 'tail-multiplier-hi',
    claim: 'the high end of the same multiplier',
    value: '2.55',
    numeric: 2.55,
    basis: 'control p95 31.41% against control p50 12.31%; the "~2.5x" an earlier draft deleted',
    sites: [
      { file: GATE, anchor: 'stress p95 17\\.35% — tails 1\\.65x-', pattern: '([\\d.]+)x' },
      {
        file: ADR,
        anchor: 'so more survives the division — \\*\\*1\\.65.',
        pattern: '([\\d.]+).\\*\\*',
      },
      { file: SPIKE, anchor: 'while the tails are 1\\.65.', pattern: '([\\d.]+).' },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // SENSITIVITY — the swept `k` values and what they buy
  // ---------------------------------------------------------------------------------------
  {
    id: 'k-new',
    claim: "the injection strength at which the gating p50 fires on the fixture's broad injection",
    value: '0.00922',
    numeric: 0.00922,
    basis: "a continuous sweep at step 1e-5, NOT `gate-fixture.test.ts`'s `KS` grid",
    sites: [
      {
        file: GATE,
        anchor: "`gate-fixture\\.test\\.ts`'s broad injection at k =",
        pattern: '\\s*([\\d.]+) where',
      },
      {
        file: GATE,
        anchor: 'the swept crossings are 0\\.00745 and',
        pattern: '\\s*\\n// ([\\d.]+)\\.',
      },
      { file: GATE, anchor: 'it is 1\\.67x \\(k = 0\\.01536 ->', pattern: '\\s*([\\d.]+)\\)' },
      {
        file: ADR,
        anchor: 'at equal tolerance the median is the LESS sensitive',
        pattern: 'k = ([\\d.]+) on',
      },
      { file: ADR, anchor: 'old gate k = 0\\.01536, new gate k =', pattern: '\\s*([\\d.]+),' },
      { file: M2, anchor: 'The end-to-end sensitivity gain is', pattern: '. ([\\d.]+), swept\\)' },
      {
        file: FIXTURE_TEST,
        anchor: 'continuous sweep \\(step 1e-5',
        pattern: 'p50 fires at ([\\d.]+)',
      },
      { file: FIXTURE_TEST, anchor: 'the gap is ~24% \\(0\\.00745 vs', pattern: '\\s*([\\d.]+),' },
    ],
  },
  {
    id: 'k-new-p95',
    claim: 'the injection strength at which the SUPERSEDED p95 fires on the same broad injection',
    value: '0.00745',
    numeric: 0.00745,
    basis: 'the same continuous sweep; p95 is the MORE sensitive statistic at equal tolerance',
    sites: [
      { file: GATE, anchor: 'where p95 fires at', pattern: '\\s*([\\d.]+)' },
      { file: GATE, anchor: 'the swept crossings are', pattern: '\\s*([\\d.]+) and' },
      { file: ADR, anchor: 'broad injection where p95 fires at', pattern: '\\s*([\\d.]+),' },
      {
        file: FIXTURE_TEST,
        anchor: 'p50 fires at 0\\.00922 and p95 at',
        pattern: '\\s*([\\d.]+),',
      },
      { file: FIXTURE_TEST, anchor: 'the gap is ~24% \\(', pattern: '([\\d.]+) vs' },
    ],
  },
  {
    id: 'k-gap-pct',
    claim: 'how much larger a regression the gating median needs than the statistic it replaced',
    value: '24',
    numeric: 24,
    basis: 'k(p50) over k(p95) on the swept values; rounding to the grid turns it into 23%',
    sites: [
      { file: GATE, anchor: 'where p95 fires at 0\\.00745 — a\\s*\\n \\*  ~', pattern: '(\\d+)%' },
      { file: GATE, anchor: "the grid's precision turns the ~", pattern: '(\\d+)% gap' },
      { file: ADR, anchor: 'where p95 fires at 0\\.00745, a ~', pattern: '(\\d+)%' },
      {
        file: ADR,
        anchor: "while still printing the grid's 0\\.0075, which turns the ~",
        pattern: '(\\d+)% gap',
      },
      { file: FIXTURE_TEST, anchor: 'magnitude of the gap is ~', pattern: '(\\d+)%' },
    ],
  },
  {
    id: 'k-old',
    claim: 'the injection strength at which the superseded p95 @ 1.25 gate fired',
    value: '0.01536',
    numeric: 0.01536,
    basis: 'the same continuous sweep, read off the same common injection',
    sites: [
      {
        file: GATE,
        anchor: 'gain therefore belongs to the tolerance, and it is',
        pattern: '\\(k = ([\\d.]+) ->',
      },
      { file: ADR, anchor: 'old gate k =', pattern: '\\s*([\\d.]+),' },
      { file: M2, anchor: 'The end-to-end sensitivity gain is', pattern: '\\(`k` ([\\d.]+) ' },
    ],
  },
  {
    id: 'sensitivity-gain',
    claim: 'the end-to-end sensitivity gain of the current gate over the superseded one',
    value: '1.67',
    numeric: 1.67,
    basis:
      'k(old) / k(new) on one common injection; it belongs to the tolerance, not the statistic',
    sites: [
      {
        file: GATE,
        anchor: 'gain therefore belongs to the tolerance, and it is',
        pattern: '\\s*([\\d.]+)x',
      },
      { file: ADR, anchor: 'old gate k =', pattern: '\\*\\*([\\d.]+).\\*\\*' },
      { file: ADR, anchor: '\\(step 1e-5, n = 2,500\\) is', pattern: '\\s*([\\d.]+).' },
      { file: M2, anchor: 'The end-to-end sensitivity gain is', pattern: '\\s*([\\d.]+).' },
      {
        file: FIXTURE_TEST,
        anchor: 'claim a 2\\.00x end-to-end gain for what is',
        pattern: '\\s*([\\d.]+)x',
      },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE DECLARED BLIND SPOT
  // ---------------------------------------------------------------------------------------
  {
    id: 'blind-spot-p95',
    claim: "how far p95 moves on the fixture's CONCENTRATED injection at k = 0.020",
    value: '35.5',
    numeric: 35.5,
    basis:
      "`gate-fixture.test.ts`'s `dueBlasts >= 3` injection — the regression shape the median cannot see",
    sites: [
      { file: GATE, anchor: 'measured at k = 0\\.020, p95 moves', pattern: '\\+([\\d.]+)%' },
      { file: ADR, anchor: 'injection \\(~11% of samples\\) p95 moves', pattern: '\\+([\\d.]+)%' },
      {
        file: FIXTURE_TEST,
        anchor: 'Measured at k = 0\\.020: p95 moves',
        pattern: '\\+([\\d.]+)%',
      },
    ],
  },
  {
    id: 'blind-spot-p50',
    claim: 'how far the gating p50 moves on the same concentrated injection',
    value: '2.2',
    numeric: 2.2,
    basis: 'the same measurement; the declared blind spot, reported but never gating',
    sites: [
      { file: GATE, anchor: '// p50 moves', pattern: '\\+([\\d.]+)%' },
      { file: ADR, anchor: 'where the gating median moves', pattern: '\\+([\\d.]+)%' },
      { file: FIXTURE_TEST, anchor: 'the gating p50 moves', pattern: '\\+([\\d.]+)%' },
    ],
  },
  {
    id: 'broad-snr-p50',
    claim: "the gating median's signal-to-noise on the BROAD regression, at k = 0.010",
    value: '3.9',
    numeric: 3.9,
    basis: 'the reversal that makes the blind-spot trade the right one',
    sites: [
      { file: GATE, anchor: 'at k = 0\\.010 it is', pattern: '\\s*([\\d.]+) for p50' },
      { file: ADR, anchor: '\\(p50 scores', pattern: '\\s*([\\d.]+),' },
      {
        file: FIXTURE_TEST,
        anchor: "at k = 0\\.010 p50's signal-to-noise",
        pattern: 'is ([\\d.]+) and',
      },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE COMMITTED BASELINE — the 17-attempt cohort and its provenance
  // ---------------------------------------------------------------------------------------
  {
    id: 'cohort-run',
    claim: "the baseline cohort's GitHub Actions run id",
    value: '31041932972',
    basis: 'read from the run that produced the 17 attempts',
    sites: [
      { file: GATE, anchor: 'PROVENANCE\\. GitHub Actions run', pattern: '\\*\\*(\\d+)\\*\\*' },
      { file: GATE_TEST, anchor: 'The median of 17 CI samples', pattern: 'run (\\d+)' },
      { file: ADR, anchor: '\\*\\*RECORDED 2026-08-05:', pattern: '\\(run (\\d+), attempts' },
      { file: SPIKE, anchor: 'from 17 CI samples', pattern: 'run (\\d+), attempts' },
    ],
  },
  {
    id: 'cohort-n',
    claim: 'the number of attempts in the baseline cohort',
    value: '17',
    numeric: 17,
    basis:
      'five were pre-committed; the span rule fired at n = 5 and the owner authorised collecting more',
    sites: [
      {
        file: GATE,
        anchor: 'PROVENANCE\\. GitHub Actions run',
        pattern: '\\*\\*attempts 1-(\\d+)\\*\\*',
      },
      {
        file: GATE_TEST,
        anchor: 'and PROVISIONAL: the',
        pattern: '(\\d+) samples are attempts',
        within: 80,
      },
      {
        file: ADR,
        anchor: '\\*\\*RECORDED 2026-08-05:',
        pattern: 'the median of \\*\\*(\\d+)\\*\\* CI samples',
      },
      {
        file: SPIKE,
        anchor: 'the numerator moved again to',
        pattern: 'the median of (\\d+) CI samples',
      },
    ],
  },
  {
    id: 'cohort-head',
    claim: "the commit head the baseline cohort's attempts ran on",
    value: 'a1600c9',
    basis:
      'one head is a precondition of the escalation rule — pooling heads mixes workload drift into sd(R)',
    sites: [
      {
        file: GATE,
        anchor: 'PROVENANCE\\. GitHub Actions run',
        pattern: 'head \\*\\*(\\w+)\\*\\*',
      },
      { file: GATE_TEST, anchor: 'The median of 17 CI samples', pattern: 'head (\\w+),' },
      { file: ADR, anchor: '\\*\\*RECORDED 2026-08-05:', pattern: 'head `(\\w+)`' },
    ],
  },
  {
    id: 'cohort-image',
    claim: 'the runner image the baseline cohort was measured on, resolved from `ubuntu-latest`',
    value: 'ubuntu-24.04',
    basis: "read out of each job's own setup log; the alias is not actionable for consequence 2",
    sites: [
      {
        file: GATE,
        anchor: 'PROVENANCE\\. GitHub Actions run',
        pattern: 'runner image \\*\\*([\\w.-]+)\\*\\*',
      },
      {
        file: GATE_TEST,
        anchor: 'The median of 17 CI samples',
        pattern: '`([\\w.-]+)` . rounded DOWN',
      },
      { file: ADR, anchor: '\\*\\*RECORDED 2026-08-05:', pattern: 'head `\\w+`, `([\\w.-]+)`\\)' },
      { file: SPIKE, anchor: 'from 17 CI samples', pattern: 'attempts 1.17, `([\\w.-]+)`' },
    ],
  },
  {
    id: 'cohort-median',
    claim: 'the median `R` of the 17-attempt cohort, before flooring',
    value: '1.0065',
    numeric: 1.0065,
    basis: 'the 9th of the 17 sorted values published in the `R0` doc',
    sites: [
      { file: GATE, anchor: 'Median \\*\\*', pattern: '([\\d.]+)\\*\\*, rounded DOWN' },
      {
        file: GATE,
        anchor: 'median \\*\\*1\\.0063\\*\\* against this',
        pattern: "cohort's ([\\d.]+)",
      },
      { file: GATE, anchor: 'medians \\*\\*1\\.0063\\*\\* and', pattern: '\\*\\*([\\d.]+)\\*\\*' },
      {
        file: ADR,
        anchor: 'The only other reading is the four diagnostic runs',
        pattern: 'against ([\\d.]+)\\)',
      },
      {
        file: ADR,
        anchor: 'across the two readings on record \\(1\\.0063,',
        pattern: '\\s*([\\d.]+)\\)',
      },
      {
        file: ADR,
        anchor: 'and their medians are \\*\\*1\\.0063\\*\\* and',
        pattern: '\\*\\*([\\d.]+)\\*\\*',
      },
    ],
  },
  {
    id: 'second-cohort-median',
    claim: "the four diagnostic runs' median `R` — the second reading the baseline reproduces on",
    value: '1.0063',
    numeric: 1.0063,
    basis: 'measured 2026-08-03/05; provenance never captured, so limit 1 does not lean on it',
    sites: [
      {
        file: GATE,
        anchor: 'The only other reading . four diagnostic runs of',
        pattern: 'median \\*\\*([\\d.]+)\\*\\*',
      },
      {
        file: GATE,
        anchor: 'reproduces on a second cohort\\*\\*: medians',
        pattern: '\\*\\*([\\d.]+)\\*\\*',
      },
      {
        file: ADR,
        anchor: 'The only other reading is the four diagnostic runs',
        pattern: '\\(median ([\\d.]+) against',
      },
      { file: ADR, anchor: 'across the two readings on record \\(', pattern: '([\\d.]+),' },
      { file: ADR, anchor: 'and their medians are', pattern: '\\*\\*([\\d.]+)\\*\\*' },
    ],
  },
  {
    id: 'cohort-max',
    claim: 'the largest `R` in the 17-attempt cohort',
    value: '1.0362',
    numeric: 1.0362,
    basis: 'the 17th of the sorted values published in the `R0` doc',
    sites: [
      { file: GATE, anchor: 'purely descriptive margin', pattern: 'own max is \\*{0,2}([\\d.]+)' },
      { file: ADR, anchor: 'purely descriptive margin', pattern: 'own max is \\*{0,2}([\\d.]+)' },
    ],
  },
  {
    id: 'raw-margin',
    claim: 'the raw gap between the ceiling and the largest `R` ever observed, as a percentage',
    value: '4.8',
    numeric: 4.8,
    basis:
      '(ceiling - observed max) / observed max; a description of the measurement, never a flake rate',
    sites: [
      { file: GATE, anchor: 'purely descriptive margin', pattern: '\\*\\*([\\d.]+)%\\*\\* gap' },
      { file: ADR, anchor: 'purely descriptive margin', pattern: '\\*\\*([\\d.]+)%\\*\\* gap' },
    ],
  },
  {
    id: 'cohort-span',
    claim: "the 17-attempt cohort's span (max/min) — the original escalation trigger, still met",
    value: '1.1058',
    numeric: 1.1058,
    basis: '1.0362 / 0.9371 over the published values; above `TOLERANCE`, and shipped anyway',
    sites: [
      { file: GATE, anchor: 'span condition is STILL MET at n = 17 \\(', pattern: '([\\d.]+) >' },
      { file: ADR, anchor: 'at 1\\.25 neither this cohort \\(', pattern: '([\\d.]+)\\)' },
      {
        file: ADR,
        anchor: 'original span condition is still met at\\s*\\n\\s*n = 17 \\(',
        pattern: '([\\d.]+) >',
      },
    ],
  },
  {
    id: 'n4-sd-ci-low',
    claim: "the lower bound of the 95% CI on the four-run cohort's sample sd",
    value: '1.45',
    numeric: 1.45,
    basis: "why any agreement between the two cohorts' sds is coincidence rather than confirmation",
    sites: [
      { file: GATE, anchor: 'a sample sd carries a 95% CI of', pattern: '\\s*([\\d.]+)%' },
      { file: ADR, anchor: 'being a coincidence at n = 4 \\(95% CI', pattern: '\\s*([\\d.]+).' },
      { file: ADR, anchor: 'The n = 4 sd carries a 95% CI', pattern: '([\\d.]+)%.[\\d.]+%' },
    ],
  },
  {
    id: 'n4-sd-ci-high',
    claim: 'the upper bound of the same CI',
    value: '9.51',
    numeric: 9.51,
    basis: 'the same computation; the interval spans a factor of 6.6, which is the point',
    sites: [
      { file: GATE, anchor: 'a sample sd carries a 95% CI of 1\\.45%-', pattern: '([\\d.]+)%' },
      {
        file: ADR,
        anchor: 'being a coincidence at n = 4 \\(95% CI 1\\.45.',
        pattern: '([\\d.]+)%',
      },
      { file: ADR, anchor: 'The n = 4 sd carries a 95% CI', pattern: '[\\d.]+%.([\\d.]+)%' },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE ESCALATION RULE
  // ---------------------------------------------------------------------------------------
  {
    id: 'escalation-sd-margin',
    claim: 'escalation branch (a) at this record — the sd-based margin to the ceiling',
    value: '3.61',
    numeric: 3.61,
    basis: '(R0 x TOLERANCE - median(R)) / sd(R) over the 17 attempts; IN-SAMPLE',
    sites: [
      { file: GATE, anchor: 'At this record: \\(a\\)', pattern: '\\*\\*([\\d.]+)\\*\\*' },
      {
        file: ADR,
        anchor: 'escalate if EITHER fails\\.\\*\\* Here:',
        pattern: '\\s*([\\d.]+) and',
      },
    ],
  },
  {
    id: 'escalation-chi-margin',
    claim:
      'escalation branch (b) at this record — the same margin against the chi-square sigma upper bound',
    value: '2.37',
    numeric: 2.37,
    basis: 'the 97.5% two-sided chi-square upper bound on sigma over the 17 attempts; IN-SAMPLE',
    sites: [
      { file: GATE, anchor: 'At this record: \\(a\\)', pattern: '\\(b\\) \\*\\*([\\d.]+)\\*\\*' },
      {
        file: ADR,
        anchor: 'escalate if EITHER fails\\.\\*\\* Here:',
        pattern: 'and ([\\d.]+), both pass',
      },
    ],
  },
  {
    id: 'branch-b-implied-margin-n10',
    claim: "branch (b)'s implied point margin at the rule's own floor of n = 10",
    value: '3.65',
    numeric: 3.65,
    basis:
      '2 x sigma_hi/sigma_hat at n = 10 on the 97.5% two-sided bound — stricter than the advertised 3',
    sites: [
      {
        file: GATE,
        anchor: 'It implies a point margin of 2 x sigma_hi/sigma_hat, which is',
        pattern: '\\s*([\\d.]+) at the',
      },
      { file: ADR, anchor: 'it implies a point margin of', pattern: '\\s*([\\d.]+) at n = 10' },
    ],
  },
  {
    id: 'branch-b-implied-margin-n17',
    claim: 'the same implied point margin at n = 17',
    value: '3.04',
    numeric: 3.04,
    basis: 'the same computation; the two branches cross at n = 18',
    sites: [
      { file: GATE, anchor: "rule's own floor of n = 10 and", pattern: '\\s*([\\d.]+) at n = 17' },
      { file: ADR, anchor: 'it implies a point margin of', pattern: 'and ([\\d.]+) at n = 17' },
    ],
  },
  {
    id: 'power-50',
    claim: 'the p50 regression size this gate has 50% power against',
    value: '9.3',
    numeric: 9.3,
    basis:
      "computed at the cohort's dispersion and the committed margin; a limit of the rule, not of the statistic",
    sites: [
      { file: GATE, anchor: 'gate has 50% power against a', pattern: '\\*\\*([\\d.]+)%\\*\\*' },
      { file: ADR, anchor: 'has 50% power against a', pattern: '\\s*([\\d.]+)% regression' },
    ],
  },
  {
    id: 'power-95',
    claim: 'the p50 regression size this gate needs for 95% power',
    value: '13.6',
    numeric: 13.6,
    basis: 'the same computation; the figure to quote when asked what this gate can actually catch',
    sites: [
      { file: GATE, anchor: 'p50 regression and needs', pattern: '\\*\\*([\\d.]+)%\\*\\*' },
      { file: ADR, anchor: 'has 50% power against a', pattern: 'needing ([\\d.]+)% for 95% power' },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE TWO CONSEQUENCES — the standing trap rules, and the block name ADR 0005 cites
  // ---------------------------------------------------------------------------------------
  {
    id: 'local-r-quiet',
    claim: 'the low end of `R` measured locally on a QUIET authoring machine',
    value: '1.66',
    numeric: 1.66,
    basis: '8 runs, same commit — the evidence that a local `R` cannot predict this gate',
    sites: [
      { file: GATE, anchor: 'authoring machine `R` sat at', pattern: '\\s*([\\d.]+)-' },
      { file: SPIKE, anchor: 'on the same laptop, measured', pattern: '\\s*([\\d.]+).' },
    ],
  },
  {
    id: 'local-r-loaded',
    claim: 'the low end of `R` measured on the SAME machine hours later under ordinary load',
    value: '2.21',
    numeric: 2.21,
    basis: '6 runs, same commit, same machine — ambient load alone moves it ~30%',
    sites: [
      { file: GATE, anchor: 'the same command measured', pattern: '\\s*([\\d.]+)-' },
      { file: SPIKE, anchor: 'across 8 runs when it was quiet and', pattern: '\\s*([\\d.]+).' },
    ],
  },
  {
    id: 'local-span-32-run',
    claim: 'the span of a 32-run interleaved local series on one machine',
    value: '56',
    numeric: 56,
    basis:
      'an uncommitted review harness, both arms of an ordering A/B pooled; only the ratio transfers',
    sites: [
      { file: GATE, anchor: 'that machine spanned', pattern: '\\*\\*(\\d+)%\\*\\*' },
      {
        file: SPIKE,
        anchor: 'A later 32-run interleaved series on that machine spanned',
        pattern: '\\*\\*(\\d+)%\\*\\*',
      },
    ],
  },
  {
    id: 'two-consequences-block-name',
    claim: "the name of the `gate.ts` block ADR 0005's Ruling 5 cites for the local-run disclaimer",
    value: 'THE TWO CONSEQUENCES',
    basis:
      'the citation that replaced `gate.ts:626-633`, which had already rotted once — a name is checkable, a line number is not',
    sites: [
      { file: GATE, anchor: 'names as the dominant risk', pattern: '(THE TWO CONSEQUENCES)' },
      {
        file: ADR,
        anchor: "`gate\\.ts`'s `R0` doc, under",
        pattern: '\\*\\*(THE TWO CONSEQUENCES)\\*\\*',
      },
    ],
  },
];
