// crossing-board.test.ts — M3 story 4: the crossing board is the shipped default.
//
// The board's DATA (docs/milestones/m3.md, "The board"): 28 × 24, a blocked border ring
// with the four openings set into it and a fully open 26 × 22 interior; entrances west
// (0,11) and north (13,0), exits east (27,11) and south (13,23), each entrance heading for
// its own one exit; empty-board routes of 27 and 23 tiles that cross at (13,11). Then what
// that data does in the sim — a build sealing either route is refused — and the schedule's
// authoring rules ("Waves & timing"), which block 1 (M3 story 5) keeps and blocks 2–3 must.
// The shipped artifact's content digest is pinned here too: M2's pin moved with the M2
// bundle to the frozen fixture (`parity.test.ts`).

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  rulesetDigest,
  step,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId, bundledRulesetIds } from './registry';
import { getM2Fixture, M2_BOARD_ID } from './m2-fixture';
import { currentPath } from './paths';

const bundle = getBundledRuleset();
const board = bundle.boards[0]!;
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
const { grid } = ruleset.board;

const WEST = 0; // entrance indices, in board order
const NORTH = 1;

/** Place `basic` towers at `anchors`, one tick each, from a fresh state. */
function placeAll(anchors: readonly { col: number; row: number }[]): SimState {
  let s = createInitialState(1, ruleset);
  for (const anchor of anchors) {
    const input: SimInput = { kind: 'placeTower', anchor, towerId: 'basic' };
    s = step(s, ruleset, [input]);
  }
  return s;
}

const towerAt = (s: SimState, col: number, row: number): boolean =>
  s.towers.col.some((c, i) => c === col && s.towers.row[i] === row);

describe('the crossing board is the shipped default', () => {
  it('is the bundle’s first board, so the client and the server both default to it', () => {
    expect(defaultBoardId(bundle)).toBe('crossing-medium');
    expect(bundle.boards.map((b) => b.id)).toEqual(['crossing-medium']);
  });

  it('carries the 28 × 24 geometry and the two crossing pairs, each entrance to its own exit', () => {
    expect([board.widthTiles, board.heightTiles]).toEqual([28, 24]);
    expect(board.entrances).toEqual([
      { id: 'west', cell: { col: 0, row: 11 }, destination: ['east'] },
      { id: 'north', cell: { col: 13, row: 0 }, destination: ['south'] },
    ]);
    expect(board.exits).toEqual([
      { id: 'east', cell: { col: 27, row: 11 } },
      { id: 'south', cell: { col: 13, row: 23 } },
    ]);
    // Two one-exit destinations, so two flow-fields — west's leads to east, north's to south.
    expect(ruleset.board.entranceDestination).toEqual([0, 1]);
    expect(ruleset.board.fields.map((f) => f.exit)).toEqual([
      { col: 27, row: 11 },
      { col: 13, row: 23 },
    ]);
  });

  it('blocks the whole border ring except the four openings, and opens the whole 26 × 22 interior', () => {
    const openings = new Set(['0,11', '13,0', '27,11', '13,23']);
    let interior = 0;
    for (let row = 0; row < 24; row++) {
      for (let col = 0; col < 28; col++) {
        const onBorder = col === 0 || col === 27 || row === 0 || row === 23;
        const cls = grid.classAt({ col, row });
        if (!onBorder) {
          expect(cls).toBe('buildable-open');
          interior++;
        } else if (openings.has(`${col},${row}`)) {
          expect(cls).toBe('walkable-unbuildable');
        } else {
          expect(cls).toBe('blocked');
        }
      }
    }
    expect(interior).toBe(26 * 22);
  });

  it('runs 27 tiles west → east along row 11 and 23 tiles north → south down column 13 on the empty board, crossing at (13,11)', () => {
    const empty = createInitialState(1, ruleset);
    const west = currentPath(ruleset, empty, WEST)!;
    const north = currentPath(ruleset, empty, NORTH)!;
    expect(west).toHaveLength(28); // 27 steps
    expect(west.every((c) => c.row === 11)).toBe(true);
    expect(north).toHaveLength(24); // 23 steps
    expect(north.every((c) => c.col === 13)).toBe(true);
    expect(north[north.length - 1]).toEqual({ col: 13, row: 23 });
    const crossing = west.filter((c) => north.some((n) => n.col === c.col && n.row === c.row));
    expect(crossing).toEqual([{ col: 13, row: 11 }]);
  });
});

describe('the maze invariant holds per route on the crossing board', () => {
  it('refuses the tower that would seal the north route, and keeps every tower before it', () => {
    // A wall across rows 5–6 from col 1 to col 26 cuts the north entrance off from the south
    // exit while west → east still runs below it. The thirteenth tower would close it.
    const anchors = Array.from({ length: 13 }, (_, i) => ({ col: 1 + 2 * i, row: 5 }));
    const s = placeAll(anchors);
    expect(s.towers.id).toHaveLength(12);
    expect(towerAt(s, 25, 5)).toBe(false);
    expect(currentPath(ruleset, s, NORTH)).not.toBeNull();
    expect(currentPath(ruleset, s, WEST)).not.toBeNull();
  });

  it('refuses the tower that would seal the west route, while north → south stays open', () => {
    // A wall down cols 5–6 from row 1 to row 22 cuts west off from east; north never needs it.
    const anchors = Array.from({ length: 11 }, (_, i) => ({ col: 5, row: 1 + 2 * i }));
    const s = placeAll(anchors);
    expect(s.towers.id).toHaveLength(10);
    expect(towerAt(s, 5, 21)).toBe(false);
    expect(currentPath(ruleset, s, WEST)).not.toBeNull();
    // And the other route is still open, to its own exit: north → south runs on as before.
    const north = currentPath(ruleset, s, NORTH)!;
    expect(north).not.toBeNull();
    expect(north[0]).toEqual({ col: 13, row: 0 });
    expect(north[north.length - 1]).toEqual({ col: 13, row: 23 });
  });
});

describe('block 1 keeps the spec’s authoring rules (m3.md, "Waves & timing")', () => {
  const creepById = new Map(bundle.creepCatalog.map((c) => [c.id, c]));
  const first = board.entrances[0]!.id;

  it('sends ground creeps only down the north route (it carries no air until block 2)', () => {
    for (const wave of board.waves) {
      for (const entry of wave.entries) {
        if (entry.entrance === first) continue;
        expect(creepById.get(entry.creepId)!.domain, `wave index ${wave.index}`).toBe('ground');
      }
    }
  });

  it('introduces at most one new thing per wave, and a boss wave nothing but its bosses', () => {
    // A "thing" is the spec's list: a creep id, a route past the first, an air lane past the
    // first, or both lanes flown in one wave. The first route and its air lane are where the
    // run starts, so neither counts.
    const seen = new Set<string>([`route:${first}`, `air:${first}`]);
    for (const wave of board.waves) {
      const fresh = new Set<string>();
      const flown = new Set<string>();
      for (const entry of wave.entries) {
        const creep = creepById.get(entry.creepId)!;
        const things = [`creep:${creep.id}`, `route:${entry.entrance}`];
        if (creep.domain === 'air') {
          things.push(`air:${entry.entrance}`);
          flown.add(entry.entrance);
        }
        for (const thing of things) if (!seen.has(thing)) fresh.add(thing);
      }
      if (flown.size > 1 && !seen.has('air:both')) fresh.add('air:both');
      expect(fresh.size, `wave index ${wave.index}: ${[...fresh].join(', ')}`).toBeLessThanOrEqual(
        1,
      );
      const bossWave = wave.entries.some((e) => creepById.get(e.creepId)!.role === 'boss');
      if (bossWave) {
        for (const thing of fresh) {
          expect(creepById.get(thing.replace(/^creep:/, ''))?.role, thing).toBe('boss');
        }
      }
      for (const thing of fresh) seen.add(thing);
    }
    // The north route did open, in a wave that brought nothing else new.
    expect(seen.has('route:north')).toBe(true);
  });

  it('keeps every wave within four (creep, route) streams, the Compact preview’s rows', () => {
    for (const wave of ruleset.waves) expect(wave.entriesSummary.length).toBeLessThanOrEqual(4);
  });

  it('spawns each stream at its own entrance, two routes in one wave where it says so', () => {
    // Wave 4 (index 3) is the first to use both routes: 8 × fast from the west, 6 × fast
    // from the north 60 ticks later — one creep id, two streams, two routes.
    expect(ruleset.waves[3]!.entriesSummary).toEqual([
      { creepId: 'fast', entrance: 'west', destination: ['east'], count: 8 },
      { creepId: 'fast', entrance: 'north', destination: ['south'], count: 6 },
    ]);
    expect(new Set(ruleset.waves[3]!.spawns.map((s) => s.entrance))).toEqual(
      new Set([WEST, NORTH]),
    );
  });

  it('opens the north route at wave 3, with ground creeps and nothing else new', () => {
    const opening = board.waves.findIndex((w) => w.entries.some((e) => e.entrance === 'north'));
    expect(opening).toBe(2);
    expect(board.waves[opening]!.entries).toEqual([
      { creepId: 'normal', entrance: 'north', count: 10, spacingTicks: 20, offsetTicks: 0 },
    ]);
  });

  it('pays every clear bonus by the spec’s rule: 2 + ⌊(wave − 1) / 10⌋, plus 4 on a boss wave', () => {
    for (const wave of board.waves) {
      const n = wave.index + 1;
      const boss = wave.entries.some((e) => creepById.get(e.creepId)!.role === 'boss');
      expect(wave.clearBonus, `wave ${n}`).toBe(2 + Math.floor((n - 1) / 10) + (boss ? 4 : 0));
    }
  });

  it('starts a boss’s same-route escorts at least 600 ticks after it (M2’s measured fix)', () => {
    let bosses = 0;
    for (const wave of board.waves) {
      for (const boss of wave.entries.filter((e) => creepById.get(e.creepId)!.role === 'boss')) {
        bosses++;
        const bossLast = (boss.offsetTicks ?? 0) + (boss.count - 1) * boss.spacingTicks;
        for (const escort of wave.entries) {
          if (escort === boss || escort.entrance !== boss.entrance) continue;
          expect(escort.offsetTicks ?? 0, `wave ${wave.index + 1}`).toBeGreaterThanOrEqual(
            bossLast + 600,
          );
        }
      }
    }
    // Block 1's one boss (wave 10, from the west) has no same-route escort — its escort walks
    // the north route — so the rule first bites in block 2; the count keeps this honest.
    expect(bosses).toBe(1);
  });
});

// --- GOLDEN — the rulesetHash of the shipped artifact -------------------------------------
// Recompute with: pnpm --filter @wynding/content exec vitest run crossing-board
// Every deployed replay binds to this digest (ADR 0007 §3), so a change is never silent.
// Pinned M3 story 4 (measured): the crossing board replaces `field-01` as the shipped
// bundle's only board. M2's digest stays pinned on the frozen fixture (`parity.test.ts`).
// Re-pinned M3 story 5 (measured): block 1's ten waves replace the placeholder schedule, and
// the lives, economy and score knobs re-pin to the longer run.
const SHIPPED_RULESET_HASH = 'cd99471c534de643a6881aabfad717917a62dc7f4f223daa70958debad44c93d';
// ------------------------------------------------------------------------------------------

describe('digest golden — the shipped artifact’s content hash', () => {
  it('matches the committed rulesetHash literal', () => {
    const digest = rulesetDigest(bundle);
    console.log(`[crossing-board] SHIPPED_RULESET_HASH: ${digest}`);
    expect(digest).toBe(SHIPPED_RULESET_HASH);
  });
});

describe('the frozen M2 fixture is not shipped', () => {
  it('is absent from the registry, which carries only the crossing bundle', () => {
    expect(bundledRulesetIds()).toEqual(['wynding-core']);
    expect(getBundledRuleset().boards.some((b) => b.id === M2_BOARD_ID)).toBe(false);
    expect(() => compileRuleset(getBundledRuleset(), M2_BOARD_ID)).toThrow();
  });

  it('is M2’s bundle — `field-01` and its ten waves, one route — frozen and cached', () => {
    const m2 = getM2Fixture();
    expect(getM2Fixture()).toBe(m2);
    expect(Object.isFrozen(m2)).toBe(true);
    expect(m2.boards.map((b) => b.id)).toEqual([M2_BOARD_ID]);
    expect(m2.boards[0]!.waves).toHaveLength(10);
    expect(m2.boards[0]!.entrances.map((e) => e.id)).toEqual(['west']);
  });
});
