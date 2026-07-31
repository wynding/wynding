// layout.test.ts — proves the scripted maze (PLAN step 17, layout.ts) is exactly what
// it claims to be: 150 distinct, non-overlapping, in-bounds anchors that together
// route a creep through 329 cells. Every asserted number is measured against the real
// sim, not re-derived here.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseRulesetJson, compileRuleset } from '@wynding/sim';
import { STRESS_RULESET_URL } from '@wynding/content/stress';
import { BAND_COLS, TAIL_BAFFLES, stressAnchors, towerIdAt, stressRouteLength } from './layout';

// `tower.ts`'s `FOOTPRINT_DELTAS` is NOT exported from `@wynding/sim` (it stays
// private on purpose — see `layout.ts`'s `stressRouteLength` doc), so the
// non-overlap check below (a property of the raw anchor list alone, independent of
// `stressRouteLength`/`materializeTowerMask`) has no shared symbol to import and must
// keep this local copy. This is a DIFFERENT hand-copy from the one QC round 1 removed:
// that one fed a bespoke route-length computation that duplicated
// `stressRouteLength`'s own logic (now routed through the shared
// `materializeTowerMask` below instead, so route length can only drift in one place);
// this one only checks that footprints don't collide, a check `stressRouteLength`
// does not perform at all. If `tower.ts` ever exports `FOOTPRINT_DELTAS`, import it
// here instead of hand-copying.
const FOOTPRINT_DELTAS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

describe('stressAnchors()', () => {
  const anchors = stressAnchors();

  it('emits exactly 150 anchors: 8 bands x 18 (144) + 6 tail baffles', () => {
    expect(BAND_COLS).toHaveLength(8);
    expect(TAIL_BAFFLES).toHaveLength(6);
    expect(anchors).toHaveLength(150);
  });

  it('the first 144 anchors are the bands, band by band, top-to-bottom within a band', () => {
    const bandAnchors = anchors.slice(0, 144);
    expect(bandAnchors).toHaveLength(144);
    // Each band contributes exactly 18 anchors (19 candidate rows minus the one
    // dropped for the gap), grouped contiguously in `BAND_COLS` order.
    for (let b = 0; b < 8; b++) {
      const band = bandAnchors.slice(b * 18, b * 18 + 18);
      const col = BAND_COLS[b];
      expect(band.every((a) => a.col === col)).toBe(true);
      // Strictly increasing rows within a band (top-to-bottom).
      for (let i = 1; i < band.length; i++) {
        expect(band[i]!.row).toBeGreaterThan(band[i - 1]!.row);
      }
      // Even bands drop the first candidate row (1), odd bands drop the last (37).
      if (b % 2 === 0) {
        expect(band[0]!.row).toBe(3);
        expect(band[band.length - 1]!.row).toBe(37);
      } else {
        expect(band[0]!.row).toBe(1);
        expect(band[band.length - 1]!.row).toBe(35);
      }
    }
  });

  it('the last 6 anchors are TAIL_BAFFLES, in the documented order', () => {
    expect(anchors.slice(144)).toEqual(TAIL_BAFFLES.map((b) => ({ col: b.col, row: b.row })));
  });

  it('no two anchors’ 2x2 footprints overlap, and every footprint cell is inside the buildable interior (cols 1..38, rows 1..38)', () => {
    const seen = new Set<string>();
    for (const anchor of anchors) {
      for (const [dc, dr] of FOOTPRINT_DELTAS) {
        const col = anchor.col + dc;
        const row = anchor.row + dr;
        expect(col).toBeGreaterThanOrEqual(1);
        expect(col).toBeLessThanOrEqual(38);
        expect(row).toBeGreaterThanOrEqual(1);
        expect(row).toBeLessThanOrEqual(38);
        const key = `${col},${row}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  // The route-length oracle, via the shared `stressRouteLength` (`layout.ts`) — built
  // on the sim's own exported `materializeTowerMask` rather than a hand-copy of
  // `tower.ts`'s PRIVATE `FOOTPRINT_DELTAS` (QC: this test's route-length check and
  // `run.ts` used to each carry that copy independently, which could only ever drift
  // together since they were byte-identical).
  //
  // 329 is the maze's committed route length and the oracle's un-waivable floor
  // (`oracle.ts`'s `ROUTE_LENGTH_FLOOR`). PLAN step 18 committed 600 before measuring;
  // the shortfall was escalated rather than lowered to fit, and the owner re-pinned the
  // floor to the measured value on 2026-07-31 (ADR 0005 finding 2) because 600 is not
  // reachable at the ADR's own ~150-tower figure on any board size. Changing this number
  // to make something else agree is exactly what the escalation existed to prevent.
  it('routes the entrance to the exit in exactly 329 cells', () => {
    const text = readFileSync(STRESS_RULESET_URL, 'utf8');
    const bundle = parseRulesetJson(text);
    const compiled = compileRuleset(bundle, 'stress-40x40');
    expect(stressRouteLength(compiled)).toBe(329);
  });
});

describe('towerIdAt()', () => {
  it('yields 100 stress-blast and 50 stress-chill over the 150 indices', () => {
    const counts: Record<string, number> = { 'stress-blast': 0, 'stress-chill': 0 };
    for (let i = 0; i < 150; i++) {
      const id = towerIdAt(i);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts['stress-blast']).toBe(100);
    expect(counts['stress-chill']).toBe(50);
  });

  it('150 x 12 (both towers cost 12) === the bundle’s startingBounty', () => {
    const text = readFileSync(STRESS_RULESET_URL, 'utf8');
    const bundle = parseRulesetJson(text);
    const blast = bundle.towerCatalog.find((t) => t.id === 'stress-blast');
    const chill = bundle.towerCatalog.find((t) => t.id === 'stress-chill');
    expect(blast?.cost).toBe(12);
    expect(chill?.cost).toBe(12);
    expect(150 * 12).toBe(bundle.balance.startingBounty);
  });
});
