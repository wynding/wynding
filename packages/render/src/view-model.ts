// view-model.ts — derive the compact per-tick `RenderVM`/`HudVM` from `SimState`.
// Pure: no Phaser, no DOM, no mutation of the sim. The one place that reads the sim's
// SoA columns and projects creep points, so the scene never touches `SimState`.

import {
  projectCreep,
  deriveScore,
  deriveStars,
  forEachValidTower,
  buildAuraIndex,
  auraMulFor,
  SUPPORT_MUL_IDENTITY,
  MS_PER_TICK,
  type SimState,
  type PreviewState,
  type CompiledRuleset,
} from '@wynding/sim';
import type { RenderVM, HudVM, HudPreview, PreviewEntryVM, CreepVM, TowerVM } from './types';
import { clamp01 } from './num';

/** Project every live creep/tower of `state` into a render snapshot. */
export function deriveViewModel(state: SimState, ruleset: CompiledRuleset): RenderVM {
  const grid = ruleset.board.grid;

  // Built ONCE per call, not per creep — a per-creep `state.dots.some(...)` scan would be
  // an O(creeps × records) rebuild of the same membership test every iteration.
  const poisonedIds = new Set<number>();
  for (const rec of state.dots) poisonedIds.add(rec.targetId);

  const creeps: CreepVM[] = [];
  for (let i = 0; i < state.creeps.id.length; i++) {
    const p = projectCreep(state.creeps, i, grid);
    if (p === null) continue; // ragged/forged row — not drawn
    const hp = state.creeps.hp[i];
    const creepId = state.creeps.creepId[i] as string;
    // TRUE per-creep denominator (M2-S3 retires the single-kind `maxCreepHp` assumption):
    // the creep's OWN catalog max HP, `creepById[creepId].hp`. `coerceSoa` already drops
    // any row whose `creepId` doesn't resolve in the catalog, so an unresolvable id here
    // can only occur via a total-guard gap the sim itself didn't anticipate — this falls
    // back to `max(1, hp)` (never 0, so the fraction stays defined) rather than throwing.
    const def = ruleset.creepById[creepId];
    const denom =
      def !== undefined ? def.hp : Math.max(1, Number.isSafeInteger(hp) ? (hp as number) : 1);
    const hpFrac = Number.isSafeInteger(hp) ? clamp01((hp as number) / denom) : 0;
    const slowMulFp = state.creeps.slowMulFp[i];
    const stunUntilTick = state.creeps.stunUntilTick[i];
    // Same inclusive-expiry rule the sim's own movement derivation uses
    // (`index.ts`: `stunUntilTick !== 0 && stunUntilTick >= state.tick`) — a stun
    // applied through tick T still holds at tick T, so the render VM must agree with
    // the sim about whether "right now" is stunned, not merely echo a stale column.
    const stunned =
      Number.isSafeInteger(stunUntilTick) &&
      (stunUntilTick as number) !== 0 &&
      (stunUntilTick as number) >= state.tick;
    creeps.push({
      id: state.creeps.id[i] as number,
      creepId,
      // Catalog join, like `warded`'s below — NOT sim state. `def` is already resolved
      // above; a forged/unresolved `creepId` (absent `def`) falls back to `'ground'`,
      // the same totality rail `warded`'s `?? 0`-style fallback and `hpFrac`'s
      // denominator already take.
      domain: def?.domain ?? 'ground',
      x: p.x,
      y: p.y,
      hpFrac,
      slowed: Number.isSafeInteger(slowMulFp) && (slowMulFp as number) !== 0,
      poisoned: poisonedIds.has(state.creeps.id[i] as number),
      stunned,
      // Catalog join, like `hpFrac`'s denominator above — NOT sim state. `def` is
      // already resolved above; the optional chain is what keeps an absent
      // definition (a forged/unresolved `creepId`) from throwing, matching the
      // adjacent HP join's own posture.
      warded: (def?.immunities.length ?? 0) > 0,
      // Catalog join, like `warded` above — NOT sim state (M2-S10). `def` is already
      // resolved above; the optional chain keeps an absent definition falling back to
      // `false`, the same totality rail `warded`/`domain` already take.
      boss: def?.role === 'boss',
    });
  }

  // Towers are projected through the CANONICAL `forEachValidTower` walk (Codex R3-2), NOT
  // by iterating raw SoA rows: a forged/restored row the sim itself classifies invalid
  // (unknown `towerId`, spend↔towerId mismatch) must not be drawn — presentation can never
  // disagree with the sim about which rows exist.
  //
  // `support`/`buffed` are CATALOG + GEOMETRY joins, not sim state — derived here by
  // calling the sim's OWN `buildAuraIndex`/`auraMulFor` (M2-S8), never a second copy of
  // the adjacency rule living in the render package. One implementation means the ✦ can
  // never mark a tower `runCombat` is not actually buffing.
  const auraIndex = buildAuraIndex(grid, state.towers, ruleset.towerById);
  const towers: TowerVM[] = [];
  forEachValidTower(grid, state.towers, ruleset.towerById, (i, id, col, row) => {
    const def = ruleset.towerById[state.towers.towerId[i] as string];
    towers.push({
      id,
      col,
      row,
      towerId: state.towers.towerId[i] as string,
      support: def?.support !== undefined,
      // The `def?.attack !== undefined` gate is load-bearing, not defensive: a beacon
      // beside a beacon IS inside the other's stamped ring, so without it the scene
      // would draw a chaining buff the sim never applies.
      //
      // WHAT THIS FLAG CLAIMS, stated because the Panel's "(boosted)" label deliberately
      // claims something else: the ✦ means "an aura REACHES this tower", keyed on the
      // multiplier. `panel.damageBuffed` means "the damage NUMBER changed", keyed on the
      // number, because `buffAmount` floors and the schema admits a multiplier (257,
      // ×1.004) that floors away on small amounts. On such a modded bundle the board
      // shows the ✦ while the Panel declines to say "boosted" — and both are telling the
      // truth about different things. Not reachable with the shipped catalog (the beacon
      // is 384 and the smallest direct amount is `venom`'s 2). Deliberately NOT unified
      // by recomputing per-effect amounts here: that would put floor arithmetic on the
      // per-tower render path to change a cue nothing in the shipped game can observe.
      buffed:
        def?.attack !== undefined && auraMulFor(auraIndex, grid, col, row) > SUPPORT_MUL_IDENTITY,
    });
  });

  return { tick: state.tick, phase: state.phase, creeps, towers };
}

/** Join `waves[waveCursor].entriesSummary` onto the compiled creep catalog for the
 *  wave-preview surface (PLAN.md P3 step 16). `entriesSummary` is the wave's
 *  authoritative preview source (FIRST-ARRIVAL order over the sorted spawn timeline,
 *  already aggregated at compile time), so this is a straight per-row lookup — no
 *  aggregation logic lives here. A
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
      // `?? 1` is unreachable from a genuinely compiled ruleset (mirrors
      // `resolveCreepLeakCost`'s posture in `packages/sim/src/index.ts`) — kept as the
      // safe fallback for the same forged/hand-built-ruleset defensiveness this join
      // already takes on `domain`/`armor`/`immunities`.
      leakCost: def?.leakCost ?? 1,
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
  // One guarded value, shared by `countdownSeconds` and `callable` — matches
  // `derivePreview`'s own `Number.isSafeInteger` guard on `waveCursor` so every HUD field
  // agrees with the preview even if that invariant (clamped by `coerceSoa`) were ever
  // violated, rather than two independently-recomputed copies drifting apart.
  const cursor = Number.isSafeInteger(state.waveCursor) ? state.waveCursor : waveCount;
  const waveAvailable = state.phase === 'running' && cursor >= 0 && cursor < waveCount;
  return {
    phase: state.phase,
    lives: state.lives,
    bounty: state.bounty,
    countdownSeconds: waveAvailable
      ? Math.ceil((state.countdownRemaining * MS_PER_TICK) / 1000)
      : null,
    score: deriveScore(state, ruleset),
    stars: deriveStars(state, ruleset),
    won: state.phase === 'won',
    waveCount,
    waveCursor: state.waveCursor,
    launchPending: state.launchPending,
    callable: waveAvailable && !state.launchPending,
    preview: derivePreview(state, ruleset),
  };
}
