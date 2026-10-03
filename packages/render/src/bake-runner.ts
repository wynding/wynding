// bake-runner.ts — running the bake (V2, #181): when to attempt one, what an attempt does,
// what a failed one leaves behind, and who owns the canvases. Phaser-free: `scene.ts` hands in
// a `BakeHost` — canvas creation, texture registration, sprite repointing, a log — and every
// decision is made here, under unit test.
//
// AN ATTEMPT lays out the board and the atlas for the inputs, makes both canvases, paints
// both, uploads both as textures under fresh keys, and points the board image and every sprite
// at them (`host.show`). Only once the show has succeeded is the previous bake retired — its
// textures removed, its canvases freed — and the inputs recorded as baked.
//
// A FAILED ATTEMPT IS UNDONE, AND NOTHING THROWS. Any failure — a browser that refuses a 2D
// context (iOS Safari does once a page's canvas memory reaches its cap), or a throw while
// painting, uploading or showing — is reported first and then undone: a show that failed is
// pointed back at the previous bake, every texture key the attempt added is removed, both its
// canvases are freed, and its inputs are not recorded. Each cleanup step runs on its own and
// logs its own failure, so cleanup can neither hide the original error nor throw out of
// `ensure` — an exception out of the renderer's `draw()` stops apps/web's frame loop, and the
// sim and the HUD freeze with the board. The previous art stays on screen; before any bake has
// succeeded, the board stays blank.
//
// RETRY. A failed attempt is not repeated for `BAKE_RETRY_FRAMES` frames, about a second,
// unless the inputs change first — so a failure that recurs costs one attempt a second, not
// one a frame. Each distinct failure (its stage, its error, its canvas size) is reported once,
// saying what the board shows meanwhile: nothing, or the art baked for which cell size, dpr
// and colour mode. The failing streak closes — its reports and its count of failed attempts
// reset, and one line says so — when a bake succeeds, or when the inputs come back to those
// the visible art was baked for.

import {
  bakedTextureKey,
  createBakeTracker,
  layoutAtlas,
  layoutBoard,
  paintAtlas,
  paintBoard,
  sameInputs,
  type AtlasLayout,
  type BakeInputs,
  type BoardBake,
} from './bake';
import { boardPaintOps, type BoardCellsGeometry } from './board-cells';
import type { Canvas2DLike } from './canvas-graphics';
import { resolvePalette } from './palette';

/** Frames a failed attempt waits before the same inputs are tried again — about a second at
 *  60 Hz. Inputs that differ from the failed attempt's are tried at once. */
export const BAKE_RETRY_FRAMES = 60;

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
 *  canvases and Phaser's texture manager, the unit tests with recorders. Any of these may
 *  throw; the runner survives it. */
export interface BakeHost<C> {
  /** A blank `width × height` canvas and its 2D context, or null when the browser refuses. */
  createCanvas(width: number, height: number): HostCanvas<C> | null;
  /** Give a canvas's memory back now. Only ever called on a canvas no texture uses. */
  releaseCanvas(canvas: C): void;
  /** Register `canvas` as texture `key`, with `frames` as its named sub-rectangles. */
  addTexture(key: string, canvas: C, frames: readonly TextureFrameRect[]): void;
  /** Destroy texture `key` — tolerating a key that was never (fully) added. */
  removeTexture(key: string): void;
  /** Point the board image and every sprite at `art`'s textures. A throw may leave some
   *  pointed and some not; the runner then shows the previous art again. */
  show(art: BakedArt): void;
  readonly log: BakeLog;
}

export interface BakeRunner {
  /**
   * The art to draw with this frame: null until a bake has succeeded. Bakes first when the
   * inputs call for it and no failed attempt is waiting out its retry; an attempt that fails
   * is reported and undone, and the art already shown is returned. Never throws.
   */
  ensure(inputs: BakeInputs, maxTextureSize: number): BakedArt | null;
  /** Free the live bake's canvases: the renderer is going away. Every later `ensure` returns
   *  null and bakes nothing. */
  destroy(): void;
}

/** One bake's art and the canvases its textures were uploaded from. */
interface Bake<C> {
  readonly art: BakedArt;
  readonly canvases: readonly C[];
}

/** The steps of an attempt, in order — what a failure is reported against. */
type Stage =
  | 'board canvas'
  | 'atlas canvas'
  | 'board paint'
  | 'atlas paint'
  | 'board upload'
  | 'atlas upload'
  | 'show';

/** Each step's canvas (none for the show, which uses both), and how its failure reads. */
const STEPS: Readonly<
  Record<Stage, { readonly canvas: 'board' | 'atlas' | null; readonly act: string }>
> = {
  'board canvas': { canvas: 'board', act: 'making the board canvas' },
  'atlas canvas': { canvas: 'atlas', act: 'making the atlas canvas' },
  'board paint': { canvas: 'board', act: 'painting the board canvas' },
  'atlas paint': { canvas: 'atlas', act: 'painting the atlas canvas' },
  'board upload': { canvas: 'board', act: 'uploading the board canvas as a texture' },
  'atlas upload': { canvas: 'atlas', act: 'uploading the atlas canvas as a texture' },
  show: { canvas: null, act: 'pointing the board and its sprites at the new textures' },
};

/** Why an attempt failed: the step, and what it threw — or `refused`, when the browser would
 *  not give a canvas a 2D context and there is nothing thrown to pass on. */
type Failure =
  | { readonly stage: 'board canvas' | 'atlas canvas'; readonly refused: true }
  | { readonly stage: Stage; readonly refused: false; readonly error: unknown };

const describeInputs = (i: BakeInputs): string =>
  `cellPx ${i.cellPx}, dpr ${i.dpr}, colour mode ${i.mode}`;

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const countAttempts = (n: number): string => `${n} failed attempt${n === 1 ? '' : 's'}`;

export function createBakeRunner<C>(geometry: BoardCellsGeometry, host: BakeHost<C>): BakeRunner {
  const tracker = createBakeTracker();
  let live: Bake<C> | null = null;
  let destroyed = false;
  /** `ensure` calls so far: the retry clock. */
  let frame = 0;
  /** The inputs whose attempt last failed, and the first frame they may be tried again on. */
  let retry: { readonly inputs: BakeInputs; readonly fromFrame: number } | null = null;
  let failedAttempts = 0;
  /** The failures this streak has reported, by stage, error and canvas size. */
  const reported = new Set<string>();

  /** Log — and survive a log that throws, since there is nowhere left to report that. */
  const say = (log: () => void): void => {
    try {
      log();
    } catch {
      // The log itself failed; `ensure` must still not throw.
    }
  };

  /** One cleanup step, on its own: a failure is logged and the next step still runs. */
  const step = (what: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      say(() => host.log.error(`board art: ${what} failed`, error));
    }
  };

  /** What the board shows while a bake keeps failing. */
  const meanwhile = (): string => {
    const baked = tracker.baked();
    return live === null || baked === null
      ? 'the board is blank until a bake succeeds'
      : `the board shows the art baked for ${describeInputs(baked)} until a bake succeeds`;
  };

  /** Report a failed attempt for `inputs` — once per distinct failure this streak. */
  const report = (
    failure: Failure,
    inputs: BakeInputs,
    sizes: Record<'board' | 'atlas', string>,
  ): void => {
    const { canvas, act } = STEPS[failure.stage];
    const size = canvas === null ? `board ${sizes.board}, atlas ${sizes.atlas}` : sizes[canvas];
    const key = `${failure.stage}|${failure.refused ? 'refused' : describeError(failure.error)}|${size}`;
    if (reported.has(key)) return;
    reported.add(key);
    const what = failure.refused
      ? `the browser refused a 2D context for the ${failure.stage} (${size})`
      : `${act} (${size}) failed`;
    const message =
      `board art: ${what} while baking for ${describeInputs(inputs)}; ${meanwhile()}. ` +
      'Retrying in about a second, or as soon as the cell size, dpr or colour mode changes.';
    say(() => (failure.refused ? host.log.warn(message) : host.log.error(message, failure.error)));
  };

  /** Undo a failed attempt, each step on its own: a show that failed is pointed back at the
   *  previous bake, then every texture key the attempt added is removed and its canvases freed. */
  const undo = (failure: Failure, canvases: readonly C[], added: readonly string[]): void => {
    const previous = live;
    if (failure.stage === 'show' && previous !== null) {
      step('pointing the board and its sprites back at the previous art', () =>
        host.show(previous.art),
      );
    }
    for (const key of added) step(`removing the texture ${key}`, () => host.removeTexture(key));
    for (const canvas of canvases) step('freeing a canvas', () => host.releaseCanvas(canvas));
  };

  /** Remove a replaced bake's textures and free its canvases. */
  const retire = (bake: Bake<C>): void => {
    for (const key of [bake.art.boardKey, bake.art.atlasKey]) {
      step(`removing the texture ${key}`, () => host.removeTexture(key));
    }
    for (const canvas of bake.canvases) step('freeing a canvas', () => host.releaseCanvas(canvas));
  };

  /** Close a failing streak: one line says how it ended, and its reports and count reset. */
  const closeStreak = (message: string): void => {
    say(() => host.log.info(message));
    failedAttempts = 0;
    reported.clear();
    retry = null;
  };

  /** One attempt for `inputs`: the new bake, or null when it failed — reported, then undone. */
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
    const sizes = {
      board: `${board.width}×${board.height}`,
      atlas: `${atlas.width}×${atlas.height}`,
    };
    const canvases: C[] = [];
    const added: string[] = [];
    let stage: Stage = 'board canvas';

    const run = (): Bake<C> | Failure => {
      const boardCanvas = host.createCanvas(board.width, board.height);
      if (boardCanvas === null) return { stage: 'board canvas', refused: true };
      canvases.push(boardCanvas.canvas);
      stage = 'atlas canvas';
      const atlasCanvas = host.createCanvas(atlas.width, atlas.height);
      if (atlasCanvas === null) return { stage: 'atlas canvas', refused: true };
      canvases.push(atlasCanvas.canvas);
      // Both are painted before either is uploaded: a paint that throws leaves nothing to
      // remove from the renderer.
      const pal = resolvePalette(inputs.mode);
      stage = 'board paint';
      paintBoard(boardCanvas.ctx, boardPaintOps(geometry, pal), geometry, inputs.cellPx, board);
      stage = 'atlas paint';
      paintAtlas(atlasCanvas.ctx, atlas, pal);
      stage = 'board upload';
      added.push(art.boardKey); // before the call: a throw partway through may leave the key
      host.addTexture(art.boardKey, boardCanvas.canvas, []);
      stage = 'atlas upload';
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
      stage = 'show';
      host.show(art);
      return { art, canvases };
    };

    let outcome: Bake<C> | Failure;
    try {
      outcome = run();
    } catch (error) {
      outcome = { stage, refused: false, error };
    }
    if ('art' in outcome) return outcome;
    report(outcome, inputs, sizes); // first, so nothing the cleanup does can hide it
    undo(outcome, canvases, added);
    return null;
  };

  return {
    ensure(inputs, maxTextureSize) {
      if (destroyed) return null;
      frame += 1;
      if (live !== null && !tracker.needsBake(inputs)) {
        // The visible art is current. A streak still open was a rebake for other inputs,
        // and nothing needs it now.
        if (failedAttempts > 0) {
          closeStreak(
            `board art: back to the inputs the visible art was baked for ` +
              `(${describeInputs(inputs)}) after ${countAttempts(failedAttempts)} at other inputs`,
          );
        }
        return live.art;
      }
      if (retry !== null && sameInputs(retry.inputs, inputs) && frame < retry.fromFrame) {
        return live?.art ?? null; // waiting out the retry
      }
      const next = attempt(inputs, maxTextureSize);
      if (next === null) {
        failedAttempts += 1;
        retry = { inputs: { ...inputs }, fromFrame: frame + BAKE_RETRY_FRAMES };
        return live?.art ?? null;
      }
      const previous = live;
      live = next;
      tracker.recordBaked(inputs);
      if (previous !== null) retire(previous);
      if (failedAttempts > 0) {
        closeStreak(
          `board art: baked for ${describeInputs(inputs)} after ${countAttempts(failedAttempts)}`,
        );
      }
      return next.art;
    },
    destroy() {
      destroyed = true;
      const bake = live;
      live = null;
      if (bake !== null) {
        for (const canvas of bake.canvases)
          step('freeing a canvas', () => host.releaseCanvas(canvas));
      }
    },
  };
}
