// board-frame.ts — one frame of the board, Phaser-free (V2, #181). Everything the renderer
// draws per frame is decided here: which live layer each cue goes into, which sprite shows
// which frame where, and in what order. `scene.ts` supplies the targets — the baked board
// image, three live `Graphics` and three sprite pools, all as structural interfaces — and
// this fills them, so the routing that keeps every aura shell under every tower body (M2-S8)
// is a unit-tested fact rather than a property of call order in a coverage-excluded file.
//
// The layers composite in `layers.ts`'s order: board, shells, towers, pending, effects
// (selection, tracers), creeps, cues (pips and status cues, then the ghost, then sparks).

import { MS_PER_TICK } from '@wynding/sim';
import {
  drawAuraShells,
  drawCreepCues,
  drawCrosshair,
  drawSelection,
  type GraphicsLike,
} from './board-draw';
import { interpolateCreeps } from './interpolate';
import { resolvePalette, type Palette } from './palette';
import {
  placeCreeps,
  placeTowers,
  snapToDevicePx,
  type FrameAnchor,
  type SpritePlacement,
} from './placement';
import type { Projection } from './projection';
import type { LiveSpark } from './sparks';
import { positionTracers, renderTimeOf, tracerPaintOps } from './tracers';
import type { CreepVM, RenderOverlay, RenderVM } from './types';

/** A live layer: a `Graphics` that is cleared and re-recorded every frame. Wider than
 *  `GraphicsLike` by what only per-frame drawing uses — kept off `GraphicsLike` itself, which
 *  the bake's Canvas2D adapter and the web app's swatch implement. */
export interface LayerGraphics extends GraphicsLike {
  clear(): unknown;
  strokeRect(x: number, y: number, width: number, height: number): unknown;
}

/** The three live layers, each at its depth in `layers.ts`. */
export interface LiveLayers {
  /** Every support-aura shell — under every tower body. */
  readonly shells: LayerGraphics;
  /** The selection cue, then in-flight tracers — between the pending builds and the creeps. */
  readonly effects: LayerGraphics;
  /** Every creep's pip and status cues, then the build ghost, then impact sparks — on top. */
  readonly cues: LayerGraphics;
}

/** A sprite layer: shows a placement list (`sprite-pool.ts`). */
export interface SpriteLayer {
  sync(placements: readonly SpritePlacement[]): void;
  hideAll(): void;
}

/** The baked board texture's image. */
export interface BoardImage {
  setPosition(x: number, y: number): unknown;
  setVisible(visible: boolean): unknown;
}

/** Everything a frame draws into. */
export interface BoardTargets {
  readonly board: BoardImage;
  readonly layers: LiveLayers;
  readonly towers: SpriteLayer;
  readonly pending: SpriteLayer;
  readonly creeps: SpriteLayer;
}

export interface BoardFrameInput {
  readonly prevVm: RenderVM | null;
  readonly curVm: RenderVM;
  /** How far between `prevVm` and `curVm` this frame sits, 0 → 1. */
  readonly alpha: number;
  readonly overlay: RenderOverlay;
  readonly projection: Projection;
  /** The baked atlas's frames, for placement. */
  readonly frames: ReadonlyMap<string, FrameAnchor>;
  /** The sparks still lit this frame (`SparkStore.live`). */
  readonly sparks: readonly LiveSpark[];
}

/** Draw one frame into `t`. */
export function drawBoardFrame(t: BoardTargets, input: BoardFrameInput): void {
  const { prevVm, curVm, alpha, overlay, projection, frames } = input;
  const pal = resolvePalette(overlay.colourMode); // resolved once per frame, passed down
  const { shells, effects, cues } = t.layers;
  // board — the baked texture at the board's corner, snapped like every sprite.
  t.board.setPosition(
    snapToDevicePx(projection.originX, projection.dpr),
    snapToDevicePx(projection.originY, projection.dpr),
  );
  t.board.setVisible(true);
  shells.clear();
  effects.clear();
  cues.clear();
  // shells — under every tower body.
  drawAuraShells(shells, pal, curVm, overlay, projection);
  // towers, pending — atlas sprites.
  const towers = placeTowers(curVm, overlay, projection, frames);
  t.towers.sync(towers.committed);
  t.pending.sync(towers.pending);
  // effects — the selection cue, then tracers. ONE render-time derivation per frame, shared
  // by tracers and the telegraph pulse (CodeRabbit #73): the "one clock" invariant is
  // structural, not two calls that happen to agree.
  drawSelection(effects, pal, overlay, projection);
  const renderTimeTicks = renderTimeOf(prevVm, curVm, alpha);
  // Interpolated ONCE and shared: the creep placement below and the tracers' lerp targets
  // are the same points (#32/P6).
  const interpolated = interpolateCreeps(prevVm, curVm, alpha);
  drawTracers(effects, pal, overlay, renderTimeTicks, interpolated, projection);
  // creeps — atlas sprites, in creep order.
  const creeps = placeCreeps(interpolated, pal, projection, frames);
  t.creeps.sync(creeps);
  // cues — every pip and status cue over every silhouette, then the ghost, then sparks.
  // CLOCK DOMAIN (QC round 2): `renderTimeOf` is in fractional TICKS (tracers.test.ts:
  // `renderTimeOf(vm(5), vm(6), 0.5) === 5.5`); the paint-plan's pulse period is
  // MILLISECONDS (`renderTimeMs`) — convert here, or the 900ms breath becomes a
  // 900-TICK (45s) one and the motion cue is imperceptible inside a 40-tick slow.
  drawCreepCues(cues, pal, creeps, overlay.reducedMotion, renderTimeTicks * MS_PER_TICK);
  drawGhost(cues, pal, overlay, projection);
  drawSparks(cues, pal, input.sparks, overlay.reducedMotion, projection);
}

/** Hide and clear everything a frame drew (Play again): the next `drawBoardFrame` shows
 *  exactly what it draws. */
export function resetBoardFrame(t: BoardTargets): void {
  t.layers.shells.clear();
  t.layers.effects.clear();
  t.layers.cues.clear();
  t.board.setVisible(false);
  t.towers.hideAll();
  t.pending.hideAll();
  t.creeps.hideAll();
}

/**
 * In-flight tracers (#32/P6), a thin executor of `tracerPaintOps`' plan — the ordering and
 * content gate lives in `tracers.test.ts` against the plan itself. Each tracer lerps toward
 * its target creep's interpolated point, and its dot is snapped to a whole device pixel the
 * way the creep sprites are (`placement.ts`), so a tracer that has arrived sits EXACTLY on
 * the centre its target creep is drawn at, not up to half a device pixel off it.
 */
export function drawTracers(
  g: GraphicsLike,
  pal: Palette,
  overlay: RenderOverlay,
  renderTimeTicks: number, // fractional TICKS — derived ONCE per frame (CodeRabbit #73)
  interpolated: readonly Pick<CreepVM, 'id' | 'x' | 'y'>[],
  projection: Projection,
): void {
  if (overlay.tracers.length === 0) return;
  const targets = new Map(interpolated.map((c) => [c.id, { x: c.x, y: c.y }]));
  const positioned = positionTracers(overlay.tracers, targets, renderTimeTicks);
  for (const op of tracerPaintOps(positioned, overlay.reducedMotion, pal)) {
    const p = projection.fpToPixel(op.x, op.y); // op.x/y are fp-unit sim coordinates
    g.fillStyle(op.colour, 1);
    g.fillCircle(
      snapToDevicePx(p.x, projection.dpr),
      snapToDevicePx(p.y, projection.dpr),
      Math.max(2, projection.cellPx * 0.15),
    );
  }
}

/** The build ghost: where an armed tower would land, valid or not. */
export function drawGhost(
  g: LayerGraphics,
  pal: Palette,
  o: RenderOverlay,
  projection: Projection,
): void {
  if (o.ghost === null) return;
  const p = projection.cellToPixel(o.ghost.col, o.ghost.row);
  const size = projection.cellPx * 2;
  if (o.ghost.valid) {
    g.lineStyle(3, pal.ghostValid, 1); // solid outline = valid
    g.strokeRoundedRect(p.x + 2, p.y + 2, size - 4, size - 4, 6);
    const cx = p.x + projection.cellPx;
    const cy = p.y + projection.cellPx;
    // M2-S8: a support tower (`beacon`) does not attack, so it previews no range ring —
    // this is the path
    // that bites FIRST, since arming a tower to place it is the first thing a player
    // does with it, and this call used to stroke unconditionally for every valid ghost.
    if (o.ghost.rangeFp !== null) {
      g.lineStyle(1, pal.range, 0.7);
      g.strokeCircle(cx, cy, projection.fpLenToPixel(o.ghost.rangeFp));
    }
    // Armed-splash blast-radius preview (M2-S4a step 14): a 12-bounty long-lob is an
    // informed purchase, matching the wave-preview philosophy. The ghost already draws
    // the range ring above — a SECOND plain circle at the same footprint would be
    // genuinely ambiguous (is the inner one the splash, a permanent aura, or the range?
    // — Codex R1-15), so this draws the same radiating-spoke motif the committed
    // `'crosshair'` footprint mark uses, at the full blast radius: shape-distinct from
    // the smooth range circle, never colour alone. Text carries the exact number
    // regardless (`panel.blastRadius`, Panel) — the ring itself stays decorative.
    // Gated on "has a blast at all" — the SAME condition the committed selection uses
    // (`board-draw.ts`), so arming a tower and selecting that same tower both show the
    // blast. The ghost's body is an OUTLINE rather than a fill, so its spokes sit
    // wholly on `floor`; a committed small-blast tower's inner spoke crosses its own
    // filled body and reads shorter. Same condition, same motif, slightly different
    // painted result — `board-draw.ts` carries the geometry. They briefly diverged during M2-S9 (selection additionally required the
    // blast to overreach the range ring, which only the mine does); Rob ruled for
    // consistency, 2026-08-07. Change both sites together or neither.
    if (o.ghost.blastRadiusFp !== null) {
      g.lineStyle(2, pal.range, 0.9);
      drawCrosshair(g, cx, cy, projection.fpLenToPixel(o.ghost.blastRadiusFp));
    }
  } else {
    g.lineStyle(3, pal.ghostInvalid, 1); // crossed-out = invalid (shape, not colour alone)
    g.strokeRect(p.x + 2, p.y + 2, size - 4, size - 4);
    g.lineBetween(p.x + 2, p.y + 2, p.x + size - 2, p.y + size - 2);
    g.lineBetween(p.x + size - 2, p.y + 2, p.x + 2, p.y + size - 2);
  }
}

/** Impact sparks, each faded by its `k` (`sparks.ts`). */
export function drawSparks(
  g: GraphicsLike,
  pal: Palette,
  sparks: readonly LiveSpark[],
  reducedMotion: boolean,
  projection: Projection,
): void {
  for (const s of sparks) {
    const p = projection.fpToPixel(s.x, s.y);
    const k = s.k; // 1 → 0 as the spark ages (both variants fade the same way)
    if (s.radiusFp === 0) {
      g.fillStyle(pal.spark, reducedMotion ? 0.5 * k : k);
      g.fillCircle(p.x, p.y, Math.max(2, projection.cellPx * 0.3 * k));
    } else {
      // Blast landing (M2-S4a step 13): an expanding-and-fading RING at the blast's
      // TRUE radius — grows outward from nothing to its real footprint as it fades.
      // Under reduced motion this is NOT the same posture as the targeted spark above
      // (QC round-1 #7 — a prior version wrongly claimed it was). Reduced motion cuts
      // `life` to 0.4× and alpha to 0.5× for BOTH cues. For the spark that is nearly
      // pure damping: it shrinks a fill inside a sub-cell radius, so the shorter window
      // does speed that shrink up (~2.5×), but over a distance small enough not to read
      // as motion. This ring instead SWEEPS OUTWARD across the blast's true, possibly
      // multi-tile radius — the same shortened `life` would COMPRESS that sweep,
      // making the ring travel FASTER over a LARGER area under "reduced" motion, an
      // ADR 0003 regression. So `grow` is clamped to its final value: the ring holds at
      // its full static radius and only fades. The honest summary is that `life`/alpha
      // damping is sufficient when the animated distance is sub-cell and insufficient
      // once it is not — which is why only this branch needs the clamp.
      const maxR = projection.fpLenToPixel(s.radiusFp);
      const grow = reducedMotion ? 1 : 1 - k; // 0 → 1 as the ring ages, opposite of the fade
      g.lineStyle(2, pal.spark, reducedMotion ? 0.5 * k : k);
      g.strokeCircle(p.x, p.y, Math.max(2, maxR * grow));
    }
  }
}
