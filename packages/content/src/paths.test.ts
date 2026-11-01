// paths.test.ts — `currentPath`, the read-only "current ground path from entrance E to
// its destination" query (M3 story 3, for the balance checker).

import { describe, it, expect } from 'vitest';
import { compileRuleset, createInitialState, step } from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { getBundledRuleset, defaultBoardId } from './registry';
import { currentPath } from './paths';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));

/** The shipped bundle with a second pair added: `north` (13,0) → `south` (13,23). The
 *  waves still spawn only at `west`, so it compiles and plays as before. */
function twoPairRuleset(): ReturnType<typeof compileRuleset> {
  const b = structuredClone(bundle) as Ruleset;
  const board = b.boards[0]! as unknown as {
    entrances: { id: string; cell: { col: number; row: number }; destination: string[] }[];
    exits: { id: string; cell: { col: number; row: number } }[];
  };
  board.entrances.push({ id: 'north', cell: { col: 13, row: 0 }, destination: ['south'] });
  board.exits.push({ id: 'south', cell: { col: 13, row: 23 } });
  return compileRuleset(b, defaultBoardId(b));
}

const key = (c: { col: number; row: number }): string => `${c.col},${c.row}`;

describe('currentPath — the ground path from an entrance to its own destination, now', () => {
  it('on the empty board, runs straight along the row from west (0,11) to east (27,11)', () => {
    const path = currentPath(ruleset, createInitialState(1, ruleset), 0)!;
    expect(path).toHaveLength(28);
    expect(path[0]).toEqual({ col: 0, row: 11 });
    expect(path[27]).toEqual({ col: 27, row: 11 });
    expect(path.every((c) => c.row === 11)).toBe(true);
  });

  it('bends around a placed tower: never enters its footprint, still entrance → exit', () => {
    let s = createInitialState(1, ruleset);
    s = step(s, ruleset, [{ kind: 'placeTower', anchor: { col: 12, row: 10 }, towerId: 'basic' }]);
    expect(s.towers.id).toHaveLength(1);
    const path = currentPath(ruleset, s, 0)!;
    const footprint = new Set(['12,10', '13,10', '12,11', '13,11']);
    expect(path.some((c) => footprint.has(key(c)))).toBe(false);
    expect(path[0]).toEqual({ col: 0, row: 11 });
    expect(path[path.length - 1]).toEqual({ col: 27, row: 11 });
    expect(path.some((c) => c.row !== 11)).toBe(true); // it left the straight row
  });

  it('follows each entrance to ITS OWN destination on a two-pair board', () => {
    const two = twoPairRuleset();
    const s = createInitialState(1, two);
    const westEast = currentPath(two, s, 0)!;
    const northSouth = currentPath(two, s, 1)!;
    expect(westEast[westEast.length - 1]).toEqual({ col: 27, row: 11 });
    expect(northSouth).toHaveLength(24);
    expect(northSouth[0]).toEqual({ col: 13, row: 0 });
    expect(northSouth[23]).toEqual({ col: 13, row: 23 });
    expect(northSouth.every((c) => c.col === 13)).toBe(true);
  });

  it('throws on an entrance index the board does not have', () => {
    expect(() => currentPath(ruleset, createInitialState(1, ruleset), 1)).toThrow(
      /board has no entrance 1/,
    );
  });
});
