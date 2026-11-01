// routes.ts — each entrance's route as the wave strip names it (M3 story 4): the wall it
// enters from, the wall of each exit in its destination, and the heading creeps travel in —
// the same heading the board draws on that entrance and its exit (`@wynding/render`'s
// `openingHeading`), so the strip's arrow and the board's cue are one cue.
//
// Read from the AUTHORED board (its ids, cells and destinations) once, when the overlay is
// made: a preview stream names its route by entrance id (`PreviewEntryVM.entrance`), and the
// compiled ruleset keeps openings by index only. Walls rather than ids are what the player
// reads — "north to south" — so a board's ids are never shown and need no catalog entries.

import { borderSide, openingHeading, type Heading } from '@wynding/render';
import type { RulesetBoard } from '@wynding/content';

/** One entrance's route: the wall it is in, the wall of each exit in its destination (board
 *  order), and the heading creeps travel in through it. */
export interface RouteView {
  readonly from: Heading;
  readonly to: readonly Heading[];
  readonly heading: Heading;
}

/** Every entrance's route, by entrance id. */
export function describeRoutes(board: RulesetBoard): ReadonlyMap<string, RouteView> {
  const geometry = { cols: board.widthTiles, rows: board.heightTiles };
  const exitCell = new Map(board.exits.map((x) => [x.id, x.cell] as const));
  return new Map(
    board.entrances.map((e) => [
      e.id,
      {
        from: borderSide(geometry, e.cell),
        to: e.destination.map((id) => borderSide(geometry, exitCell.get(id)!)),
        heading: openingHeading(geometry, e.cell, 'entrance'),
      },
    ]),
  );
}

/** The arrow for a heading — a glyph, not copy: it has no language, so it stays out of the
 *  `t()` catalog, as the overlay's other glyphs do (`overlay.ts`'s `ICONS`). */
export const HEADING_ARROW: Readonly<Record<Heading, string>> = {
  north: '↑',
  east: '→',
  south: '↓',
  west: '←',
};
