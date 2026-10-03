// bake-runner.ts — running the bake (V2, #181): when to attempt one, what an attempt does,
// what happens when one fails, and who owns the canvases. Phaser-free: `scene.ts` hands in a
// `BakeHost` — canvas creation, texture registration, sprite repointing, a log — and every
// decision is made here, under unit test.
//
// AN ATTEMPT lays out the board and the atlas for the inputs, allocates BOTH canvases before
// painting anything (so a refusal wastes no work), paints and registers each in turn, points
// the board image and every sprite at the new textures (`host.show`), and only then removes
// the previous textures and frees their canvases. The tracker records the inputs only once
// all of that has succeeded (`createBakeTracker`).
//
// A FAILED ATTEMPT NEVER ESCAPES. An exception out of the renderer's `draw()` stops apps/web's
// frame scheduler, and the sim and the HUD freeze along with the board — so whatever an
// attempt made is undone (its textures removed, its canvases freed), the previous art stays
// on screen, and because nothing was recorded the next frame tries again. Two failures are
// expected in the field: a browser that refuses a 2D context (iOS Safari does once a page's
// canvas memory reaches its cap, which clears as dropped canvases are collected), and a
// paint or an upload that throws. Each is reported ONCE per failing streak — a warning for a
// refusal, an error naming the canvas and its size for a throw — and the first success after
// a streak says so.

import {
  bakedTextureKey,
  createBakeTracker,
  layoutAtlas,
  layoutBoard,
  paintAtlas,
  paintBoard,
  type AtlasLayout,
  type BakeInputs,
  type BoardBake,
} from './bake';
import { boardPaintOps, type BoardCellsGeometry } from './board-cells';
import type { Canvas2DLike } from './canvas-graphics';
import { resolvePalette } from './palette';

/** A blank canvas the host made, and its 2D context. */
export interface HostCanvas<C> {
  readonly canvas: C;
  readonly ctx: Canvas2DLike;
}

/** A named sub-rectangle of an atlas texture, in texels. */
export interface TextureFrameRect {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What one successful bake made: its texture keys, and the layouts the board image and the
 *  sprites are sized and placed by. */
export interface BakedArt {
  readonly boardKey: string;
  readonly atlasKey: string;
  readonly board: BoardBake;
  readonly atlas: AtlasLayout;
}

/** Where failures and recoveries are reported — `console` satisfies it. */
export interface BakeLog {
  warn(message: string): void;
  error(message: string, error: unknown): void;
  info(message: string): void;
}

/** Everything a bake needs from the renderer, structurally: `scene.ts` backs it with real
 *  canvases and Phaser's texture manager, the unit tests with recorders. */
export interface BakeHost<C> {
  /** A blank `width × height` canvas and its 2D context, or null when the browser refuses. */
  createCanvas(width: number, height: number): HostCanvas<C> | null;
  /** Give a canvas's memory back now. Only ever called on a canvas no texture uses. */
  releaseCanvas(canvas: C): void;
  /** Register `canvas` as texture `key`, with `frames` as its named sub-rectangles. May throw. */
  addTexture(key: string, canvas: C, frames: readonly TextureFrameRect[]): void;
  /** Destroy texture `key` — tolerating a key that was never (fully) added. */
  removeTexture(key: string): void;
  /** Point the board image and every sprite at `art`'s textures. */
  show(art: BakedArt): void;
  readonly log: BakeLog;
}

export interface BakeRunner {
  /**
   * The art to draw with this frame. Bakes first when `inputs` call for it; an attempt that
   * fails is undone and reported, and the PREVIOUS art is returned — null when no bake has
   * succeeded yet. Never throws.
   */
  ensure(inputs: BakeInputs, maxTextureSize: number): BakedArt | null;
  /** Free every canvas still held: the renderer is going away. */
  destroy(): void;
}

/** One bake's art and the canvases its textures were uploaded from. */
interface Bake<C> {
  readonly art: BakedArt;
  readonly canvases: readonly C[];
}

type CanvasName = 'board' | 'atlas';

export function createBakeRunner<C>(geometry: BoardCellsGeometry, host: BakeHost<C>): BakeRunner {
  const tracker = createBakeTracker();
  let live: Bake<C> | null = null;
  // Bakes whose textures could not be retired, because pointing the sprites away from them
  // failed partway: some sprite may still draw from them, so they stay until `destroy`.
  const kept: Bake<C>[] = [];
  let failedAttempts = 0;
  // What this failing streak has already reported, so each kind of failure is said once.
  const reported = new Set<string>();

  const reportOnce = (signature: string, report: () => void): void => {
    if (reported.has(signature)) return;
    reported.add(signature);
    report();
  };

  /** Make, paint and register both textures for `inputs` — or undo all of it and say why. */
  const attempt = (inputs: BakeInputs, maxTextureSize: number): Bake<C> | null => {
    const board = layoutBoard(geometry, inputs.cellPx, inputs.dpr, maxTextureSize);
    const atlas = layoutAtlas(inputs.cellPx, inputs.dpr, maxTextureSize);
    const version = tracker.nextVersion();
    const art: BakedArt = {
      boardKey: bakedTextureKey('wy-board', version),
      atlasKey: bakedTextureKey('wy-atlas', version),
      board,
      atlas,
    };
    const size: Record<CanvasName, string> = {
      board: `${board.width}×${board.height}`,
      atlas: `${atlas.width}×${atlas.height}`,
    };

    // Both canvases before any painting or upload, so a refusal wastes no work.
    const boardCanvas = host.createCanvas(board.width, board.height);
    const atlasCanvas = boardCanvas === null ? null : host.createCanvas(atlas.width, atlas.height);
    if (boardCanvas === null || atlasCanvas === null) {
      if (boardCanvas !== null) host.releaseCanvas(boardCanvas.canvas);
      const which: CanvasName = boardCanvas === null ? 'board' : 'atlas';
      reportOnce(`refused:${which}`, () =>
        host.log.warn(
          `board art: the browser refused a 2D context for the ${which} canvas (${size[which]}); ` +
            'keeping the previous art and retrying next frame',
        ),
      );
      return null;
    }

    const added: string[] = [];
    let stage: CanvasName = 'board';
    try {
      const pal = resolvePalette(inputs.mode);
      paintBoard(boardCanvas.ctx, boardPaintOps(geometry, pal), geometry, inputs.cellPx, board);
      added.push(art.boardKey); // before the call: a throw partway through may leave the key
      host.addTexture(art.boardKey, boardCanvas.canvas, []);
      stage = 'atlas';
      paintAtlas(atlasCanvas.ctx, atlas, pal);
      added.push(art.atlasKey);
      host.addTexture(
        art.atlasKey,
        atlasCanvas.canvas,
        [...atlas.frames.values()].map((f) => ({
          key: f.key,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        })),
      );
    } catch (error) {
      for (const key of added) host.removeTexture(key);
      host.releaseCanvas(boardCanvas.canvas);
      host.releaseCanvas(atlasCanvas.canvas);
      reportOnce(`threw:${stage}`, () =>
        host.log.error(
          `board art: baking the ${stage} canvas (${size[stage]}) failed; ` +
            'keeping the previous art and retrying next frame',
          error,
        ),
      );
      return null;
    }
    return { art, canvases: [boardCanvas.canvas, atlasCanvas.canvas] };
  };

  return {
    ensure(inputs, maxTextureSize) {
      if (!tracker.needsBake(inputs)) return live?.art ?? null;
      const next = attempt(inputs, maxTextureSize);
      if (next === null) {
        failedAttempts += 1;
        return live?.art ?? null;
      }
      const previous = live;
      live = next;
      tracker.recordBaked(inputs);
      try {
        host.show(next.art);
      } catch (error) {
        // Some sprites may already draw from the new textures and some still from the old,
        // so neither set can be destroyed: keep the old one until `destroy`. The new one is
        // recorded, so this is not retried.
        if (previous !== null) kept.push(previous);
        failedAttempts += 1;
        reportOnce('threw:show', () =>
          host.log.error(
            'board art: pointing the sprites at the new textures failed; keeping the previous ' +
              'textures alive',
            error,
          ),
        );
        return next.art;
      }
      if (previous !== null) {
        host.removeTexture(previous.art.boardKey);
        host.removeTexture(previous.art.atlasKey);
        for (const canvas of previous.canvases) host.releaseCanvas(canvas);
      }
      if (failedAttempts > 0) {
        host.log.info(
          `board art: baked after ${failedAttempts} failed attempt${failedAttempts === 1 ? '' : 's'}`,
        );
        failedAttempts = 0;
        reported.clear();
      }
      return next.art;
    },
    destroy() {
      for (const bake of live === null ? kept : [live, ...kept]) {
        for (const canvas of bake.canvases) host.releaseCanvas(canvas);
      }
      live = null;
      kept.length = 0;
    },
  };
}
