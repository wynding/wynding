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
   *  `1.10` agree. Omitted for identifiers (run ids, commit heads, image names), which are
   *  compared as exact strings. */
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
        file: GATE_TEST,
        anchor: 'with TOLERANCE, yields the',
        pattern: '([\\d.]+) ceiling the provenance doc records',
        within: 80,
      },
      { file: ADR, anchor: '\\*\\*RECORDED 2026-08-05:', pattern: 'ceiling \\*\\*([\\d.]+)\\*\\*' },
      {
        file: SPIKE,
        anchor: 'the numerator moved again to',
        pattern: '\\(ceiling \\*\\*([\\d.]+)\\*\\*',
      },
      { file: M2, anchor: 'The numerator is now', pattern: '\\(ceiling ([\\d.]+),' },
    ],
  },
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
        file: ADR,
        anchor: 'The only other reading is the four diagnostic runs',
        pattern: 'against ([\\d.]+)\\)',
      },
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
    id: 'observed-max',
    claim: 'the largest `R` ever observed under the p50/p50 statistic, across both cohorts',
    value: '1.0493',
    numeric: 1.0493,
    basis: "the four diagnostic runs of 2026-08-03/05, whose max exceeds the 17-attempt cohort's",
    sites: [
      {
        file: GATE,
        anchor: 'purely descriptive margin',
        pattern: 'across BOTH readings on record, is \\*\\*([\\d.]+)\\*\\*',
      },
      {
        file: ADR,
        anchor: 'purely descriptive margin',
        pattern: 'across BOTH readings on record, is \\*\\*([\\d.]+)\\*\\*',
      },
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
        file: ADR,
        anchor: 'The only other reading is the four diagnostic runs',
        pattern: '\\(median ([\\d.]+) against',
      },
    ],
  },
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
      {
        file: ADR,
        anchor: 'matched medians give',
        pattern: '\\*\\*.([\\d.]+)%\\*\\* half-spread',
      },
      {
        file: SPIKE,
        anchor: 'the difference is the point: measured over four',
        pattern: 'and .([\\d.]+)% with matched medians',
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
        file: ADR,
        anchor: 'at equal tolerance the median is the LESS sensitive',
        pattern: 'k = ([\\d.]+) on',
      },
      {
        file: M2,
        anchor: 'The end-to-end sensitivity gain is',
        pattern: '. ([\\d.]+), swept\\)',
      },
      {
        file: FIXTURE_TEST,
        anchor: 'continuous sweep \\(step 1e-5',
        pattern: 'p50 fires at ([\\d.]+)',
      },
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
      { file: M2, anchor: 'The end-to-end sensitivity gain is', pattern: '\\s*([\\d.]+).' },
      {
        file: FIXTURE_TEST,
        anchor: 'claim a 2\\.00x end-to-end gain for what is',
        pattern: '\\s*([\\d.]+)x',
      },
    ],
  },
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
    id: 'two-consequences-block-name',
    claim: "the name of the `gate.ts` block ADR 0005's Ruling 5 cites for the local-run disclaimer",
    value: 'THE TWO CONSEQUENCES',
    basis:
      'the citation that replaced `gate.ts:626-633`, which had already rotted once — a name is checkable, a line number is not',
    sites: [
      {
        file: GATE,
        anchor: 'names as the dominant risk',
        pattern: '(THE TWO CONSEQUENCES)',
      },
      {
        file: ADR,
        anchor: "`gate\\.ts`'s `R0` doc, under",
        pattern: '\\*\\*(THE TWO CONSEQUENCES)\\*\\*',
      },
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
];
