// routes.test.ts — each entrance's route, as the wave strip names it (M3 story 4).

import { describe, it, expect } from 'vitest';
import { getBundledRuleset } from '@wynding/content';
import type { RulesetBoard } from '@wynding/content';
import { describeRoutes, HEADING_ARROW } from './routes';

describe('describeRoutes', () => {
  it('names the crossing board’s two routes by their walls, each pointed the way its creeps enter', () => {
    const routes = describeRoutes(getBundledRuleset().boards[0]!);
    expect([...routes]).toEqual([
      ['west', { from: 'west', to: ['east'], heading: 'east' }],
      ['north', { from: 'north', to: ['south'], heading: 'south' }],
    ]);
    expect(HEADING_ARROW[routes.get('west')!.heading]).toBe('→');
    expect(HEADING_ARROW[routes.get('north')!.heading]).toBe('↓');
  });

  it('names a route by its walls, not its ids, and every exit of a destination in board order', () => {
    const board = {
      id: 'b',
      widthTiles: 10,
      heightTiles: 8,
      entrances: [{ id: 'gate', cell: { col: 9, row: 3 }, destination: ['top', 'bottom'] }],
      exits: [
        { id: 'top', cell: { col: 4, row: 0 } },
        { id: 'bottom', cell: { col: 4, row: 7 } },
      ],
      waves: [],
    } as unknown as RulesetBoard;
    expect(describeRoutes(board).get('gate')).toEqual({
      from: 'east',
      to: ['north', 'south'],
      heading: 'west',
    });
    expect(HEADING_ARROW.west).toBe('←');
    expect(HEADING_ARROW.north).toBe('↑');
  });
});
