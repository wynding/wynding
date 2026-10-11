// shots.ts — every shot in flight, drawn as its tower's own tracer (visual pass C2, #181).
// Pure and Phaser-free: `board-frame.ts` hands the sprites to the shots layer and draws the live
// strokes and dots into the effects layer, under them.
//
// WHERE a shot is comes from `positionTracers` alone — its one source of position — and this
// only decides how it looks there: a bolt, a glob, a shard or a streak turned to the shot's
// heading; a lob's ball up its arc over the ground point, its shadow on that point, a dashed
// path and a ring where it will land; a stun arc's fixed zigzag from the tower to the shot; and
// for a tower the table does not know, the dot every shot was before C2. A mine going off is no
// shot (`isDetonation`), and is left out. WHICH tower fired a shot is the fire tracker's answer
// (`FireTracker.towerIdOf`), so a shot keeps its style when its tower is sold mid-flight.
//
// A shot has arrived when it sits on its target's drawn point: the shot is placed there
// exactly, with no snap to the pixel grid, so an arrived bolt is centred on the body it struck,
// a flyer's lifted one included (`creepAimPoints`). Its sprites are resampled as they move, as
// every shot always was.
//
// REDUCE MOTION omits every shot — an empty plan — the posture the tracer dot always had: a
// shot is decoration, and the impact spark and the HP bar carry what it did.

import { shotFrameKeys, LOB_SHADOW_FRAME_KEY } from './art-frames';
import {
  effectArtColour,
  fxUnit,
  LOB_MAX_RISE_CELLS,
  LOB_RISE,
  LOB_TRAIL,
  SHOT_DOT,
  STUN_ARC,
} from './effect-art';
import type { Palette } from './palette';
import type { FrameAnchor, SpritePlacement } from './placement';
import type { Projection } from './projection';
import { isDetonation } from './scorches';
import type { PositionedTracer } from './tracers';
import type { TracerVM } from './types';

/** A live stroke: an open polyline through `points`, CSS px — every other segment of it, from
 *  the first, when `dashed`. */
export interface ShotStroke {
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly dashed: boolean;
  readonly width: number;
  readonly colour: number;
  readonly alpha: number;
}

/** A shot drawn as a dot: the look of a tower the shot table does not know. */
export interface ShotDot {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly colour: number;
}

/** One frame's shots. */
export interface ShotPlan {
  /** The shots layer's sprites: every lob's landing ring and shadow, on the ground, then every
   *  tracer over them. */
  readonly sprites: readonly SpritePlacement[];
  /** The effects layer's live strokes, under the sprites: each lob's dashed path, each stun
   *  arc's glow and then its core. */
  readonly strokes: readonly ShotStroke[];
  /** The effects layer's dots, after the strokes. */
  readonly dots: readonly ShotDot[];
}

const EMPTY: ShotPlan = { sprites: [], strokes: [], dots: [] };

/** How high a lob's ball is above its ground point at `frac` of a flight `lengthPx` long: a
 *  parabola, zero at either end, `LOB_RISE` of the length at its middle and never over
 *  `LOB_MAX_RISE_CELLS`. */
export function lobRise(frac: number, lengthPx: number, cellPx: number): number {
  const peak = Math.min(LOB_RISE * lengthPx, LOB_MAX_RISE_CELLS * cellPx);
  return 4 * peak * frac * (1 - frac);
}

/** The corners of a stun arc from `from` to `to`, CSS px: `STUN_ARC.segments` equal steps along
 *  the line, every corner between `offset` design units off it, to alternate sides — the first
 *  to the left of the heading. Fixed by the two ends alone, so the same arc is drawn every frame
 *  they hold still, and it never flickers. Null for an arc with no length. */
export function stunArcPoints(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  unit: number,
): { x: number; y: number }[] | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  // The left-hand normal of the heading (y grows downward).
  const nx = dy / len;
  const ny = -dx / len;
  const n = STUN_ARC.segments;
  const points = [{ x: from.x, y: from.y }];
  for (let i = 1; i < n; i++) {
    const off = (i % 2 === 1 ? 1 : -1) * STUN_ARC.offset * unit;
    points.push({ x: from.x + (dx * i) / n + nx * off, y: from.y + (dy * i) / n + ny * off });
  }
  points.push({ x: to.x, y: to.y });
  return points;
}

function centred(
  frames: ReadonlyMap<string, FrameAnchor>,
  key: string,
  x: number,
  y: number,
): SpritePlacement {
  const a = frames.get(key);
  if (a === undefined) throw new Error(`board atlas has no frame '${key}'`);
  return { frame: key, x: x - a.anchorX, y: y - a.anchorY };
}

/**
 * Every shot this frame, as `positioned` places them, each in the style of the tower that
 * fired it (`towerIdOf`; undefined for a shot whose tower is not known, which keeps the dot).
 * Positions are world CSS px, unsnapped; colours are each shot's tower's role colour in `pal`,
 * and its core mixed from it. Empty under Reduce motion.
 */
export function planShots(
  positioned: readonly PositionedTracer[],
  towerIdOf: (t: TracerVM) => string | undefined,
  reducedMotion: boolean,
  pal: Palette,
  projection: Projection,
  frames: ReadonlyMap<string, FrameAnchor>,
): ShotPlan {
  if (reducedMotion || positioned.length === 0) return EMPTY;
  const { cellPx } = projection;
  const unit = fxUnit(cellPx);
  const ground: SpritePlacement[] = [];
  const flying: SpritePlacement[] = [];
  const strokes: ShotStroke[] = [];
  const dots: ShotDot[] = [];
  for (const p of positioned) {
    // A mine has no shot: its scorch and its blast's ring show it going off.
    if (isDetonation(p.tracer)) continue;
    const keys = shotFrameKeys(towerIdOf(p.tracer));
    const { style, role } = keys.look;
    const at = projection.fpToPixel(p.x, p.y);
    if (style === 'dot') {
      dots.push({
        x: at.x,
        y: at.y,
        r: Math.max(SHOT_DOT.minPx, cellPx * SHOT_DOT.cells),
        colour: pal.tracer,
      });
      continue;
    }
    const from = projection.fpToPixel(p.fromX, p.fromY);
    const to = projection.fpToPixel(p.toX, p.toY);
    if (style === 'arc') {
      const points = stunArcPoints(from, at, unit);
      if (points === null) continue;
      strokes.push(
        {
          points,
          dashed: false,
          width: STUN_ARC.glowWidth * unit,
          colour: effectArtColour('role', pal, role),
          alpha: STUN_ARC.glowAlpha,
        },
        {
          points,
          dashed: false,
          width: STUN_ARC.coreWidth * unit,
          colour: effectArtColour('core', pal, role),
          alpha: 1,
        },
      );
      continue;
    }
    if (style === 'lob') {
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const path: { x: number; y: number }[] = [];
      const steps = LOB_TRAIL.dashes * 2;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        path.push({
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t - lobRise(t, length, cellPx),
        });
      }
      strokes.push({
        points: path,
        dashed: true,
        width: LOB_TRAIL.width * unit,
        colour: effectArtColour('role', pal, role),
        alpha: LOB_TRAIL.alpha,
      });
      ground.push(centred(frames, keys.landing as string, to.x, to.y));
      ground.push(centred(frames, LOB_SHADOW_FRAME_KEY, at.x, at.y));
      flying.push(
        centred(frames, keys.tracer as string, at.x, at.y - lobRise(p.frac, length, cellPx)),
      );
      continue;
    }
    // A tracer turned to its heading, about its head — where the shot is.
    const key = keys.tracer as string;
    const a = frames.get(key);
    if (a === undefined) throw new Error(`board atlas has no frame '${key}'`);
    flying.push({
      frame: key,
      x: at.x,
      y: at.y,
      originX: a.pivotX,
      originY: a.pivotY,
      rotation: Math.atan2(to.y - from.y, to.x - from.x),
    });
  }
  return {
    sprites: ground.length === 0 ? flying : [...ground, ...flying],
    strokes,
    dots,
  };
}
