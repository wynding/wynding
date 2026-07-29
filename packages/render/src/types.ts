// types.ts — the presentation-layer view-model contract. These are DERIVED from the
// sim's `SimState` each tick by `view-model.ts` (both `deriveViewModel` and `deriveHud`
// live there); the renderer draws them and never reaches back into `SimState`. Kept free
// of Phaser/DOM types so the derivation + interpolation modules are pure and unit-testable.

import type { SimPhase } from '@wynding/sim';

/** One creep row in the wave preview (M2-S2) — the preview-facing axes
 *  `CompiledCreep` carries, joined onto `waves[waveCursor].entriesSummary`. */
export interface PreviewEntryVM {
  readonly creepId: string;
  readonly count: number;
  readonly domain: 'ground' | 'air';
  readonly armor: number;
  readonly immunities: readonly ('slow' | 'stun')[];
}

/** The HUD's wave-preview surface (M2-S2, PLAN.md P3 step 16): `'upcoming'` while
 *  `waveCursor < waveCount` shows the coming wave's composition (the authoritative
 *  source is `CompiledWave.entriesSummary` — one row per creep id, first-appearance
 *  order, already aggregated at compile time); `'lastWave'` is the explicit marker
 *  once every wave has launched but the run hasn't resolved yet (nothing left to
 *  preview, but the run is still live — distinct from `HudVM.preview === null`,
 *  which means terminal). */
export type HudPreview =
  | {
      readonly kind: 'upcoming';
      readonly waveNumber: number;
      readonly waveCount: number;
      readonly entries: readonly PreviewEntryVM[];
    }
  | { readonly kind: 'lastWave' };

/** One creep as the renderer sees it: derived point (fixed-point sim units) + health. */
export interface CreepVM {
  readonly id: number;
  /** Catalog id (M2-S3) — keys the silhouette shape (`creep-paint.ts`) and the per-creep
   *  max-HP join (`creepById[creepId].hp`) `hpFrac` is now derived against. */
  readonly creepId: string;
  /** Fixed-point sim point (256 units = 1 cell) — projected to pixels by `projection`. */
  readonly x: number;
  readonly y: number;
  /** Remaining-health fraction in [0,1] for the health pip (dual-encoded, not colour-only). */
  readonly hpFrac: number;
  /** Whether an active slow status affects this creep right now (`slowMulFp !== 0`,
   *  M2-S3) — drives the slowed telegraph's shape+motion cues (`creep-paint.ts`). */
  readonly slowed: boolean;
}

/** One tower as the renderer sees it: its 2×2 anchor cell. */
export interface TowerVM {
  readonly id: number;
  readonly col: number;
  readonly row: number;
  /** Catalog id (M2-S3) — keys the footprint mark distinguishing `slow` from `basic`
   *  (`tower-paint.ts`); both share `palette.tower` (shape carries the distinction). */
  readonly towerId: string;
}

/** The compact per-tick render snapshot (the "view-model"). Two of these + an alpha
 *  drive interpolation; the controller keeps the last two (it can't retain `SimState`,
 *  which `step()` mutates in place). Landed-impact spark points are NOT inferred from
 *  this snapshot — they come from the sim's `StepEvents` collector (ADR-adjacent #31),
 *  so a wasted (leaked-target) shot never sparks. */
export interface RenderVM {
  readonly tick: number;
  readonly phase: SimPhase;
  readonly creeps: readonly CreepVM[];
  readonly towers: readonly TowerVM[];
}

/** HUD display fields — derived, all numbers; the UI layer resolves labels via `t()`. */
export interface HudVM {
  readonly phase: SimPhase;
  readonly lives: number;
  readonly bounty: number;
  /** Whole seconds until the wave auto-launches; null once launched (not shown). */
  readonly countdownSeconds: number | null;
  /** Phase-dependent (#53). While the run is live this is the score components EARNED SO
   *  FAR (the accrued kill bounty); the survival term is not yet earned and is excluded.
   *  Once the run resolves (won/lost) this is the authoritative `deriveScore` total, which
   *  is what the results dialog and replay verification compare against. Note this is not
   *  a monotonicity guarantee — a future score input may lower a live score. */
  readonly score: number;
  readonly stars: number;
  readonly won: boolean;
  /** Total waves in the ruleset — static per run, but carried here so the overlay never
   *  reaches back into `CompiledRuleset` for a single number. */
  readonly waveCount: number;
  /** Index of the next wave to launch (mirrors `SimState.waveCursor`). */
  readonly waveCursor: number;
  /** A buffered `callWaveEarly` not yet consumed by the wave phase — mirrors
   *  `SimState.launchPending` (or its `previewInputs` projection, PLAN.md P3: "the
   *  projection path surfaces a buffered call as `launchPending`"). Drives the primary
   *  control's pending-launch state distinctly from `callable === false` for other
   *  reasons (last wave, terminal). */
  readonly launchPending: boolean;
  /** Whether `callWaveEarly` would be accepted right now: `running && waveCursor <
   *  waveCount && !launchPending` (PLAN.md P3 step 16). The web layer additionally folds
   *  in tick-buffer capacity (step 15) — that's presentation-only and out of `@wynding/render`'s
   *  scope, so this field is the sim-semantics half of "callable" only. */
  readonly callable: boolean;
  /** The wave-preview surface (PLAN.md P3 step 16) — `null` once the run is terminal
   *  (there is nothing left to preview; the results dialog takes over). */
  readonly preview: HudPreview | null;
}

/** Selectable colourblind mode (a11y setting, GAG §2). `default` = the base palette. */
export type ColourMode = 'default' | 'protan' | 'deutan' | 'tritan';

/** The build ghost the player is aiming: a 2×2 footprint at `(col,row)` and whether
 *  placing it there is legal (from `previewInputs`). Dual-encoded by the scene (a valid
 *  tick uses a distinct shape/outline AND colour — never colour alone). */
export interface GhostVM {
  readonly col: number;
  readonly row: number;
  readonly valid: boolean;
  /** Tower attack range in fixed-point sim units, for the preview range ring. */
  readonly rangeFp: number;
}

/** A currently-selected tower whose range ring is shown (for sell/inspect). */
export interface SelectionVM {
  readonly col: number;
  readonly row: number;
  readonly rangeFp: number;
  /** The selected tower's catalog id (M2-S3) — keys the Panel's per-id stats. */
  readonly towerId: string;
}

/** One in-flight shot (Tracer, #32/P6): fp-unit origin (the firing tower's centre) +
 *  the target locked at fire time, over its real launch→impact tick window. Carried
 *  from the sim's `StepEvents.fired` (never inferred from `state.impacts`, whose
 *  `targetId` a retargeting tower can overwrite mid-flight) straight through the
 *  controller to here — purely decorative, never essential (damage/outcomes are
 *  always carried by the impact spark + HP pips). */
export interface TracerVM {
  readonly originX: number;
  readonly originY: number;
  readonly targetId: number;
  readonly launchTick: number;
  readonly impactTick: number;
}

/** Board-space presentation state handed to `draw()` alongside the two view-models.
 *  Everything here is transient UI (not sim state): the aiming ghost, the selection
 *  ring, and the accessibility palette/motion choices the scene draws with. */
export interface RenderOverlay {
  readonly ghost: GhostVM | null;
  readonly selection: SelectionVM | null;
  /** Impact-spark points (fixed-point sim units) that RESOLVED since the last frame —
   *  accumulated per sim tick by the controller so kills during a multi-tick catch-up
   *  frame still flash (the scene only sees the latest two view-models). */
  readonly sparks: readonly { readonly x: number; readonly y: number }[];
  /** Towers accepted into the tick buffer but not yet committed (paused planning, #37+
   *  #27) — anchor cells + the queued tower's catalog id (M2-S3, Codex R1-7: a slow
   *  tower queued while paused must keep its shape-distinct identity). Drawn with a
   *  non-colour cue (dual-encoded per ADR 0003). */
  readonly pendingAdds: readonly {
    readonly col: number;
    readonly row: number;
    readonly towerId: string;
  }[];
  /** Committed towers whose sell is accepted but not yet committed — hidden immediately
   *  rather than drawn as still-present. */
  readonly pendingSells: readonly { readonly col: number; readonly row: number }[];
  /** Colourblind palette mode currently active. */
  readonly colourMode: ColourMode;
  /** When true the scene damps the impact-spark FX (WCAG 2.3.3 / GAG §2). */
  readonly reducedMotion: boolean;
  /** Shots currently in flight (Tracer, #32/P6) — copied from `FrameSnapshot.tracers`
   *  each frame. Under reduced motion the scene omits them entirely (`tracerPaintOps`
   *  returns an empty plan), same posture as the impact spark's damping. */
  readonly tracers: readonly TracerVM[];
}

/** Live handle to a mounted Phaser view. The controller feeds it the last two render
 *  view-models + an interpolation `alpha` + the transient `overlay` each frame. */
export interface RenderHandle {
  /** Draw a frame: creeps interpolate between `prevVm`→`curVm` by `alpha` (id-matched);
   *  towers/board/overlay are drawn from `curVm`/`overlay`. `prevVm` is null on the
   *  very first frame of a run. */
  draw(prevVm: RenderVM | null, curVm: RenderVM, alpha: number, overlay: RenderOverlay): void;
  /** Clear every scene object for Play-again (§7). The next `draw()` repaints the fresh
   *  run, so no seed frame is passed. */
  reset(): void;
  /** Tear down the Phaser game and release the WebGL context. */
  destroy(): void;
}
