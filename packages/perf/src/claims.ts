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
// shared claims, asserted EXACTLY so the set cannot grow silently. That last one is EMPTY: it
// held the scene ORACLE's family until #163 rowed it (the section of that name below), and the
// five entries that proved to be numeral collisions rather than claims moved to
// `CONTRACT_EXCLUSIONS`. An empty table compared exactly means every cross-file figure on the
// surface has a row or a named collision.
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
const HARNESS = 'packages/perf/src/harness.ts';
/** Outside the perf package, because a few scene-oracle rows rest on a constant another
 *  package declares. Both are listed in `@wynding/perf#test`'s turbo `inputs` for the same
 *  reason the documents are: an edit there must bust this task's cache. */
const STRESS_RULESET = 'packages/content/src/rulesets/stress-40x40.json';
const GAME_LOOP = 'packages/engine/src/game-loop.ts';
const RUN = 'packages/perf/src/run.ts';
const LAYOUT = 'packages/perf/src/layout.ts';

const GATE_CLAIMS: readonly Claim[] = [
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

/** THE SCENE ORACLE'S FAMILY, as its own list because it carries a duty the gate's rows do not:
 *  every low-information value here also has a COUNTED CENSUS in `claims.test.ts`
 *  (`ROWED_CENSUS`), since per-occurrence accounting only reaches high-information numerals and
 *  every figure in this family is below that bar. `claims.test.ts` asserts the census covers
 *  exactly this list's low-information values, so a row added here without one fails. */
export const SCENE_ORACLE_CLAIMS: readonly Claim[] = [
  // ---------------------------------------------------------------------------------------
  // THE SCENE ORACLE'S FAMILY (#163) — the stress scene's measured and derived facts, stated
  // in `oracle.ts` (and its neighbours `scenario.ts` and `gate-fixture.test.ts`) and copied
  // into ADR 0005, the spike and m2.md. PR #161 measured this family and held it in
  // `KNOWN_UNROWED`; these rows retire that holding. Where one numeral carries two genuine
  // shared claims (150 is both the placed-tower count and the ADR's "~150 towers" figure; 100
  // is the slowed floor, the AoE tower count and the countdown), each claim is its own row, so
  // a site binds the claim it states and not merely a digit that happens to match.
  // ---------------------------------------------------------------------------------------

  // THE SCENE'S AUTHORED SHAPE
  {
    id: 'stress-towers-placed',
    claim: 'accepted tower placements the stress scene must reach — its full anchor count',
    value: '150',
    numeric: 150,
    basis:
      "authored: `stressAnchors()`'s anchor count, `BUILD_TICKS` x `PLACEMENTS_PER_TICK`; the oracle asserts it EXACTLY",
    sites: [
      {
        file: ORACLE,
        anchor: 'export const TOWERS_PLACED_THRESHOLD =',
        pattern: '^\\s*(\\d+);',
      },
      {
        file: ORACLE,
        anchor: 'Accepted tower placements must be EXACTLY',
        pattern: '^\\s*(\\d+) ',
      },
      {
        file: SCENARIO,
        anchor: '`BUILD_TICKS \\* PLACEMENTS_PER_TICK` =',
        pattern: '^\\s+\\*\\s+(\\d+),',
      },
      {
        file: SPIKE,
        anchor: '\\| Towers placed\\s+\\| \\*\\*exactly',
        pattern: '^ (\\d+)\\*\\*',
      },
      { file: SPIKE, anchor: 'carries the same checks \\(', pattern: '^(\\d+) towers' },
      {
        file: M2,
        anchor: 'Every other oracle assertion cleared:',
        pattern: '^\\s*(\\d+)/\\d+ placements',
      },
      {
        file: M2,
        anchor: 'Every other oracle assertion cleared:\\s*\\n\\s*\\d+/',
        pattern: '^(\\d+) placements',
      },
      { file: SPIKE, anchor: 'Towers placed \\*\\*', pattern: '^(\\d+)\\*\\*' },
      { file: SPIKE, anchor: 'CONTROL run — phase,', pattern: '^\\s*(\\d+) towers' },
      {
        file: ADR,
        anchor: 'roughly 1\\.25 applications per tick against',
        pattern: '^\\s*(\\d+) towers',
      },
      {
        file: ADR,
        anchor: 'The existing scene runs that loop',
        pattern: '^\\s*(\\d+) towers deep',
      },
      {
        file: M2,
        anchor: 'peak 304 concurrent creeps, median 224,',
        pattern: '^\\s*(\\d+) towers',
      },
      {
        file: RUN,
        anchor:
          "'control: accepted tower placements',\\s*\\n\\s*controlResult\\.towersPlacedAfterBuild,",
        pattern: '^\\s*(\\d+),',
      },
      { file: RUN, anchor: 'controlResult\\.towersPlacedAfterBuild ===', pattern: '^\\s*(\\d+),' },
    ],
  },
  {
    id: 'adr-tower-figure',
    claim: "ADR 0005's worst-case tower figure — the budget the route arithmetic is measured at",
    value: '150',
    numeric: 150,
    basis: "declared by ADR 0005's worst-case load, alongside ~300 concurrent creeps",
    sites: [
      { file: ADR, anchor: 'concurrent creeps \\+ ~', pattern: '^(\\d+) towers' },
      { file: SPIKE, anchor: 'concurrent creeps \\+ ~', pattern: '^(\\d+) towers' },
      {
        file: ORACLE,
        anchor: "is not reachable at ADR 0005's\\s+\\*\\s+own ~",
        pattern: '^(\\d+)-tower figure',
      },
      { file: ADR, anchor: "ADR's own ~", pattern: '^(\\d+)-tower figure' },
      {
        file: SPIKE,
        anchor: "cannot be met at ADR 0005's own\\s*\\n~",
        pattern: '^(\\d+)-tower figure',
      },
      { file: M2, anchor: "ADR 0005's own ~", pattern: '^(\\d+)-tower figure' },
    ],
  },
  {
    id: 'adr-concurrency-target',
    claim: "ADR 0005's worst-case concurrent-creep target",
    value: '300',
    numeric: 300,
    basis:
      "declared by ADR 0005; the oracle's 280 peak floor is this target less headroom for a wave's ebb",
    sites: [
      { file: ADR, anchor: 'sustain\\s*\\n\\s*\\*\\*~', pattern: '^(\\d+) concurrent' },
      { file: ADR, anchor: '117 creeps against "~', pattern: '^(\\d+) concurrent' },
      { file: ORACLE, anchor: '0005\'s "~', pattern: '^(\\d+) concurrent' },
      { file: SPIKE, anchor: 'ADR 0005 asks for "~', pattern: '^(\\d+) concurrent' },
      {
        file: SPIKE,
        anchor: "117 creeps, against the ADR's ~",
        pattern: '^(\\d+) concurrent',
      },
    ],
  },
  {
    id: 'stress-board-side',
    claim: 'the side of the synthetic square board the stress scene runs on',
    value: '40',
    numeric: 40,
    basis: 'authored: the shipped board cannot host 150 towers at a 2x2 footprint',
    sites: [
      {
        file: ORACLE,
        anchor: 'and on the committed\\s+\\*\\s+',
        pattern: '^(\\d+)×40 board',
      },
      { file: ADR, anchor: 'runs on a purpose-built synthetic ', pattern: '^(\\d+)×40' },
      { file: SPIKE, anchor: 'purpose-built synthetic ', pattern: '^(\\d+)×40' },
      { file: SPIKE, anchor: '\\| Board\\s+\\| ', pattern: '^(\\d+) × 40' },
      { file: M2, anchor: 'purpose-built synthetic ', pattern: '^(\\d+)×40' },
    ],
  },
  {
    id: 'stress-wave-entries',
    claim: "the stress schedule's wave entries — 19 creeps each, 304 scheduled",
    value: '16',
    numeric: 16,
    basis: 'authored: the per-wave entry cap, which is why the catalog scene is a new scene',
    sites: [
      { file: ORACLE, anchor: 'staggered spawns \\(', pattern: '^(\\d+) × 19' },
      { file: SPIKE, anchor: '\\| Creeps scheduled \\| ', pattern: '^(\\d+) entries' },
      { file: M2, anchor: 'already at its', pattern: '^\\s*(\\d+)-entry' },
    ],
  },
  {
    id: 'stress-tower-cost',
    claim: "what each of the stress scene's three tower kinds costs",
    value: '12',
    numeric: 12,
    basis:
      "authored equal, so 150 x cost equals `startingBounty` exactly — the scene's second placement oracle",
    sites: [
      { file: ORACLE, anchor: 'placements × cost', pattern: '^\\s*(\\d+) exactly' },
      { file: SCENARIO, anchor: 'total cost \\(150 ×', pattern: '^\\s*(\\d+) =' },
      { file: ADR, anchor: 'and all three towers cost', pattern: '^\\s*(\\d+) so' },
      {
        file: ADR,
        anchor: "breaks the scene's second oracle\\*\\* — the `150 ×",
        pattern: '^\\s*(\\d+) =',
      },
      { file: STRESS_RULESET, anchor: '"id": "stress-blast",', pattern: '^\\s*"cost": (\\d+),' },
      { file: STRESS_RULESET, anchor: '"id": "stress-chill",', pattern: '^\\s*"cost": (\\d+),' },
      { file: STRESS_RULESET, anchor: '"id": "stress-venom",', pattern: '^\\s*"cost": (\\d+),' },
      { file: STRESS_RULESET, anchor: '"id": "stress-single",', pattern: '^\\s*"cost": (\\d+),' },
      {
        file: STRESS_RULESET,
        anchor: '"id": "stress-chill-single",',
        pattern: '^\\s*"cost": (\\d+),',
      },
    ],
  },
  {
    id: 'stress-build-cost',
    claim: "the stress scene's whole build spend, equal to its starting bounty",
    value: '1800',
    numeric: 1800,
    basis: 'derived: 150 placements x cost 12',
    sites: [
      { file: SCENARIO, anchor: 'total cost \\(150 × 12 =', pattern: '^\\s*(\\d+)\\)' },
      { file: ADR, anchor: 'so that `150 × 12 =', pattern: '^\\s*(\\d+)`' },
      {
        file: ADR,
        anchor: "breaks the scene's second oracle\\*\\* — the `150 × 12 =",
        pattern: '^\\s*(\\d+) ==',
      },
      { file: STRESS_RULESET, anchor: '"startingBounty":', pattern: '^\\s*(\\d+),' },
    ],
  },
  {
    id: 'placements-per-tick',
    claim: 'tower placements issued per build tick, in both scenes and in the browser harness',
    value: '3',
    numeric: 3,
    basis: 'authored; the catalog scene keeps it and lengthens its prefix instead',
    sites: [
      {
        file: SCENARIO,
        anchor: 'export const PLACEMENTS_PER_TICK =',
        pattern: '^\\s*(\\d+);',
      },
      {
        file: SCENARIO,
        anchor: 'SAME `PLACEMENTS_PER_TICK` \\(',
        pattern: '^(\\d+)\\)',
      },
      { file: ADR, anchor: 'placements at the pinned', pattern: '^\\s*(\\d+)/tick' },
      {
        file: SPIKE,
        anchor: '`armTower` \\+ `clickAt`,',
        pattern: '^\\s*(\\d+) per tick',
      },
    ],
  },
  {
    id: 'aoe-tower-count',
    claim: 'AoE-producing towers in the stress scene since M2-S5b P9 (down from 150)',
    value: '100',
    numeric: 100,
    basis:
      'authored: P9 split the anchors three ways and gave 50 of them to `stress-venom`, which forced the R0 re-record',
    sites: [
      {
        file: FIXTURE_TEST,
        anchor: 'AoE-producing tower population from 150 to',
        pattern: '^\\s*(\\d+),',
      },
      {
        file: ADR,
        anchor: 'the AoE-producing tower population fell 150 →',
        pattern: '^\\s*(\\d+) —',
      },
      { file: SPIKE, anchor: 'AoE-producing towers \\(', pattern: '^(\\d+), down' },
      {
        file: SPIKE,
        anchor: 'the AoE-producing tower count fell 150 →',
        pattern: '^\\s*(\\d+)\\)',
      },
      {
        file: M2,
        anchor: 'the AoE-producing tower count fell 150 →',
        pattern: '^\\s*(\\d+)\\)',
      },
    ],
  },
  {
    id: 'wave-countdown-ticks',
    claim: "the first wave's countdown, inside which the whole build prefix lands",
    value: '100',
    numeric: 100,
    basis: 'authored in the stress ruleset; both build prefixes (50 and 55 ticks) fit inside it',
    sites: [
      {
        file: SCENARIO,
        anchor: "anchors landing inside the wave's",
        pattern: '^\\s*(\\d+)-tick countdown',
      },
      {
        file: SCENARIO,
        anchor: "Still comfortably inside the wave's",
        pattern: '^\\s*(\\d+)-tick countdown',
      },
      { file: SPIKE, anchor: 'the rest of the', pattern: '^\\s*(\\d+)-tick\\s' },
      { file: STRESS_RULESET, anchor: '"countdownTicks":', pattern: '^\\s*(\\d+),' },
    ],
  },
  {
    id: 'tick-rate-hz',
    claim: "the sim's fixed tick rate",
    value: '20',
    numeric: 20,
    basis:
      'declared by the engine: a 50 ms fixed timestep, which the spike measured the sim holding',
    sites: [
      {
        file: ADR,
        anchor: 'the sim advances \\*\\*only in whole fixed',
        pattern: '^\\s*(\\d+) Hz ticks',
      },
      { file: ADR, anchor: '~200 expected at', pattern: '^\\s*(\\d+) Hz' },
      { file: SPIKE, anchor: 'A tick is \\*\\*50 ms\\*\\* at', pattern: '^\\s*(\\d+) Hz' },
      { file: SPIKE, anchor: '\\(200 expected at', pattern: '^\\s*(\\d+) Hz' },
      { file: SPIKE, anchor: '~200 expected at', pattern: '^\\s*(\\d+) Hz' },
      { file: M2, anchor: 'the sim held its', pattern: '^\\s*(\\d+) Hz cadence' },
      { file: GAME_LOOP, anchor: 'Default simulation cadence:', pattern: '^\\s*(\\d+) Hz' },
    ],
  },

  // THE ROUTE — the floor, the figure it replaced, and the measurements behind the ruling
  {
    id: 'route-floor',
    claim:
      "`ROUTE_LENGTH_FLOOR` — the scripted maze's entrance-to-exit route, a zero-slack tripwire",
    value: '329',
    numeric: 329,
    basis:
      'measured: what the committed layout achieves (307 from eight bands plus 22 from six tail baffles); re-pinned by owner ruling 2026-07-31',
    sites: [
      {
        file: ORACLE,
        anchor: 'export const ROUTE_LENGTH_FLOOR =',
        pattern: '^\\s*(\\d+);',
      },
      { file: ORACLE, anchor: 'route floor: \\*\\*', pattern: '^(\\d+) cells' },
      {
        file: ORACLE_TEST,
        anchor: 'expect\\(ROUTE_LENGTH_FLOOR\\)\\.toBe\\(',
        pattern: '^(\\d+)\\)',
      },
      { file: ADR, anchor: 'The scripted route is', pattern: '^\\s*(\\d+) cells' },
      { file: SPIKE, anchor: 'the scripted route is', pattern: '^\\s*(\\d+) cells' },
      {
        file: SPIKE,
        anchor: 'The committed 150-tower layout measures \\*\\*',
        pattern: '^(\\d+)\\*\\*',
      },
      { file: M2, anchor: "The stress scene's route is", pattern: '^\\s*(\\d+) cells' },
      { file: ORACLE, anchor: '`ROUTE_LENGTH_FLOOR` \\(', pattern: '^(\\d+),' },
      { file: ADR, anchor: '175 DoT records,\\s*\\n\\s*route length', pattern: '^\\s*(\\d+)\\)' },
      {
        file: ADR,
        anchor: 'the scripted route is still exactly\\s*\\n\\*\\*',
        pattern: '^(\\d+)\\*\\*',
      },
      { file: SPIKE, anchor: '\\| Route length\\s+\\| \\*\\*', pattern: '^(\\d+) cells' },
      {
        file: SPIKE,
        anchor: 'Route length is \\*\\*one\\*\\* un-waivable assertion at the measured',
        pattern: '^\\s*(\\d+),',
      },
      { file: M2, anchor: 'un-waivable route assertion at', pattern: '^\\s*(\\d+) with' },
    ],
  },
  {
    id: 'route-floor-superseded',
    claim: 'the route floor S4b committed before measuring, and the ruling replaced',
    value: '600',
    numeric: 600,
    basis:
      'committed pre-measurement; unreachable at ~150 towers on any board and at any tower count on 40x40',
    sites: [
      { file: ORACLE, anchor: 'RE-PINNED FROM', pattern: '^\\s*(\\d+) BY OWNER' },
      { file: ORACLE_TEST, anchor: 'pre-measurement', pattern: '^\\s*(\\d+) to the' },
      {
        file: ADR,
        anchor: 'cells against a committed floor of',
        pattern: '^\\s*(\\d+) —',
      },
      {
        file: SPIKE,
        anchor: 'cells against a committed floor of',
        pattern: '^\\s*(\\d+) \\(ruled',
      },
      {
        file: M2,
        anchor: 'cells against a committed floor of',
        pattern: '^\\s*(\\d+) —',
      },
    ],
  },
  {
    id: 'route-cap-at-adr-figure',
    claim: 'where ~150 towers cap the route on any board size',
    value: '330',
    numeric: 330,
    basis: 'derived: a 2x2 tower buys about 2.2 cells of route; confirmed by the band-only sweep',
    sites: [
      { file: ORACLE, anchor: 'capping\\s+\\*\\s+near', pattern: '^\\s*(\\d+);' },
      { file: ADR, anchor: '150 towers cap near', pattern: '^\\s*(\\d+)\\s' },
      { file: M2, anchor: '150 towers cap near', pattern: '^\\s*(\\d+) on' },
    ],
  },
  {
    id: 'route-ceiling-40x40',
    claim: 'the longest route the 40x40 board admits at any tower count',
    value: '459',
    numeric: 459,
    basis: 'measured: twelve bands is all that fits at the 2-cell wall / 1-cell corridor pitch',
    sites: [
      {
        file: ORACLE,
        anchor: 'twelve bands is all that fits,\\s+\\*\\s+capping at',
        pattern: '^\\s*(\\d+)\\.',
      },
      {
        file: ADR,
        anchor: 'twelve bands is all that fits, capping at',
        pattern: '^\\s*(\\d+) —',
      },
      { file: SPIKE, anchor: 'budget caps at \\*\\*', pattern: '^(\\d+)\\*\\*' },
      { file: M2, anchor: 'the ceiling is', pattern: '^\\s*(\\d+)\\)' },
    ],
  },
  {
    id: 'route-towers-for-600',
    claim: 'roughly how many towers the superseded 600-cell route would need',
    value: '270',
    numeric: 270,
    basis: 'derived from the same ~2.2 cells of route per tower, on a board larger than 40x40',
    sites: [
      {
        file: ORACLE,
        anchor: 'larger board and roughly',
        pattern: '^\\s*(\\d+) towers',
      },
      {
        file: ADR,
        anchor: 'a larger board and\\s*\\n\\s*roughly',
        pattern: '^\\s*(\\d+) towers',
      },
      { file: SPIKE, anchor: 'would need roughly', pattern: '^\\s*(\\d+) towers' },
      {
        file: SPIKE,
        anchor: 'would need a larger board and roughly',
        pattern: '^\\s*(\\d+) towers',
      },
      { file: M2, anchor: 'larger board and roughly', pattern: '^\\s*(\\d+) towers' },
    ],
  },
  {
    id: 'band-route-40',
    claim: 'the band-only route on a 40x40 board under a 150-tower budget',
    value: '307',
    numeric: 307,
    basis: 'measured (144 towers used); the committed layout adds six tail baffles to reach 329',
    sites: [
      { file: ORACLE, anchor: 'near 330; measured', pattern: '^\\s*(\\d+)/' },
      { file: ADR, anchor: 'budget: 40×40 →', pattern: '^\\s*(\\d+),' },
      { file: SPIKE, anchor: 'budget: 40×40 →', pattern: '^\\s*(\\d+) \\(' },
      { file: SPIKE, anchor: 'cells:', pattern: '^\\s*(\\d+) from the eight' },
    ],
  },
  {
    id: 'band-route-50',
    claim: 'the band-only route on a 50x50 board under a 150-tower budget',
    value: '298',
    numeric: 298,
    basis: 'measured (138 towers used)',
    sites: [
      { file: ORACLE, anchor: 'near 330; measured \\d+/', pattern: '^(\\d+)/' },
      { file: ADR, anchor: '50×50 →', pattern: '^\\s*(\\d+),' },
      { file: SPIKE, anchor: '50×50 →', pattern: '^\\s*(\\d+) \\(' },
    ],
  },
  {
    id: 'band-route-60',
    claim: 'the band-only route on a 60x60 board under a 150-tower budget',
    value: '308',
    numeric: 308,
    basis: 'measured (140 towers used)',
    sites: [
      { file: ORACLE, anchor: 'near 330; measured \\d+/\\d+/', pattern: '^(\\d+)/' },
      { file: ADR, anchor: '60×60 →', pattern: '^\\s*(\\d+),' },
      { file: SPIKE, anchor: '60×60 →', pattern: '^\\s*(\\d+) \\(' },
    ],
  },
  {
    id: 'band-board-largest',
    claim: 'the side of the largest board the band-only sweep measured',
    value: '80',
    numeric: 80,
    basis: 'measured sweep; quadrupling the board area bought nothing, so the budget binds',
    sites: [
      { file: ORACLE, anchor: 'on 40×40/50×50/60×60/', pattern: '^(\\d+)×' },
      { file: ADR, anchor: '60×60 → 308, ', pattern: '^(\\d+)×' },
      { file: SPIKE, anchor: '60×60 → 308 \\(140\\), ', pattern: '^(\\d+)×' },
    ],
  },

  // THE POPULATION FLOORS, and the window they are asserted over
  {
    id: 'peak-live-floor',
    claim: '`PEAK_LIVE_CREEPS_THRESHOLD` — peak concurrent live creeps the window must reach',
    value: '280',
    numeric: 280,
    basis: "committed before measurement: ADR 0005's ~300 less headroom for a wave's ebb",
    sites: [
      {
        file: ORACLE,
        anchor: 'export const PEAK_LIVE_CREEPS_THRESHOLD =',
        pattern: '^\\s*(\\d+);',
      },
      {
        file: ORACLE,
        anchor: 'over the sampled window, must be at least',
        pattern: '^\\s*(\\d+) —',
      },
      { file: ORACLE_TEST, anchor: '\\(peak = 304 >=', pattern: '^\\s*(\\d+)\\)' },
      { file: SPIKE, anchor: '0 leftover bounty, ≥', pattern: '^\\s*(\\d+) creeps' },
      { file: M2, anchor: 'peak 304 concurrent \\(floor', pattern: '^\\s*(\\d+)\\)' },
    ],
  },
  {
    id: 'median-live-floor',
    claim: '`MEDIAN_LIVE_CREEPS_THRESHOLD` — median live creeps across the window',
    value: '200',
    numeric: 200,
    basis:
      'a regression tripwire pinned below the measured 224, not a pre-committed target; far above the ~1 a degenerate window produces',
    sites: [
      {
        file: ORACLE,
        anchor: 'export const MEDIAN_LIVE_CREEPS_THRESHOLD =',
        pattern: '^\\s*(\\d+);',
      },
      {
        file: ORACLE,
        anchor: '`MEDIAN_LIVE_CREEPS_THRESHOLD` \\(',
        pattern: '^(\\d+),',
      },
      {
        file: ORACLE,
        anchor: 'MEDIAN live creeps across the window must be at least',
        pattern: '^\\s*(\\d+) ',
      },
      { file: SPIKE, anchor: 'route floor and the', pattern: '^\\s*(\\d+) median-creep' },
      { file: M2, anchor: 'median 224 \\(floor', pattern: '^\\s*(\\d+)\\)' },
    ],
  },
  {
    id: 'peak-slowed-floor',
    claim: '`PEAK_SLOWED_CREEPS_THRESHOLD` — creeps carrying an active slow at peak',
    value: '100',
    numeric: 100,
    basis:
      "committed before measurement: a scene with no live status effects is not ADR 0005's active mix",
    sites: [
      {
        file: ORACLE,
        anchor: 'export const PEAK_SLOWED_CREEPS_THRESHOLD =',
        pattern: '^\\s*(\\d+);',
      },
      {
        file: ORACLE,
        anchor: 'At peak, at least',
        pattern: '^\\s*(\\d+) creeps must carry',
      },
      {
        file: M2,
        anchor: 'peak 304 under status\\s*\\n\\s*\\(floor',
        pattern: '^\\s*(\\d+)\\)',
      },
    ],
  },
  {
    id: 'degenerate-window-ticks',
    claim: 'the one-creep ticks in the synthetic window that passes every peak-based check',
    value: '2499',
    numeric: 2499,
    basis:
      'constructed: one peak tick plus the rest of the 2,500-tick window at one creep, which is why a median floor exists',
    sites: [
      {
        file: ORACLE,
        anchor: 'a window of one tick at 304 creeps followed by',
        pattern: '^\\s*([\\d,]+) ticks',
      },
      {
        file: SPIKE,
        anchor: 'a window of one tick at 304 creeps and',
        pattern: '^\\s*([\\d,]+) at',
      },
    ],
  },
  {
    id: 'sample-window',
    claim: 'the sustained sampled window, in ticks — the sample count every floor is out of',
    value: '2500',
    numeric: 2500,
    basis: "`harness.ts`'s `SAMPLE_TICKS`, after a 200-tick warm-up",
    sites: [
      { file: FIXTURE_TEST, anchor: 'const N_FULL =', pattern: '^\\s*([\\d_]+);' },
      {
        file: ORACLE,
        anchor: 'fewer than\\s+\\*\\s+2,000/',
        pattern: '^([\\d,]+) qualifying',
      },
      {
        file: SCENARIO,
        anchor: 'Measured over the identical',
        pattern: '^\\s*([\\d,]+)-tick',
      },
      {
        file: SPIKE,
        anchor: 'then a sustained window of \\*\\*',
        pattern: '^([\\d,]+) ticks',
      },
      {
        file: SPIKE,
        anchor: '### `step\\(\\)` time — headless, unthrottled',
        pattern: '^\\s*([\\d,]+) sustained samples',
      },
      {
        file: M2,
        anchor: 'due-blast samples \\(floor 500\\),',
        pattern: '^\\s*([\\d,]+) qualifying',
      },
      { file: HARNESS, anchor: 'export const SAMPLE_TICKS =', pattern: '^\\s*([\\d_]+);' },
      {
        file: HARNESS,
        anchor: 'The sustained sampling window: ticks 200\\.\\.2699 \\(',
        pattern: '^([\\d,]+) ticks',
      },
    ],
  },
  {
    id: 'qualifying-floor',
    claim: '`QUALIFYING_SAMPLES_THRESHOLD` — samples on a running, populated board',
    value: '2000',
    numeric: 2000,
    basis: 'committed before measurement: the headline "was the sim doing sustained work" floor',
    sites: [
      {
        file: ORACLE,
        anchor: 'export const QUALIFYING_SAMPLES_THRESHOLD =',
        pattern: '^\\s*([\\d_]+);',
      },
      {
        file: ORACLE,
        anchor: '/\\*\\* At least(?= [\\d,]+ samples must QUALIFY)',
        pattern: '^\\s*([\\d,]+) samples',
      },
      { file: ORACLE, anchor: 'fewer than\\s+\\*\\s+', pattern: '^([\\d,]+)/' },
      { file: M2, anchor: 'qualifying \\(floor', pattern: '^\\s*([\\d,]+)\\)' },
    ],
  },
  {
    id: 'due-blast-subset-n',
    claim: "the stress run's measured due-blast subset — the sample the gate's numerator is over",
    value: '1427',
    numeric: 1427,
    basis:
      'measured post-M2-S5b P9, when the AoE-producing tower count fell 150 -> 100 (the pre-P9 plan figure was 1671)',
    sites: [
      {
        file: FIXTURE_TEST,
        anchor: '`pnpm run perf` reports',
        pattern: '^\\s*(\\d+)\\)',
      },
      {
        file: FIXTURE_TEST,
        anchor: 'the instrumented run now measures',
        pattern: '^\\s+\\*\\s+(\\d+)\\.',
      },
      { file: ADR, anchor: '224 median,', pattern: '^\\s*([\\d,]+) due-blast' },
      { file: SPIKE, anchor: 'sustained samples;', pattern: '^\\s*([\\d,]+) of them' },
      {
        file: SPIKE,
        anchor: 'Stress — due-blast ticks \\(n=',
        pattern: '^([\\d,]+)\\)',
      },
      { file: M2, anchor: '\\(floor 100\\), \\*\\*', pattern: '^([\\d,]+)\\*\\*' },
      {
        file: FIXTURE_TEST,
        anchor: 'a 0\\.12% margin \\(0\\.21% at\\s*\\n// n =',
        pattern: '^\\s*([\\d,]+),',
      },
    ],
  },

  // THE DoT AND ARMOR FLOORS' ARITHMETIC
  {
    id: 'armored-spawns',
    claim: '`stress-armored` creeps among the 304 scheduled spawns',
    value: '114',
    numeric: 114,
    basis:
      "authored by M2-S5b P9 (`layout.ts`'s wave-entry doc); the armored-live floor of 50 sits well under it",
    sites: [
      {
        file: ORACLE,
        anchor: 'at least\\s+\\*\\s+50\\.',
        pattern: '^\\s*(\\d+) `stress-armored`',
      },
      { file: ORACLE, anchor: 'at its measured peak \\(', pattern: '^(\\d+)\\)' },
      { file: ADR, anchor: 'and an armored population \\(', pattern: '^(\\d+) of' },
      {
        file: SPIKE,
        anchor: 'a `stress-armored` population — ',
        pattern: '^(\\d+) of',
      },
    ],
  },
  {
    id: 'dot-records-ceiling',
    claim: 'the post-sweep arithmetic ceiling on concurrent DoT records',
    value: '400',
    numeric: 400,
    basis: 'derived: floor((240-1)/30)+1 = 8 live records per source x 50 venom towers',
    sites: [
      {
        file: ORACLE,
        anchor: 'give an arithmetic ceiling of',
        pattern: '^\\s+\\*\\s+(\\d+) concurrent',
      },
      {
        file: ORACLE,
        anchor: "`PEAK_DOT_RECORDS_THRESHOLD`'s neighbourhood:",
        pattern: '^\\s*(\\d+) post-sweep',
      },
    ],
  },
  {
    id: 'dot-depth-at-peak',
    claim: "the stress arm's DoT record depth per carrier at its peak-records tick, rounded",
    value: '9.2',
    numeric: 9.2,
    basis: 'derived: 175 records over 19 carriers; the depth floor of 6 sits under it',
    sites: [
      { file: ORACLE, anchor: '19 carriers is ~', pattern: '^([\\d.]+) records' },
      { file: ORACLE_TEST, anchor: 'depth ~', pattern: '^([\\d.]+)' },
    ],
  },
  {
    id: 'stress-oracle-rows',
    claim: 'rows the oracle carries on the stress arm (gated plus reported)',
    value: '16',
    numeric: 16,
    basis: 'counted in `oracle.ts` and `run.ts` after M2-S5b P9/P10 added five gated rows',
    sites: [
      {
        file: SPIKE,
        anchor: 'genuinely advancing across the window\\)\\.',
        pattern: '^\\s*\\*\\*(\\d+)\\*\\* assertions',
      },
      {
        file: M2,
        anchor: 'The oracle now carries',
        pattern: '^\\s*\\*\\*(\\d+)\\*\\* rows on the stress arm',
      },
      { file: ADR, anchor: 'p99 0\\.726 ms\\)\\. All', pattern: '^\\s*(\\d+) stress-arm' },
    ],
  },
  {
    id: 'stress-oracle-gated-rows',
    claim: 'of those stress-arm rows, the ones that gate',
    value: '15',
    numeric: 15,
    basis: 'counted: every stress-arm row but the reported-not-gated `dotCarriers`',
    sites: [
      {
        file: SPIKE,
        anchor: 'assertions on the stress run \\(',
        pattern: '^(\\d+) gated',
      },
      { file: M2, anchor: 'rows on the stress arm \\(', pattern: '^(\\d+) gated' },
    ],
  },

  // THE CATALOG SCENE (M2-S11 P7) — the fourth scene's shape and re-pinned floors
  {
    id: 'catalog-tower-count',
    claim: 'placements in the catalog scene — the 150 anchors plus the mine pads',
    value: '165',
    numeric: 165,
    basis: 'authored by the P7 amendment; live towers hold flat at it across every sampled tick',
    sites: [
      { file: SCENARIO, anchor: '`CATALOG_TOWER_COUNT` \\(', pattern: '^(\\d+)\\)' },
      {
        file: SCENARIO,
        anchor: 'catalog towers over',
        pattern: '^\\s*(\\d+)\\s',
      },
      { file: ADR, anchor: 'strengthens to \\*\\*==', pattern: '^\\s*(\\d+) at' },
      {
        file: ADR,
        anchor: 'extension rather than warm-up\\. Build',
        pattern: '^\\s*(\\d+) placements',
      },
      { file: M2, anchor: 'towers hold \\*\\*==', pattern: '^\\s*(\\d+) across' },
      {
        file: SCENARIO,
        anchor: 'scenes \\(150 anchors\\) and the catalog scene\\s+\\*\\s+\\(',
        pattern: '^(\\d+) placements',
      },
      { file: ADR, anchor: 'the ten detonations \\(', pattern: '^(\\d+) →' },
      { file: M2, anchor: 'the ten detonations \\(', pattern: '^(\\d+) →' },
      { file: LAYOUT, anchor: 'export const CATALOG_TOWER_COUNT =', pattern: '^\\s*(\\d+);' },
    ],
  },
  {
    id: 'catalog-mine-count',
    claim: 'mine pads the catalog scene places off the anchor set',
    value: '15',
    numeric: 15,
    basis: 'authored by the P7 amendment: no route-neutral pad exists near the early route',
    sites: [
      {
        file: SCENARIO,
        anchor: 'seven attacking kinds,\\s+\\*\\s+then',
        pattern: '^\\s*(\\d+) `mine`',
      },
      {
        file: ADR,
        anchor: 'force the applied amendment:\\s*\\nthe',
        pattern: '^\\s*(\\d+) mines',
      },
      { file: ADR, anchor: 'mines stand on', pattern: '^\\s*(\\d+) authored' },
      {
        file: M2,
        anchor: 'forced the applied amendment: the',
        pattern: '^\\s*(\\d+) mines',
      },
    ],
  },
  {
    id: 'catalog-build-ticks',
    claim: "the catalog scene's build-tick prefix",
    value: '55',
    numeric: 55,
    basis: 'derived: 165 placements at 3 per tick',
    sites: [
      {
        file: SCENARIO,
        anchor: 'export const CATALOG_BUILD_TICKS =',
        pattern: '^\\s*(\\d+);',
      },
      {
        file: SCENARIO,
        anchor: 'prefix LENGTH differs: 165 / 3 = \\*\\*',
        pattern: '^(\\d+)\\*\\*',
      },
      { file: ADR, anchor: 'at the pinned 3/tick =', pattern: '^\\s*(\\d+) ticks' },
    ],
  },
  {
    id: 'catalog-dot-records-measured',
    claim: "the catalog scene's measured peak resident DoT records",
    value: '12',
    numeric: 12,
    basis:
      'measured: the ground family travels as a ~27-cell convoy, so only ~6 venom towers engage at once',
    sites: [
      {
        file: ADR,
        anchor: 'peak resident DoT\\s*\\nrecords measured',
        pattern: '^\\s*(\\d+) against',
      },
      {
        file: M2,
        anchor: 'proposed ≥ 1000, peak DoT records',
        pattern: '^\\s*(\\d+) vs',
      },
      { file: M2, anchor: 'by owner ruling \\(531/', pattern: '^(\\d+) measured' },
    ],
  },
  {
    id: 'catalog-dot-records-proposed',
    claim: 'the peak DoT records floor the catalog scene proposed before measuring',
    value: '20',
    numeric: 20,
    basis: 'estimated pre-measurement assuming all sources engage simultaneously; re-pinned to 10',
    sites: [
      {
        file: ADR,
        anchor: 'records measured 12 against the proposed ≥',
        pattern: '^\\s*(\\d+)\\.',
      },
      { file: M2, anchor: 'peak DoT records 12 vs ≥', pattern: '^\\s*(\\d+)\\.' },
    ],
  },
  {
    id: 'catalog-stunned-floor',
    claim: "the catalog scene's re-pinned stunned-samples floor",
    value: '400',
    numeric: 400,
    basis: 'owner ruling 2026-08-09, measurement-backed: 531 measured against a proposed 1000',
    sites: [
      {
        file: ADR,
        anchor: 'the owner re-pinned the floors to the measurement-backed ≥',
        pattern: '^\\s*(\\d+) and',
      },
      {
        file: M2,
        anchor: 'Rob re-pinned the floors to the measurement-backed ≥',
        pattern: '^\\s*(\\d+) and',
      },
      { file: M2, anchor: 'measured → floors', pattern: '^\\s*(\\d+)/10' },
      // The executable threshold the catalog oracle enforces, so the canonical claim and the
      // enforced floor cannot diverge (`oracle-catalog.ts` is off-surface, so nothing else
      // would see it).
      {
        file: 'packages/perf/src/oracle-catalog.ts',
        anchor: 'export const STUNNED_SAMPLES_FLOOR =',
        pattern: '^\\s*(\\d+);',
      },
    ],
  },

  // THE POPULATION GAP between the arms — the residual a single-form twin cannot close
  {
    id: 'population-gap-before',
    claim: "the control arm's population gap before round 1 matched the chill pair's slow",
    value: '28.6',
    numeric: 28.6,
    basis: "derived: control median 160 against the stress arm's 224",
    sites: [
      { file: SCENARIO, anchor: 'a population gap of ~', pattern: '^([\\d.]+)%' },
      {
        file: SPIKE,
        anchor: 'narrowed the population gap from −',
        pattern: '^([\\d.]+)%',
      },
    ],
  },
  {
    id: 'population-gap-after',
    claim: "the control arm's population gap after round 1's fix",
    value: '19.2',
    numeric: 19.2,
    basis: "derived: control median 181 against the stress arm's 224",
    sites: [
      { file: SCENARIO, anchor: '% down to ~', pattern: '^([\\d.]+)%' },
      { file: SPIKE, anchor: '% to\\s*\\n−', pattern: '^([\\d.]+)%' },
    ],
  },

  // THE SPIKE'S HEADLINE READINGS the documents restate
  {
    id: 'step-cost-low',
    claim: "the low end of `step()`'s measured cost per 50 ms tick in the browser spike",
    value: '0.2',
    numeric: 0.2,
    basis: 'measured across both emulated profiles; the sim is not the bottleneck',
    sites: [
      { file: ADR, anchor: '`step\\(\\)` costs', pattern: '^\\s*([\\d.]+)–0\\.32' },
      { file: SPIKE, anchor: '`step\\(\\)` costs', pattern: '^\\s*([\\d.]+)–0\\.32' },
      { file: M2, anchor: '`step\\(\\)` costs', pattern: '^\\s*([\\d.]+)–0\\.32' },
    ],
  },
  {
    id: 'arm-median-correlation',
    claim: "the four-run cohort's cross-arm correlation of the MEDIANS",
    value: '0.99',
    numeric: 0.99,
    basis:
      'measured over four byte-identical CI runs; the only correlation whose 95% CI excludes zero',
    sites: [
      {
        file: ADR,
        anchor: 'cross-arm correlation \\*\\*\\+',
        pattern: '^([\\d.]+)\\*\\*',
      },
      { file: ADR, anchor: 'on top of the \\+0\\.88-versus-\\+', pattern: '^([\\d.]+) ' },
      { file: ADR, anchor: 'Only the \\+', pattern: '^([\\d.]+) excludes' },
      { file: SPIKE, anchor: "the arms' medians co-move \\(\\+", pattern: '^([\\d.]+)\\)' },
    ],
  },
  {
    id: 'within-band-strawman',
    claim: 'the symmetric "within N%" rule ADR 0005 rejects for its two-directional budgets',
    value: '25',
    numeric: 25,
    basis: 'declared by ADR 0005 as the rule it does NOT use; the spike restates the rejection',
    sites: [
      { file: ADR, anchor: 'a single "within', pattern: '^\\s*(\\d+)%" rule' },
      { file: SPIKE, anchor: 'a single "within', pattern: '^\\s*(\\d+)%" rule' },
    ],
  },
];

/** Every row, gate and scene oracle alike — what the resolver, the sweep and the accounting read. */
export const CLAIMS: readonly Claim[] = [...GATE_CLAIMS, ...SCENE_ORACLE_CLAIMS];
