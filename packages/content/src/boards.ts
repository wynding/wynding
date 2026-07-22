// boards.ts — the authored M1 ruleset bundle (game content).
//
// AGPL-3.0-or-later, like the rest of the project: all material — code and
// assets/content alike — is AGPL + the §7 App Store Exception (see ADR 0002).
//
// Every number here is a first-pass M1 value from docs/milestones/m1.md, chosen to
// be tuned. All of it is ruleset content (ADR 0007): a change bumps `rulesetHash`,
// never `simVersion`. The sim reads ALL of it via `compileRuleset` — nothing is a
// hardcoded engine constant.

import type { Ruleset } from '@wynding/types';

/** The M1 board id (single-path 28×24 field). */
export const M1_BOARD_ID = 'field-01';

/**
 * The M1 ruleset: one single-path board, one ground creep, one single-target tower,
 * one wave of ten. Economy runs thin (starting bounty + per-kill only); the
 * wave-clear and early-call bonuses exist but are valued 0 (M2 gives them meaning).
 */
export const m1Ruleset: Ruleset = {
  formatVersion: 1,
  rulesetId: 'wynding-core-m1',
  version: 1,
  creepCatalog: [{ kind: 'normal', hp: 20, speedFp: 26, bounty: 1, domain: 'ground' }],
  towerCatalog: [
    { kind: 'basic', cost: 5, damage: 10, rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
  ],
  balance: {
    startingLives: 10,
    startingBounty: 80,
    refundNum: 3,
    refundDen: 4, // ⌊75% × spend⌋
    leakCost: 1,
    countdownTicks: 500, // ≈ 25 s at 20 Hz, callable early from tick 0
    waveClearBonus: 0, // mechanic present, valued off at M1
    earlyCallBonus: 0,
  },
  scoring: {
    survivalMul: 25, // score = Σ kill-bounties + lives × 25
    starThresholds: [1, 6, 9], // 1★ ≥ 1 · 2★ ≥ 6 · 3★ ≥ 9
  },
  boards: [
    {
      id: M1_BOARD_ID,
      name: 'Open Field',
      widthTiles: 28,
      heightTiles: 24,
      entrance: { col: 0, row: 11 },
      exit: { col: 27, row: 11 },
      waves: [
        {
          index: 0,
          entries: [{ kind: 'normal', count: 10, spacingTicks: 20 }],
        },
      ],
    },
  ],
};

/** All bundled rulesets (campaign order). */
export const rulesets: readonly Ruleset[] = [m1Ruleset];
