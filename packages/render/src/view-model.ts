// view-model.ts — derive the compact per-tick `RenderVM`/`HudVM` from `SimState`.
// Pure: no Phaser, no DOM, no mutation of the sim. The one place that reads the sim's
// SoA columns and projects creep points, so the scene never touches `SimState`.

import {
  projectCreep,
  deriveScore,
  deriveStars,
  isTerminalPhase,
  MS_PER_TICK,
  type SimState,
  type PreviewState,
  type CompiledRuleset,
} from '@wynding/sim';
import type { RenderVM, HudVM, CreepVM, TowerVM } from './types';
import { clamp01 } from './num';

// The health-fraction denominator is a pure function of the (immutable) ruleset, but
// deriveViewModel runs every tick — memoize per ruleset so the object isn't re-walked
// each tick (it scales with a future creep roster).
const maxHpCache = new WeakMap<CompiledRuleset, number>();

/** Largest creep max-HP in the ruleset — the health-fraction denominator. At M1 there is
 *  exactly one creep kind, so this equals that kind's spawn HP and `hpFrac` is a true
 *  per-creep [0,1] fraction (what the scene assumes). A TRUE per-creep denominator for a
 *  multi-kind roster (M2) needs each creep's spawn max-HP, which the SoA does not store —
 *  adding it is a sim state-shape change (a `simVersion` bump), out of scope for Story 6.
 *  Until then this ruleset-wide max is the correct single-kind denominator. */
function maxCreepHp(ruleset: CompiledRuleset): number {
  const memo = maxHpCache.get(ruleset);
  if (memo !== undefined) return memo;
  let max = 1;
  for (const id of Object.keys(ruleset.creepById) as (keyof typeof ruleset.creepById)[]) {
    const def = ruleset.creepById[id];
    if (def !== undefined && def.hp > max) max = def.hp;
  }
  maxHpCache.set(ruleset, max);
  return max;
}

/** Project every live creep/tower of `state` into a render snapshot. */
export function deriveViewModel(state: SimState, ruleset: CompiledRuleset): RenderVM {
  const grid = ruleset.board.grid;
  const denom = maxCreepHp(ruleset);

  const creeps: CreepVM[] = [];
  for (let i = 0; i < state.creeps.id.length; i++) {
    const p = projectCreep(state.creeps, i, grid);
    if (p === null) continue; // ragged/forged row — not drawn
    const hp = state.creeps.hp[i];
    const hpFrac = Number.isSafeInteger(hp) ? clamp01((hp as number) / denom) : 0;
    creeps.push({ id: state.creeps.id[i] as number, x: p.x, y: p.y, hpFrac });
  }

  const towers: TowerVM[] = [];
  for (let i = 0; i < state.towers.id.length; i++) {
    towers.push({
      id: state.towers.id[i] as number,
      col: state.towers.col[i] as number,
      row: state.towers.row[i] as number,
    });
  }

  return { tick: state.tick, phase: state.phase, creeps, towers };
}

/** Derive the HUD fields (countdown in whole seconds, score, stars) from `state`. Also
 *  accepts a `PreviewState` — the controller's pending-aware presentation reads the
 *  HUD off a `previewInputs()` result while the run itself stays uncommitted.
 *
 *  `score` is phase-dependent (#53): the HUD shows the score components ALREADY EARNED,
 *  and the survival term (`lives × survivalMul`) is credited only at resolution. Rendering
 *  the authoritative terminal formula against a live state showed `Score: 250` before a
 *  wave had even launched. This is deliberately NOT a monotonicity guarantee — the rule is
 *  "earned so far", and a future score input (e.g. an M2 sell haircut) may legitimately
 *  lower a live score. Once terminal, `deriveScore` is authoritative and unchanged, so the
 *  results dialog and the replay-verify comparison still see the server-re-derivable number. */
export function deriveHud(state: SimState | PreviewState, ruleset: CompiledRuleset): HudVM {
  const preWave = state.phase === 'pre-wave';
  const ticksLeft = preWave ? Math.max(0, state.launchAtTick - state.tick) : 0;
  // Guarded exactly as `deriveScore` guards the same accumulator, so a forged/ragged
  // state reads 0 here rather than leaking NaN into the chip.
  const earned = Number.isSafeInteger(state.cumulativeKillBounty) ? state.cumulativeKillBounty : 0;
  return {
    phase: state.phase,
    lives: state.lives,
    bounty: state.bounty,
    countdownSeconds: preWave ? Math.ceil((ticksLeft * MS_PER_TICK) / 1000) : null,
    score: isTerminalPhase(state.phase) ? deriveScore(state, ruleset) : earned,
    stars: deriveStars(state, ruleset),
    won: state.phase === 'won',
  };
}
