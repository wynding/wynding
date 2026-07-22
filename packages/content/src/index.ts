// @wynding/content — the authored ruleset bundle (ADR 0007).
//
// Type shapes are re-exported from ./schema.ts (they live in @wynding/types) and the
// authored data in ./boards.ts; this barrel re-exports both and holds no game logic.
// All AGPL-3.0-or-later, like the rest of the project (see ADR 0002).

export type {
  Ruleset,
  RulesetBoard,
  WaveSchedule,
  WaveEntry,
  CreepDef,
  TowerDef,
  BalanceConstants,
  ScoringConfig,
  CreepDomain,
} from './schema';
export { m1Ruleset, rulesets, M1_BOARD_ID } from './boards';
