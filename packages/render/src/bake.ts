// bake.ts — painting the board's static art into textures, once (V2, #181).
//
// ADR 0005's S10 finding measured where the frame time went: Phaser tessellating `Graphics`
// geometry on the CPU every frame, for art that almost never changes. So the board (floor,
// border ring, entrance, exit) is painted ONCE into its own texture, and every tower and
// creep silhouette is painted once into one atlas texture that pooled sprites show. Both
// are repainted only when what they depend on changes — the cell size, the effective dpr or
// the colour mode (`createBakeTracker`) — never per frame.
//
// Everything here is Phaser-free and unit-tested: `scene.ts` creates the textures and hands
// their 2D contexts in; these functions decide sizes and paint through `canvas-graphics.ts`.
//
// SCALE. Art is drawn in CSS px under `ctx.setTransform(scale, …)`, `scale` being the
// effective dpr — so one texel is one device pixel when the sprite is shown at 1/scale under
// the camera's dpr zoom. If a texture would exceed the renderer's maximum size, the scale is
// lowered until it fits (`fitScale`): the art comes out softer, never missing.

import { packShelves } from './atlas-pack';
import { atlasFrameSpecs, type FrameSpec } from './art-frames';
import { drawBoard, type BoardPaintOp } from './board-cells';
import { canvasGraphics, type Canvas2DLike } from './canvas-graphics';
import { artGraphics, type ArtCanvas2DLike, type PathFactory } from './art-paint';
import type { Palette } from './palette';
import type { ColourMode } from './types';

/** The widest an atlas is packed, in texels — well inside every WebGL implementation's
 *  limit (the spec's floor is 1024 per side for WebGL1, real devices 4096+), and wide
 *  enough that a phone-sized atlas is a handful of shelves. A renderer with a smaller
 *  maximum packs to that instead. */
export const ATLAS_MAX_WIDTH = 2048;

/** Transparent texels between and around atlas frames (`packShelves`). */
export const ATLAS_GUTTER_TEXELS = 2;

/** The lowest bake scale `fitScale` will go to — at a quarter texel per CSS px the art is
 *  already a blur, and a renderer that cannot fit even that is not one this board runs on. */
export const MIN_BAKE_SCALE = 0.25;

/** Each step down `fitScale` takes. */
const SCALE_STEP = 0.8;

/**
 * The bake scale for art that wants `dpr` texels per CSS px: `dpr` itself when `fits`
 * accepts it, else the first of `dpr × 0.8ⁿ` that does — never below `MIN_BAKE_SCALE`,
 * which is returned even if it still does not fit (degrade, never fail).
 */
export function fitScale(dpr: number, fits: (scale: number) => boolean): number {
  let scale = dpr > 0 ? dpr : 1;
  while (!fits(scale) && scale > MIN_BAKE_SCALE)
    scale = Math.max(MIN_BAKE_SCALE, scale * SCALE_STEP);
  return scale;
}

/** One frame of a laid-out atlas: its spec plus its texel rectangle. */
export interface AtlasFrame extends FrameSpec {
  readonly x: number;
  readonly y: number;
}

export interface AtlasLayout {
  /** Texels per CSS px the frames were sized at (the effective dpr unless degraded). */
  readonly scale: number;
  /** Texture size in texels. */
  readonly width: number;
  readonly height: number;
  readonly frames: ReadonlyMap<string, AtlasFrame>;
}

/** Size and place every atlas frame for `cellPx` at `dpr`, within `maxTextureSize`. */
export function layoutAtlas(cellPx: number, dpr: number, maxTextureSize: number): AtlasLayout {
  const maxWidth = Math.min(ATLAS_MAX_WIDTH, maxTextureSize);
  const packAt = (
    scale: number,
  ): { specs: FrameSpec[]; packed: ReturnType<typeof packShelves> } => {
    const specs = atlasFrameSpecs(cellPx, scale);
    return { specs, packed: packShelves(specs, maxWidth, ATLAS_GUTTER_TEXELS) };
  };
  const scale = fitScale(dpr, (s) => {
    const { packed } = packAt(s);
    return packed.width <= maxTextureSize && packed.height <= maxTextureSize;
  });
  const { specs, packed } = packAt(scale);
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const frames = new Map<string, AtlasFrame>();
  for (const rect of packed.rects) {
    const spec = byKey.get(rect.key) as FrameSpec;
    frames.set(rect.key, { ...spec, x: rect.x, y: rect.y });
  }
  return { scale, width: Math.max(1, packed.width), height: Math.max(1, packed.height), frames };
}

/** Paint every frame of `layout` into `ctx` (a fresh, transparent canvas of the layout's
 *  size). Each frame is clipped to its own rectangle so nothing it draws can land in a
 *  neighbour — which is also what scopes a frame's group fade (`ArtGraphics.fade`) to that
 *  frame — and drawn in frame-local CSS px scaled to texels. `makePath` turns the art's SVG
 *  path strings into `Path2D`s (`(d) => new Path2D(d)` in a browser). */
export function paintAtlas(
  ctx: ArtCanvas2DLike,
  layout: AtlasLayout,
  pal: Palette,
  makePath: PathFactory,
): void {
  for (const frame of layout.frames.values()) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.width, frame.height);
    ctx.clip();
    ctx.setTransform(layout.scale, 0, 0, layout.scale, frame.x, frame.y);
    const g = artGraphics(ctx, makePath);
    frame.paint(g, pal);
    g.flush();
    ctx.restore();
  }
}

/** The board texture's size and scale: the whole `cols × rows` board at `cellPx`, at `dpr`
 *  texels per CSS px unless that exceeds `maxTextureSize`. */
export interface BoardBake {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

export function layoutBoard(
  geometry: { readonly cols: number; readonly rows: number },
  cellPx: number,
  dpr: number,
  maxTextureSize: number,
): BoardBake {
  const size = (scale: number): [number, number] => [
    Math.max(1, Math.ceil(geometry.cols * cellPx * scale)),
    Math.max(1, Math.ceil(geometry.rows * cellPx * scale)),
  ];
  const scale = fitScale(dpr, (s) => {
    const [w, h] = size(s);
    return w <= maxTextureSize && h <= maxTextureSize;
  });
  const [width, height] = size(scale);
  return { scale, width, height };
}

/** Paint the board `plan` into `ctx` (a fresh canvas of `bake`'s size), board-local. */
export function paintBoard(
  ctx: Canvas2DLike,
  plan: readonly BoardPaintOp[],
  geometry: { readonly cols: number; readonly rows: number },
  cellPx: number,
  bake: BoardBake,
): void {
  ctx.setTransform(bake.scale, 0, 0, bake.scale, 0, 0);
  const g = canvasGraphics(ctx);
  drawBoard(g, plan, geometry, cellPx);
  g.flush();
}

/** What the baked art depends on. Board geometry is fixed for a mount, so it is not here. */
export interface BakeInputs {
  readonly cellPx: number;
  readonly dpr: number;
  readonly mode: ColourMode;
}

export interface BakeTracker {
  /** True when the art must be (re)baked for `inputs`: on the first call, and whenever the
   *  cell size, the effective dpr or the colour mode differs from the last bake's. Each
   *  `true` advances `version`, so a rebake can create its textures under fresh keys,
   *  repoint the sprites, and only then destroy the old ones. */
  needsBake(inputs: BakeInputs): boolean;
  /** Forget the last bake, so the next `needsBake` calls for another whatever its inputs. For
   *  a bake that could not complete — no canvas to paint into — which must be retried rather
   *  than leave the board on missing or stale art until the next resize. */
  invalidate(): void;
  /** How many bakes `needsBake` has called for so far. */
  readonly version: number;
}

export function createBakeTracker(): BakeTracker {
  let last: BakeInputs | null = null;
  let version = 0;
  return {
    needsBake(inputs) {
      if (
        last !== null &&
        last.cellPx === inputs.cellPx &&
        last.dpr === inputs.dpr &&
        last.mode === inputs.mode
      ) {
        return false;
      }
      last = { cellPx: inputs.cellPx, dpr: inputs.dpr, mode: inputs.mode };
      version += 1;
      return true;
    },
    invalidate() {
      last = null;
    },
    get version() {
      return version;
    },
  };
}

/** A versioned texture key, e.g. `wy-atlas-3`. */
export function bakedTextureKey(base: string, version: number): string {
  return `${base}-${version}`;
}
