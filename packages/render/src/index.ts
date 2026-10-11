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
export { resolvePalette, roleColour, COLOUR_MODES } from './palette';
export type { Palette } from './palette';
export { renderTimeOf, positionTracers, tracerPaintOps } from './tracers';
export type { PositionedTracer, TracerPaintOp } from './tracers';
export { isDetonation } from './scorches';
export { creepShapeFor, creepSilhouettePaintOp, slowTelegraphPaintOps } from './creep-paint';
export type { CreepShape, CreepSilhouettePaintOp, SlowTelegraphPaintOp } from './creep-paint';
export { towerFootprintMarkFor, towerRoleFor, towerLookFor } from './tower-paint';
export type { TowerFootprintMark, TowerRole, TowerLook } from './tower-paint';
// The tower art kit, for the Card swatches (`apps/web/src/swatch.ts`): the same art through
// the same painter as the board's atlas, so a Card always matches the board.
export { artGraphics } from './art-paint';
export type { ArtGraphics, ArtCanvas2DLike, PathFactory } from './art-paint';
export { paintTowerArt, towerArtFit } from './art-frames';
// How often a tower's shot flashes (visual pass T3) — what `apps/web`'s fire-rate test holds
// every shipped tower to at every game speed (ADR 0003, WCAG 2.3.1).
export {
  flashesPerSecond,
  shortestFourFlashMs,
  FIRE_FEEDBACK_TICKS,
  MAX_FLASHES_PER_SECOND,
} from './tower-fire';
// The backing store a canvas needs to be shown pixel for pixel — a Card swatch's as the board's.
export { backingStoreSize, devicePixelReport, observesDevicePixels } from './device-px';
export type { DevicePixelReport } from './device-px';
export type { GraphicsLike } from './board-draw';
export type {
  CreepVM,
  CreepStatusCounts,
  TowerVM,
  RenderVM,
  HudVM,
  HudPreview,
  PreviewEntryVM,
  ColourMode,
  GhostVM,
  SelectionVM,
  RenderOverlay,
  RenderHandle,
  TracerVM,
} from './types';
