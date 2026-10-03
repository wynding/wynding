// board-frame.ts — one frame of the board, Phaser-free (V2, #181). Everything the renderer
// draws per frame is decided here: which live layer each cue goes into, which sprite shows
// which frame where, and in what order. `scene.ts` supplies the targets — the baked board
// image, three live `Graphics` and five sprite pools, all as structural interfaces — and
// this fills them, so the routing that keeps every aura shell under every tower body (M2-S8)
// is a unit-tested fact rather than a property of call order in a coverage-excluded file.
//
// The layers composite in `layers.ts`'s order: board, scorches, shells, plates, heads,
// pending, effects (selection, fire feedback, tracers), creeps, cues (pips and status cues,
// then the ghost, then sparks).
//
// State that lives across frames — where mines went off, where each head points, which towers
// just fired — is kept in Phaser-free trackers the scene owns (`scorches.ts`, `tower-aim.ts`,
// `tower-fire.ts`). Each frame feeds every one of them once, on the render clock, before
// anything they shape is placed or drawn; `resetBoardFrame` requires all three.

import { MS_PER_TICK } from '@wynding/sim';
import {
  drawAuraShells,
  drawCreepCues,
  drawCrosshair,
  drawSelection,
  visibleTowers,
  type GraphicsLike,
} from './board-draw';
import { snapToDevicePx } from './device-px';
import { interpolateCreeps } from './interpolate';
import { resolvePalette, type Palette } from './palette';
import {
  placeCreeps,
  placeScorches,
  placeTowers,
  type FrameAnchor,
  type SpritePlacement,
} from './placement';
import type { Projection } from './projection';
import type { ScorchTracker } from './scorches';
import type { LiveSpark } from './sparks';
import type { AimTracker } from './tower-aim';
import {
  fireFeedbackPaintOps,
  headPose,
  type FireFeedbackOp,
  type FireTracker,
} from './tower-fire';
import { positionTracers, renderTimeOf, tracerPaintOps } from './tracers';
import type { RenderOverlay, RenderVM, TowerVM } from './types';

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
  /** The selection cue, then the shots' muzzle flashes and ring pulses, then in-flight
   *  tracers — over the heads and the pending builds, under the creeps. */
  readonly effects: LayerGraphics;
  /** Every creep's pip and status cues, then the build ghost, then impact sparks — on top. */
  readonly cues: LayerGraphics;
}

/** A live layer's name — the one it is made under, and its depth is read from. */
export type LiveLayerName = keyof LiveLayers;

/** The three live layers, each made by `make` under its own name: whatever depth `make` gives
 *  a layer comes from that layer's own entry in `layers.ts`, never a neighbour's. */
export function createLiveLayers<G extends LayerGraphics>(
  make: (layer: LiveLayerName) => G,
): { readonly shells: G; readonly effects: G; readonly cues: G } {
  return { shells: make('shells'), effects: make('effects'), cues: make('cues') };
}

/** A sprite layer: shows a placement list (`sprite-pool.ts`). */
export interface SpriteLayer {
  sync(placements: readonly SpritePlacement[]): void;
  hideAll(): void;
}

/** A sprite layer's name — the one it is made under, and its depth is read from. */
export type SpriteLayerName = 'scorches' | 'plates' | 'heads' | 'pending' | 'creeps';

/** One `S` per sprite layer. */
export type SpriteLayers<S> = { readonly [L in SpriteLayerName]: S };

/** The five sprite layers, each made by `make` under its own name, as `createLiveLayers`. */
export function createSpriteLayers<S>(make: (layer: SpriteLayerName) => S): SpriteLayers<S> {
  return {
    scorches: make('scorches'),
    plates: make('plates'),
    heads: make('heads'),
    pending: make('pending'),
    creeps: make('creeps'),
  };
}

/**
 * `fn` for every sprite in every layer of `layers`, with the frame it shows — what a rebake
 * repoints at the new atlas. EVERY layer, read off the layers themselves rather than listed
 * by hand: a sprite a rebake missed would stay on the atlas the bake runner removes right
 * after, and the first one drawn would throw inside Phaser's WebGL batcher and end the frame
 * loop.
 */
export function forEachLayerSprite<S>(
  layers: SpriteLayers<{ forEach(fn: (sprite: S, frame: string) => void): void }>,
  fn: (sprite: S, frame: string) => void,
): void {
  for (const layer of Object.values(layers)) layer.forEach(fn);
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
  /** Where mines went off, fading — on the floor, under everything a tower draws. */
  readonly scorches: SpriteLayer;
  /** What committed towers stand on: each one's plate, or the plateless mine's pad. */
  readonly plates: SpriteLayer;
  /** Committed towers' heads — boosted ones with their glow — over the plates. */
  readonly heads: SpriteLayer;
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
  /** Where mines went off (`scorches.ts`): state the scene keeps across frames and resets
   *  with the run. Each frame feeds it its tracers, impacts and towers, then draws the
   *  scorches still fading. */
  readonly scorches: ScorchTracker;
  /** Where each tower's head points (`tower-aim.ts`), kept and reset the same way. Each frame
   *  feeds it its towers and where every creep is drawn, then turns the heads to it. */
  readonly aim: AimTracker;
  /** Which towers just fired (`tower-fire.ts`), kept and reset the same way. Each frame feeds
   *  it its tracers and towers, then knocks back and flashes or pulses the ones that did. */
  readonly fire: FireTracker;
}

/** The trackers a frame keeps across frames — what a reset must forget, every one of them. */
export interface BoardFrameTrackers {
  readonly scorches: Pick<ScorchTracker, 'reset'>;
  readonly aim: Pick<AimTracker, 'reset'>;
  readonly fire: Pick<FireTracker, 'reset'>;
}

/** Draw one frame into `t`. */
export function drawBoardFrame(t: BoardTargets, input: BoardFrameInput): void {
  const { prevVm, curVm, alpha, overlay, projection, frames } = input;
  const pal = resolvePalette(overlay.colourMode); // resolved once per frame, passed down
  const { shells, effects, cues } = t.layers;
  // ONE render-time derivation per frame, shared by the scorches, the tracers and the
  // telegraph pulse (CodeRabbit #73): the "one clock" invariant is structural, not calls
  // that happen to agree.
  const renderTimeTicks = renderTimeOf(prevVm, curVm, alpha);
  // board — the baked texture at the board's corner, snapped like every sprite.
  t.board.setPosition(
    snapToDevicePx(projection.originX, projection.dpr),
    snapToDevicePx(projection.originY, projection.dpr),
  );
  t.board.setVisible(true);
  shells.clear();
  effects.clear();
  cues.clear();
  // scorches — on the floor, under everything a tower draws. The tracker sees this frame's
  // tracers, impacts and towers before the scorches still fading are placed.
  input.scorches.update({
    tracers: overlay.tracers,
    sparks: overlay.sparks,
    towers: curVm.towers,
    renderTick: renderTimeTicks,
  });
  t.scorches.sync(placeScorches(input.scorches.live(renderTimeTicks), projection, frames));
  // shells — under every tower.
  drawAuraShells(shells, pal, curVm, overlay, projection);
  // Interpolated ONCE and shared: the creep placement below, the tracers' lerp targets and
  // the points the heads turn toward are the same points (#32/P6).
  const interpolated = interpolateCreeps(prevVm, curVm, alpha);
  const drawnAt = new Map(interpolated.map((c) => [c.id, { x: c.x, y: c.y }]));
  // The heads turn toward where their targets are drawn, and the towers whose shots just
  // appeared are noted — both before a head is placed.
  input.aim.update({
    towers: curVm.towers,
    creeps: drawnAt,
    renderTick: renderTimeTicks,
    reducedMotion: overlay.reducedMotion,
  });
  input.fire.update({
    tracers: overlay.tracers,
    towers: curVm.towers,
    renderTick: renderTimeTicks,
  });
  const poseOf = (tw: TowerVM) =>
    headPose(tw, input.aim, input.fire, overlay.reducedMotion, projection.cellPx);
  // plates, heads, pending — atlas sprites; each head turned and knocked back as posed.
  const towers = placeTowers(curVm, overlay, projection, frames, poseOf);
  t.plates.sync(towers.plates);
  t.heads.sync(towers.heads);
  t.pending.sync(towers.pending);
  // effects — the selection cue, then the shots' flashes and pulses, then tracers.
  drawSelection(effects, pal, overlay, projection);
  drawFireFeedback(
    effects,
    fireFeedbackPaintOps(
      visibleTowers(curVm.towers, overlay.pendingSells),
      input.aim,
      input.fire,
      overlay.reducedMotion,
      pal,
      projection,
    ),
  );
  drawTracers(effects, pal, overlay, renderTimeTicks, drawnAt, projection);
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

/** Hide and clear everything a frame drew (Play again), and forget what the run left — its
 *  scorches, where its heads pointed, the shots it fired: the next `drawBoardFrame` shows
 *  exactly what it draws, on a clean floor, with every head pointing up. */
export function resetBoardFrame(t: BoardTargets, state: BoardFrameTrackers): void {
  state.scorches.reset();
  state.aim.reset();
  state.fire.reset();
  t.layers.shells.clear();
  t.layers.effects.clear();
  t.layers.cues.clear();
  t.board.setVisible(false);
  t.scorches.hideAll();
  t.plates.hideAll();
  t.heads.hideAll();
  t.pending.hideAll();
  t.creeps.hideAll();
}

/** A tower's shot, shown (T3): a thin executor of `fireFeedbackPaintOps`' plan, whose content
 *  and reduced-motion gate are tested against the plan itself (`tower-fire.test.ts`) — a
 *  muzzle flash is a filled disc, a pulse ring a stroked circle. */
export function drawFireFeedback(g: GraphicsLike, ops: readonly FireFeedbackOp[]): void {
  for (const op of ops) {
    if (op.kind === 'flash') {
      g.fillStyle(op.colour, op.alpha);
      g.fillCircle(op.x, op.y, op.r);
    } else {
      g.lineStyle(op.width, op.colour, op.alpha);
      g.strokeCircle(op.x, op.y, op.r);
    }
  }
}

/**
 * In-flight tracers (#32/P6), a thin executor of `tracerPaintOps`' plan — the ordering and
 * content gate lives in `tracers.test.ts` against the plan itself. Each tracer lerps toward
 * its target creep's interpolated point (`drawnAt`, by creep id — the frame's one map of
 * them), and its dot is snapped to a whole device pixel the way the creep sprites are
 * (`placement.ts`), so a tracer that has arrived sits EXACTLY on the centre its target creep
 * is drawn at, not up to half a device pixel off it.
 */
export function drawTracers(
  g: GraphicsLike,
  pal: Palette,
  overlay: RenderOverlay,
  renderTimeTicks: number, // fractional TICKS — derived ONCE per frame (CodeRabbit #73)
  drawnAt: ReadonlyMap<number, { readonly x: number; readonly y: number }>,
  projection: Projection,
): void {
  if (overlay.tracers.length === 0) return;
  const positioned = positionTracers(overlay.tracers, drawnAt, renderTimeTicks);
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
    // wholly on `floor`; a committed small-blast tower's spokes start just clear of its
    // head and cross its plate (3.70:1, gated) and rim before they reach the floor. Same
    // condition, same motif, slightly different painted result — `board-draw.ts` carries
    // the geometry. They briefly diverged during M2-S9 (selection additionally required the
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
