// levels.ts — authored level and wave data (game content).
//
// SPDX-License-Identifier: CC-BY-SA-4.0
//
// This file holds *content data* — a creative work (level geometry, economy,
// wave scripts, balance numbers) licensed under Creative Commons
// Attribution-ShareAlike 4.0, separate from the AGPL code in ./index.ts that
// defines its shapes and loads it. See
// ../../../docs/adr/0002-asset-and-content-licensing.md.

import type { Level } from './schema';

/** A first sample level — enough to exercise the pipeline end to end. */
export const sampleLevel: Level = {
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

/** All bundled levels (campaign order). */
export const levels: readonly Level[] = [sampleLevel];
