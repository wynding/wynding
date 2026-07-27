// @wynding/content — the ruleset bundle registry (ADR 0007, M2-S1).
//
// Type shapes are re-exported from ./schema.ts (they live in @wynding/types); the
// shipped M1 artifact is authored JSON under ./rulesets, loaded and validated at
// runtime by ./registry.ts (the client-side loader half of ADR 0007 §2's "two
// independent loaders" — the server loads the same bytes via the separate
// `@wynding/content/artifact` subpath, see ./artifact.ts). This barrel re-exports
// the registry + types and holds no game logic itself.
// All AGPL-3.0-or-later, like the rest of the project (see ADR 0002).

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
} from './schema';
export {
  DEFAULT_RULESET_ID,
  getBundledRuleset,
  bundledRulesetIds,
  defaultBoardId,
} from './registry';
