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
// THE COVERAGE CONTRACT — and it is a TEST, not this paragraph. The authority is
// `claims.test.ts`'s describe block `the coverage contract is enforced, not merely asserted`,
// and specifically its case `every figure the perf package states, and another guarded file
// repeats, has a row`. Read what follows as a description of that test, never as the promise
// itself — a prose contract cannot fail, which is precisely how the first versions of it came
// to be wrong.
//
// SCOPE, as the test implements it. The SURFACE is `PERF_SOURCES` — the `packages/perf`
// sources on it; a figure is a perf-gate claim if the perf package states it, in PROSE or as a
// numeric literal its code EXECUTES — both are occurrences, and the second was invisible to
// the sweep until Codex found it (PR #161; see `codeLiterals`). Coverage is then
// ALL-PAIRS across every file in `GUARDED_FILES`: any such figure appearing in two guarded
// files needs a row, whoever states it, so an ADR<->spike disagreement is caught with no
// `gate.ts` copy involved. An earlier version of this paragraph said the contract was
// `gate.ts`-anchored and that document-only pairs were out of scope; that described an
// earlier, narrower test, and CodeRabbit was right that it contradicted the implementation.
//
// WHICH SOURCES ARE ON THE SURFACE IS NOT A HAND-LIST ANY MORE. It was one, and it was short:
// `dot-bench.ts` sat outside it while already restating the historical `R0`, so that copy
// could drift alone and stay green (Codex). Every `.ts` file under `packages/perf/src` is now
// either on the surface or named in `OFF_SURFACE` with the reason and the measured price of
// leaving it off; the partition is recomputed from the directory each run and compared
// exactly, so a new source fails the build until someone classifies it.
//
// What the surface deliberately excludes is the rest of those documents' numeric content —
// device frame budgets, board geometry, wave arithmetic — which belongs to other packages and
// other tests. Measured: taking "all pairs" over every numeral in the three documents yields
// 196 gaps against 39 on the perf surface, and annexing the other 157 would bind other groups'
// documents to this table for no propagation benefit.
//
// THREE ESCAPES, each named and machine-checked rather than assumed: `CONTRACT_EXCLUSIONS`
// for numerals that collide across unrelated claims, `OCCURRENCE_EXCEPTIONS` for a specific
// occurrence that means something else, and `KNOWN_UNROWED` for figures that are real unrowed
// shared claims — the scene ORACLE's family, a neighbouring surface — asserted EXACTLY so the
// set cannot grow silently. That residue is owner-ruled to stand for this change and is
// tracked in #163.
//
// The contract was overstated three times before it was enforced this way, and the corrections
// are on record rather than quietly folded in: ship-review found ten multi-file figures with no
// row and five rowed figures whose second and third copies were unguarded; Codex found two
// whole families still missing, then found rows were matched by VALUE rather than per
// occurrence, then found an executable-pin exemption that guarded no prose copy, then found
// the sweep could not see a value that lives only in CODE — so a literal copied into a document
// duplicated invisibly — then found the surface list itself was short by a whole source, and a
// reference mask eating ordinary scientific notation; CodeRabbit found the sweep seeded from
// one file. Each time the fix was to close the gap, never to soften the claim to fit it.
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
// edit; and spelled `$TURBO_ROOT$/docs/...`, the documented microsyntax for repo-root-relative
// inputs, rather than `../../docs/...` — both hash identically today, but the traversal form
// is undocumented and a future turbo could tighten it. If a doc path is added to a site below,
// add it there too.
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
const ORACLE_TEST = 'packages/perf/src/oracle.test.ts';
const SCENARIO = 'packages/perf/src/scenario.ts';
const SCENARIO_TEST = 'packages/perf/src/scenario.test.ts';
const DOT_BENCH = 'packages/perf/src/dot-bench.ts';
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
        pattern: '`TOLERANCE` tightened \\*\\*1\\.25 → ([\\d.]+)\\*\\*',
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
        // Bound to the table ROW: `[^\\n]` cannot cross the line, so deleting or rewording
        // this cell fails the site instead of falling through to the tolerance paragraph's
        // identical `+/- 2.8%` two thousand characters later (Codex, PR #161).
        file: GATE,
        anchor: '\\| p50\\(subset\\) / p50\\(control\\) \\|',
        pattern: '^[^\\n]*?\\+/-\\s*([\\d.]+)%',
      },
      { file: GATE, anchor: 'rests on\\s*\\n \\*  the', pattern: '\\+/- ([\\d.]+)% row' },
      { file: GATE, anchor: 'because matched medians swing', pattern: '\\+/- ([\\d.]+)%' },
      {
        file: GATE,
        anchor: '\\(four rows, all n = 4\\); comparing its',
        pattern: '\\s*([\\d.]+)%',
      },
      { file: ADR, anchor: 'so do not read 31\\.1% against', pattern: '±([\\d.]+)%' },
      { file: ADR, anchor: 'matched medians give', pattern: '\\*\\*±([\\d.]+)%\\*\\* half-spread' },
      {
        file: ADR,
        anchor: 'must be derived from the\\s*\\n\\s*unrounded 2\\.758%, not the published',
        pattern: '\\s*([\\d.]+)%',
      },
      {
        file: SPIKE,
        anchor: 'the difference is the point: measured over four',
        pattern: 'and ±([\\d.]+)% with matched medians',
      },
      {
        file: SPIKE,
        anchor: 'the limit that move REDUCES',
        pattern: '±([\\d.]+)% is a much smaller residue',
      },
      {
        file: SPIKE,
        anchor: 'Measured over four consecutive byte-identical CI runs',
        pattern: 'and ±([\\d.]+)% with matched medians',
      },
      {
        file: M2,
        anchor: 'four byte-identical runs, `R` swings',
        pattern: 'and ±([\\d.]+)% under p50/p50',
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
      { file: ADR, anchor: 'over the same four runs, against', pattern: '±([\\d.]+)%' },
      {
        file: SPIKE,
        anchor: 'the difference is the point: measured over four',
        pattern: '±([\\d.]+)% with a tail numerator',
      },
      {
        file: SPIKE,
        anchor: 'Measured over four consecutive byte-identical CI runs',
        pattern: '±([\\d.]+)% with a tail',
      },
      {
        file: M2,
        anchor: 'four byte-identical runs, `R` swings',
        pattern: '±([\\d.]+)% under p95/p50',
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
        pattern: '±([\\d.]+)% for a like-for-like',
      },
      {
        file: ADR,
        anchor: 'p95 cannot be run at 1\\.10, because its own',
        pattern: '±([\\d.]+)% spread exceeds',
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
        pattern: 'half-spread \\([\\d.]+ [–—-] ([\\d.]+)\\)',
      },
      {
        file: ADR,
        anchor: 'purely descriptive margin',
        pattern: 'across BOTH readings on record, is \\*\\*([\\d.]+)\\*\\*',
      },
      { file: GATE, anchor: 'runs \\(limit 1, and the', pattern: '\\s*([\\d.]+)' },
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
      { file: ADR, anchor: '\\| control p50\\s+\\|', pattern: '\\s*([\\d.]+) [–—-]' },
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
      { file: ADR, anchor: '\\| control p50\\s+\\|', pattern: '[\\d.]+ [–—-] ([\\d.]+)' },
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
      { file: ADR, anchor: '\\| stress p50\\s+\\|', pattern: '\\s*([\\d.]+) [–—-]' },
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
      { file: ADR, anchor: '\\| stress p50\\s+\\|', pattern: '[\\d.]+ [–—-] ([\\d.]+)' },
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
      { file: ADR, anchor: '\\| control p95\\s+\\|', pattern: '\\s*([\\d.]+) [–—-]' },
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
      { file: ADR, anchor: '\\| stress p95\\s+\\|', pattern: '\\s*([\\d.]+) [–—-]' },
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
      { file: ADR, anchor: '\\| stress p95\\s+\\|', pattern: '[\\d.]+ [–—-] ([\\d.]+)' },
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
      { file: ADR, anchor: '\\| control p95\\s+\\|', pattern: '[\\d.]+ [–—-] ([\\d.]+)' },
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
      { file: ADR, anchor: 'and the numerator barely moved \\(', pattern: '([\\d.]+) →' },
      { file: SPIKE, anchor: 'the numerator unmoved \\(', pattern: '([\\d.]+) →' },
      { file: GATE, anchor: 'where the unrounded scale gives', pattern: '\\s*([\\d.]+) /' },
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
        pattern: '[\\d.]+ → ([\\d.]+)\\)',
      },
      { file: SPIKE, anchor: 'the numerator unmoved \\(', pattern: '[\\d.]+ → ([\\d.]+)\\)' },
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
    basis:
      'stress p95 17.35% against stress p50 10.50%, on the declared convention — a WITHIN-arm\n      ratio, as ADR 0005 pairs them; an earlier basis named the cross-arm pairing, which computes\n      to 1.41 rather than 1.65 (Fable stand-in, PR #161)',
    sites: [
      { file: GATE, anchor: 'stress p95 17\\.35% — tails', pattern: '\\s*([\\d.]+)x' },
      { file: ADR, anchor: 'so more survives the division —', pattern: '\\*\\*([\\d.]+)×' },
      { file: SPIKE, anchor: 'while the tails are', pattern: '\\s*([\\d.]+)×' },
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
        pattern: '([\\d.]+)×\\*\\*',
      },
      { file: SPIKE, anchor: 'while the tails are 1\\.65.', pattern: '([\\d.]+)×' },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // SENSITIVITY — the swept `k` values and what they buy
  // ---------------------------------------------------------------------------------------
  {
    // Surfaced the moment masks were made tokenizer-aligned: the plan-step mask had been
    // taking the `1` out of `step 1e-5` and leaving `e-5`, so the step size was invisible in
    // all three files that state it. Codex demonstrated the bite with a constructed sentence;
    // this is the same bug already living in the repository (PR #161).
    id: 'sweep-step',
    claim: 'the step size of the continuous sweep the `k` figures come from',
    value: '1e-5',
    numeric: 1e-5,
    basis:
      "the sweep is continuous at this resolution, which is what makes its crossings magnitudes rather than the `KS` grid's buckets",
    sites: [
      { file: GATE, anchor: 'SWEEP \\(step ', pattern: '([\\de.+-]+)\\)' },
      { file: FIXTURE_TEST, anchor: 'continuous sweep \\(step ', pattern: '([\\de.+-]+),' },
      { file: ADR, anchor: '\\(step ', pattern: '([\\de.+-]+),' },
    ],
  },
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
      { file: M2, anchor: 'The end-to-end sensitivity gain is', pattern: '→ ([\\d.]+), swept\\)' },
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
      { file: ADR, anchor: 'old gate k =', pattern: '\\*\\*([\\d.]+)×\\*\\*' },
      { file: ADR, anchor: '\\(step 1e-5, n = 2,500\\) is', pattern: '\\s*([\\d.]+)×' },
      { file: M2, anchor: 'The end-to-end sensitivity gain is', pattern: '\\s*([\\d.]+)×' },
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
        pattern: '`([\\w.-]+)` [–—-] rounded DOWN',
      },
      { file: ADR, anchor: '\\*\\*RECORDED 2026-08-05:', pattern: 'head `\\w+`, `([\\w.-]+)`\\)' },
      { file: SPIKE, anchor: 'from 17 CI samples', pattern: 'attempts 1[–—-]17, `([\\w.-]+)`' },
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
      { file: GATE, anchor: '1\\.0017 1\\.0029 1\\.0029 1\\.0039', pattern: '\\s*([\\d.]+)' },
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
      { file: GATE, anchor: '1\\.0168 1\\.0265 1\\.0355', pattern: '\\s*([\\d.]+)' },
      { file: ADR, anchor: 'An earlier draft quoted', pattern: '\\s*([\\d.]+)' },
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
      {
        file: ADR,
        anchor: 'being a coincidence at n = 4 \\(95% CI',
        pattern: '\\s*([\\d.]+)[–—-]',
      },
      { file: ADR, anchor: 'The n = 4 sd carries a 95% CI', pattern: '([\\d.]+)%[–—-][\\d.]+%' },
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
      { file: ADR, anchor: 'The n = 4 sd carries a 95% CI', pattern: '[\\d.]+%[–—-]([\\d.]+)%' },
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
      { file: SPIKE, anchor: 'on the same laptop, measured', pattern: '\\s*([\\d.]+)[–—-]' },
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
      { file: SPIKE, anchor: 'across 8 runs when it was quiet and', pattern: '\\s*([\\d.]+)[–—-]' },
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

  // ---------------------------------------------------------------------------------------
  // THE SCENE'S REPRODUCIBILITY PIN — the seed every figure below was measured under.
  // Found by widening the sweep to the values the code EXECUTES: the seed is a literal in
  // `scenario.ts` and a table row in the spike, with no prose copy anywhere, so it was
  // invisible to a sweep that read comments only and the two copies bound nothing.
  // ---------------------------------------------------------------------------------------
  {
    id: 'stress-seed',
    claim: 'the fixed seed both perf scenarios run under',
    value: '1234',
    numeric: 1234,
    basis:
      'arbitrary but pinned, so the committed replays — and every figure measured against them — reproduce byte-for-byte',
    sites: [
      { file: SCENARIO, anchor: 'const STRESS_SEED =', pattern: '\\s*(\\d+);' },
      { file: SPIKE, anchor: '\\| Seed\\s+\\|', pattern: '\\s*(\\d+)' },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE TWO ARMS' WORKLOADS — the population gap and the DoT asymmetry.
  // Codex found this whole family unrowed: `gate.ts` states all eight figures, and every
  // one is duplicated into the oracle, the scenario builder, their tests, or the docs.
  // ---------------------------------------------------------------------------------------
  {
    id: 'population-control-median',
    claim: "the control arm's median live creeps",
    value: '181',
    numeric: 181,
    basis:
      "measured; a single-form twin cannot reproduce an area effect's slow coverage, so the control runs lighter",
    sites: [
      { file: GATE, anchor: 'measured median', pattern: '\\s*(\\d+) against' },
      { file: SCENARIO, anchor: 'live-creep median from 160 to', pattern: '\\s*(\\d+)' },
      { file: SCENARIO, anchor: "control's median live creeps is", pattern: '\\s*(\\d+) against' },
      { file: SPIKE, anchor: 'median of \\*\\*', pattern: '(\\d+)\\*\\* live creeps' },
    ],
  },
  {
    id: 'population-stress-median',
    claim: "the stress arm's median live creeps",
    value: '224',
    numeric: 224,
    basis:
      "measured; `oracle.ts`'s MEDIAN_LIVE_CREEPS_THRESHOLD of 200 is set below it as a drift tripwire",
    sites: [
      {
        file: GATE,
        anchor: "measured median 181 against the stress\\s*\\n// run's",
        pattern: '\\s*(\\d+),',
      },
      { file: ORACLE, anchor: 'set below the measured', pattern: '\\s*(\\d+)\\)' },
      { file: ORACLE, anchor: 'the real run measures a median of', pattern: '\\s*(\\d+)\\)' },
      {
        file: SCENARIO,
        anchor: "median from 160 to 181\\s*\\n \\*  against the stress run's",
        pattern: '\\s*(\\d+) \\(a population gap',
      },
      {
        file: SCENARIO,
        anchor: "control's median live creeps is 181 against the stress arm's",
        pattern: '\\s*(\\d+)\\)',
      },
      { file: ADR, anchor: 'the two runs \\(304 peak creeps,', pattern: '\\s*(\\d+) median' },
      { file: SPIKE, anchor: '\\| Live creeps\\s+\\| median \\*\\*', pattern: '(\\d+)\\*\\*' },
      { file: M2, anchor: 'peak 304 concurrent creeps, median', pattern: '\\s*(\\d+),' },
    ],
  },
  {
    id: 'population-control-peak-slowed',
    claim: "the control arm's peak slowed creeps",
    value: '109',
    numeric: 109,
    basis:
      'measured; the blast-borne slow COVERAGE the control cannot reproduce, which is why R is not blast cost alone',
    sites: [
      { file: GATE, anchor: 'peak slowed creeps', pattern: '\\s*(\\d+) against' },
      { file: SCENARIO, anchor: 'peak slowed creeps from 0 to', pattern: '\\s*(\\d+) against' },
      { file: SPIKE, anchor: 'and peaks at \\*\\*', pattern: '(\\d+)\\*\\*' },
    ],
  },
  {
    id: 'population-stress-peak',
    claim: "the stress arm's peak concurrent live creeps",
    value: '304',
    numeric: 304,
    basis: "the scene's full scheduled spawn count, all live at the sampled peak",
    sites: [
      { file: GATE, anchor: 'peak slowed creeps 109 against', pattern: '\\s*(\\d+) \\(' },
      { file: ORACLE, anchor: 'a window of one tick at', pattern: '\\s*(\\d+) creeps' },
      { file: ORACLE, anchor: 'DoT record: >= 100" \\(ceiling', pattern: '\\s*(\\d+),' },
      { file: ORACLE_TEST, anchor: 'one tick at peak \\(', pattern: '(\\d+) live creeps' },
      {
        file: SCENARIO,
        anchor: "0 peak slowed creeps against the stress run's",
        pattern: '\\s*(\\d+)\\.',
      },
      { file: ADR, anchor: 'the two runs \\(', pattern: '(\\d+) peak creeps' },
      {
        file: SPIKE,
        anchor: '\\| Live creeps\\s+\\| median \\*\\*224\\*\\*, peak \\*\\*',
        pattern: '(\\d+)\\*\\*',
      },
      {
        file: M2,
        anchor: "Measured at the ADR's own worst case \\(peak",
        pattern: '\\s*(\\d+) concurrent',
      },
    ],
  },
  {
    id: 'dot-records-control-peak',
    claim: "the control arm's peak resident DoT records",
    value: '368',
    numeric: 368,
    basis:
      "measured both arms, same board/seed/anchors/targeting — the control's thin slow coverage seeds a fresh pair per shot",
    sites: [
      {
        file: GATE,
        anchor: 'HEAVIER in the CONTROL arm —',
        pattern: '\\s*(\\d+) peak resident records',
      },
      { file: ORACLE, anchor: '\\*      control\\s+', pattern: '(\\d+)\\s' },
      { file: ORACLE, anchor: 'is 175 \\(stress\\) /', pattern: '\\s*(\\d+) \\(control\\)' },
    ],
  },
  {
    id: 'dot-records-stress-peak',
    claim: "the stress arm's peak resident DoT records",
    value: '175',
    numeric: 175,
    basis:
      "measured; `stress-chill`'s AoE slow bunches creeps so venom towers refresh one cohort instead of seeding new pairs",
    sites: [
      { file: GATE, anchor: "against the stress\\s*\\n// arm's", pattern: '\\s*(\\d+),' },
      { file: ORACLE, anchor: '\\*      stress\\s+', pattern: '(\\d+)\\s' },
      { file: ORACLE, anchor: 'peak `dotRecords` is', pattern: '\\s*(\\d+) \\(stress\\)' },
      {
        file: ORACLE,
        anchor: 'RECORD-DEPTH floor, which pins what this scene actually stresses\\.',
        pattern: '\\s*(\\d+) records',
      },
      {
        file: ORACLE_TEST,
        anchor: "scene's measured stress-arm figures \\(",
        pattern: '(\\d+) records',
      },
      {
        file: ORACLE_TEST,
        anchor: 'own default `dotRecords:',
        pattern: '\\s*(\\d+)',
      },
      { file: ADR, anchor: '1,427 due-blast samples,', pattern: '\\s*(\\d+) DoT records' },
    ],
  },
  {
    id: 'dot-carriers-control-peak',
    claim: "the control arm's peak DoT carriers",
    value: '127',
    numeric: 127,
    basis:
      'measured; it clears the deleted ">= 100 carriers" floor, which is how sticky targeting was ruled out as the cause',
    sites: [
      { file: GATE, anchor: "arm's 175, and", pattern: '\\s*(\\d+) peak DoT carriers' },
      { file: ORACLE, anchor: '\\*      control\\s+\\d+\\s+', pattern: '(\\d+)\\s' },
      { file: ORACLE, anchor: 'and the control reaches', pattern: '\\s*(\\d+) carriers' },
      { file: ORACLE, anchor: "stress arm's dispersion \\(", pattern: '(\\d+) vs' },
    ],
  },
  {
    id: 'dot-carriers-stress-peak',
    claim: "the stress arm's peak DoT carriers",
    value: '19',
    numeric: 19,
    basis:
      'measured; far below the deleted ">= 100" floor, which is why that floor was replaced rather than lowered',
    sites: [
      { file: GATE, anchor: 'peak DoT carriers against', pattern: '\\s*(\\d+) —' },
      { file: ORACLE, anchor: "stress arm's measured peak is", pattern: '\\s*(\\d+) carriers' },
      { file: ORACLE, anchor: '\\*      stress\\s+\\d+\\s+', pattern: '(\\d+)\\s' },
      {
        file: ORACLE_TEST,
        anchor: 'measured stress-arm figures \\(175 records /',
        pattern: '\\s*(\\d+) carriers',
      },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE SUPERSEDED PAIRING, and the fixture grid the swept values must not be read off
  // ---------------------------------------------------------------------------------------
  {
    id: 'tolerance-superseded',
    claim: 'the tolerance the p95/p50 pairing ran at, before M2-S6 tightened it',
    value: '1.25',
    numeric: 1.25,
    basis:
      'right for a statistic whose ratio swung +/- 15.5%; far too loose for one that swings +/- 2.8%',
    sites: [
      {
        file: GATE,
        anchor: 'in absolute ms" claim:\\s*\\n \\*  ',
        pattern: '([\\d.]+) bounded a p95',
      },
      { file: GATE_TEST, anchor: 'Tightened', pattern: '\\s*([\\d.]+) ->' },
      { file: ADR, anchor: '\\*\\*`TOLERANCE`', pattern: '\\s*([\\d.]+) →' },
      { file: SPIKE, anchor: '`TOLERANCE` tightened \\*\\*', pattern: '([\\d.]+) →' },
    ],
  },
  {
    id: 'ci-failure-r',
    claim: 'the `R` the M2-S6 CI failure came in at, on byte-identical work',
    value: '1.8348',
    numeric: 1.8348,
    basis:
      'run 4 of the four diagnostic runs under the old p95/p50 pairing — the failure that triggered the statistic change',
    sites: [
      {
        file: SPIKE,
        anchor: 'whose firing is the `R = ',
        pattern: '([\\d.]+)`',
      },
      {
        file: GATE,
        anchor: '\\| p95\\(subset\\) / p50\\(control\\) \\| [\\d.]+ [\\d.]+ [\\d.]+',
        pattern: '\\s*([\\d.]+)',
      },
      {
        file: FIXTURE_TEST,
        anchor: 'the M2-S6 CI failure\\s*\\n\\s*// at R =',
        pattern: '\\s*([\\d.]+)',
      },
      {
        file: ADR,
        anchor: 'The trigger was a CI failure, not a preference: `R =',
        pattern: '\\s*([\\d.]+)',
      },
      { file: SPIKE, anchor: 'CI returned `R =', pattern: '\\s*([\\d.]+)`' },
      {
        file: ADR,
        anchor: 'that escalation rule fired: CI came in at `R = ',
        pattern: '([\\d.]+)',
      },
    ],
  },
  {
    id: 'paired-gap-lo',
    claim: 'the low end of the gap between the median ratio and every tail ratio',
    value: '4.2',
    numeric: 4.2,
    basis: 'paired over the same four runs, which is what makes the gap decisive at n = 4',
    sites: [
      { file: GATE, anchor: 'every tail ratio is\\s*\\n \\*  ', pattern: '([\\d.]+)x' },
      { file: ADR, anchor: 'every tail ratio is', pattern: '\\s*([\\d.]+)×–' },
    ],
  },
  {
    id: 'paired-gap-hi',
    claim: 'the high end of the gap between the median ratio and every tail ratio',
    value: '5.9',
    numeric: 5.9,
    basis:
      'the same paired comparison; the load-bearing evidence for the statistic, ahead of the correlations',
    sites: [
      { file: GATE, anchor: 'every tail ratio is\\s*\\n \\*  [\\d.]+x-', pattern: '([\\d.]+)x' },
      { file: ADR, anchor: 'every tail ratio is [\\d.]+.–', pattern: '([\\d.]+)×' },
    ],
  },
  {
    id: 'tail-gap-p95-p99',
    claim: 'the gap between p95/p95 and p99/p99 — inside four-sample noise, so not readable',
    value: '1.41',
    numeric: 1.41,
    basis:
      'why the honest reading is "the median ratio is quieter than any tail ratio", not a ranking among tails',
    sites: [
      { file: GATE, anchor: 'p99/p99 is', pattern: '\\s*([\\d.]+)x' },
      { file: ADR, anchor: 'p95/p95 versus p99/p99 is', pattern: '\\s*([\\d.]+)×' },
      { file: SPIKE, anchor: 'Even at face value that', pattern: '\\s*([\\d.]+)× gap' },
    ],
  },
  {
    id: 'concentrated-injection-share',
    claim: 'the share of samples the CONCENTRATED injection touches (`dueBlasts >= 3`)',
    value: '11',
    numeric: 11,
    basis:
      'the shape an O(n^2) in blast membership scanning would take — real mass, but a minority',
    sites: [
      { file: GATE, anchor: 'injection at `dueBlasts >= 3` \\(~', pattern: '(\\d+)%' },
      { file: FIXTURE_TEST, anchor: 'carries real mass \\(270 of 2,500, ~', pattern: '(\\d+)%' },
      { file: ADR, anchor: "fixture's `dueBlasts >= 3` injection \\(~", pattern: '(\\d+)%' },
    ],
  },
  {
    id: 'k-concentrated',
    claim: 'the injection strength the concentrated blind-spot figures are measured at',
    value: '0.020',
    numeric: 0.02,
    basis: "`gate-fixture.test.ts`'s pinned measurement point for the `dueBlasts >= 3` injection",
    sites: [
      { file: GATE, anchor: 'scanning would take\\), measured at k =', pattern: '\\s*([\\d.]+),' },
      { file: FIXTURE_TEST, anchor: 'Measured at k =', pattern: '\\s*([\\d.]+):' },
      { file: ADR, anchor: 'this amendment\'s original "k =', pattern: '\\s*([\\d.]+) →' },
      { file: FIXTURE_TEST, anchor: 'an injection of at most 8 \\* ', pattern: '([\\d.]+)' },
      {
        file: ADR,
        anchor: 'catching a broad blast-cost regression at `k = ',
        pattern: '([\\d.]+)',
      },
      { file: SPIKE, anchor: 'broad blast-cost regression at\\n`k = ', pattern: '([\\d.]+)' },
      { file: M2, anchor: 'catching a broad blast-cost regression at `k = ', pattern: '([\\d.]+)' },
    ],
  },
  {
    id: 'k-broad-snr-point',
    claim: 'the injection strength the BROAD signal-to-noise comparison is read at',
    value: '0.010',
    numeric: 0.01,
    basis: 'the common case the gate primarily exists to catch, where the ordering reverses',
    sites: [
      { file: GATE, anchor: 'ordering reverses: at k =', pattern: '\\s*([\\d.]+) it is' },
      { file: FIXTURE_TEST, anchor: 'the ratio reverses — at k =', pattern: "\\s*([\\d.]+) p50's" },
      { file: ADR, anchor: 'original "k = 0\\.020 .', pattern: '\\s*([\\d.]+)"' },
    ],
  },
  {
    id: 'fixture-grid-lo',
    claim:
      "the lower of `gate-fixture.test.ts`'s two `KS` grid points bracketing the swept crossings",
    value: '0.0075',
    numeric: 0.0075,
    basis: 'a grid point, right for the ORDERING the fixture asserts and wrong as a magnitude',
    sites: [
      { file: GATE, anchor: "grid\\. The grid's nearest points are", pattern: '\\s*([\\d.]+) and' },
      {
        file: FIXTURE_TEST,
        anchor: 'THE ADDED',
        pattern: '\\s*([\\d.]+) POINT SITS CLOSE',
      },
      { file: ADR, anchor: 'grid, so its\\s*\\n\\s*pinned', pattern: '\\s*([\\d.]+) and' },
      { file: FIXTURE_TEST, anchor: 'So .expect\\(k95\\)\\.toBe\\(', pattern: '([\\d.]+)' },
      { file: FIXTURE_TEST, anchor: "while p95's ratio at k =", pattern: '\\s*([\\d.]+)' },
      { file: FIXTURE_TEST, anchor: 'failure would be .expected', pattern: '\\s*([\\d.]+)' },
      { file: ADR, anchor: "name while still printing the grid's", pattern: '\\s*([\\d.]+)' },
      // The three EXECUTABLE occurrences: the grid itself, and the two assertions that read
      // it. Seven prose sites restated this grid point and not one of them bound the literal
      // the fixture actually runs — `KS`'s `0.0075` could have been retuned and every one of
      // them stayed green, because the sweep could not see a value that lives only in code
      // (Codex, PR #161). Executable literals are an occurrence class now, so they are sites.
      { file: FIXTURE_TEST, anchor: 'const KS = \\[', pattern: '[\\d.]+, ([\\d.]+),' },
      {
        file: FIXTURE_TEST,
        anchor: 'deliberately and re-record the pins\\.',
        pattern: '\\s*expect\\(ratio\\(broad\\(([\\d.]+)\\)',
      },
      {
        file: FIXTURE_TEST,
        anchor: 'expect\\(kGating\\)\\.toBe\\(0\\.01\\);',
        pattern: '\\s*expect\\(k95\\)\\.toBe\\(([\\d.]+)\\)',
      },
    ],
  },
  {
    id: 'grid-substitution-error',
    claim: 'the ~24% gap misread off the grid instead of the sweep',
    value: '23',
    numeric: 23,
    basis:
      "rounding a swept value to the grid's precision reintroduces the error one decimal place lower",
    sites: [
      { file: GATE, anchor: "grid's precision turns the ~24% gap into", pattern: '\\s*(\\d+)%' },
      {
        file: ADR,
        anchor: "printing the grid's 0\\.0075, which turns the ~24% gap into",
        pattern: '\\s*(\\d+)%',
      },
    ],
  },
  {
    id: 'claimed-doubling',
    claim: 'the end-to-end gain an earlier draft claimed by quoting the grid',
    value: '2.00',
    numeric: 2.0,
    basis: 'the substitution this file exists to prevent — the real swept answer is 1.67x',
    sites: [
      { file: GATE, anchor: 'gain\\s*\\n// into a claimed', pattern: '\\s*([\\d.]+)x' },
      { file: FIXTURE_TEST, anchor: 'claim a', pattern: '\\s*([\\d.]+)x end-to-end' },
      { file: ADR, anchor: 'a claimed', pattern: '\\s*([\\d.]+)× where the swept' },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE BASELINE'S ARITHMETIC — figures the escalation rule and the three limits rest on
  // ---------------------------------------------------------------------------------------
  {
    id: 'skew-g1',
    claim: "the 17-attempt cohort's sample skewness, SIGN INCLUDED",
    value: '-1.36',
    numeric: -1.36,
    basis:
      'left-skewed, which thins the upper tail in our favour but which the chi-square bound assumes away. The sign is part of the claim and is captured rather than matched by a wildcard: flipping it to +1.36 reverses the statistical meaning while the surrounding prose still says left-skewed, and an earlier magnitude-only capture let that pass (Codex, PR #161)',
    sites: [
      { file: GATE, anchor: '\\(g1 = ', pattern: '(-?[\\d.]+)\\)' },
      { file: ADR, anchor: 'left-skewed \\(g1 = ', pattern: '([\u2212-]?[\\d.]+)\\)' },
    ],
  },
  {
    id: 'chi-square-quantile',
    claim: 'the quantile branch (b) uses — two-sided, and naming it matters',
    value: '97.5',
    numeric: 97.5,
    basis: 'a rule that does not say which bound it means is two rules',
    sites: [
      { file: GATE, anchor: 'tested it against the', pattern: '^[^\\n]*?([\\d.]+)% two-sided' },
      {
        file: ADR,
        anchor: 'the same margin against the\\s*\\n\\s*',
        pattern: '([\\d.]+)% two-sided',
      },
    ],
  },
  {
    id: 'draft2-unsatisfiable-n',
    claim: 'the sample count draft 2 would have needed to clear its own threshold',
    value: '68',
    numeric: 68,
    basis: 'a rule whose own floor of >= 10 samples can never satisfy it is not a rule',
    sites: [
      { file: GATE, anchor: 'needing n around', pattern: '\\s*(\\d+) at this noise' },
      { file: ADR, anchor: 'which is unsatisfiable below n .', pattern: '\\s*(\\d+)' },
    ],
  },
  {
    id: 'branch-crossover-n',
    claim: 'the sample count at which the two escalation branches cross',
    value: '18',
    numeric: 18,
    basis: 'below it branch (b) binds, so the operative threshold is not the advertised 3',
    sites: [
      { file: GATE, anchor: 'They cross at n =', pattern: '\\s*(\\d+)\\.' },
      {
        file: ADR,
        anchor: 'The bound test is the stricter one below n =',
        pattern: '\\s*(\\d+) —',
      },
    ],
  },
  {
    id: 'floor-granularity',
    claim: 'the margin flooring `R0` to a hundredth discards before the gate exists',
    value: '0.01',
    numeric: 0.01,
    basis: "why draft 1's `TOLERANCE - 1` was the wrong quantity",
    sites: [
      { file: GATE, anchor: 'FLOORED, so up to', pattern: '\\s*([\\d.]+) of margin' },
      { file: ADR, anchor: 'flooring `R0` discards up to', pattern: '\\s*([\\d.]+) before' },
    ],
  },
  {
    id: 'limit1-median-agreement',
    claim: 'how closely two per-image baselines must agree for limit 1 to clear',
    value: '0.02',
    numeric: 0.02,
    basis:
      '~1 sigma at the spread measured here; compared on MEDIANS, never on the floored `R0` values',
    sites: [
      {
        file: GATE,
        anchor: 'MEDIANS agree to within \\|median_A - median_B\\| <=',
        pattern: '\\s*([\\d.]+)',
      },
      {
        file: ADR,
        anchor: 'baseline under the same rule, medians agreeing within',
        pattern: '\\s*([\\d.]+),',
      },
    ],
  },
  {
    id: 'log-retention-days',
    claim: 'the CI log retention that makes publishing the raw cohort necessary',
    value: '90',
    numeric: 90,
    basis:
      'no artifact upload, so the raw `R` values expire and only what is written down survives',
    sites: [
      { file: GATE, anchor: 'CI logs expire on a', pattern: '\\s*(\\d+)-day' },
      {
        file: ADR,
        anchor: 'the raw `R` values live only in CI logs under a\\s*\\n\\s*',
        pattern: '(\\d+)-day',
      },
    ],
  },
  {
    id: 'local-r-quiet-high',
    claim: 'the high end of `R` measured locally on a QUIET authoring machine',
    value: '1.79',
    numeric: 1.79,
    basis: '8 runs, same commit — the upper end of the range a local run cannot transfer from',
    sites: [
      { file: GATE, anchor: 'authoring machine `R` sat at [\\d.]+-', pattern: '([\\d.]+) over' },
      { file: SPIKE, anchor: 'on the same laptop, measured [\\d.]+.', pattern: '([\\d.]+) across' },
    ],
  },
  {
    id: 'local-r-loaded-high',
    claim: 'the high end of `R` on the same machine under ordinary background load',
    value: '2.36',
    numeric: 2.36,
    basis: '6 runs, same commit, same machine — ambient load alone moves the range this far',
    sites: [
      { file: GATE, anchor: 'the same command measured [\\d.]+-', pattern: '([\\d.]+) over' },
      { file: SPIKE, anchor: 'quiet and [\\d.]+.', pattern: '([\\d.]+)\\s*\\nacross' },
    ],
  },
  {
    id: 'local-series-runs',
    claim: 'the size of the interleaved local series behind the 56% span',
    value: '32',
    numeric: 32,
    basis:
      'an uncommitted review harness pooling both arms of an ordering A/B; only the ratio transfers',
    sites: [
      { file: GATE, anchor: 'over 6 runs; a later', pattern: '\\s*(\\d+)-run interleaved' },
      { file: SPIKE, anchor: 'A later', pattern: '\\s*(\\d+)-run interleaved' },
    ],
  },

  // ---------------------------------------------------------------------------------------
  // THE SUPERSEDED p95 ERA — records the docs still quote from, whose raw table now lives in
  // ADR 0005 rather than in `gate.ts` (#86 cut the gate file's superseded-era provenance).
  // ---------------------------------------------------------------------------------------
  {
    id: 'fixture-grid-hi',
    claim:
      "the upper of `gate-fixture.test.ts`'s two `KS` grid points bracketing the swept crossings",
    value: '0.0100',
    numeric: 0.01,
    basis:
      "the grid's nearest point above the true 0.00922 — right for the ORDERING the fixture asserts, wrong as a magnitude",
    sites: [
      { file: GATE, anchor: 'nearest points are 0\\.0075 and', pattern: '\\s*([\\d.]+);' },
      {
        file: FIXTURE_TEST,
        anchor: 'not the threshold . p50.s\\s*\\n// ',
        pattern: '([\\d.]+) below is the grid',
      },
      { file: ADR, anchor: 'pinned 0\\.0075 and', pattern: '\\s*([\\d.]+) are the nearest' },
      { file: FIXTURE_TEST, anchor: "not the threshold — p50's\\s*\\n// ", pattern: '([\\d.]+)' },
    ],
  },
  {
    id: 'superseded-ceiling',
    claim: 'the ceiling the p95/p50 era ran at — `R0` 1.42 x `TOLERANCE` 1.25',
    value: '1.7750',
    numeric: 1.775,
    basis:
      'superseded by the 1.1000 ceiling at M2-S6; kept because the docs still read the p95 era against it',
    sites: [
      {
        file: SPIKE,
        anchor: 'whose operands and',
        pattern: '\\s*([\\d.]+) ceiling',
      },
      { file: ADR, anchor: '1\\.427743 rounded down\\. Ceiling', pattern: '\\s*([\\d.]+)\\.' },
      { file: ADR, anchor: 'Ceiling = 1\\.42 . 1\\.25 =', pattern: '\\s*\\*\\*([\\d.]+)\\*\\*' },
      {
        file: SPIKE,
        anchor: 'attempts 1.5, `ubuntu-24\\.04`\\), ceiling',
        pattern: '\\s*\\*\\*([\\d.]+)\\*\\*',
      },
      { file: M2, anchor: 'attempts 1.5, `ubuntu-24\\.04`; ceiling', pattern: '\\s*([\\d.]+)\\)' },
      {
        file: ADR,
        anchor: 'came in at \\*\\*R = 1\\.7595\\s*\\n\\s*against the ',
        pattern: '([\\d.]+)',
      },
      { file: ADR, anchor: 'not a preference: `R = 1\\.8348` against the ', pattern: '([\\d.]+)' },
      { file: ADR, anchor: 'against `R0 = 1\\.42` / ceiling `', pattern: '([\\d.]+)' },
      { file: ADR, anchor: 'CI came in at `R = 1\\.8348`\\nagainst the `', pattern: '([\\d.]+)' },
      { file: ADR, anchor: 'provisional\\)\\. The `1\\.42` / `', pattern: '([\\d.]+)' },
      { file: SPIKE, anchor: 'CI returned `R = 1\\.8348` against the `', pattern: '([\\d.]+)' },
    ],
  },
  {
    id: 'five-run-p95-spread',
    claim: "the p95 ratio's spread over the five-attempt cohort, `(max - min) / min`",
    value: '20.2',
    numeric: 20.2,
    basis: "computed from ADR 0005's restored five-attempt table — 1.5802 against 1.3146",
    sites: [
      {
        file: ADR,
        anchor: 'over the five R\\(p95\\) values is\\s*\\n\\s*',
        pattern: '\\*\\*([\\d.]+)%\\*\\*',
      },
      { file: SPIKE, anchor: '`\\(max . min\\) / min` is', pattern: '\\s*\\*\\*([\\d.]+)%\\*\\*' },
      {
        file: M2,
        anchor: "p95's spread across the five R values is",
        pattern: '\\s*\\*\\*([\\d.]+)%\\*\\*',
      },
    ],
  },
  {
    id: 'five-run-p99-spread',
    claim:
      "the p99 ratio's spread over the same five attempts — nearly half p95's, which the tail-noise diagnosis did not predict",
    value: '11.1',
    numeric: 11.1,
    basis: "computed from the same restored table's audit p99 column — 2.0112 against 1.8100",
    sites: [
      {
        file: ADR,
        anchor:
          'over the five R\\(p99\\) values, computed on the exact same five runs, it is\\s*\\n\\s*',
        pattern: '\\*\\*([\\d.]+)%\\*\\*',
      },
      {
        file: SPIKE,
        anchor: 'for the five R\\(p95\\) values against',
        pattern: '\\s*\\*\\*([\\d.]+)%\\*\\*',
      },
      { file: M2, anchor: 'nearly double the', pattern: '\\s*\\*\\*([\\d.]+)%\\*\\*' },
    ],
  },
  {
    id: 'denominator-faster',
    claim:
      'how much faster the control arm ran on the byte-identical work that failed the gate at M2-S6',
    value: '23',
    numeric: 23,
    basis:
      'the diagnosis that moved the gate: the numerator barely moved, so a faster DENOMINATOR failed the build',
    sites: [
      { file: ADR, anchor: 'DENOMINATOR: the control arm ran', pattern: '\\s*(\\d+)% faster' },
      {
        file: M2,
        anchor: 'the numerator barely moved and the DENOMINATOR ran',
        pattern: '\\s*(\\d+)% faster',
      },
    ],
  },
  {
    id: 'superseded-r0',
    claim: 'the baseline the p95/p50 era ran at, before M2-S6 re-recorded it',
    value: '1.42',
    numeric: 1.42,
    basis:
      "the floored median of the five-attempt cohort ADR 0005 now carries (1.427743 -> 1.42); rowed rather than exempted because `gate.test.ts`'s only occurrence is an it() TITLE and its assertion checks R0 === 1.00, so nothing executable pinned the doc copies (Codex, PR #161)",
    sites: [
      {
        file: GATE_TEST,
        anchor: 'not the stale',
        pattern: '\\s*([\\d.]+) from the superseded',
      },
      { file: ADR, anchor: '\\*\\*`R0` re-recorded at', pattern: '\\s*([\\d.]+)\\*\\*' },
      {
        file: ADR,
        anchor: 'to the nearer hundredth . `R0` =',
        pattern: '\\s*([\\d.]+)\\.',
      },
      { file: ADR, anchor: 'Ceiling =', pattern: '\\s*([\\d.]+) ×' },
      { file: ADR, anchor: 'The first CI run after `R0 =', pattern: '\\s*([\\d.]+)` was recorded' },
      { file: ADR, anchor: 'which is the current state\\.', pattern: '\\s*([\\d.]+) baselines' },
      { file: ADR, anchor: 'CI perf job on the PR, against `R0 =', pattern: '\\s*([\\d.]+)`' },
      {
        file: SPIKE,
        anchor: 'and `R0` was re-recorded\\s*\\n',
        pattern: 'to ([\\d.]+) on the post-P9',
      },
      { file: SPIKE, anchor: 're-recorded to \\*\\*', pattern: '([\\d.]+)\\*\\*' },
      { file: M2, anchor: 're-recorded to \\*\\*', pattern: '([\\d.]+)\\*\\*' },
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

  // ---------------------------------------------------------------------------------------
  // DOT-BENCH'S SURFACE — the two cross-file claims that surfaced when `dot-bench.ts` joined
  // the guarded set. Codex found the source omitted from both coverage lists while it already
  // restated the historical `R0`: changing only the dot-bench copy to 1.68 left all 742 claim
  // tests green. Both figures below are stated in a perf source AND in the documents, and
  // neither had a row, which is exactly what the omission was hiding.
  // ---------------------------------------------------------------------------------------
  {
    id: 'historical-r0',
    claim: 'the `R0` first recorded on the authoring machine, before it failed to transfer to CI',
    value: '1.69',
    numeric: 1.69,
    basis:
      "8 runs on the authoring machine (range 1.663-1.795, sd 0.045); superseded by the runner-recorded 2.49, and kept because the failure to transfer is one of the story's results",
    sites: [
      { file: DOT_BENCH, anchor: 'untransferable .R0 = ', pattern: '([\\d.]+)' },
      { file: ADR, anchor: 'authoring machine \\(', pattern: '([\\d.]+),' },
      {
        file: ADR,
        anchor: 'that produced the untransferable',
        pattern: '\\s*`R0 = ([\\d.]+)',
      },
      { file: SPIKE, anchor: 'R0 was first recorded at', pattern: '\\s*([\\d.]+) from' },
      { file: SPIKE, anchor: 'on the runner \\(', pattern: '([\\d.]+) →' },
      { file: M2, anchor: 're-recorded on the runner \\(', pattern: '([\\d.]+) →' },
    ],
  },
  {
    id: 'instrumented-run-seconds',
    claim: 'what a sustained simulation costs locally under vitest `--coverage`',
    value: '7.5',
    numeric: 7.5,
    basis:
      'measured; ~0.65 s uninstrumented, so coverage is ~6.5x on top of the module runner — the reason a sim-heavy path is excluded from the coverage gate rather than made faster',
    sites: [
      { file: DOT_BENCH, anchor: 'of work cost ~', pattern: '([\\d.]+)s locally' },
      { file: SCENARIO_TEST, anchor: 'this test cost ~', pattern: '([\\d.]+)s locally' },
      { file: SPIKE, anchor: 'vitest, .--coverage. \\| ~', pattern: '([\\d.]+) s' },
      { file: SPIKE, anchor: 'the instrumented ', pattern: '([\\d.]+) s' },
    ],
  },
];
