// board-frame.ts — one frame of the board, Phaser-free (V2, #181). Everything the renderer
// draws per frame is decided here: which live layer each cue goes into, which sprite shows
// which frame where, and in what order. `scene.ts` supplies the targets — the baked board
// image, three live `Graphics` and ten sprite pools, all as structural interfaces — and
// this fills them, so the routing that keeps every aura shell under every tower body (M2-S8)
// is a unit-tested fact rather than a property of call order in a coverage-excluded file.
//
// The layers composite in `layers.ts`'s order: board, scorches, shells, plates, heads, rims,
// pending, creep shadows, effects (selection, fire feedback, the shots' live parts), shots,
// creeps, flashes, cues (HP bars and status cues, then the ghost, then sparks, then kill
// bursts and the leak pulse), pops.
//
// State that lives across frames — where mines went off, where each head points, which towers
// just fired, which creeps flash and which kills and leaks are still showing — is kept in
// Phaser-free trackers the scene owns (`scorches.ts`, `tower-aim.ts`, `tower-fire.ts`,
// `combat-feedback.ts`), each fed once a frame, before anything it shapes is placed or drawn:
// the scorch tracker by the scene's `draw()`, before any early return, and the rest here.
// `resetBoardFrame` requires all four.
//
// ONE DRAWN POINT PER CREEP (visual pass C2, #181). A creep is drawn at its interpolated point,
// snapped to a whole device pixel, and a flyer's body lifted above it (`placeCreeps`). The heads
// aim at that body's centre and the shots land on it (`creepAimPoints`), so a head, its shot and
// the creep the player sees agree — a flyer's lifted body included.

import { MS_PER_TICK } from '@wynding/sim';
import {
  drawAuraShells,
  drawCreepCues,
  drawCrosshair,
  drawSelection,
  visibleTowers,
  type GraphicsLike,
} from './board-draw';
import { polygonCircles, type PathGraphics } from './circle-path';
import { fillCircleAsPolygon, strokeCircleAsPolygon, type PolygonGraphics } from './circle-polygon';
import {
  bountyPopPlacements,
  killBurstStrokes,
  leakPulseStrokes,
  type FeedbackStroke,
  type FeedbackTracker,
} from './combat-feedback';
import { snapToDevicePx } from './device-px';
import { interpolateCreeps } from './interpolate';
import { resolvePalette, type Palette } from './palette';
import {
  creepAimPoints,
  creepBodyCentre,
  placeCreeps,
  placeScorches,
  placeTowers,
  type FrameAnchor,
  type SpritePlacement,
} from './placement';
import type { Projection } from './projection';
import type { ScorchTracker } from './scorches';
import { planShots, type ShotPlan } from './shots';
import type { LiveSpark } from './sparks';
import type { AimTracker } from './tower-aim';
import {
  fireFeedbackPaintOps,
  headPose,
  type FireFeedbackOp,
  type FireTracker,
} from './tower-fire';
import { positionTracers, renderTimeOf } from './tracers';
import type { RenderOverlay, RenderVM, TowerVM } from './types';

/** A live layer: a `Graphics` that is cleared and re-recorded every frame. Wider than
 *  `GraphicsLike` by what only per-frame drawing uses — clearing, the outline rectangle and the
 *  closed polygon a small circle is stroked as (`circle-polygon.ts`) — kept off `GraphicsLike`
 *  itself, which the bake's Canvas2D adapter and the web app's swatch implement. */
export interface LayerGraphics extends GraphicsLike, PolygonGraphics {
  clear(): unknown;
  strokeRect(x: number, y: number, width: number, height: number): unknown;
}

/** The three live layers, each at its depth in `layers.ts`. */
export interface LiveLayers {
  /** Every support-aura shell — under every tower body. */
  readonly shells: LayerGraphics;
  /** The selection cue, then the shots' muzzle flashes and ring pulses, then the shots' live
   *  parts — over the heads and the pending builds, under the shots' sprites and the creeps. */
  readonly effects: LayerGraphics;
  /** Every creep's HP bar and status cues, then the build ghost, then impact sparks, then kill
   *  bursts and the exit's leak pulse — on top of every body. */
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

/** The three live layers as `createLiveLayers` makes them, with every layer's circles drawn as
 *  polygons sized to their radius at `dpr()`, read at each call (`circle-path.ts`): the live
 *  layers draw hundreds of circles a frame, and Phaser's own arc is 100 segments whatever its
 *  size (ADR 0005). Here, not in `scene.ts`, so a test can see that every layer has it. */
export function createPolygonLiveLayers<G extends LayerGraphics & PathGraphics>(
  make: (layer: LiveLayerName) => G,
  dpr: () => number,
): { readonly shells: G; readonly effects: G; readonly cues: G } {
  return createLiveLayers((layer) => polygonCircles(make(layer), dpr));
}

/** A sprite layer: shows a placement list (`sprite-pool.ts`). */
export interface SpriteLayer {
  sync(placements: readonly SpritePlacement[]): void;
  hideAll(): void;
}

/** A sprite layer's name — the one it is made under, and its depth is read from. */
export type SpriteLayerName =
  | 'scorches'
  | 'plates'
  | 'heads'
  | 'rims'
  | 'pending'
  | 'creepShadows'
  | 'shots'
  | 'creeps'
  | 'flashes'
  | 'pops';

/** One `S` per sprite layer. */
export type SpriteLayers<S> = { readonly [L in SpriteLayerName]: S };

/** The ten sprite layers, each made by `make` under its own name, as `createLiveLayers`. */
export function createSpriteLayers<S>(make: (layer: SpriteLayerName) => S): SpriteLayers<S> {
  return {
    scorches: make('scorches'),
    plates: make('plates'),
    heads: make('heads'),
    rims: make('rims'),
    pending: make('pending'),
    creepShadows: make('creepShadows'),
    shots: make('shots'),
    creeps: make('creeps'),
    flashes: make('flashes'),
    pops: make('pops'),
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
  /** The plate rim's straight runs, again, over each posed head (`TowerPlacements.rims`). */
  readonly rims: SpriteLayer;
  readonly pending: SpriteLayer;
  /** Every creep's ground shadow — under every creep's body. */
  readonly creepShadows: SpriteLayer;
  /** Every shot's tracer (C2): lobs' landing rings and shadows, then the tracers. */
  readonly shots: SpriteLayer;
  /** Every creep's body: those on the ground, then flyers over them. */
  readonly creeps: SpriteLayer;
  /** Each hit creep's flash (C1), over every body. */
  readonly flashes: SpriteLayer;
  /** Each kill's bounty pop (C1), over everything. */
  readonly pops: SpriteLayer;
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
  /** The board's exit cell, where a leak pulses (C1). */
  readonly exit: { readonly col: number; readonly row: number };
  /** The wall clock, ms — the clock the sparks fade on, and combat feedback's (C1). */
  readonly nowMs: number;
  /** The sparks still lit this frame (`SparkStore.live`). */
  readonly sparks: readonly LiveSpark[];
  /** Where mines went off (`scorches.ts`): state the scene keeps across frames and resets
   *  with the run. The scene feeds it every `draw()` — even one that returns before this
   *  frame is drawn — so a frame only reads the scorches still fading. */
  readonly scorches: ScorchTracker;
  /** Where each tower's head points (`tower-aim.ts`), kept and reset the same way. Each frame
   *  feeds it its towers, where every creep is drawn and the shots first seen, then turns the
   *  heads to it. */
  readonly aim: AimTracker;
  /** Which towers just fired, and which tower fired each shot (`tower-fire.ts`), kept and reset
   *  the same way. Each frame feeds it its tracers and towers — the shots it first sees go on to
   *  the aim tracker — then knocks back and flashes or pulses the towers that fired, and styles
   *  each shot as its tower's. */
  readonly fire: FireTracker;
  /** Which creeps flash, and which kills and leaks still show (`combat-feedback.ts`), kept and
   *  reset the same way. Each frame feeds it the shots, which creeps are drawn, and the kills
   *  and leaks since the last frame. */
  readonly feedback: FeedbackTracker;
}

/** The trackers a frame keeps across frames — what a reset must forget, every one of them. */
export interface BoardFrameTrackers {
  readonly scorches: Pick<ScorchTracker, 'reset'>;
  readonly aim: Pick<AimTracker, 'reset'>;
  readonly fire: Pick<FireTracker, 'reset'>;
  readonly feedback: Pick<FeedbackTracker, 'reset'>;
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
  // scorches — on the floor, under everything a tower draws. The scene has already fed the
  // tracker this frame's tracers and impacts (`scene.ts`).
  t.scorches.sync(placeScorches(input.scorches.live(renderTimeTicks), projection, frames));
  // shells — under every tower.
  drawAuraShells(shells, pal, curVm, overlay, projection);
  // Interpolated ONCE and shared by every creep sprite and, through where their bodies are
  // drawn, by the heads and the shots (#32/P6).
  const interpolated = interpolateCreeps(prevVm, curVm, alpha);
  // Combat feedback takes in the frame first — a hit that lands now flashes in this frame's
  // placement — reading only which creeps are drawn.
  const drawnIds = new Set<number>();
  for (const c of interpolated) drawnIds.add(c.id);
  const feedback = input.feedback;
  feedback.update({
    nowMs: input.nowMs,
    renderTick: renderTimeTicks,
    tracers: overlay.tracers,
    drawn: drawnIds,
    kills: overlay.kills,
    leaks: overlay.leaks,
  });
  const creeps = placeCreeps(interpolated, pal, projection, frames, (id) => feedback.flashOf(id));
  // Where each creep is DRAWN — its body's centre, a flyer's lifted one — in sim units: what the
  // heads turn toward and the shots land on.
  const drawnAt = creepAimPoints(creeps.bodies, projection);
  // The towers whose shots just appeared are noted, then the heads turn toward where their
  // targets are drawn, each that just fired onto its shot's bearing — before a head is placed.
  const shots = input.fire.update({
    tracers: overlay.tracers,
    towers: curVm.towers,
    creeps: drawnAt,
    renderTick: renderTimeTicks,
    reducedMotion: overlay.reducedMotion,
  });
  input.aim.update({
    towers: curVm.towers,
    creeps: drawnAt,
    renderTick: renderTimeTicks,
    reducedMotion: overlay.reducedMotion,
    shots,
  });
  const poseOf = (tw: TowerVM) =>
    headPose(tw, input.aim, input.fire, overlay.reducedMotion, projection.cellPx);
  // plates, heads, rims, pending — atlas sprites; each head turned and knocked back as posed,
  // and the rim painted again over each one that is.
  const towers = placeTowers(curVm, overlay, projection, frames, poseOf);
  t.plates.sync(towers.plates);
  t.heads.sync(towers.heads);
  t.rims.sync(towers.rims);
  t.pending.sync(towers.pending);
  // effects — the selection cue, then the shots' flashes and pulses, then the shots' live parts.
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
    projection.dpr,
  );
  const plan = planShots(
    overlay.reducedMotion ? [] : positionTracers(overlay.tracers, drawnAt, renderTimeTicks),
    (shot) => input.fire.towerIdOf(shot),
    overlay.reducedMotion,
    pal,
    projection,
    frames,
  );
  drawShots(effects, plan);
  // shots — every tracer, over the effects and under the creeps.
  t.shots.sync(plan.sprites);
  // creep shadows, creeps and their flashes — atlas sprites: every shadow, then every body over
  // them, then each hit creep's flash over its body.
  t.creepShadows.sync(creeps.shadows);
  t.creeps.sync(creeps.bodies);
  t.flashes.sync(creeps.flashes);
  // cues — every HP bar and status cue over every body, then the ghost, then sparks, then kill
  // bursts and the leak pulse.
  // CLOCK DOMAIN (QC round 2): `renderTimeOf` is in fractional TICKS (tracers.test.ts:
  // `renderTimeOf(vm(5), vm(6), 0.5) === 5.5`); the paint-plan's pulse period is
  // MILLISECONDS (`renderTimeMs`) — convert here, or the 900ms breath becomes a
  // 900-TICK (45s) one and the motion cue is imperceptible inside a 40-tick slow.
  drawCreepCues(cues, pal, creeps.bodies, overlay.reducedMotion, renderTimeTicks * MS_PER_TICK);
  drawGhost(cues, pal, overlay, projection);
  drawSparks(cues, pal, input.sparks, overlay.reducedMotion, projection, frames);
  // Kill bursts and pops, each on the body the creep was last drawn with; then the exit pulse.
  const pops: SpritePlacement[] = [];
  for (const { kill, sinceMs } of feedback.kills()) {
    const at = creepBodyCentre(kill.x, kill.y, kill, projection, frames);
    drawFeedbackStrokes(
      cues,
      killBurstStrokes(kill, at, sinceMs, overlay.reducedMotion, pal, projection.cellPx),
    );
    for (const p of bountyPopPlacements(
      kill.bounty,
      at,
      sinceMs,
      overlay.reducedMotion,
      projection.cellPx,
      projection.dpr,
      frames,
    )) {
      pops.push(p);
    }
  }
  const pulse = feedback.pulseSinceMs();
  if (pulse !== null) {
    const exit = projection.cellToPixel(input.exit.col, input.exit.row);
    const half = projection.cellPx / 2;
    drawFeedbackStrokes(
      cues,
      leakPulseStrokes(
        { x: exit.x + half, y: exit.y + half },
        pulse,
        overlay.reducedMotion,
        projection.cellPx,
      ),
    );
  }
  // pops — each kill's bounty, over everything.
  t.pops.sync(pops);
}

/** Hide and clear everything a frame drew (Play again), and forget what the run left — its
 *  scorches, where its heads pointed, the shots it fired, the flashes, bursts, pops and pulse
 *  still showing: the next `drawBoardFrame` shows exactly what it draws, on a clean floor, with
 *  every head pointing up. */
export function resetBoardFrame(t: BoardTargets, state: BoardFrameTrackers): void {
  state.scorches.reset();
  state.aim.reset();
  state.fire.reset();
  state.feedback.reset();
  t.layers.shells.clear();
  t.layers.effects.clear();
  t.layers.cues.clear();
  t.board.setVisible(false);
  t.scorches.hideAll();
  t.plates.hideAll();
  t.heads.hideAll();
  t.rims.hideAll();
  t.pending.hideAll();
  t.creepShadows.hideAll();
  t.shots.hideAll();
  t.creeps.hideAll();
  t.flashes.hideAll();
  t.pops.hideAll();
}

/** A tower's shot, shown (T3): a thin executor of `fireFeedbackPaintOps`' plan, whose content
 *  and reduced-motion gate are tested against the plan itself (`tower-fire.test.ts`) — a
 *  muzzle flash is a filled disc, a pulse ring a stroked circle, each drawn as a polygon with
 *  the sides the board's one rule gives it at `dpr` (`circle-polygon.ts`: Phaser would draw
 *  either as a 101-point arc). */
export function drawFireFeedback(
  g: Pick<LayerGraphics, 'fillStyle' | 'lineStyle' | 'fillPoints' | 'strokePoints'>,
  ops: readonly FireFeedbackOp[],
  dpr: number,
): void {
  for (const op of ops) {
    if (op.kind === 'flash') {
      g.fillStyle(op.colour, op.alpha);
      fillCircleAsPolygon(g, op.x, op.y, op.r, dpr);
    } else {
      g.lineStyle(op.width, op.colour, op.alpha);
      strokeCircleAsPolygon(g, op.x, op.y, op.r, dpr);
    }
  }
}

/** The shots' live parts (C2), a thin executor of `planShots`' plan, whose content and
 *  reduced-motion gate are tested against the plan itself (`shots.test.ts`): each stroke — a
 *  lob's dashed path as every other segment of it, a stun arc as an open polyline — then each
 *  unknown tower's dot. */
export function drawShots(
  g: Pick<LayerGraphics, 'fillStyle' | 'lineStyle' | 'strokePoints' | 'lineBetween' | 'fillCircle'>,
  plan: Pick<ShotPlan, 'strokes' | 'dots'>,
): void {
  for (const s of plan.strokes) {
    g.lineStyle(s.width, s.colour, s.alpha);
    if (!s.dashed) {
      g.strokePoints(s.points, false, false);
      continue;
    }
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      const a = s.points[i] as { x: number; y: number };
      const b = s.points[i + 1] as { x: number; y: number };
      g.lineBetween(a.x, a.y, b.x, b.y);
    }
  }
  for (const d of plan.dots) {
    g.fillStyle(d.colour, 1);
    g.fillCircle(d.x, d.y, d.r);
  }
}

/** Combat feedback's strokes (C1), a thin executor of `killBurstStrokes`' and
 *  `leakPulseStrokes`' plans (`combat-feedback.test.ts`): a ring as a stroked circle — a polygon
 *  on a live layer (`circle-path.ts`) — and a shard as a straight line. */
export function drawFeedbackStrokes(
  g: Pick<LayerGraphics, 'lineStyle' | 'strokeCircle' | 'lineBetween'>,
  strokes: readonly FeedbackStroke[],
): void {
  for (const s of strokes) {
    g.lineStyle(s.width, s.colour, s.alpha);
    if (s.kind === 'ring') g.strokeCircle(s.x, s.y, s.r);
    else g.lineBetween(s.x1, s.y1, s.x2, s.y2);
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

/** Impact sparks, each faded by its `k` (`sparks.ts`). A spark the controller marked as a
 *  flyer's (`SparkPoint.flyer`) is drawn on that flyer's body, lifted above the point the sim
 *  reports, as its body is (C2) — the frame's atlas places the lift. */
export function drawSparks(
  g: GraphicsLike,
  pal: Palette,
  sparks: readonly LiveSpark[],
  reducedMotion: boolean,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): void {
  for (const s of sparks) {
    const p =
      s.flyer === undefined
        ? projection.fpToPixel(s.x, s.y)
        : creepBodyCentre(
            s.x,
            s.y,
            { creepId: s.flyer.creepId, boss: s.flyer.boss, domain: 'air' },
            projection,
            frames,
          );
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
