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
function claimKey(stated: string): string {
  // A leading typographic minus (U+2212) or en-dash is the same sign as an ASCII '-';
  // ADR 0005 writes the cohort's skew as −1.36 while `gate.ts` writes -1.36.
  const bare = stated.replace(/[,_]/g, '').replace(/^[\u2212\u2013]/, '-');
  const parsed = Number(bare);
  return /^[+-]?\d[\d.]*$/.test(bare) && Number.isFinite(parsed) ? `n:${parsed}` : `s:${stated}`;
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
const CONTRACT_EXCLUSIONS: readonly { readonly value: string; readonly why: string }[] = [
  {
    value: '0',
    why: 'Bare zero — "zero dropped applications", "0 leftover bounty", "R0". Not a measurement.',
  },
  {
    value: '10',
    why: 'The tolerance percentage ("a 10% move in R"), the escalation rule\'s sample floor, and n = 10 all collide on one numeral; each is rowed or argued in its own words, and the digit alone identifies nothing.',
  },
  {
    value: '95',
    why: 'Reads as the percentile name (p95) and as "95% power"/"95% CI" throughout; the percentile is a statistic identifier, not a claim value.',
  },
  {
    value: '50',
    why: 'Same collision as 95 — the p50 percentile name against "50% power" and the 50 venom towers.',
  },
  {
    value: '60',
    why: "`splash`'s cadence-60 and the 60-tick DoT window are catalog facts owned by the content tests, not perf-gate claims.",
  },
  {
    value: '0.25',
    why: "A digit collision, not a shared claim: gate.ts's 0.25 is `dot-bench`'s ms-per-1,000-records curve, while ADR 0005's only 0.25 is `0.25σ` — the margin flooring discards. Neither document states the other's quantity.",
  },
  {
    value: '1000',
    why: "Another collision: gate.ts's 1,000 is the denominator of that same dot-bench curve; elsewhere it is `MAX_TOTAL_TOWER_COMMANDS`. Different quantities, same numeral.",
  },
  {
    value: '0.8',
    why: 'Two different quantities that coincide: the gating p50 scores 0.8 on the CONCENTRATED injection and p95 scores 0.8 on the BROAD one. Each is stated beside the statistic it belongs to and beside its counterpart (2.2 and 3.9, both rowed), so the pair is guarded through those; the bare numeral cannot tell the two apart and a row keyed on it would bind the wrong sites together.',
  },
  {
    value: '0.3863',
    why: "A collision between two unrelated per-arm tables: gate.ts's 0.3863 is run 1's control p50 in the four-run diagnostic table, while the spike's is attempt 15's STRESS p50 in the 17-attempt operands table. Same numeral, different arm, different cohort.",
  },
  {
    value: '1.9',
    why: "A collision the numeric normalisation itself surfaced: `gate-fixture.test.ts` states the blind spot's p99 movement as +1.9% (single-file, so not a shared claim), while ADR 0005's only 1.90 is `wy:draw` 1.90% of busy frame time in the browser-spike section. Different subsystems entirely; the two spellings never grouped until claimKey made 1.9 and 1.90 one key.",
  },
  {
    value: '2.7',
    why: "Collision: gate.ts's ~2.7% is the sigma agreement between the n = 4 and n = 17 cohorts; ADR 0005's ×2.7 is the centring step in a flake-rate decomposition this file deliberately drops.",
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

/** The three characters that open a region the walk skips. Named once and consulted
 *  everywhere, because the scanner and the tripwire drifting apart is exactly how the backtick
 *  came to be a string opener one of them honoured and the other did not. */
const STRING_OPENERS = ["'", '"', '`'] as const;

const opensString = (c: string | undefined): boolean =>
  (STRING_OPENERS as readonly string[]).includes(c ?? '');

/** Words after which a `/` opens a REGEX rather than dividing. After any other identifier — or
 *  a digit, a `)`, or a `]` — a value has just ended, and the grammar cannot read a regex
 *  literal there. That asymmetry is what lets the substitution rule admit division and still
 *  make regexes impossible. */
const REGEX_CONTEXT_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

/** Whether the `/` at `at` is unambiguously DIVISION: the previous significant token produces
 *  a value, so a regex literal cannot legally begin here. */
function isDivision(src: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /\s/.test(src[j] as string)) j--;
  if (j < 0) return false;
  const prev = src[j] as string;
  if (prev === ')' || prev === ']') return true;
  if (!/[A-Za-z0-9_$]/.test(prev)) return false;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k] as string)) k--;
  return !REGEX_CONTEXT_WORDS.has(src.slice(k + 1, j + 1));
}

interface Walked {
  /** Per byte: inside comment TEXT. */
  readonly commentAt: readonly boolean[];
  /** Per byte: ordinary code — not a string, not a template, not a comment. */
  readonly codeAt: readonly boolean[];
  /** Constructs the walk cannot lex soundly, phrased for the error message. */
  readonly problems: ReadonlySet<string>;
}

/** A regex literal whose body holds a string opener, matched against the RAW source. It has to
 *  be found where it actually sits, because the walk desynchronises on precisely this
 *  construct and would blank the evidence before the search ran. Matches that land in a
 *  comment or a string are discarded by `codeAt` — which is the job the old comment-stripping
 *  `replace` was doing, done string-awarely (CodeRabbit). */
const REGEX_HOLDING_OPENER = new RegExp(
  String.raw`(?:^|[=(,:;[{!?&|+\-*%<>~^]|\breturn\b|\btypeof\b|\bcase\b|\bin\b|\bof\b|\bdo\b|=>|&&|\|\|)` +
    String.raw`\s*\/(?![/*])` +
    String.raw`(?:\\.|\[[^\]]*\]|[^/\n])*` +
    `[${STRING_OPENERS.join('')}]` +
    String.raw`(?:\\.|\[[^\]]*\]|[^/\n])*\/`,
  'g',
);

/** THE ONE WALKER, and the soundness conditions that make trusting it legitimate — stated so
 *  the next "can it lex X?" question has an answer instead of an investigation.
 *
 *  Everything that needs to know what is prose, what is code and what is literal text asks
 *  THIS function. `commentsOnly` (keep comment text, blank the rest) and
 *  `rejectUnlexableSyntax` (refuse what cannot be lexed) are both projections of a single
 *  pass. There is no second, regex-shaped lexer anywhere: an earlier one stripped `//...` with
 *  a plain `replace`, which reached INSIDE strings and cascaded into misclassification
 *  (CodeRabbit).
 *
 *  The governing invariant — every region the walk does not scan for prose is either
 *
 *    (a) INCAPABLE of containing a comment, so skipping it cannot hide anything; or
 *    (b) REJECTED, loudly, before any scan is trusted.
 *
 *  The regions, and which condition carries each:
 *
 *    1. `'...'` and `"..."` — skipped; (a) holds by the language's own rules, since a comment
 *       marker inside a string is literal text. (A numeral in a string is code data, not
 *       prose; the table guards prose. `1.42` living in an `it()` title is exactly why that
 *       figure is a rowed claim rather than an exemption.)
 *    2. A template literal — skipped whole, substitutions included; (a) FAILS, because a
 *       substitution is an ordinary expression position that can hold a real comment. Carried
 *       by (b), via the substitution rule below.
 *    3. A NESTED template literal — desynchronises backtick matching outright. Rejected, and
 *       detected by the walk's own brace and string tracking rather than by a regex, so
 *       nesting that opens AFTER a `}` in the same substitution is caught too (CodeRabbit).
 *    4. A regex literal holding a STRING OPENER — read as the start of a quoted region, which
 *       masks every comment after it. Rejected. All three openers count; the walk cannot tell
 *       them apart, so neither may the tripwire.
 *
 *  THE SUBSTITUTION RULE, which ENDS the slash ambiguity instead of parsing around it. A `/`
 *  inside a substitution is a comment, a regex, or a division, and only the last is harmless.
 *  A comment there hides prose; a regex body can carry braces and quotes that derail the
 *  counter looking for the substitution's close — a regex holding a brace, followed by a block
 *  comment, was exactly Codex's reproduction. So:
 *
 *    - `//` or `/*` in a substitution is REJECTED outright; and
 *    - any other `/` in a substitution is REJECTED unless the previous significant token
 *      produces a value (`isDivision`), which is precisely where the grammar forbids a regex.
 *
 *  A regex literal therefore cannot occur in an accepted substitution, and neither can a
 *  comment. So every brace inside a substitution and outside a string is a real code brace,
 *  the depth counter that finds the closing `}` is SOUND, and that is what licenses skipping
 *  the template at all. Division survives the rule because a guarded file genuinely uses it:
 *  `oracle.ts` reports a ratio inside a substitution, so a blanket ban on slashes would refuse
 *  a file that lexes perfectly well.
 *
 *  The conditions together: strings are skipped by `skipString`, so no brace or comment marker
 *  inside one is ever read as code; regexes and comments are impossible inside substitutions,
 *  by rejection; therefore braces track, therefore the walk knows where every region begins
 *  and ends. Anything added that skips a region must extend this list and satisfy (a) or (b).
 *
 *  The posture is deliberately conservative — it would rather refuse a file it could lex than
 *  lex one it cannot — because the failure it guards against is SILENT, which is the one
 *  outcome this whole file exists to prevent (CodeRabbit and Codex, PR #161). */
function walk(src: string): Walked {
  const commentAt = new Array<boolean>(src.length).fill(false);
  const codeAt = new Array<boolean>(src.length).fill(false);
  const problems = new Set<string>();
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        commentAt[i] = true;
        i++;
      }
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) problems.add('an unterminated block comment');
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) commentAt[i] = true;
    } else if (c === '`') {
      i = walkTemplate(src, i, problems);
    } else if (opensString(c)) {
      i = skipString(src, i, problems);
    } else {
      codeAt[i] = true;
      i++;
    }
  }
  return { commentAt, codeAt, problems };
}

/** Advance past a `'`- or `"`-quoted string opening at `i`, honouring backslash escapes, and
 *  return the index just past its closing quote. A raw newline inside one is not a long
 *  string, it is proof the walk is desynchronised — most often because a regex literal
 *  containing a quote was read as a string opener — so it is reported rather than absorbed. */
function skipString(src: string, i: number, problems: Set<string>): number {
  const quote = src[i];
  i++;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === '\n') {
      problems.add('an unterminated string literal');
      return i;
    }
    if (src[i] === '\\') i++;
    i++;
  }
  if (i >= src.length) problems.add('an unterminated string literal');
  return i + 1;
}

/** Advance past a template literal opening at `i`, stepping THROUGH its substitutions rather
 *  than over them, and return the index just past its closing backtick. */
function walkTemplate(src: string, i: number, problems: Set<string>): number {
  i++;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '$' && src[i + 1] === '{') {
      i = walkSubstitution(src, i + 2, problems);
      continue;
    }
    i++;
  }
  if (i >= src.length) {
    problems.add('an unterminated template literal');
    return i;
  }
  return i + 1;
}

/** Walk a substitution from just past its `${` to just past its matching `}`, enforcing the
 *  substitution rule. Strings are skipped, so a brace inside one never moves the counter. */
function walkSubstitution(src: string, from: number, problems: Set<string>): number {
  let i = from;
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && (n === '/' || n === '*')) {
      problems.add('a comment inside a template substitution');
      i++;
      continue;
    }
    if (c === '/' && !isDivision(src, i)) {
      problems.add('a regex literal inside a template substitution');
      i++;
      continue;
    }
    if (c === '`') {
      problems.add('a nested template literal');
      i = walkTemplate(src, i, problems);
      continue;
    }
    if (opensString(c)) {
      i = skipString(src, i, problems);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  problems.add('an unterminated template substitution');
  return i;
}

/** Refuse a file the walk cannot lex soundly, before anything trusts the scan. */
function rejectUnlexableSyntax(file: string, src: string): void {
  const { codeAt, problems } = walk(src);
  const what = new Set(problems);
  for (const m of src.matchAll(REGEX_HOLDING_OPENER)) {
    if (codeAt[m.index ?? 0] === true) {
      what.add('a regex literal containing a quote or backtick');
      break;
    }
  }
  if (what.size > 0) {
    throw new Error(
      `${file} contains syntax this scanner cannot lex (${[...what].join(' and ')}). Upgrade ` +
        `the walker before trusting the scan — a desynchronised lexer miscounts silently.`,
    );
  }
}

/** Blank everything in a `.ts` source except comment text, preserving length so byte offsets
 *  stay comparable with the resolver's. A projection of the walk, so `//` inside a string is
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
    .replace(/\d{4}-\d{2}-\d{2}(\/\d{2})?/g, spaces) // ISO dates
    .replace(/#\d+/g, spaces) // issue refs
    .replace(/\b(ADR|PRD)\s+\d+/g, spaces) // document refs
    .replace(/[\w./-]*\/[\w./-]+/g, spaces) // file paths (carry ADR/format numbers)
    .replace(/\bubuntu-?\d[\w.]*/gi, spaces) // runner image / release ids
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

function numeralsOf(file: string): Numeral[] {
  const text = scannedProse(file);
  const found: Numeral[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z_])\d[\d,_]*(?:\.\d+)?/g)) {
    found.push({ raw: m[0], value: m[0].replace(/[,_]/g, ''), at: m.index ?? 0 });
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
      if (files.size < 2) continue;
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
        if (!highInformation(n.raw)) continue;
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

  it('carries no unused exclusion — an exception that stops being needed is deleted', () => {
    const everywhere = new Set(GUARDED_FILES.flatMap((f) => scan(f).map((n) => n.value)));
    for (const e of CONTRACT_EXCLUSIONS) {
      expect(
        everywhere.has(e.value),
        `CONTRACT_EXCLUSIONS entry "${e.value}" matches nothing`,
      ).toBe(true);
      expect(e.why.length, `CONTRACT_EXCLUSIONS entry "${e.value}" has no reason`).toBeGreaterThan(
        20,
      );
    }
  });

  it('records a reason for every known-unrowed claim', () => {
    for (const e of KNOWN_UNROWED) {
      expect(e.why.length, `KNOWN_UNROWED entry ${e.value} has no reason`).toBeGreaterThan(20);
    }
  });

  it('carries no unused occurrence exception', () => {
    for (const e of OCCURRENCE_EXCEPTIONS) {
      const raw = read(e.file);
      expect(
        new RegExp(e.near).test(raw),
        `OCCURRENCE_EXCEPTIONS entry for ${e.file} (/${e.near}/) matches nothing`,
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
describe('the scanner refuses syntax it cannot lex', () => {
  // `return /'/;` is valid JavaScript in an expression position the earlier check did not
  // cover. Left unrejected, `commentsOnly` reads the regex's quote as a string delimiter and
  // masks every comment after it, so those numerals escape occurrence coverage entirely —
  // a silent miscount, which is the one failure mode this file cannot tolerate (CodeRabbit).
  it('rejects a regex literal containing a quote in `return` position', () => {
    expect(() => rejectUnlexableSyntax('synthetic.ts', "function f() { return /'/; }")).toThrow(
      /regex literal containing a quote/,
    );
  });

  it('rejects a nested template literal', () => {
    expect(() => rejectUnlexableSyntax('synthetic.ts', 'const x = `a ${`b`} c`;')).toThrow(
      /nested template literal/,
    );
  });

  it('rejects a comment inside a template substitution', () => {
    // A substitution is an ordinary expression position, so a comment there is REAL prose the
    // scanner would skip through to the closing backtick — a numeral inside it would vanish
    // from coverage entirely (Codex, PR #161).
    const src = 'const s = `${value /' + '* 1.0065 *' + '/}`;';
    expect(() => rejectUnlexableSyntax('synthetic.ts', src)).toThrow(
      /comment inside a template substitution/,
    );
  });

  it('rejects a line comment inside a template substitution too', () => {
    const src = 'const s = `${\n  value // 1.0065\n}`;';
    expect(() => rejectUnlexableSyntax('synthetic.ts', src)).toThrow(
      /comment inside a template substitution/,
    );
  });

  // The invariant found this one, which is the point of stating it: `commentsOnly` treats all
  // three STRING_OPENERS alike, but the tripwire's class read `['"]`. A regex holding a
  // backtick therefore opened a "template" that ran to EOF, blanking every comment after it —
  // the same silent miscount as the quote case, unrejected (self-raised, PR #161).
  it('rejects a regex literal containing a backtick, not just a quote', () => {
    const src = 'const re = /' + '`' + '/;\n// 1.0065 hidden after it\n';
    // The hiding is real: without the rejection, the comment is blanked out of the scan.
    expect(commentsOnly(src)).not.toContain('1.0065');
    expect(() => rejectUnlexableSyntax('synthetic.ts', src)).toThrow(
      /regex literal containing a quote or backtick/,
    );
  });

  it('rejects a comment in a substitution whose code contains a braced string', () => {
    // A `}` inside a string is not the end of the substitution. A brace-counting scan stopped
    // there and never saw the comment that followed (self-raised, PR #161).
    const src = 'const s = `${ "}" /' + '* 1.0065 *' + '/ }`;';
    expect(() => rejectUnlexableSyntax('synthetic.ts', src)).toThrow(
      /comment inside a template substitution/,
    );
  });

  // Codex's reproduction. The regex's `}` was counted as the substitution's close, so the
  // scan walked out of the substitution early, never saw the block comment behind it, and
  // `commentsOnly` skipped the whole template — the planted 1.0065 stayed green. The rule
  // that kills it is not a regex parser but a refusal: a `/` here cannot start a regex.
  it('rejects a regex literal inside a template substitution', () => {
    const src = 'const s = `${/}/.test(x) /' + '* 1.0065 *' + '/}`;';
    expect(() => rejectUnlexableSyntax('synthetic.ts', src)).toThrow(
      /regex literal inside a template substitution/,
    );
  });

  // CodeRabbit: the old `nestedTemplate` regex required no `}` between `${` and the nested
  // backtick, so nesting that opened after a brace in the SAME substitution slipped past it.
  // The walker counts real braces and skips real strings, so position no longer matters.
  it('rejects a nested template that opens after a brace in the same substitution', () => {
    const src = 'const s = `a ${({x: 1}, `inner // literal 1.0065`)} c`;';
    expect(() => rejectUnlexableSyntax('synthetic.ts', src)).toThrow(/nested template literal/);
  });

  // CodeRabbit: the old tripwire stripped `//...` with a plain replace before looking for a
  // quote-bearing regex, so a `//` inside a STRING erased the rest of the line — regex and
  // all — and the regex went unrejected while `commentsOnly` masked every later comment.
  // Nothing strips comment markers by regex any more; comment spans come from the walk.
  it('rejects a quote-bearing regex standing behind a string that contains a comment marker', () => {
    const src = 'const prefix = "//"; const re = /' + "'" + '/;\n// 1.0065 must stay visible\n';
    expect(() => rejectUnlexableSyntax('synthetic.ts', src)).toThrow(
      /regex literal containing a quote or backtick|unterminated string literal/,
    );
  });

  it('accepts the ordinary constructs the guarded files actually use', () => {
    const ordinary = [
      'const re = /[0-9]+/;',
      'const s = "a // not a comment";',
      'const t = `plain ${x} template`;',
      'const u = `nested braces ${ {a: 1}.a } still fine`;',
      // A comment marker inside a STRING inside a substitution is literal text — a URL or a
      // path, not prose. Refusing these would make the tripwire a blanket refusal.
      'const v = `see ${"https://example.test/a"} and ${"}"} done`;',
      // DIVISION inside a substitution, which `oracle.ts` genuinely does. The slash rule bans
      // regexes and comments, not arithmetic — a blanket ban would refuse a guarded file.
      'const w = `${(peak / cap).toFixed(4)} of cap`;',
      '// a trailing comment with 1.0065 in it',
    ].join('\n');
    expect(() => rejectUnlexableSyntax('synthetic.ts', ordinary)).not.toThrow();
  });

  // The narrowing is a grammar fact, not a guess: a regex cannot begin where a value just
  // ended. Both halves are pinned so neither can drift into over- or under-rejection.
  it('separates division from regex by the token before the slash', () => {
    expect(() => rejectUnlexableSyntax('d.ts', 'const a = `${x / y}`;')).not.toThrow();
    expect(() => rejectUnlexableSyntax('d.ts', 'const b = `${f(x) / 2}`;')).not.toThrow();
    expect(() => rejectUnlexableSyntax('d.ts', 'const c = `${xs[0] / 2}`;')).not.toThrow();
    // ...but after a keyword, or at the start of the substitution, a regex is what fits.
    expect(() => rejectUnlexableSyntax('d.ts', 'const d = `${typeof /x/}`;')).toThrow(
      /regex literal inside a template substitution/,
    );
    expect(() => rejectUnlexableSyntax('d.ts', 'const e = `${/x/.test(s)}`;')).toThrow(
      /regex literal inside a template substitution/,
    );
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
