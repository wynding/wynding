// paths.test.ts — `currentPath`, the read-only "current ground path from entrance E to
// its destination" query (M3 story 3, for the balance checker).

import { describe, it, expect } from 'vitest';
import { compileRuleset, createInitialState, step } from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { getBundledRuleset, defaultBoardId } from './registry';
import { currentPath } from './paths';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));

/** The shipped bundle with two more entrances and one more exit — THREE entrances, TWO
 *  destinations, so an entrance's index is not its destination's: `west` (0,11) and
 *  `west-lo` (0,20) both → `east` (27,11); `east-lo` (27,20) → `south` (13,23). Fields
 *  [east, south]; entrances → [0, 0, 1]. The waves still spawn only at `west`. */
function threeEntranceRuleset(): ReturnType<typeof compileRuleset> {
  const b = structuredClone(bundle) as Ruleset;
  const board = b.boards[0]! as unknown as {
    entrances: { id: string; cell: { col: number; row: number }; destination: string[] }[];
    exits: { id: string; cell: { col: number; row: number } }[];
  };
  board.entrances.push(
    { id: 'west-lo', cell: { col: 0, row: 20 }, destination: ['east'] },
    { id: 'east-lo', cell: { col: 27, row: 20 }, destination: ['south'] },
  );
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

  it('follows each entrance to ITS OWN destination — by the entrance’s destination, never its index', () => {
    const three = threeEntranceRuleset();
    expect(three.board.entranceDestination).toEqual([0, 0, 1]);
    const s = createInitialState(1, three);
    const westLo = currentPath(three, s, 1)!; // shares entrance 0's destination: east
    expect(westLo[0]).toEqual({ col: 0, row: 20 });
    expect(westLo[westLo.length - 1]).toEqual({ col: 27, row: 11 });
    const eastLo = currentPath(three, s, 2)!; // destination 1: south
    expect(eastLo[0]).toEqual({ col: 27, row: 20 });
    expect(eastLo[eastLo.length - 1]).toEqual({ col: 13, row: 23 });
  });

  it('entrance 2’s path bends around a tower placed on it, still ending at its own exit', () => {
    const three = threeEntranceRuleset();
    const open = currentPath(three, createInitialState(1, three), 2)!;
    // A tower whose 2 × 2 footprint covers an interior cell of east-lo's empty-board path
    // from above (the path hugs row 22, and row 23 is the border).
    const anchor = { col: open[6]!.col, row: open[6]!.row - 1 };
    for (const dc of [0, 1]) {
      for (const dr of [0, 1]) {
        expect(three.board.grid.classAt({ col: anchor.col + dc, row: anchor.row + dr })).toBe(
          'buildable-open',
        );
      }
    }
    let s = createInitialState(1, three);
    s = step(s, three, [{ kind: 'placeTower', anchor, towerId: 'basic' }]);
    expect(s.towers.id).toHaveLength(1);
    const path = currentPath(three, s, 2)!;
    const footprint = new Set(
      [0, 1].flatMap((dc) =>
        [0, 1].map((dr) => key({ col: anchor.col + dc, row: anchor.row + dr })),
      ),
    );
    expect(path.some((c) => footprint.has(key(c)))).toBe(false);
    expect(path[0]).toEqual({ col: 27, row: 20 });
    expect(path[path.length - 1]).toEqual({ col: 13, row: 23 });
    expect(path).not.toEqual(open);
  });

  it('throws on an entrance index the board does not have', () => {
    expect(() => currentPath(ruleset, createInitialState(1, ruleset), 1)).toThrow(
      /board has no entrance 1/,
    );
    const three = threeEntranceRuleset();
    expect(() => currentPath(three, createInitialState(1, three), 3)).toThrow(
      /board has no entrance 3 \(it has 3\)/,
    );
  });
});
