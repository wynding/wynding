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
  const match = new RegExp(site.pattern).exec(region);
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
  const matchStart = located.index + (match.index ?? 0);
  const capturedAt = matchStart + match[0].indexOf(captured);
  return { value: captured, start: capturedAt, end: capturedAt + captured.length };
}

/** Numeric claims compare by value, so `1.1` and `1.10` agree and only a real change
 *  fails. Identifier claims (run ids, commit heads, image names, block names) compare
 *  exactly. */
function agrees(claim: Claim, stated: string): boolean {
  if (claim.numeric === undefined) return stated === claim.value;
  const parsed = Number(stated);
  return Number.isFinite(parsed) && parsed === claim.numeric;
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
          ' '.repeat(found.end - found.start) +
          original.slice(found.end);
        const after = extract(site, blanked);
        if ('error' in after) return; // deleting the claim broke the site — correct.
        if (after.value === found.value) {
          throw new Error(
            `claim "${claim.id}" at ${label(site)} is BLEED-PRONE: after blanking the value it matched, ` +
              `the same pattern found "${after.value}" again elsewhere within its ${site.within ?? DEFAULT_SITE_WINDOW}-character window. ` +
              `Deleting the named occurrence would NOT fail this test. Constrain the pattern or the window to this site.`,
          );
        }
      });
    }
  }
});

// PROPERTY 3 — the coverage contract, swept rather than asserted.
//
// SWEEP METHOD: take `gate.ts`'s comment prose, strip tokens that are references rather
// than claims, and keep every numeral that also appears in the prose of another guarded
// file. Each survivor must have a row. A figure `gate.ts` states in only one place is out
// of scope by design — the table is for claims with copies.
const SWEPT_FILES = [
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
 *  small: every entry is a hole, so an entry that stops being needed should be deleted.
 *  This is the same shape as `scripts/glossary-lint.config.json`'s exception list — a
 *  machine-checked contract with named, justified exceptions beats a prose promise. */
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
    value: '2.7',
    why: "Collision: gate.ts's ~2.7% is the sigma agreement between the n = 4 and n = 17 cohorts; ADR 0005's ×2.7 is the centring step in a flake-rate decomposition this file deliberately drops.",
  },
];
const EXCLUDED = new Set(CONTRACT_EXCLUSIONS.map((e) => e.value));

function proseOf(file: string): string {
  const raw = read(file);
  if (file.endsWith('.md')) return raw;
  let inBlock = false;
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    let isComment = false;
    if (inBlock) {
      isComment = true;
      if (t.includes('*/')) inBlock = false;
    } else if (t.startsWith('/*')) {
      isComment = true;
      if (!t.includes('*/')) inBlock = true;
    } else if (t.startsWith('//')) isComment = true;
    if (isComment) out.push(line);
  }
  return out.join('\n');
}

/** Strip the token shapes that are references, identifiers or structure — never claims. */
function stripReferences(s: string): string {
  return s
    .replace(/\d{4}-\d{2}-\d{2}(\/\d{2})?/g, ' ') // ISO dates
    .replace(/#\d+/g, ' ') // issue refs
    .replace(/\b(ADR|PRD)\s+\d+/g, ' ') // document refs
    .replace(/[\w./-]*\/[\w./-]+/g, ' ') // file paths (carry ADR/format numbers)
    .replace(/\bubuntu-?\d[\w.]*/gi, ' ') // runner image / release ids
    .replace(/\b(PLAN\s+)?step\s+\d+/gi, ' ') // plan step refs
    .replace(/\bM\d+-S\d+\w*/g, ' ') // milestone/story refs
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{7,}\b/gi, ' ') // commit shas
    .replace(/\bp(50|95|99)\b/g, ' ') // percentile NAMES, not values
    .replace(/^\s*\d+\.\s/gm, ' '); // ordered-list markers
}

function numerals(text: string): string[] {
  return (stripReferences(text).match(/(?<![A-Za-z_])\d[\d,_]*(?:\.\d+)?/g) ?? []).map((t) =>
    t.replace(/[,_]/g, ''),
  );
}

describe('the coverage contract is enforced, not merely asserted', () => {
  it('every figure `gate.ts` states that also appears in another guarded file has a row', () => {
    const rowed = new Set(
      CLAIMS.map((c) => Number(c.value))
        .filter((n) => Number.isFinite(n))
        .map(String),
    );
    const stated = new Set(numerals(proseOf('packages/perf/src/gate.ts')));
    const elsewhere = new Map<string, string[]>();
    for (const file of SWEPT_FILES) {
      for (const value of new Set(numerals(proseOf(file)))) {
        elsewhere.set(value, [...(elsewhere.get(value) ?? []), file]);
      }
    }

    const gaps: string[] = [];
    for (const value of stated) {
      if (EXCLUDED.has(value)) continue;
      // Bare integers under 10 are prose ("one of two arms", "n = 4"), never claim values.
      if (!value.includes('.') && Number(value) < 10) continue;
      const where = elsewhere.get(value);
      if (where === undefined) continue; // stated only in gate.ts — nothing to propagate to
      if (rowed.has(String(Number(value)))) continue;
      gaps.push(`${value} (also in ${where.map((f) => f.split('/').pop()).join(', ')})`);
    }

    expect(
      gaps,
      `these figures are stated in gate.ts AND duplicated in a guarded file, but have no claim row — ` +
        `add a row (with every site) or, if the numeral is a reference rather than a claim, an entry in CONTRACT_EXCLUSIONS:\n  ` +
        gaps.join('\n  '),
    ).toEqual([]);
  });

  it('carries no unused exclusion — an exception that stops being needed is deleted', () => {
    const stated = new Set(numerals(proseOf('packages/perf/src/gate.ts')));
    for (const e of CONTRACT_EXCLUSIONS) {
      expect(stated.has(e.value), `CONTRACT_EXCLUSIONS entry "${e.value}" matches nothing`).toBe(
        true,
      );
      expect(e.why.length, `CONTRACT_EXCLUSIONS entry "${e.value}" has no reason`).toBeGreaterThan(
        20,
      );
    }
  });
});
