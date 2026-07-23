// types.ts — the presentation-layer view-model contract. These are DERIVED from the
// sim's `SimState` each tick by `view-model.ts` (both `deriveViewModel` and `deriveHud`
// live there); the renderer draws them and never reaches back into `SimState`. Kept free
// of Phaser/DOM types so the derivation + interpolation modules are pure and unit-testable.

import type { SimPhase } from '@wynding/sim';

/** One creep as the renderer sees it: derived point (fixed-point sim units) + health. */
export interface CreepVM {
  readonly id: number;
  /** Fixed-point sim point (256 units = 1 cell) — projected to pixels by `projection`. */
  readonly x: number;
  readonly y: number;
  /** Remaining-health fraction in [0,1] for the health pip (dual-encoded, not colour-only). */
  readonly hpFrac: number;
}

/** One tower as the renderer sees it: its 2×2 anchor cell. */
export interface TowerVM {
  readonly id: number;
  readonly col: number;
  readonly row: number;
}

/** A scheduled impact, carried so the renderer can spark on resolution (multiset-diffed). */
export interface ImpactVM {
  readonly targetId: number;
  readonly impactTick: number;
}

/** The compact per-tick render snapshot (the "view-model"). Two of these + an alpha
 *  drive interpolation; the controller keeps the last two (it can't retain `SimState`,
 *  which `step()` mutates in place). */
export interface RenderVM {
  readonly tick: number;
  readonly phase: SimPhase;
  readonly creeps: readonly CreepVM[];
  readonly towers: readonly TowerVM[];
  readonly impacts: readonly ImpactVM[];
}

/** HUD display fields — derived, all numbers; the UI layer resolves labels via `t()`. */
export interface HudVM {
  readonly phase: SimPhase;
  readonly lives: number;
  readonly bounty: number;
  /** Whole seconds until the wave auto-launches; null once launched (not shown). */
  readonly countdownSeconds: number | null;
  readonly score: number;
  readonly stars: number;
  readonly won: boolean;
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
  /** Colourblind palette mode currently active. */
  readonly colourMode: ColourMode;
  /** When true the scene damps the impact-spark FX (WCAG 2.3.3 / GAG §2). */
  readonly reducedMotion: boolean;
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
