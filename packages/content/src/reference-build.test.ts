// reference-build.test.ts — M3 story 1: the grid reference-build format
// (`reference-build.ts`), on M2's board (`field-01`, 28 × 24, entrance (0,11), exit
// (27,11)). Pure compilation: nothing here runs the sim.

import { describe, it, expect } from 'vitest';
import { compileRuleset, type CompiledRuleset } from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { getBundledRuleset } from './registry';
import {
  compileReferenceBuild,
  drawGrid,
  TOWER_LETTERS,
  type ReferenceBuild,
} from './reference-build';
import { M2_PINNED_LOSER } from './reference-builds';

const ruleset = compileRuleset(getBundledRuleset('wynding-core'), 'field-01');

/** The board drawn with `towers` (anchor + letter) over it, one string per row. */
const draw = (towers: readonly (readonly [number, number, string])[]): string[] =>
  drawGrid(ruleset, towers).split('\n');

function build(gridLines: readonly string[], order: string): ReferenceBuild {
  return { id: 'probe', summary: 'a test build', grid: gridLines.join('\n'), order };
}

const compile = (gridLines: readonly string[], order: string, on: CompiledRuleset = ruleset) =>
  compileReferenceBuild(build(gridLines, order), on);

describe('the grid reference-build format', () => {
  it('draws the board it reads: an empty board, and a registered build’s own maze', () => {
    expect(drawGrid(ruleset)).toBe(
      M2_PINNED_LOSER.grid.replace(/[a-z]/g, '.').trim().replace(/\n\s+/g, '\n'),
    );
    const loser = drawGrid(ruleset, [
      [2, 10, 'b'],
      [2, 12, 'b'],
      [6, 10, 'b'],
      [6, 12, 'b'],
      [10, 10, 'b'],
      [10, 12, 'b'],
      [14, 10, 'v'],
      [14, 12, 'v'],
      [18, 10, 's'],
      [18, 12, 's'],
      [22, 10, 'v'],
      [22, 12, 'v'],
    ]);
    expect(loser).toBe(M2_PINNED_LOSER.grid.trim().replace(/\n\s+/g, '\n'));
  });

  it('re-arms a mine: placing one again while it may already have fired is allowed, unlike any other tower', () => {
    const lines = draw([
      [10, 12, 'm'],
      [2, 10, 'b'],
    ]);
    expect(compile(lines, 'm10,12 b2,10 m10,12@900 m10,12')).toStrictEqual([
      { col: 10, row: 12, towerId: 'mine' },
      { col: 2, row: 10, towerId: 'basic' },
      { col: 10, row: 12, towerId: 'mine', notBeforeTick: 900 },
      { col: 10, row: 12, towerId: 'mine' },
    ]);
    expect(() => compile(lines, 'm10,12 b2,10 b2,10')).toThrow(/already standing/);
  });

  it('rejects a letter whose tower this ruleset’s catalog does not carry', () => {
    const bundle = getBundledRuleset('wynding-core');
    const withoutMine: Ruleset = {
      ...bundle,
      towerCatalog: bundle.towerCatalog.filter((t) => t.id !== 'mine'),
    };
    expect(() =>
      compile(draw([[10, 12, 'm']]), 'm10,12', compileRuleset(withoutMine, 'field-01')),
    ).toThrow(/'m' at \(10,12\) names no tower in this ruleset/);
  });

  it('compiles an order into the runner plan: placements, timed placements, sells, re-placements', () => {
    const lines = draw([
      [2, 10, 'b'],
      [4, 12, 'v'],
    ]);
    expect(compile(lines, 'b2,10  v4,12@600\n -b2,10@900 b2,10')).toStrictEqual([
      { col: 2, row: 10, towerId: 'basic' },
      { col: 4, row: 12, towerId: 'venom', notBeforeTick: 600 },
      { kind: 'sell', col: 2, row: 10, notBeforeTick: 900 },
      { col: 2, row: 10, towerId: 'basic' },
    ]);
  });

  it('accepts indentation and blank lines around the drawing, and a sell with no tick', () => {
    const lines = draw([[2, 10, 'a']]).map((l) => `      ${l}  `);
    expect(compile(['', ...lines, ''], 'a2,10 -a2,10')).toStrictEqual([
      { col: 2, row: 10, towerId: 'antiair' },
      { kind: 'sell', col: 2, row: 10 },
    ]);
  });

  it('splits a run of same-letter cells into footprints one way: the first unclaimed cell is an anchor', () => {
    // Two basics side by side, and two more offset by one row — a 4-wide and a stepped block.
    const lines = draw([
      [2, 2, 'b'],
      [4, 2, 'b'],
      [8, 2, 'b'],
      [10, 3, 'b'],
    ]);
    expect(compile(lines, 'b2,2 b4,2 b8,2 b10,3').map((s) => [s.col, s.row])).toEqual([
      [2, 2],
      [4, 2],
      [8, 2],
      [10, 3],
    ]);
    expect(() => compile(lines, 'b2,2 b3,2 b8,2 b10,3')).toThrow(
      /names no 'b' tower anchored at \(3,2\)/,
    );
  });

  it('every letter names a catalog tower, and every catalog tower has a letter', () => {
    expect(Object.values(TOWER_LETTERS).sort()).toEqual(ruleset.towers.map((t) => t.id).sort());
  });

  describe('rejects, naming the build', () => {
    const one = draw([[2, 10, 'b']]);

    it.each([
      ['a missing row', one.slice(1), 'b2,10', /grid has 23 rows, the board has 24/],
      [
        'a short row',
        one.map((l, i) => (i === 5 ? l.slice(1) : l)),
        'b2,10',
        /grid row 5 has 27 cells/,
      ],
      [
        'a drawing one column off',
        one.map((l) => `.${l.slice(0, -1)}`),
        'b3,10',
        /\(0,0\) is drawn '\.' but is blocked \('#'\)/,
      ],
      [
        'an opening drawn as open ground',
        one.map((l, i) => (i === 11 ? `.${l.slice(1)}` : l)),
        'b2,10',
        /\(0,11\) is drawn '\.' but is walkable-unbuildable \('\+'\)/,
      ],
      [
        'a tower on the border',
        one.map((l, i) => (i === 0 ? `bb${l.slice(2)}` : i === 1 ? `bb${l.slice(2)}` : l)),
        'b2,10',
        /\(0,0\) carries a tower but is blocked/,
      ],
      [
        'a letter that names no tower',
        draw([[2, 10, 'z']]),
        'z2,10',
        /'z' at \(2,10\) names no tower/,
      ],
      [
        'an incomplete footprint',
        one.map((l, i) => (i === 10 ? `${l.slice(0, 4)}b${l.slice(5)}` : l)),
        'b2,10',
        /'b' at \(4,10\) does not complete a 2×2 footprint/,
      ],
      [
        'a footprint running into the border',
        one.map((l, i) => (i === 22 ? `${l.slice(0, 26)}b#` : l)),
        'b2,10',
        /'b' at \(26,22\) does not complete a 2×2 footprint/,
      ],
      ['a malformed order step', one, 'b2-10', /order step 'b2-10' is not/],
      ['a step naming the wrong letter', one, 'v2,10', /names no 'v' tower anchored at \(2,10\)/],
      ['a step naming no anchor', one, 'b2,11', /names no 'b' tower anchored at \(2,11\)/],
      ['a sell of a tower not standing', one, '-b2,10 b2,10', /sells a tower that is not standing/],
      ['a place of a tower already standing', one, 'b2,10 b2,10', /already standing/],
      [
        'a sell of a mine',
        draw([[10, 12, 'm']]),
        'm10,12 -m10,12@900',
        /order step '-m10,12@900' sells a mine, which may already have detonated/,
      ],
      [
        'a drawn tower never placed',
        draw([
          [2, 10, 'b'],
          [6, 10, 'b'],
        ]),
        'b2,10',
        /\(6,10\) is drawn but never placed/,
      ],
    ])('%s', (_what, lines, order, message) => {
      expect(() => compile(lines, order)).toThrow(/^reference build 'probe': /);
      expect(() => compile(lines, order)).toThrow(message);
    });
  });
});
