// schema.ts — content data shapes.
//
// The ruleset bundle types (ADR 0007, v2 schema) are the shared vocabulary and live
// in `@wynding/types` so the sim can consume them without importing this package.
// This module re-exports them so content authoring imports stay local to the
// package.

export type {
  Ruleset,
  RulesetBoard,
  WaveSchedule,
  WaveEntry,
  CreepDef,
  TowerDef,
  EffectDef,
  BalanceConstants,
  ScoringConfig,
  CreepDomain,
  TowerTargetDomain,
} from '@wynding/types';
