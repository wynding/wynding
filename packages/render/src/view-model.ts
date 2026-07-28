// view-model.ts — derive the compact per-tick `RenderVM`/`HudVM` from `SimState`.
// Pure: no Phaser, no DOM, no mutation of the sim. The one place that reads the sim's
// SoA columns and projects creep points, so the scene never touches `SimState`.

import {
  projectCreep,
  deriveScore,
  deriveStars,
  MS_PER_TICK,
  type SimState,
  type PreviewState,
  type CompiledRuleset,
} from '@wynding/sim';
import type { RenderVM, HudVM, HudPreview, PreviewEntryVM, CreepVM, TowerVM } from './types';
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

/** Join `waves[waveCursor].entriesSummary` onto the compiled creep catalog for the
 *  wave-preview surface (PLAN.md P3 step 16). `entriesSummary` is the wave's
 *  authoritative preview source (first-appearance order, already aggregated at compile
 *  time), so this is a straight per-row lookup — no aggregation logic lives here. A
 *  creepId absent from `creepById` cannot occur for a genuinely compiled ruleset (every
 *  `entriesSummary` row is derived from a validated, catalog-resolved entry), but the
 *  join stays defensive rather than throwing: a forged/hand-built ruleset must not crash
 *  the renderer, so a missing definition falls back to the safest sv6-legal values
 *  (ground domain, no armor, no immunities) rather than dropping the row (an entry
 *  disappearing from the preview is a worse UX bug than one rendering with placeholder
 *  metadata — a player would trust the shorter list).
 */
function previewEntries(
  wave: CompiledRuleset['waves'][number],
  ruleset: CompiledRuleset,
): PreviewEntryVM[] {
  return wave.entriesSummary.map(({ creepId, count }) => {
    const def = ruleset.creepById[creepId];
    return {
      creepId,
      count,
      domain: def?.domain ?? 'ground',
      armor: def?.armor ?? 0,
      immunities: def?.immunities ?? [],
    };
  });
}

/** Derive the wave-preview surface (PLAN.md P3 step 16): the coming wave's composition
 *  while `waveCursor < waveCount`, the explicit last-wave marker once every wave has
 *  launched but the run is still live, or `null` once terminal (the results dialog
 *  takes over — there is nothing left to preview). */
function derivePreview(
  state: SimState | PreviewState,
  ruleset: CompiledRuleset,
): HudPreview | null {
  const waveCount = ruleset.waves.length;
  if (state.phase !== 'running') return null;
  // Guarded like every other forged-state read in this module: a negative/non-integer
  // `waveCursor` cannot address a real wave, so it reads as the safe "nothing left to
  // preview" state rather than indexing out of bounds — `coerceSoa` never actually
  // produces one (it's clamped to `[0, waves.length]`), but render code stays defensive
  // regardless of what produced the state it's handed.
  const cursor = Number.isSafeInteger(state.waveCursor) ? state.waveCursor : waveCount;
  const wave = cursor >= 0 && cursor < waveCount ? ruleset.waves[cursor] : undefined;
  if (wave === undefined) return { kind: 'lastWave' };
  return {
    kind: 'upcoming',
    waveNumber: cursor + 1,
    waveCount,
    entries: previewEntries(wave, ruleset),
  };
}

/** Derive the HUD fields (countdown in whole seconds, score, stars, wave preview) from
 *  `state`. Also accepts a `PreviewState` — the controller's pending-aware presentation
 *  reads the HUD off a `previewInputs()` result while the run itself stays uncommitted;
 *  the wave-preview's `callable`/`launchPending` in particular MUST read the projection
 *  (PLAN.md P3 step 16: "the projection path surfaces a buffered call as
 *  `launchPending`") so a queued-while-paused call disables the control immediately.
 *
 *  `score` is now unconditionally `deriveScore` (#53's phase-dependent scorer, M2-S2):
 *  the `running` branch already returns exactly the "earned so far" figure (Σ kill
 *  bounty + Σ early-call credit, no survival term) the HUD wants live, and the `won`/
 *  `lost` branches are the authoritative terminal formula the results dialog and the
 *  replay-verify comparison compare against — one call now covers every phase. */
export function deriveHud(state: SimState | PreviewState, ruleset: CompiledRuleset): HudVM {
  const waveCount = ruleset.waves.length;
  const counting = state.phase === 'running' && state.waveCursor < waveCount;
  return {
    phase: state.phase,
    lives: state.lives,
    bounty: state.bounty,
    countdownSeconds: counting ? Math.ceil((state.countdownRemaining * MS_PER_TICK) / 1000) : null,
    score: deriveScore(state, ruleset),
    stars: deriveStars(state, ruleset),
    won: state.phase === 'won',
    waveCount,
    waveCursor: state.waveCursor,
    launchPending: state.launchPending,
    callable: state.phase === 'running' && state.waveCursor < waveCount && !state.launchPending,
    preview: derivePreview(state, ruleset),
  };
}
