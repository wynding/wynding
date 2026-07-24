// @wynding/render — the presentation layer.
//
// The renderer READS simulation state and draws it; it never mutates the sim. This
// barrel exports the PURE, unit-tested modules — the projection geometry, the
// view-model/HUD derivation, id-matched interpolation, and the colourblind palettes.
// The Phaser scene itself (WebGL, not unit-testable under jsdom) lives behind the
// `@wynding/render/scene` subpath so importing this barrel never pulls Phaser into a
// test process. `apps/web` imports `mount` from `@wynding/render/scene`.

export { createProjection } from './projection';
export type { BoardLayout, Projection } from './projection';
export { deriveViewModel, deriveHud } from './view-model';
export { interpolateCreeps } from './interpolate';
export { resolvePalette, COLOUR_MODES } from './palette';
export type { Palette } from './palette';
export type {
  CreepVM,
  TowerVM,
  RenderVM,
  HudVM,
  ColourMode,
  GhostVM,
  SelectionVM,
  RenderOverlay,
  RenderHandle,
} from './types';
