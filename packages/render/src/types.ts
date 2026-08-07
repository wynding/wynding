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
  /** Catalog domain (M2-S7) — a straight join like `warded`'s, NOT sim state (it never
   *  changes tick-to-tick for a given creep). Drives the airborne cue (`creep-paint.ts`):
   *  an independent shape+colour cue layered over whichever base silhouette `creepId`
   *  already draws, so an id that is both armored AND airborne (`armored-flyer`, S10)
   *  reads as both — a single id-keyed `CreepShape` could never express that (ADR 0003:
   *  never colour alone). `'ground'` for a forged/unresolved `creepId` (the same
   *  total-over-absent-definition posture `warded`'s join already takes). */
  readonly domain: 'ground' | 'air';
  /** Fixed-point sim point (256 units = 1 cell) — projected to pixels by `projection`. */
  readonly x: number;
  readonly y: number;
  /** Remaining-health fraction in [0,1] for the health pip (dual-encoded, not colour-only). */
  readonly hpFrac: number;
  /** Whether an active slow status affects this creep right now (`slowMulFp !== 0`,
   *  M2-S3) — drives the slowed telegraph's shape+motion cues (`creep-paint.ts`). */
  readonly slowed: boolean;
  /** Whether a live DoT record targets this creep right now (`SimState.dots` carries
   *  a matching `targetId`, M2-S5a) — a boolean, not a count: multiple co-ticking
   *  records on the same creep (independent `venom` sources) still read as one
   *  poisoned cue, drives the poisoned telegraph (`creep-paint.ts`). */
  readonly poisoned: boolean;
  /** Whether an active stun holds this creep right now (`stunUntilTick !== 0 &&
   *  stunUntilTick >= tick`, M2-S6, the same inclusive-expiry rule the sim's own
   *  movement derivation uses) — sim state, drives the stun telegraph's shape+motion
   *  cues (`creep-paint.ts`). */
  readonly stunned: boolean;
  /** Whether `creepId`'s catalog definition carries any immunity (M2-S6) — a catalog
   *  JOIN, like `hpFrac`'s max-HP denominator, NOT sim state: this never changes
   *  tick-to-tick for a given creep. `false` for a forged/unresolved `creepId` (the
   *  same total-over-absent-definition posture `hpFrac`'s join already takes). */
  readonly warded: boolean;
}

/** One tower as the renderer sees it: its 2×2 anchor cell. */
export interface TowerVM {
  readonly id: number;
  readonly col: number;
  readonly row: number;
  /** Catalog id (M2-S3) — keys the footprint mark distinguishing `slow` from `basic`
   *  (`tower-paint.ts`); both share `palette.tower` (shape carries the distinction). */
  readonly towerId: string;
  /** This tower is a SUPPORT tower (M2-S8, `beacon`) — it does not attack, and the
   *  scene draws its adjacency shell one cell out from the footprint. A catalog join,
   *  not sim state. */
  readonly support: boolean;
  /** A support aura is currently reaching this tower AND it can actually use one
   *  (M2-S8). Gated on the tower having an attack: a beacon's shell stamps a
   *  neighbouring beacon's cells, so an ungated flag would mark beacon-beside-beacon
   *  as buffed — a visual chaining lie the sim never enacts (support effects are
   *  dropped from the fire-time snapshot, and a support tower never fires at all). */
  readonly buffed: boolean;
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
  /** Tower attack range in fixed-point sim units, for the preview range ring — `null`
   *  for an ATTACKLESS tower (M2-S8's `beacon`), where the scene skips the ring
   *  entirely. Nullable rather than `0`: a zero-radius circle is a dot the player must
   *  interpret, and arming the beacon is the very first thing they do with it. */
  readonly rangeFp: number | null;
  /** The armed tower's AoE blast radius (fixed-point sim units), `null` for a
   *  single-target tower (M2-S4a step 14). A 12-bounty `splash` is an informed
   *  purchase, matching the wave-preview philosophy — so this previews the blast
   *  radius too, drawn SHAPE-DISTINCT from the range ring above (`scene.ts`): two
   *  plain concentric circles at the same footprint would be ambiguous (is the
   *  inner one the splash, a permanent aura, or the range? — Codex R1-15). The
   *  Panel labels both rings as text (`panel.range`/`panel.blastRadius`), so the
   *  ring itself stays decorative, never the sole carrier (ADR 0003 §3). */
  readonly blastRadiusFp: number | null;
}

/** A currently-selected tower whose range ring is shown (for sell/inspect). */
export interface SelectionVM {
  readonly col: number;
  readonly row: number;
  /** `null` for a support tower, which does not attack (M2-S8) — same reason as
   *  `GhostVM.rangeFp`. The
   *  live support multiplier the Panel needs to show buffed damage is deliberately NOT
   *  here: the scene draws no number, so a field with no render consumer would be dead
   *  weight on the per-frame surface. It rides on `UiState.selection` instead, where the
   *  Panel actually reads it. */
  readonly rangeFp: number | null;
  /** The selected tower's catalog id (M2-S3) — keys the Panel's per-id stats. */
  readonly towerId: string;
}

/** One in-flight shot (Tracer, #32/P6): fp-unit origin (the firing tower's centre),
 *  over its real launch→impact tick window. Carried from the sim's `StepEvents.fired`
 *  straight through the controller to here — purely decorative, never essential
 *  (damage/outcomes are always carried by the impact spark + HP pips).
 *
 *  A discriminated union (M2-S4a step 12, mirroring `StepEvents.fired`/`Impact`):
 *  `targeted` chases its `targetId`'s CURRENT interpolated position (never re-derived
 *  from `state.impacts`, whose `targetId` a retargeting tower can overwrite mid-
 *  flight — this carries the ORIGINAL fire-time target) and is dropped if that target
 *  is no longer drawn (died/leaked in flight — nothing to aim at); `blast` interpolates
 *  toward its OWN fixed `destX`/`destY` (the same fire-time lead point the impact will
 *  land at) regardless of whether the original target survives — left undiscriminated,
 *  every blast tracer would visibly fly toward wherever its fire-time target ends up
 *  rather than where the blast actually lands (`tracers.ts`). */
export type TracerVM =
  | {
      readonly kind: 'targeted';
      readonly originX: number;
      readonly originY: number;
      readonly targetId: number;
      readonly launchTick: number;
      readonly impactTick: number;
    }
  | {
      readonly kind: 'blast';
      readonly originX: number;
      readonly originY: number;
      readonly destX: number;
      readonly destY: number;
      readonly launchTick: number;
      readonly impactTick: number;
    };

/** One impact/spark point in fixed-point sim units — shared shape for `RenderOverlay.sparks`,
 *  `scene.ts`'s internal `Spark` (which adds a `bornAt` stamp), and its `preReady` buffer. */
export interface SparkPoint {
  readonly x: number;
  readonly y: number;
  readonly radiusFp: number;
}

/** Board-space presentation state handed to `draw()` alongside the two view-models.
 *  Everything here is transient UI (not sim state): the aiming ghost, the selection
 *  ring, and the accessibility palette/motion choices the scene draws with. */
export interface RenderOverlay {
  readonly ghost: GhostVM | null;
  readonly selection: SelectionVM | null;
  /** Impact points (fixed-point sim units) that RESOLVED since the last frame —
   *  accumulated per sim tick by the controller so kills during a multi-tick catch-up
   *  frame still flash (the scene only sees the latest two view-models). `radiusFp`
   *  (M2-S4a step 11, threaded from `StepEvents.impactPoints`) is `0` for a `targeted`
   *  impact — the pre-existing small fading spark — or the blast's true radius, which
   *  the scene draws as an expanding-and-fading RING instead (`scene.ts`) so a blast
   *  landing reads at its real footprint, not a point. One list, not a parallel array —
   *  each entry already carries everything the scene needs to draw itself. */
  readonly sparks: readonly SparkPoint[];
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
