// boards.ts — authored board and wave data (game content).
//
// AGPL-3.0-or-later, like the rest of the project: all material — code and
// assets/content alike — is AGPL + the §7 App Store Exception (see ADR 0002).

import type { Board } from './schema';

/** A first sample board — enough to exercise the pipeline end to end. */
export const sampleBoard: Board = {
  id: 'field-01',
  name: 'Open Field',
  widthTiles: 20,
  heightTiles: 14,
  startingLives: 20,
  startingBounty: 100,
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
