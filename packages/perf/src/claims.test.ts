// claims.test.ts — the cross-file consistency check for the perf gate's numeric claims.
//
// PR #85 ran this as an ad-hoc pass over twelve key claims at review time. Issue #86's
// finding is that review time is the wrong time: three of the seven P1s that PR produced
// were a fix landing in `gate.ts` and not in the ADR that duplicates it, and a reviewer
// reading five files by hand is the mechanism, not the mitigation. So it is a test.
//
// WHAT MAKES IT FALSIFIABLE, and why a table that only checks itself would not be. A
// self-consistent table proves nothing about a downstream document keeping a stale copy.
// This test therefore reads the real files: for every site of every claim it resolves the
// anchor, extracts the value STATED THERE, and compares it to the canonical row.
//
// A SITE THAT FAILS TO RESOLVE IS A FAILURE, NEVER A SKIP. That is the whole point: a
// check that silently passes when it can no longer find what it was checking rots into
// decoration, which is exactly what happened to the line-number citations this table
// replaced.
//
// THREE PROPERTIES ARE ENFORCED HERE, and the second and third exist because review found
// the first one alone was not enough:
//
//  1. VALUE AGREEMENT — every site states the row's value (`states the same value`).
//  2. NO SILENT FALLBACK — blanking a site's matched value must break that site. A site
//     whose pattern can reach a SECOND occurrence inside its window would keep passing
//     after its named occurrence was deleted, which is the promised failure not happening.
//     Codex found one instance (the p50/p50 table cell falling through to the tolerance
//     paragraph's identical `+/- 2.8%`); the audit behind this test found 79 of 198 sites
//     with the same shape, so it is enforced for every site rather than patched one by one
//     (`no site can silently fall back`).
//  3. COVERAGE — every figure `gate.ts` states that also appears in another guarded file
//     has a row. The contract used to be a paragraph asking to be believed; Codex found two
//     whole families it did not cover (DoT records/carriers, and the creep-population
//     figures). A prose contract cannot fail, so it is a sweep now (`the coverage contract
//     is enforced`).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CLAIMS, DEFAULT_SITE_WINDOW, type Claim, type ClaimSite } from './claims';
import { R0, TOLERANCE } from './gate';

/** `packages/perf/src/` -> repo root. Sites are repo-relative because claims cross package
 *  and doc boundaries; resolving from `import.meta.url` keeps that independent of cwd. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const fileCache = new Map<string, string>();
function read(file: string): string {
  const cached = fileCache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  fileCache.set(file, text);
  return text;
}

type Located = { index: number } | { error: string };

/** Where a site's anchor resolves to, or why it did not. The anchor is a regular
 *  expression so a site can tolerate the dash characters and hard line wraps prose editors
 *  introduce, without tolerating a changed VALUE. It must match exactly once. */
function locateAnchor(site: ClaimSite, text: string): Located {
  const hits = [...text.matchAll(new RegExp(site.anchor, 'g'))];
  const hit = hits[0];
  if (hit === undefined) {
    return {
      error: `anchor did not resolve — no match for /${site.anchor}/ in ${site.file}. An anchor that no longer exists is rot, not an excuse to skip.`,
    };
  }
  if (hits.length > 1) {
    return {
      error: `anchor is ambiguous — ${hits.length} matches for /${site.anchor}/ in ${site.file}. An anchor must name one place.`,
    };
  }
  return { index: (hit.index ?? 0) + hit[0].length };
}

type Extracted = { value: string; start: number; end: number } | { error: string };

/** The value a site states, with its absolute offsets, or why it could not be read. */
function extract(site: ClaimSite, text = read(site.file)): Extracted {
  const located = locateAnchor(site, text);
  if ('error' in located) return located;
  const window = site.within ?? DEFAULT_SITE_WINDOW;
  const region = text.slice(located.index, located.index + window);
  // `d` gives each group's real span. Without it the only way back to the capture's offset
  // is `match[0].indexOf(captured)`, which binds the FIRST identical substring in the full
  // match — the wrong span whenever the value repeats earlier in it (CodeRabbit, PR #161).
  const match = new RegExp(site.pattern, 'd').exec(region);
  if (match === null) {
    return {
      error: `pattern /${site.pattern}/ found nothing within ${window} characters after the anchor in ${site.file}. Either the claim moved away from its anchor or its wording changed.`,
    };
  }
  const captured = match[1];
  if (captured === undefined) {
    return {
      error: `pattern /${site.pattern}/ has no capture group — a site must capture the value it states.`,
    };
  }
  // Offsets of the CAPTURE inside the whole file, so a caller can blank exactly it.
  const span = (match as RegExpExecArray & { indices?: (readonly [number, number] | undefined)[] })
    .indices?.[1];
  const relative = span !== undefined ? span[0] : (match.index ?? 0) + match[0].indexOf(captured);
  const capturedAt = located.index + relative;
  return { value: captured, start: capturedAt, end: capturedAt + captured.length };
}

/** THE ONE CLAIM-VALUE SEMANTICS. Everything in this suite that compares or keys a stated
 *  value goes through here, because three subsystems previously each decided for themselves
 *  and two of them decided differently: the resolver treated `1.1` and `1.10` as the same
 *  claim while the fallback check compared raw strings (so blanking a named `1.10` that fell
 *  through to a `1.1` looked like a real difference and passed), and the all-pairs sweep
 *  keyed by exact spelling (so `12.340` in a source and `12.34` in a doc never grouped).
 *  Codex found both. A site-local reimplementation of this is the bug, so there is exactly
 *  one of them.
 *
 *  A numeric token normalises to its number; anything else — run ids, commit heads, image
 *  names, block names — is its own exact string, since `a1600c9` is not a quantity. */
/** ONE DEFINITION OF "A NUMERAL", and everything that asks about numerals asks this.
 *
 *  It drifted once already, exactly the way the slash classifier did. The tokenizer learned
 *  leading-dot and scientific spellings in round 15; the mask's numeral-led prohibition, written
 *  a round later, still required an initial DIGIT — so `.00922/iteration` was blanked as a file
 *  path and its numeral left the sweep silently (Codex). `claimKey` carried a third spelling of
 *  the same idea, which filed `.00922` under a string key instead of a numeric one.
 *
 *  A second definition of a thing is a defect waiting for its reproduction. There is one now:
 *  the grammar body below, and the three consumers built from it — `IS_NUMERAL` (is this whole
 *  string one), `NUMERAL` (find them in prose), `IS_BARE_NUMERAL` (is this path segment nothing but one).
 *
 *  Signs are still read OFF the numeral, deliberately: a row valued -1.36 covers a prose 1.36,
 *  and the sign is enforced at the row's sites. `IS_NUMERAL` accepts a leading sign because it
 *  answers a different question — whether an already-extracted string is numeric. */
/** A run of digits, separators allowed INSIDE but never at either end. Named once, because the
 *  integer part had it and the fractional and exponent parts did not — so `1.006_5` keyed as
 *  1.006, a different claim from the one it restates, and `1.0e1_0` as 1.0e1 (Codex, PR #161).
 *  Every part of a numeral is the same kind of thing; it is spelled once and used three times. */
const DIGIT_RUN = String.raw`\d(?:[\d,_]*\d)?`;

const NUMERAL_BODY = String.raw`(?:${DIGIT_RUN}(?:\.${DIGIT_RUN})?|\.${DIGIT_RUN})(?:[eE][+-]?${DIGIT_RUN})?`;

/** WHERE A NUMERAL MAY BEGIN, defined as "not part of the same numeral, and not part of a
 *  NAME" rather than as the complement of a hand-listed word-char set. The old lookbehind was
 *  that complement, and it treated `_` as a word character — so `_1.0065_`, which is just
 *  markdown emphasis around a figure, was refused and the claim inside it never scanned
 *  (Codex, PR #161).
 *
 *  The grammar decides where a numeral ENDS, and the scan is greedy and left-to-right, so
 *  starting mid-numeral is impossible by construction: `1_000` is consumed whole from its
 *  first digit and the scan resumes after it, never inside it. That leaves exactly one thing
 *  a boundary must still refuse — a numeral that is the tail of an IDENTIFIER:
 *
 *    - preceded by a letter (`v1`, `p50`, `R0`); or
 *    - preceded by an underscore that is itself part of an identifier (`foo_1`), which is
 *      what tells `foo_1` apart from `_1.0065_` — the delimiter is the same character, and
 *      only what sits BEFORE it says whether it is a name or emphasis.
 *
 *  A digit or a dot before the numeral is kept as a belt-and-braces guard on the same
 *  mid-numeral case the greediness already covers.
 *
 *  Every other delimiter these documents put against a figure is therefore a boundary, with no
 *  list to keep current: `*`, backtick, `(`, `[`, quotes and typographic quotes, en and em
 *  dashes, `%`, `$`, `/`, `,`. Each is covered by a case in the delimiter test below. */
const NUMERAL_BOUNDARY = String.raw`(?<![A-Za-z])(?<![A-Za-z0-9_]_)(?<![\d.])`;

const IS_NUMERAL = new RegExp(String.raw`^[+-]?` + NUMERAL_BODY + String.raw`$`);

function claimKey(stated: string): string {
  // A leading typographic minus (U+2212) or en-dash is the same sign as an ASCII '-';
  // ADR 0005 writes the cohort's skew as −1.36 while `gate.ts` writes -1.36.
  const bare = stated.replace(/[,_]/g, '').replace(/^[\u2212\u2013]/, '-');
  const parsed = Number(bare);
  return IS_NUMERAL.test(bare) && Number.isFinite(parsed) ? `n:${parsed}` : `s:${stated}`;
}

/** Claim ids that share a `claimKey` with another row — `0.0100` (the fixture's upper grid
 *  point), `0.010` (the broad injection's k) and `0.01` (the flooring granularity) are three
 *  different claims that all normalise to 0.01. Numeric equivalence is the right default, but
 *  where two claims alias it stops telling ATTRIBUTION apart: an occurrence spelled `0.0100`
 *  must be accounted for by a `0.0100` site, not by a `0.010` one that merely normalises to the
 *  same number. Agreement AT a declared site is unaffected — there the owning claim is already
 *  known, and the executable `TOLERANCE` legitimately reads `1.1` for a row valued `1.10`
 *  (CodeRabbit, PR #161). */
const ALIASED_KEYS: ReadonlySet<string> = (() => {
  const seen = new Map<string, number>();
  for (const c of CLAIMS) seen.set(claimKey(c.value), (seen.get(claimKey(c.value)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
})();

/** Whether a value stated at a site is the claim the row holds. */
function agrees(claim: Claim, stated: string): boolean {
  if (claim.numeric === undefined) return stated === claim.value;
  return claimKey(stated) === claimKey(String(claim.numeric));
}

/** Every key a row answers to. The scan reads numerals WITHOUT their sign (`-1.360` is
 *  scanned as `1.360`), so a row valued `-1.36` must also answer to `n:1.36` or none of its
 *  occurrences would ever match it — Codex demonstrated that by restating the skew as
 *  `-1.360` and watching it skip. One rule, applied everywhere a row is keyed: the sweep, the
 *  rowed set, and the accounting index. The SIGN is still enforced where it is stated, by the
 *  row's sites, which capture it. */
function claimKeysFor(claim: Claim): string[] {
  const primary = claimKey(claim.value);
  if (claim.numeric === undefined || claim.numeric >= 0) return [primary];
  return [primary, claimKey(String(Math.abs(claim.numeric)))];
}

/** A site's human label. Several claims are stated TWICE in one file — `2.8%` appears three
 *  times in the spike alone — so the file name alone does not name a site, and a duplicate
 *  `it()` title would leave a reader unable to tell which copy failed. */
function label(site: ClaimSite): string {
  return `${site.file} @ /${site.anchor}/`;
}

describe('the claim table is well formed', () => {
  it('has unique ids', () => {
    const ids = CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every claim a basis and at least two sites — a claim stated in one place needs no table', () => {
    for (const claim of CLAIMS) {
      expect(claim.basis.length, `${claim.id} has no basis`).toBeGreaterThan(0);
      expect(claim.sites.length, `${claim.id} has fewer than two sites`).toBeGreaterThanOrEqual(2);
    }
  });

  it('declares a numeric value that parses, wherever it declares one', () => {
    for (const claim of CLAIMS) {
      if (claim.numeric === undefined) continue;
      expect(Number(claim.value), `${claim.id}'s value and numeric disagree`).toBe(claim.numeric);
    }
  });

  it('never cites a line number — line numbers are the demonstrated rot vector', () => {
    for (const claim of CLAIMS) {
      for (const site of claim.sites) {
        expect(site.anchor, `${claim.id} at ${site.file}`).not.toMatch(/:\d+(-\d+)?\s*$/);
      }
    }
  });

  // A `.` outside a character class matches ANYTHING, so a pattern that wildcards the character
  // BETWEEN two numbers stops reading a range and starts reading whatever is there: flip the
  // en-dash of `1.45%–9.51%` to a `+` and a confidence interval becomes an addition, still green
  // (Codex, PR #161). Thirty-eight of these existed, every one of them standing in for a single
  // symbol — 15 en-dashes, 13 multiplication signs, 8 arrows, 1 em-dash — and one, `attempts
  // 1.17`, was an unescaped decimal point quietly matching the `1–17` actually in the prose.
  //
  // Round 10 closed the symbol-BEFORE-a-number class the same way. This is the BETWEEN and
  // AFTER class, and this test is what keeps it closed: a site may not wildcard anything.
  it('wildcards nothing — every character a pattern matches is one it names', () => {
    const offenders: string[] = [];
    for (const claim of CLAIMS) {
      for (const site of claim.sites) {
        let inClass = false;
        for (let i = 0; i < site.pattern.length; i++) {
          const c = site.pattern[i];
          if (c === '\\') {
            i++;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '.' && !inClass) {
            offenders.push(`${claim.id} at ${site.file}: /${site.pattern}/`);
          }
        }
      }
    }
    expect(
      offenders,
      `these site patterns contain a WILDCARD, so they no longer pin what they appear to pin. ` +
        `Name the character — a dash class, an arrow, a times sign — or escape it if it is a ` +
        `decimal point:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('the executable constants agree with their rows', () => {
  it('`TOLERANCE`', () => {
    expect(CLAIMS.find((c) => c.id === 'tolerance')?.numeric).toBe(TOLERANCE);
  });

  it('`R0`', () => {
    expect(CLAIMS.find((c) => c.id === 'r0')?.numeric).toBe(R0);
  });

  it('the ceiling row is `R0` x `TOLERANCE`', () => {
    expect(R0).not.toBeNull();
    expect(CLAIMS.find((c) => c.id === 'ceiling')?.numeric).toBeCloseTo(
      (R0 as number) * TOLERANCE,
      10,
    );
  });
});

describe('every claim states the same value at every site', () => {
  for (const claim of CLAIMS) {
    for (const site of claim.sites) {
      it(`${claim.id} — ${label(site)}`, () => {
        const result = extract(site);
        if ('error' in result) {
          throw new Error(
            `claim "${claim.id}" (${claim.claim}) could not be read at ${label(site)}: ${result.error}`,
          );
        }
        if (!agrees(claim, result.value)) {
          throw new Error(
            `claim "${claim.id}" (${claim.claim}) is ${claim.value} in claims.ts but ${result.value} at ${label(site)}. ` +
              `Basis: ${claim.basis}. Fix the table row first, then every site it lists.`,
          );
        }
      });
    }
  }

  it('generates a unique title for every site, so a failure names one place', () => {
    const titles = CLAIMS.flatMap((c) => c.sites.map((s) => `${c.id} — ${label(s)}`));
    expect(new Set(titles).size).toBe(titles.length);
  });
});

// PROPERTY 2 — the promised failure has to actually happen.
//
// For every site: blank out the exact characters the site matched, then re-read it. If the
// site still yields the same value, the pattern reached a DIFFERENT occurrence inside its
// window — so deleting the named claim would not have failed the build, and the site is
// guarding nothing. This is Codex's finding generalised: rather than tightening the one
// case it named, every site is required to be un-fallbackable, forever.
describe('no site can silently fall back to another occurrence', () => {
  for (const claim of CLAIMS) {
    for (const site of claim.sites) {
      it(`${claim.id} — ${label(site)}`, () => {
        const original = read(site.file);
        const found = extract(site, original);
        if ('error' in found) {
          // Resolution failures are reported by the suite above; not this property's job.
          return;
        }
        const blanked =
          original.slice(0, found.start) +
          '\0'.repeat(found.end - found.start) +
          original.slice(found.end);
        const after = extract(site, blanked);
        if ('error' in after) return; // deleting the claim broke the site — correct.
        // Compared through `claimKey`, not as raw strings: a named `1.10` falling through to
        // a `1.1` elsewhere in the window IS the silent fallback this property exists to
        // catch, and string inequality would have called it a pass (Codex, PR #161).
        if (claimKey(after.value) === claimKey(found.value)) {
          throw new Error(
            `claim "${claim.id}" at ${label(site)} is BLEED-PRONE: after blanking the value it matched, ` +
              `the same pattern found "${after.value}" — the same claim value — again elsewhere within its ${site.within ?? DEFAULT_SITE_WINDOW}-character window. ` +
              `Deleting the named occurrence would NOT fail this test. Constrain the pattern or the window to this site.`,
          );
        }
      });
    }
  }
});
// PROPERTY 3 — coverage, swept over ALL PAIRS of guarded files and accounted per OCCURRENCE.
//
// Three review rounds hardened this check and each one's finding is why a piece of it exists:
//
//  - SHIP-REVIEW: the contract was a paragraph asking to be believed. A prose contract cannot
//    fail, so it became a sweep.
//  - CODEX: the sweep reduced the table to a set of VALUES, so once any row carried `17`,
//    every `17` in a guarded file read as covered without anyone confirming it sat at a listed
//    site — an unlisted restatement stayed green and could drift. Accounting is now per
//    OCCURRENCE, against the exact capture offsets the resolver returns.
//  - CODERABBIT: the sweep seeded from `gate.ts` alone, so a figure duplicated between ADR
//    0005 and the spike with no `gate.ts` copy was never examined. It is now ALL-PAIRS: any
//    value appearing in two guarded files needs a row, whoever states it.
//
// THE SCAN. One pass per file feeds both halves, and it is OFFSET-PRESERVING — every mask
// replaces text with the same number of spaces — because the occurrence half compares byte
// offsets against the resolver's capture offsets. For `.ts` files it keeps comment text and
// blanks code, INCLUDING trailing comments (`const N = 500; // the floor`) which an earlier
// line-oriented version dropped, and it does so with a small lexer that tracks string and
// template literals so a `//` inside a string is not mistaken for a comment (CodeRabbit).
// Then it blanks the token shapes that are references rather than claims.
//
// THE DISCIPLINE for occurrence accounting, stated because a bare numeral cannot always
// identify a claim. Accounting is enforced for HIGH-INFORMATION occurrences — three or more
// decimal places, or five or more digits — where the numeral is effectively self-identifying
// (`1.0065`, `1.7750`, `0.00922`, `31041932972`). Below that threshold a numeral like `17` or
// `1.10` occurs constantly for unrelated reasons (tick counts, list indices, percentages of
// other things), and requiring every one of them to sit at a listed site would produce noise
// rather than signal. Those values are still covered by the all-pairs half and by their rows'
// declared sites; what is NOT claimed is that every low-information restatement is guarded.
// That gap is real, bounded, and named here rather than papered over.

/** The files whose prose the perf gate's claim set lives in. The SEED half — the six
 *  `packages/perf` sources — defines the SURFACE: a figure is a perf-gate claim if the perf
 *  package states it. The docs are guarded too, and all-pairs coverage runs across every
 *  guarded file, so an ADR<->spike disagreement about a perf figure is caught even when
 *  `gate.ts` never mentions it (CodeRabbit). What the surface deliberately excludes is the
 *  rest of those documents' numeric content — device frame budgets, board geometry, wave
 *  arithmetic — which belongs to other packages and other tests, and which this table has no
 *  business annexing. */
const PERF_SOURCES = [
  'packages/perf/src/gate.ts',
  'packages/perf/src/gate.test.ts',
  'packages/perf/src/gate-fixture.test.ts',
  'packages/perf/src/oracle.ts',
  'packages/perf/src/oracle.test.ts',
  'packages/perf/src/scenario.ts',
] as const;

const GUARDED_FILES = [
  'packages/perf/src/gate.ts',
  'packages/perf/src/gate.test.ts',
  'packages/perf/src/gate-fixture.test.ts',
  'packages/perf/src/oracle.ts',
  'packages/perf/src/oracle.test.ts',
  'packages/perf/src/scenario.ts',
  'docs/adr/0005-performance-budgets.md',
  'docs/design-notes/performance-spike.md',
  'docs/milestones/m2.md',
] as const;

/** Numerals the sweep must not treat as claims, each with the reason. Kept deliberately
 *  small: every entry is a hole, so an entry that stops being needed should be deleted —
 *  which a test below enforces. Same shape as `scripts/glossary-lint.config.json`'s
 *  exception list: a machine-checked contract with named, justified exceptions beats a
 *  prose promise. */
/** The guarded surfaces, named once so an exclusion's census can cite them without a wall of
 *  paths. */
/** The number of guarded surfaces at which a repeated numeral becomes a cross-file claim the
 *  table must account for. Named once, because the coverage half and the exclusion check both
 *  ask it and a second copy is how the last four rounds each started. */
const COLLISION_THRESHOLD = 2;

const G = {
  gate: 'packages/perf/src/gate.ts',
  gateTest: 'packages/perf/src/gate.test.ts',
  fixture: 'packages/perf/src/gate-fixture.test.ts',
  oracle: 'packages/perf/src/oracle.ts',
  oracleTest: 'packages/perf/src/oracle.test.ts',
  scenario: 'packages/perf/src/scenario.ts',
  adr: 'docs/adr/0005-performance-budgets.md',
  spike: 'docs/design-notes/performance-spike.md',
  m2: 'docs/milestones/m2.md',
} as const;

const CONTRACT_EXCLUSIONS: readonly {
  readonly value: string;
  /** The guarded surfaces whose DIFFERENT meanings of this numeral justified the entry — the
   *  census taken when it was written, re-verified every run. An exclusion is subtracted from
   *  the sweep BEFORE the coverage census is built, so unlike a known-unrowed claim nothing
   *  else re-checks it; without this field the only thing verified was that the numeral still
   *  existed somewhere, and an entry whose collision had collapsed sat on, able to suppress a
   *  future genuine cross-file duplicate (Codex, PR #161). */
  readonly surfaces: readonly string[];
  readonly why: string;
}[] = [
  {
    value: '0',
    surfaces: [
      G.gate,
      G.gateTest,
      G.fixture,
      G.oracle,
      G.oracleTest,
      G.scenario,
      G.adr,
      G.spike,
      G.m2,
    ],
    why: 'Bare zero — "zero dropped applications", "0 leftover bounty", "R0". Not a measurement.',
  },
  {
    value: '10',
    surfaces: [G.gate, G.gateTest, G.adr, G.spike, G.m2],
    why: 'The tolerance percentage ("a 10% move in R"), the escalation rule\'s sample floor, and n = 10 all collide on one numeral; each is rowed or argued in its own words, and the digit alone identifies nothing.',
  },
  {
    value: '95',
    surfaces: [G.gate, G.fixture, G.adr, G.m2],
    why: 'Reads as the percentile name (p95) and as "95% power"/"95% CI" throughout; the percentile is a statistic identifier, not a claim value.',
  },
  {
    value: '50',
    surfaces: [G.gate, G.oracle, G.scenario, G.adr, G.spike, G.m2],
    why: 'Same collision as 95 — the p50 percentile name against "50% power" and the 50 venom towers.',
  },
  {
    value: '60',
    surfaces: [G.gate, G.oracle, G.adr, G.spike, G.m2],
    why: "`splash`'s cadence-60 and the 60-tick DoT window are catalog facts owned by the content tests, not perf-gate claims.",
  },
  {
    value: '0.25',
    surfaces: [G.gate, G.adr],
    why: "A digit collision, not a shared claim: gate.ts's 0.25 is `dot-bench`'s ms-per-1,000-records curve, while ADR 0005's only 0.25 is `0.25σ` — the margin flooring discards. Neither document states the other's quantity.",
  },
  {
    value: '1000',
    surfaces: [G.gate, G.oracleTest, G.adr, G.spike, G.m2],
    why: "Another collision: gate.ts's 1,000 is the denominator of that same dot-bench curve; elsewhere it is `MAX_TOTAL_TOWER_COMMANDS`. Different quantities, same numeral.",
  },
  {
    value: '0.8',
    surfaces: [G.gate, G.fixture, G.adr],
    why: 'Two different quantities that coincide: the gating p50 scores 0.8 on the CONCENTRATED injection and p95 scores 0.8 on the BROAD one. Each is stated beside the statistic it belongs to and beside its counterpart (2.2 and 3.9, both rowed), so the pair is guarded through those; the bare numeral cannot tell the two apart and a row keyed on it would bind the wrong sites together.',
  },
  {
    value: '0.3863',
    surfaces: [G.gate, G.spike],
    why: "A collision between two unrelated per-arm tables: gate.ts's 0.3863 is run 1's control p50 in the four-run diagnostic table, while the spike's is attempt 15's STRESS p50 in the 17-attempt operands table. Same numeral, different arm, different cohort.",
  },
  {
    value: '1.9',
    surfaces: [G.fixture, G.adr],
    why: "A collision the numeric normalisation itself surfaced: `gate-fixture.test.ts` states the blind spot's p99 movement as +1.9% (single-file, so not a shared claim), while ADR 0005's only 1.90 is `wy:draw` 1.90% of busy frame time in the browser-spike section. Different subsystems entirely; the two spellings never grouped until claimKey made 1.9 and 1.90 one key.",
  },
  {
    value: '2.7',
    surfaces: [G.gate, G.adr],
    why: "Collision: gate.ts's ~2.7% is the sigma agreement between the n = 4 and n = 17 cohorts; ADR 0005's ×2.7 is the centring step in a flake-rate decomposition this file deliberately drops.",
  },
  {
    value: '30',
    surfaces: [G.oracle, G.adr, G.spike, G.m2],
    why: "Collision, and revealed only when the file-path mask stopped eating compact ratios: oracle.ts's 30 is the DoT record window in `floor((240-1)/30)+1`, ADR 0005's is the ≥ 30 fps low-end floor, the spike's are a 30% slow and a 30% ambient-load swing, and m2.md's are tower range columns. Five unrelated quantities wearing one numeral; a row keyed on it would bind every one of those sites to the others.",
  },
];

/** REAL unrowed shared claims, pinned so the set cannot grow silently.
 *
 *  These are the scene ORACLE's claim family — the stress scene's measured and derived facts,
 *  duplicated between `oracle.ts`'s doc prose and the three documents. They are genuine
 *  cross-file claims of exactly the kind this table exists for, and they are NOT collisions.
 *  They are unrowed because they belong to the oracle's surface rather than the gate's, and
 *  rowing them with verified sites is a body of work this PR sized and measured but did not
 *  undertake — recorded here rather than absorbed silently, and asserted EXACTLY so a new gap
 *  fails the build instead of joining the list. */
const KNOWN_UNROWED: readonly { readonly value: string; readonly why: string }[] = [
  {
    value: '0.1',
    why: 'its canonical value is an executable constant in gate.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '0.2',
    why: 'its canonical value is an executable constant in gate.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '0.99',
    why: 'its canonical value is an executable constant in gate-fixture.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '100',
    why: 'its canonical value is an executable constant in oracle.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '14',
    why: 'its canonical value is an executable constant in gate-fixture.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '1427',
    why: 'its canonical value is an executable constant in gate-fixture.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '15',
    why: 'its canonical value is an executable constant in gate-fixture.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '150',
    why: 'its canonical value is an executable constant in oracle.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '20',
    why: 'its canonical value is an executable constant in oracle.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '200',
    why: 'its canonical value is an executable constant in oracle.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '2000',
    why: 'its canonical value is an executable constant in oracle.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '2499',
    why: 'its canonical value is an executable constant in oracle.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '2500',
    why: 'its canonical value is an executable constant in oracle.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '270',
    why: 'its canonical value is an executable constant in gate-fixture.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '280',
    why: 'its canonical value is an executable constant in oracle.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '3.0',
    why: 'its canonical value is an executable constant in gate-fixture.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '300',
    why: 'its canonical value is an executable constant in gate-fixture.test.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  {
    value: '55',
    why: 'its canonical value is an executable constant in scenario.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  { value: '0.9', why: 'A fixture ratio quoted in the spike; oracle-surface.' },
  { value: '114', why: 'Peak armored live creeps — oracle.ts doc, ADR and spike.' },
  {
    value: '12',
    why: 'Measured peak resident DoT records at the catalog scene — oracle/ADR/spike/m2.',
  },
  { value: '16', why: 'Wave-entry count for the stress schedule — oracle/ADR/spike/m2.' },
  { value: '165', why: 'Catalog-scene tower count — scenario.ts, ADR and m2.' },
  { value: '1800', why: 'Catalog-scene tick figure — scenario.ts and the ADR.' },
  { value: '19.2', why: "The control arm's population gap percentage — scenario.ts and spike." },
  { value: '25', why: 'A fixture/threshold figure shared between the fixture test and the docs.' },
  { value: '28.6', why: 'The pre-narrowing population gap percentage — scenario.ts and spike.' },

  {
    value: '329',
    why: 'its canonical value is an executable constant in oracle.ts, which is evidence for the CODE occurrence but binds none of the prose copies in the guarded documents — the PINNED_IN_CODE exemption it used to carry claimed otherwise and let a doc copy drift green (Codex, PR #161). Oracle-surface, tracked in #163.',
  },
  { value: '330', why: 'Route-length cap at ~150 towers — oracle.ts, ADR and m2.' },
  { value: '36', why: 'Catalog-scene arithmetic shared between scenario.ts and m2.' },
  { value: '40', why: 'Board dimension / threshold numeral shared across oracle and the docs.' },
  { value: '400', why: 'Re-pinned stunned-samples floor — oracle.ts, ADR and m2.' },
  { value: '450', why: 'An oracle threshold quoted in the ADR and m2.' },
  { value: '459', why: 'The 40x40 route-length ceiling — oracle.ts, ADR, spike and m2.' },
  { value: '600', why: 'The unreachable route target — oracle.ts, ADR, spike and m2.' },
  { value: '80', why: 'Board-size figure in the route-cap table — oracle.ts and the docs.' },
  { value: '9.2', why: 'DoT record depth per carrier at peak — oracle.ts doc prose.' },
  {
    value: '298',
    why: "its canonical statement is oracle.ts's compact `307/298/308/329` series of band-only layout cell counts, which the FILE-PATH MASK blanked whole because the series has no letter in it - so three of the four values were invisible to this sweep while 329, which also appears standalone, was not. ADR 0005 and the spike both restate it longhand per board size. Oracle-surface, tracked in #163.",
  },
  {
    value: '307',
    why: "its canonical statement is oracle.ts's compact `307/298/308/329` series of band-only layout cell counts, which the FILE-PATH MASK blanked whole because the series has no letter in it - so three of the four values were invisible to this sweep while 329, which also appears standalone, was not. ADR 0005 and the spike both restate it longhand per board size. Oracle-surface, tracked in #163.",
  },
  {
    value: '308',
    why: "same band-only cell-count series as 298 and 307, hidden by the same file-path mask, and restated longhand in ADR 0005 and the spike. It ALSO coincides with m2.md's `of 308 total` bounty spend, which is an unrelated quantity - so rowing this one will need explicit sites rather than a bare value. Oracle-surface, tracked in #163.",
  },
];

const EXCLUDED = new Set(CONTRACT_EXCLUSIONS.map((e) => e.value));

/** High-information occurrences that are NOT restatements of the row that shares their
 *  numeral. Each names the file and the text immediately before the occurrence, so the
 *  exemption is pinned to one place rather than to a value. */
const OCCURRENCE_EXCEPTIONS: readonly {
  readonly file: string;
  readonly near: string;
  /** The numeral this exception is allowed to excuse. Without it an exception is a blanket
   *  suppressor: matching only preceding CONTEXT, it would excuse ANY unaccounted
   *  high-information value that happened to follow the phrase — Codex demonstrated it by
   *  restating k-new as `// Exactly 0.00922` and watching the suite stay green. An exception
   *  now names what it excuses, so an unexpected numeral after the same phrase still fails. */
  readonly value: string;
  readonly why: string;
}[] = [
  {
    file: 'packages/perf/src/gate-fixture.test.ts',
    near: 'Exactly ',
    value: '1.0000',
    why: 'A ratio that happens to equal 1.0000 exactly at the fixture boundary — not the committed `R0` of 1.00 restated.',
  },
  {
    file: 'packages/perf/src/gate-fixture.test.ts',
    near: 'p95 was ALREADY\\s*\\n\\s*// exactly ',
    value: '1.0000',
    why: 'The same boundary ratio, quoted a second time in the paragraph explaining it. Still not `R0`.',
  },
];

/** THE SCANNER IS THE LANGUAGE'S OWN, and that is the whole design.
 *
 *  This file used to carry a hand-rolled lexer. It was rewritten five times in five review
 *  rounds, and every rewrite was the same bug wearing a new construct: a `/` that the lexer
 *  read as division when the grammar meant a regex, so the regex's quote opened a phantom
 *  string, and the string swallowed the comment behind it — SILENTLY, which is the one failure
 *  this file exists to prevent. `throw`, then `export default`, then a control-condition `)`,
 *  then a `/` whose previous token was the last letter of a COMMENT. Each fix was correct and
 *  each left the next edge standing, because the question "can a regex start here" is a
 *  question about the whole grammar and cannot be answered by a lookbehind.
 *
 *  So it is no longer answered here. `ts.createSourceFile` parses the source with the compiler
 *  the repository already builds with, and the projections below are read off the resulting
 *  tree. Slash classification, template substitutions, nested templates, regex literals and
 *  every construct that used to be REFUSED are now simply LEXED, correctly, by the language's
 *  own answer to its own grammar.
 *
 *  What the walk still owes its callers, unchanged:
 *
 *    - `commentAt` — the bytes inside comment TEXT, which is the prose this file guards.
 *    - `codeAt`    — the bytes of ordinary code, so newlines outside literals survive masking.
 *    - length and position are PRESERVED exactly, because the occurrence half compares byte
 *      offsets against the resolver's; that invariant is asserted in `scannedProse`, not
 *      assumed.
 *
 *  A template SUBSTITUTION is ordinary code now rather than a skipped region, so a comment
 *  inside one is read as the prose it is instead of being refused. Everything the old tripwire
 *  rejected is covered by a test asserting the numeral is SEEN — the constructs did not become
 *  safe, they became legible. */
interface Walked {
  /** Per byte: inside comment TEXT. */
  readonly commentAt: readonly boolean[];
  /** Per byte: ordinary code — not a string, not a template literal, not a comment. */
  readonly codeAt: readonly boolean[];
  /** Reasons the source could not be parsed at all. Empty for anything that compiles. */
  readonly problems: ReadonlySet<string>;
}

const walkCache = new Map<string, Walked>();

function walk(src: string): Walked {
  const cached = walkCache.get(src);
  if (cached !== undefined) return cached;

  const sf = ts.createSourceFile('scan.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const commentAt = new Array<boolean>(src.length).fill(false);
  const literalAt = new Array<boolean>(src.length).fill(false);
  const problems = new Set<string>();

  const mark = (into: boolean[], from: number, to: number): void => {
    for (let i = Math.max(0, from); i < Math.min(src.length, to); i++) into[i] = true;
  };

  // A comment is trivia attached to a token, and the compiler splits that attachment two ways:
  // a comment on its OWN line is LEADING trivia of the token after it, while a comment sharing
  // a line with code is TRAILING trivia of the token before it. Both halves are needed —
  // asking only for leading ranges silently drops every end-of-line comment, which in this
  // file is most of the prose it guards.
  const collectComments = (node: ts.Node): void => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      ts.forEachLeadingCommentRange(src, node.getFullStart(), (pos, end) => {
        mark(commentAt, pos, end);
      });
      ts.forEachTrailingCommentRange(src, node.getEnd(), (pos, end) => {
        mark(commentAt, pos, end);
      });
    }
    for (const child of children) collectComments(child);
  };
  collectComments(sf);

  // Literal TEXT — what the language reads as data rather than as code. Template heads,
  // middles and tails are literal; the substitutions between them are not, which is the one
  // place this projection is deliberately finer than the lexer it replaced.
  const collectLiterals = (node: ts.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.RegularExpressionLiteral:
        mark(literalAt, node.getStart(sf), node.getEnd());
        break;
      default:
        break;
    }
    node.forEachChild(collectLiterals);
  };
  collectLiterals(sf);

  const codeAt = new Array<boolean>(src.length);
  for (let i = 0; i < src.length; i++) codeAt[i] = !commentAt[i] && !literalAt[i];

  // The only thing left to refuse is a source the compiler cannot parse, because then the
  // tree these projections are read from is guesswork.
  const parseErrors = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseErrors !== undefined && parseErrors.length > 0) {
    const first = parseErrors[0] as ts.Diagnostic;
    problems.add(
      `${ts.flattenDiagnosticMessageText(first.messageText, ' ')} at offset ${first.start ?? 0}`,
    );
  }

  const walked: Walked = { commentAt, codeAt, problems };
  walkCache.set(src, walked);
  return walked;
}

/** Refuse a source the compiler cannot parse. Nothing else is refused any more: the constructs
 *  this used to reject — nested templates, comments and regexes inside substitutions, regexes
 *  holding quotes — all parse, so all are read correctly rather than tripwired. */
function rejectUnlexableSyntax(file: string, src: string): void {
  const { problems } = walk(src);
  if (problems.size > 0) {
    throw new Error(
      `${file} does not parse, so the scan below would be guesswork (${[...problems].join('; ')})`,
    );
  }
}

/** Blank everything in a `.ts` source except comment text, preserving length so byte offsets
 *  stay comparable with the resolver's. A projection of the parse, so `//` inside a string is
 *  code rather than a comment, and TRAILING comments are kept. */
function commentsOnly(src: string): string {
  const { commentAt, codeAt } = walk(src);
  const out = new Array<string>(src.length);
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    out[i] = commentAt[i] === true ? c : codeAt[i] === true && c === '\n' ? '\n' : ' ';
  }
  return out.join('');
}

const spaces = (m: string): string => ' '.repeat(m.length);

/** A path NAMES something; a measurement MEASURES something. The rule is stated as a thing the
 *  mask may never do, because every attempt to state it as a thing the mask SHOULD do has been
 *  a list, and every list has been short by one.
 *
 *    A TOKEN CONTAINING A BARE-NUMERAL SEGMENT IS NEVER A PATH.
 *
 *  Requiring a LETTER anywhere was not enough — a unit suffix is a letter, so `1.0065/ms` read
 *  as a directory. Carving out `<number>/<unit>` was not enough either, because the carve-out
 *  had to guess how long a unit is, and `1.0065/iteration` is eleven characters (Codex). The
 *  length game is the keyword-list game again, so it ends the same way: by inverting it.
 *
 *  Real path segments carry letters, or are `.` or `..`. A segment that is nothing BUT a
 *  numeral therefore cannot be a directory, so a token holding one is carrying a value and
 *  belongs in the scan. This is the FAIL-CLOSED COMPLETION of the rule, and it subsumes its
 *  own history: round 16 prohibited a numeral-LED token, which is just the leading-segment
 *  special case, and it left `R/1.0065` — a compact algebraic ratio, letter-led — masking as a
 *  path with its value inside (Codex). Any segment that IS a claim-shaped numeral now forces
 *  the whole token into the scan, wherever it sits.
 *
 *  Note this is NOT the rejected "the first segment must contain a letter": that one unmasked
 *  every relative path, since `.` and `..` have no letters either. Asking what a segment IS NOT
 *  keeps them masked, and `0005-performance-budgets.md` stays a path because it carries letters
 *  and an extension rather than being a bare numeral.
 *
 *  The widening hands two reference classes back to the masks that own them, which is where
 *  they belonged: an issue reference is the issue-ref mask's (in both `#22` and `issues/22`
 *  spellings) and a dated runner build is the runner mask's, rather than both being swallowed
 *  by a path mask that cannot tell a reference from a measurement. Real dates were already the
 *  date mask's, and it runs first.
 *
 *  The direction is fail-closed. Misreading a path as a measurement surfaces its numerals as
 *  LOUD unaccounted claims; misreading a measurement as a path blanks it SILENTLY, which is the
 *  failure this whole file exists to prevent. */
const IS_BARE_NUMERAL = new RegExp(String.raw`^` + NUMERAL_BODY + String.raw`$`);

/** The suffixes these documents hang on a figure without making it a name: the `x`/`×` factor
 *  style, and `%`. A segment of numeral-then-suffix is CLAIM-SHAPED — it is carrying a value,
 *  not naming a directory — so it forces its token into the scan exactly as a bare numeral
 *  does. `R/1.0065x` was masking as a path because no segment of it was BARE (Codex).
 *
 *  The suffix is shape-bounded, not length-bounded: letters, `×` and `%` only. That is what
 *  keeps `0005-performance-budgets.md` a path — its hyphen and extension are not suffix
 *  characters — while asking nothing about how long a unit may be, which is the guess round 16
 *  removed. And the direction stays fail-closed: a path misread as claim-shaped surfaces its
 *  numerals LOUDLY, while a measurement misread as a path is blanked in silence. */
const IS_CLAIM_SHAPED = new RegExp(String.raw`^` + NUMERAL_BODY + String.raw`[A-Za-z\u00d7%]*$`);

function looksLikePath(m: string): boolean {
  return /[A-Za-z]/.test(m) && !m.split('/').some((seg) => IS_CLAIM_SHAPED.test(seg));
}

/** The claim-bearing prose of a guarded file, masked to preserve every byte offset. */
function scannedProse(file: string): string {
  const raw = read(file);
  if (!file.endsWith('.md')) rejectUnlexableSyntax(file, raw);
  const prose = file.endsWith('.md') ? raw : commentsOnly(raw);
  // Every mask replaces text with the SAME number of spaces, because the occurrence half
  // compares byte offsets against the resolver's. A length change would silently shift every
  // offset after it, so it is asserted rather than assumed (CodeRabbit, PR #161).
  //
  // These masks are regexes, but none of them can reach inside a string: they run on `prose`,
  // which for a `.ts` file is the walk's comment-only projection (string bodies are already
  // blanked) and for a `.md` file is markdown, which has no string literals. They mask
  // reference NUMERALS, never comment markers. The one replacement that did strip comment
  // markers by regex — and did reach inside strings — was the tripwire's, and it is gone.
  if (prose.length !== raw.length) {
    throw new Error(`commentsOnly changed the length of ${file} — every offset after the
      change would be wrong`);
  }
  const masked = prose
    // Both date and path masks require a NON-NUMERIC shape. A mask made only of digits and
    // separators cannot tell a reference from a measurement, and will eat the measurement:
    // the path mask blanked `1.0065/1.0065` as though it were a directory, which took a
    // restated ratio out of BOTH all-pairs coverage and per-occurrence accounting (Codex).
    // The date mask has the same shape, so it is bounded to real months and days here rather
    // than left to match any hyphenated numeric triple.
    .replace(/\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:\/\d{2})?/g, spaces) // ISO dates
    .replace(/#\d+|\b(?:issues|pull)\/\d+/g, spaces) // issue refs, in both spellings
    .replace(/\b(ADR|PRD)\s+\d+/g, spaces) // document refs
    // A path needs a LETTER somewhere. `docs/adr/0005-x.md` is a reference; `1.0065/1.0065`
    // is a ratio wearing a slash, and masking it hid a claim in plain sight.
    .replace(/[\w./-]*\/[\w./-]+/g, (m) => (looksLikePath(m) ? spaces(m) : m)) // file paths
    .replace(/\bubuntu-?\d[\w.]*(?:\/[\d.]+)?/gi, spaces) // runner image / release ids
    .replace(/\b(PLAN\s+)?step\s+\d+/gi, spaces) // plan step refs
    .replace(/\bM\d+-S\d+\w*/g, spaces) // milestone/story refs
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{7,}\b/gi, spaces) // commit shas
    .replace(/\bp(50|95|99)\b/g, spaces) // percentile NAMES, not values
    .replace(/^[ \t]*\d+\.[ \t]/gm, spaces); // ordered-list markers
  if (masked.length !== raw.length) {
    throw new Error(`a reference mask changed the length of ${file} — offsets would be wrong`);
  }
  return masked;
}

interface Numeral {
  readonly raw: string;
  readonly value: string;
  readonly at: number;
}

/** The NUMERIC GRAMMAR this sweep reads, which is the language's, not a run of digits. A
 *  leading-dot decimal (`.00922`) and scientific notation (`9.22e-3`) are ordinary spellings of
 *  values this table already rows; reading the first as `00922` and the second as `9.22` filed
 *  each under a different claim from the one it restates, or under none at all (Codex).
 *
 *  Signs are still read OFF the numeral, deliberately and as before: a row valued -1.36 is what
 *  covers a prose 1.36, and the sign is enforced at the row's SITES, which capture it. An
 *  exponent's sign is part of the number rather than in front of it, so that one is read. */
const NUMERAL = new RegExp(NUMERAL_BOUNDARY + NUMERAL_BODY, 'g');

/** One number, one spelling: `.00922`, `9.22e-3` and `0.00922` must reach `claimKey` alike. */
function normalizeNumeral(cleaned: string): string {
  if (/[eE]/.test(cleaned)) {
    const n = Number(cleaned);
    const plain = String(n);
    return Number.isFinite(n) && !/[eE]/.test(plain) ? plain : cleaned;
  }
  return cleaned.startsWith('.') ? `0${cleaned}` : cleaned;
}

function numeralsOf(file: string): Numeral[] {
  const text = scannedProse(file);
  const found: Numeral[] = [];
  for (const m of text.matchAll(NUMERAL)) {
    const cleaned = m[0].replace(/[,_]/g, '');
    found.push({ raw: m[0], value: normalizeNumeral(cleaned), at: m.index ?? 0 });
  }
  return found;
}

/** Self-identifying: a numeral this specific is a restatement, not a coincidence. */
function highInformation(raw: string): boolean {
  const decimals = raw.includes('.') ? (raw.split('.')[1] as string).length : 0;
  return decimals >= 3 || raw.replace(/[^\d]/g, '').length >= 5;
}

const scanCache = new Map<string, Numeral[]>();
function scan(file: string): Numeral[] {
  const hit = scanCache.get(file);
  if (hit !== undefined) return hit;
  const n = numeralsOf(file);
  scanCache.set(file, n);
  return n;
}

describe('the coverage contract is enforced, not merely asserted', () => {
  it('every figure the perf package states, and another guarded file repeats, has a row', () => {
    // Everything here keys by `claimKey`, so `12.340` in a source and `12.34` in a doc are
    // one claim rather than two strangers that never group (Codex, PR #161).
    // A signed row also covers its MAGNITUDE here: the sweep's tokenizer reads numerals
    // without their sign, so a row valued -1.36 is what covers a prose `1.36`. The sign is
    // still enforced where it matters — at the row's sites, which capture it.
    const rowed = new Set(CLAIMS.flatMap(claimKeysFor));
    const surface = new Set(PERF_SOURCES.flatMap((f) => scan(f).map((n) => claimKey(n.value))));
    const excluded = new Set([...EXCLUDED].map(claimKey));
    const where = new Map<string, Set<string>>();
    const spelling = new Map<string, string>();
    for (const file of GUARDED_FILES) {
      for (const n of scan(file)) {
        const key = claimKey(n.value);
        if (excluded.has(key)) continue;
        // Bare integers under 10 are prose ("one of two arms", "n = 4"), never claim values.
        if (!n.value.includes('.') && Number(n.value) < 10) continue;
        if (!surface.has(key)) continue;
        if (!where.has(key)) where.set(key, new Set());
        (where.get(key) as Set<string>).add(file);
        if (!spelling.has(key)) spelling.set(key, n.value);
      }
    }

    const gaps: string[] = [];
    for (const [key, files] of where) {
      if (files.size < COLLISION_THRESHOLD) continue;
      if (rowed.has(key)) continue;
      gaps.push(spelling.get(key) as string);
    }
    gaps.sort();

    expect(
      gaps,
      'these figures are stated by the perf package AND repeated in another guarded file, but ' +
        'have no claim row. Add a row (with every site); or a CONTRACT_EXCLUSIONS entry if the ' +
        'numeral is a collision; or, if it is a real unrowed claim, a KNOWN_UNROWED entry with ' +
        'the reason it is not ' +
        `rowed yet:\n  ${gaps.join('\n  ')}`,
    ).toEqual([...KNOWN_UNROWED.map((e) => e.value)].sort());
  });

  it('every high-information occurrence of a rowed value sits at a listed site', () => {
    const rowedValues = new Set(CLAIMS.flatMap(claimKeysFor));

    // Where the resolver actually reads each claim from.
    // Two indexes: by the claim's KEY, and by its exact SPELLING. Aliased values need both —
    // a `0.0100` occurrence should be attributed to the `0.0100` row when one exists, but an
    // occurrence spelled `0.0200` that matches no row's exact value must still be attributed
    // to SOME row sharing its key rather than skipped, which is what an earlier `continue`
    // did (Codex, PR #161).
    const accountedByKey = new Map<string, Set<string>>();
    const accountedBySpelling = new Map<string, Set<string>>();
    for (const claim of CLAIMS) {
      for (const site of claim.sites) {
        const found = extract(site);
        if ('error' in found) continue;
        const at = `${site.file}:${found.start}`;
        for (const key of claimKeysFor(claim)) {
          if (!accountedByKey.has(key)) accountedByKey.set(key, new Set());
          (accountedByKey.get(key) as Set<string>).add(at);
        }
        if (!accountedBySpelling.has(claim.value)) accountedBySpelling.set(claim.value, new Set());
        (accountedBySpelling.get(claim.value) as Set<string>).add(at);
      }
    }

    const unaccounted: string[] = [];
    for (const file of GUARDED_FILES) {
      const raw = read(file);
      for (const n of scan(file)) {
        if (!highInformation(n.value)) continue;
        const key = claimKey(n.value);
        if (!rowedValues.has(key)) continue;
        const at = `${file}:${n.at}`;
        // Aliased keys prefer exact-spelling attribution when a row spells it that way, so a
        // `0.0100` occurrence is not accounted for by a `0.010` site; when no row carries the
        // spelling, any row sharing the key may account for it — but SOMETHING must.
        const exact = accountedBySpelling.get(n.value);
        const pool = ALIASED_KEYS.has(key) && exact !== undefined ? exact : accountedByKey.get(key);
        if (pool !== undefined && pool.has(at)) continue;
        const before = raw.slice(Math.max(0, n.at - 90), n.at);
        if (
          OCCURRENCE_EXCEPTIONS.some(
            (e) =>
              e.file === file &&
              claimKey(e.value) === claimKey(n.value) &&
              new RegExp(`${e.near}$`).test(before),
          )
        ) {
          continue;
        }
        const line = raw.slice(0, n.at).split('\n').length;
        unaccounted.push(`${n.raw} at ${file}:${line}`);
      }
    }

    expect(
      unaccounted,
      `these are restatements of a rowed value that no listed site reads — so editing one would ` +
        `not fail anything, which is the drift this table exists to stop. Add the occurrence as a ` +
        `site of its claim, or, if the numeral means something else there, an OCCURRENCE_EXCEPTIONS ` +
        `entry naming the place:\n  ` +
        unaccounted.join('\n  '),
    ).toEqual([]);
  });

  // An exclusion is a HOLE cut in the coverage census, and it is subtracted BEFORE that census
  // is built — so unlike a known-unrowed claim, nothing downstream re-checks it. Verifying only
  // that the numeral still existed SOMEWHERE let an entry whose justification had lapsed sit on:
  // the collision could collapse to one surface, or the value could later be rowed, and the
  // entry stayed, still armed to suppress a future genuine cross-file duplicate (Codex, PR
  // #161). Each entry now re-proves its own recorded justification every run.
  it('carries no stale exclusion — every entry re-proves its own justification', () => {
    const rowed = new Set(CLAIMS.flatMap(claimKeysFor));
    for (const e of CONTRACT_EXCLUSIONS) {
      const key = claimKey(e.value);

      // 1. The census is CURRENT: every surface it names still states the numeral.
      for (const file of e.surfaces) {
        expect(
          scan(file).some((n) => claimKey(n.value) === key),
          `CONTRACT_EXCLUSIONS entry "${e.value}" names ${file} among the colliding surfaces ` +
            `that justified it, but that file no longer states the numeral. The collision it ` +
            `documents has changed — re-justify the entry against what is there now, or delete it.`,
        ).toBe(true);
      }

      // 2. The collision still meets the THRESHOLD the coverage half uses. Below it there is no
      //    cross-file duplicate to suppress, so the hole is cutting nothing and only hiding.
      expect(
        e.surfaces.length,
        `CONTRACT_EXCLUSIONS entry "${e.value}" names fewer than ${COLLISION_THRESHOLD} ` +
          `colliding surfaces, so it suppresses nothing and should be deleted.`,
      ).toBeGreaterThanOrEqual(COLLISION_THRESHOLD);

      // 3. It is not SHADOWED by a row. A rowed value needs no hole — and while the hole stands
      //    the sweep never sees the occurrences the row exists to bind.
      expect(
        rowed.has(key),
        `CONTRACT_EXCLUSIONS entry "${e.value}" is also a claim row's value. The row covers it, ` +
          `so the hole is stale — and while it stands the sweep never sees the occurrences that ` +
          `row is meant to bind.`,
      ).toBe(false);

      expect(e.why.length, `CONTRACT_EXCLUSIONS entry "${e.value}" has no reason`).toBeGreaterThan(
        20,
      );
    }
  });

  // WHY THIS ONE IS ONLY A REASON CHECK, decided deliberately rather than left as an omission.
  // The same one-sided-existence defect was looked for here and is not present, because the two
  // tables have opposite shapes. An EXCLUSION is subtracted from the coverage census before it
  // is built, so nothing downstream can notice a stale one — which is why it now re-proves its
  // own justification above. A KNOWN-UNROWED claim is the opposite: the gap set is recomputed
  // from the guarded files every run and compared to this list EXACTLY, so an entry whose
  // condition lapses is already loud. Verified, not assumed — removing one of `2499`'s two
  // stated occurrences drops it out of the recomputed gaps and the comparison fails naming it:
  //
  //     -   "2499",
  //
  // So existence-exactness IS the correct contract here, and the only thing left unchecked is
  // the PROSE of the reason, which is owner-ruled residue (whose oracle-surface backlog is
  // tracked in #163) rather than a machine-checkable condition.
  it('records a reason for every known-unrowed claim', () => {
    for (const e of KNOWN_UNROWED) {
      expect(e.why.length, `KNOWN_UNROWED entry ${e.value} has no reason`).toBeGreaterThan(20);
    }
  });

  // An exception is USED only when its (near, value) PAIR actually excused an occurrence this
  // run. Checking `near` alone let the phrase outlive the numeral it was written for: reword
  // the excused figure away and the exception stayed "used", still armed to suppress a future
  // unlisted occurrence of that value after the same phrase (Codex). Stale exceptions are rot,
  // and this table's whole claim is that its holes are named and current.
  it('carries no unused occurrence exception', () => {
    for (const e of OCCURRENCE_EXCEPTIONS) {
      const raw = read(e.file);
      const excuses = scan(e.file).some(
        (n) =>
          claimKey(n.value) === claimKey(e.value) &&
          new RegExp(`${e.near}$`).test(raw.slice(Math.max(0, n.at - 90), n.at)),
      );
      expect(
        excuses,
        `OCCURRENCE_EXCEPTIONS entry for ${e.file} (/${e.near}/ excusing ${e.value}) excuses ` +
          `nothing: no occurrence of that VALUE sits after that phrase. The phrase may still be ` +
          `in the file — that is exactly the rot this checks for.`,
      ).toBe(true);
      expect(
        e.why.length,
        `OCCURRENCE_EXCEPTIONS entry for ${e.file} has no reason`,
      ).toBeGreaterThan(20);
    }
  });
});

// The resolver's capture-offset arithmetic, pinned. `match[0].indexOf(captured)` binds the
// FIRST identical substring in the full match, which is the wrong span whenever the capture
// repeats earlier in the match — and a wrong span silently mis-targets the blanking in
// `no site can silently fall back`. The `d` flag gives the group's real span (CodeRabbit).
// Every construct this file used to REFUSE now parses, so each of these asserts the numeral is
// SEEN rather than hidden. The constructs did not become safe — they became legible. Five
// review rounds each found one more grammar edge the hand-rolled lexer got wrong; the parser
// gets all of them right by construction, so these are regressions against the migration
// rather than tripwires against the language.
describe("the language's own scanner reads what the hand-rolled one refused", () => {
  const sees = (src: string, numeral: string): void => {
    expect(commentsOnly(src), `the numeral must survive the scan of: ${src}`).toContain(numeral);
  };

  it('reads a block comment inside a template substitution', () => {
    sees('const s = `${value /' + '* 1.0065 *' + '/}`;', '1.0065');
  });

  it('reads a line comment inside a template substitution', () => {
    sees('const s = `${\n  value // 1.0065\n}`;', '1.0065');
  });

  it('reads past a nested template literal', () => {
    sees('const s = `a ${`inner`} c`;\n// 1.0065 after it\n', '1.0065');
  });

  it('reads past a nested template opening after a brace in the same substitution', () => {
    sees('const s = `a ${({x: 1}, `inner`)} c`;\n// 1.0065 after it\n', '1.0065');
  });

  it('reads past a regex literal holding a quote or a backtick', () => {
    sees("function f() { return /'/; }\n// 1.0065 after it\n", '1.0065');
    sees('const re = /' + '`' + '/;\n// 1.0065 after it\n', '1.0065');
  });

  it('reads past a regex whose body holds a brace, inside a substitution', () => {
    sees('const s = `${/}/.test(x) /' + '* 1.0065 *' + '/}`;', '1.0065');
  });

  // The four slash-classification edges that cost a review round each. The hand-rolled rule
  // had to be told about every one of them; the parser was never wrong about any.
  it('reads a regex after every context the hand-rolled classifier got wrong', () => {
    sees("throw /'/; // ' 1.0065\n", '1.0065');
    sees("export default /'/; // ' 1.0065\n", '1.0065');
    sees("if (x) /'/.test(y); // ' 1.0065\n", '1.0065');
    sees("// see note\n/'a/.test(s); // ' 1.0065\n", '1.0065');
  });

  it('still tells division from a regex, because the parser does', () => {
    sees('const a = x / y; // 1.0065\n', '1.0065');
    sees('const b = (peak / cap).toFixed(4); // 1.0065\n', '1.0065');
    sees('const c = {} / 2; // 1.0065\n', '1.0065');
  });

  it('keeps a comment marker inside a string as literal text, not prose', () => {
    expect(commentsOnly('const s = "a // not a comment 1.0065";')).not.toContain('1.0065');
  });

  it('preserves length, and every newline outside a literal', () => {
    const src = 'const t = `a ${x} c`;\n// 1.0065\nconst u = 1; // 2.0065\n';
    const masked = commentsOnly(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.split('\n').length).toBe(src.split('\n').length);
    const templated = 'const t = `a\nb`;\n// 1.0065\n';
    expect(commentsOnly(templated)).toHaveLength(templated.length);
  });

  it('refuses only a source the compiler cannot parse at all', () => {
    expect(() => rejectUnlexableSyntax('broken.ts', 'const x = (;')).toThrow(/does not parse/);
    expect(() => rejectUnlexableSyntax('fine.ts', 'const x = `a ${`b`} c`;')).not.toThrow();
  });
});

describe('the resolver reads the capture group, not the first lookalike', () => {
  it('takes the SECOND occurrence when that is what the group captured', () => {
    const text = 'ANCHOR-XYZ 2.8 and 2.8 percent';
    const site = {
      file: 'packages/perf/src/gate.ts',
      anchor: 'ANCHOR-XYZ',
      pattern: ' 2\\.8 and (2\\.8)',
    };
    const found = extract(site, text);
    expect('error' in found).toBe(false);
    if ('error' in found) throw new Error('unreachable');
    expect(found.value).toBe('2.8');
    // The captured group is the SECOND "2.8", at index 19 — not the first at index 11.
    expect(found.start).toBe(19);
    expect(text.slice(found.start, found.end)).toBe('2.8');
  });
});

// A mask is a hole by construction: whatever it blanks leaves the sweep entirely, escaping
// BOTH all-pairs coverage and per-occurrence accounting. So a mask made only of digits and
// separators cannot be allowed — it has no way to tell a reference from a measurement, and it
// will eat the measurement. Ten masks run in `scannedProse`; two had that shape and are now
// restricted (Codex, PR #161).
describe('the reference masks blank references, not measurements', () => {
  const valuesIn = (file: string): string[] => numeralsOf(file).map((n) => n.value);

  // Codex's reproduction, in the place it actually bit. `oracle.ts` states the band-only cell
  // counts compactly as `307/298/308/329`; the file-path mask read that as a directory and
  // blanked it whole, so three of the four vanished from the sweep while 329 — which also
  // appears standalone — did not. A restated figure that no mask can see is a claim that
  // cannot drift red.
  it('sees a compact ratio series that the file-path mask used to eat', () => {
    const values = valuesIn('packages/perf/src/oracle.ts');
    for (const cell of ['307', '298', '308', '329']) {
      expect(values, `${cell} is a measurement, not a path segment`).toContain(cell);
    }
  });

  it('still blanks a real file path, so its ADR and format numbers stay out of the sweep', () => {
    // `gate.ts` names `docs/adr/0005-performance-budgets.md` in its header prose. The `0005`
    // is a document reference; if the restriction had turned the mask off it would surface.
    expect(valuesIn('packages/perf/src/gate.ts')).not.toContain('0005');
  });

  // Exercises the REAL discriminator, not a copy of it, so the test cannot drift from the mask.
  const mask = (text: string): string =>
    text.replace(/[\w./-]*\/[\w./-]+/g, (m) => (looksLikePath(m) ? ' '.repeat(m.length) : m));

  it('leaves a bare ratio alone but blanks a path that shares its shape', () => {
    expect(mask('the ratio 1.0065/1.0065 holds')).toContain('1.0065/1.0065');
    expect(mask('see docs/adr/0005-x.md now')).not.toContain('0005');
    // Length is preserved either way, because the occurrence half compares byte offsets.
    expect(mask('see docs/adr/0005-x.md now')).toHaveLength('see docs/adr/0005-x.md now'.length);
  });

  // The prohibition and the tokenizer must agree about what a numeral IS. They did not: the
  // prohibition required an initial digit while the tokenizer had learned leading-dot and
  // scientific spellings, so these masked as paths and vanished silently (Codex, PR #161).
  // A bare-numeral segment ANYWHERE, not merely in front. `R/1.0065` is a compact algebraic
  // ratio whose value sat inside a token the mask read as a directory (Codex, PR #161).
  // A suffixed numeric factor has no BARE segment, so the mask ate it. A segment of
  // numeral-then-suffix is claim-shaped: it carries a value rather than naming a directory.
  it('never masks a token whose segment is a numeral with a conventional suffix', () => {
    expect(mask('the factor R/1.0065x holds')).toContain('R/1.0065x');
    expect(mask('the factor R/1.0065\u00d7 holds')).toContain('1.0065');
    expect(mask('the factor 2.8x/R holds')).toContain('2.8x');
    expect(mask('the share R/50% holds')).toContain('50%');
  });

  it('never masks a token with a bare-numeral segment, wherever the segment sits', () => {
    expect(mask('the ratio R/1.0065 holds')).toContain('R/1.0065');
    expect(mask('the ratio ceiling/1.7750 holds')).toContain('ceiling/1.7750');
    expect(mask('the ratio R/n/0.00922 holds')).toContain('0.00922');
  });

  it('still blanks a path whose numeral segment is not BARE', () => {
    // `0005-performance-budgets.md` carries letters and an extension; it is a name, not a value.
    expect(mask('see docs/adr/0005-performance-budgets.md now')).not.toContain('0005');
    expect(mask('see ../adr/0005-performance-budgets.md now')).not.toContain('0005');
  });

  it('never masks a numeral-led token, at any numeral SPELLING', () => {
    expect(mask('cost .00922/iteration measured')).toContain('.00922/iteration');
    expect(mask('cost 9.22e-3/iteration measured')).toContain('9.22e-3/iteration');
    expect(mask('rate .5/ms measured')).toContain('.5/ms');
    expect(mask('rate 1,427/tick measured')).toContain('1,427/tick');
  });

  it('leaves a UNIT-suffixed measurement alone, at any unit length', () => {
    expect(mask('throughput 1.0065/ms holds')).toContain('1.0065/ms');
    expect(mask('DoT lands 4/tick and slow 3/tick')).toContain('4/tick');
    // The carve-out this replaced capped a unit at six characters, so these escaped it. The
    // rule asks nothing about what FOLLOWS the slash any more (Codex, PR #161).
    expect(mask('cost 1.0065/iteration measured')).toContain('1.0065/iteration');
    expect(mask('rate 240/millisecond measured')).toContain('240/millisecond');
    expect(mask('depth 9.2/records-per-creep')).toContain('9.2/records-per-creep');
  });

  it('still blanks a RELATIVE path, whose leading segment has no letter of its own', () => {
    // The rule asks what the leading segment IS NOT — a bare numeral — rather than what it is.
    // Requiring a LETTER there would unmask every one of these, since `.` and `..` have none.
    expect(mask('see ../adr/0005-x.md now')).not.toContain('0005');
    expect(mask('see ../../prd/0001-core.md now')).not.toContain('0001');
    // The URL's trailing `22` IS a bare numeral, so the path mask correctly declines it now —
    // an issue reference is owned by the issue-ref mask, in both of its spellings, rather than
    // swallowed by a path mask that cannot tell a reference from a measurement.
    expect(mask('see //github.com/o/r/issues/22 now')).toContain('22');
    expect(
      'see //github.com/o/r/issues/22 now'.replace(/#\d+|\b(?:issues|pull)\/\d+/g, (x) =>
        ' '.repeat(x.length),
      ),
    ).not.toContain('22');
  });

  it('bounds the ISO-date mask to real months and days, not any numeric triple', () => {
    // Same pure-numeric shape as the path mask, so it is bounded rather than trusted.
    const dates = /\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:\/\d{2})?/g;
    expect('2026-08-03/05'.replace(dates, '')).toBe('');
    expect('2026-07-30'.replace(dates, '')).toBe('');
    expect('1000-20-30'.replace(dates, '')).toBe('1000-20-30');
  });
});

// `.00922` read as `00922`, and `9.22e-3` read as `9.22`, each filed a restatement under a
// different claim from the one it restates — or under none (Codex). The sweep reads the
// language's numeric grammar now, so equivalent spellings share a claim key.
describe("the numeral grammar is the language's, not a run of digits", () => {
  const values = (text: string): string[] =>
    [...text.matchAll(NUMERAL)].map((m) => normalizeNumeral(m[0].replace(/[,_]/g, '')));

  it('reads a leading-dot decimal as its value, not as its digits', () => {
    expect(values('// k = .00922')).toEqual(['0.00922']);
  });

  it('reads scientific notation as ONE value, exponent sign included', () => {
    expect(values('// k = 9.22e-3')).toEqual(['0.00922']);
    expect(values('// n = 9e5')).toEqual(['900000']);
  });

  it('groups every spelling of one number under one claim key', () => {
    const spellings = ['0.00922', '.00922', '9.22e-3'];
    const keys = new Set(spellings.map((t) => claimKey(values(t)[0] as string)));
    expect([...keys]).toHaveLength(1);
  });

  // One definition, three consumers. If they ever disagree again, this fails first.
  it('answers "is this a numeral" identically everywhere it is asked', () => {
    for (const spelling of [
      '0.00922',
      '.00922',
      '9.22e-3',
      '1,427',
      '1.0065',
      '900000',
      // Separators belong to EVERY part of a numeral, not just the integer part.
      '1.006_5',
      '1.006,5',
      '1.0e1_0',
      '.00_922',
    ]) {
      expect(IS_NUMERAL.test(spelling), `IS_NUMERAL rejected ${spelling}`).toBe(true);
      expect(IS_BARE_NUMERAL.test(spelling), `IS_BARE_NUMERAL missed ${spelling}`).toBe(true);
      expect([...`x ${spelling} y`.matchAll(NUMERAL)], `NUMERAL missed ${spelling}`).toHaveLength(
        1,
      );
    }
  });

  // THE BOUNDARY AUDIT, one case per delimiter that can legitimately abut a figure in these
  // documents. The rule is not a list of permitted delimiters — it is "not part of the same
  // numeral, and not part of a name" — but the audit is written down as tests so the claim
  // that every delimiter works is checkable rather than asserted.
  it('reads a figure through every delimiter these documents put against one', () => {
    const cases: readonly [string, string][] = [
      ['_1.0065_', 'markdown underscore emphasis'],
      ['**1.0065**', 'markdown bold'],
      ['*1.0065*', 'markdown italic'],
      ['`1.0065`', 'code span'],
      ['(1.0065)', 'parentheses'],
      ['[1.0065]', 'brackets'],
      ['"1.0065"', 'quotes'],
      ['\u201c1.0065\u201d', 'typographic quotes'],
      ['\u20131.0065\u2013', 'en dashes'],
      ['\u20141.0065\u2014', 'em dashes'],
      ['$1.0065', 'currency'],
      ['1.0065%', 'percent'],
      ['R/1.0065', 'ratio'],
      ['\u21921.0065', 'transition arrow'],
      ['\u00d71.0065', 'times sign'],
    ];
    for (const [text, what] of cases) {
      expect(
        [...text.matchAll(NUMERAL)].map((m) => m[0]),
        `${what}: ${text}`,
      ).toContain('1.0065');
    }
  });

  it('still refuses a numeral that is part of a NAME, not a figure', () => {
    // The delimiter is the same character in `foo_1` and `_1.0065_`; only what sits BEFORE it
    // says whether it is an identifier or emphasis.
    for (const name of ['v1', 'p50', 'R0', 'foo_1', 'x_1_000', 'v1.2.3']) {
      expect(
        [...name.matchAll(NUMERAL)].map((m) => m[0]),
        `${name} is a name`,
      ).toEqual([]);
    }
  });

  it('never ends a numeral on a separator', () => {
    // `\d[\d,_]*` used to swallow a trailing comma or underscore, so a figure at the end of a
    // clause carried punctuation into its raw spelling. The grammar decides where it ends.
    expect([...'score 434, stars'.matchAll(NUMERAL)].map((m) => m[0])).toEqual(['434']);
    expect([...'_1065_'.matchAll(NUMERAL)].map((m) => m[0])).toEqual(['1065']);
    expect([...'1_000 exact'.matchAll(NUMERAL)].map((m) => m[0])).toEqual(['1_000']);
  });

  // The integer part accepted separators and the fractional and exponent parts did not, so
  // `1.006_5` keyed as 1.006 — a different claim from the one it restates (Codex, PR #161).
  it('accepts separators in every part of a numeral, and strips them alike', () => {
    const value = (t: string): string =>
      normalizeNumeral(([...t.matchAll(NUMERAL)][0] as RegExpMatchArray)[0].replace(/[,_]/g, ''));
    expect(value('k = 1.006_5')).toBe('1.0065');
    expect(value('k = 1.006,5')).toBe('1.0065');
    expect(value('n = 1.0e1_0')).toBe('10000000000');
    expect(value('k = .00_922')).toBe('0.00922');
    // and every spelling of the one number still reaches one key
    expect(claimKey(value('k = 1.006_5'))).toBe(claimKey('1.0065'));
  });

  it('does not split an ordinary decimal into a bare fraction', () => {
    expect(values('1.5')).toEqual(['1.5']);
    expect(values('1.0065 and 1,427')).toEqual(['1.0065', '1427']);
  });
});
