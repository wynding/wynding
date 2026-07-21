// boards.ts — authored board and wave data (game content).
//
// AGPL-3.0-or-later, like the rest of the project: all material — code and
// assets/content alike — is AGPL + the §7 App Store Exception (see ADR 0002).

import type { Board } from './schema';

/**
 * The M1 board: a 28×24 grid with a 1-cell blocked border, leaving a 26×22
 * buildable-open field. A single walkable-unbuildable entrance (left border,
 * row 11) and exit (right border, row 11) are the only openings; the sim derives
 * every cell class from this geometry. Waves are still the sample set — wave
 * tuning is Story 5.
 */
export const sampleBoard: Board = {
  id: 'field-01',
  name: 'Open Field',
  widthTiles: 28,
  heightTiles: 24,
  entrance: { col: 0, row: 11 },
  exit: { col: 27, row: 11 },
  startingLives: 10,
  startingBounty: 80,
  waves: [
    {
      index: 0,
      leadInTicks: 40,
      entries: [{ creep: 'normal', count: 10, hp: 10, spacingTicks: 8 }],
    },
    {
      index: 1,
      leadInTicks: 120,
      entries: [
        { creep: 'normal', count: 12, hp: 14, spacingTicks: 6 },
        { creep: 'fast', count: 4, hp: 8, spacingTicks: 10 },
      ],
    },
  ],
};

/** All bundled boards (campaign order). */
export const boards: readonly Board[] = [sampleBoard];
