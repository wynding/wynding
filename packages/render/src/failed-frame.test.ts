// failed-frame.test.ts — what a failed Phaser step leaves half-done in the renderer, and its
// clean-up: under WebGL, `discardPendingBatch` clears exactly what `WebGLPipeline#flush` clears
// after it draws (Phaser 3.90.0), on every registered pipeline, and nothing else; under Canvas,
// `unwindCanvasSaves` restores every state the failed step left saved.

import { describe, it, expect } from 'vitest';
import {
  clearFailedFrame,
  discardPendingBatch,
  unwindCanvasSaves,
  type BatchedPipeline,
  type PipelineHolder,
} from './failed-frame';

/** A pipeline part-way through a frame: quads batched, none drawn. */
function holding(): BatchedPipeline & {
  activeBuffer: unknown;
  activeTextures: unknown[];
  vertexData: number[];
} {
  return {
    vertexCount: 12,
    batch: [
      { start: 0, count: 6 },
      { start: 6, count: 6 },
    ],
    currentBatch: { start: 6, count: 6 },
    currentTexture: { webGLTexture: {} },
    currentUnit: 2,
    activeBuffer: { webGLBuffer: {} },
    activeTextures: [{ webGLTexture: {} }],
    vertexData: [1, 2, 3],
  };
}

/** Phaser's `CustomMap#each`, over the pipelines registered by name: it stops where a callback
 *  returns false (`structs/Map.js`, 3.90.0). */
function renderer(...pipelines: BatchedPipeline[]): PipelineHolder {
  const map = new Map(pipelines.map((p, i) => [`pipeline${String(i)}`, p]));
  return {
    pipelines: {
      pipelines: {
        each: (callback) => {
          for (const [name, pipeline] of map) {
            if ((callback(name, pipeline) as unknown) === false) break;
          }
        },
      },
    },
  };
}

describe('discardPendingBatch', () => {
  it('leaves every pipeline as the end of a flush does, drawing nothing', () => {
    const a = holding();
    const b = holding();
    const batch = a.batch;
    discardPendingBatch(renderer(a, b));
    for (const p of [a, b]) {
      expect(p.vertexCount).toBe(0);
      expect(p.batch).toEqual([]);
      expect(p.currentBatch).toBeNull();
      expect(p.currentTexture).toBeNull();
      expect(p.currentUnit).toBe(0);
    }
    expect(a.batch, 'emptied in place, as flush does').toBe(batch);
  });

  it('touches nothing else: the bound buffer, the active textures and the vertex data stay', () => {
    const p = holding();
    const buffer = p.activeBuffer;
    discardPendingBatch(renderer(p));
    expect(p.activeBuffer).toBe(buffer);
    expect(p.activeTextures).toHaveLength(1);
    expect(p.vertexData).toEqual([1, 2, 3]);
  });

  it('leaves a pipeline with nothing batched as it was', () => {
    const idle: BatchedPipeline = {
      vertexCount: 0,
      batch: [],
      currentBatch: null,
      currentTexture: null,
      currentUnit: 0,
    };
    discardPendingBatch(renderer(idle));
    expect(idle).toEqual({
      vertexCount: 0,
      batch: [],
      currentBatch: null,
      currentTexture: null,
      currentUnit: 0,
    });
  });

  it('does nothing for a renderer with no pipelines (Canvas), or none at all', () => {
    expect(() => discardPendingBatch({})).not.toThrow();
    expect(() => discardPendingBatch({ pipelines: {} })).not.toThrow();
    expect(() => discardPendingBatch(null)).not.toThrow();
    expect(() => discardPendingBatch(undefined)).not.toThrow();
  });
});

/** A 2D context's stack of saved states, as the HTML spec has it: `save` pushes the state,
 *  `restore` pops it back and does nothing with none saved. The state here is only whether a
 *  clip is in force. */
function context(): { saved: boolean[]; clipped: boolean; save(): void; restore(): void } {
  const ctx = {
    saved: [] as boolean[],
    clipped: false,
    save(): void {
      ctx.saved.push(ctx.clipped);
    },
    restore(): void {
      const top = ctx.saved.pop();
      if (top !== undefined) ctx.clipped = top;
    },
  };
  return ctx;
}

describe('unwindCanvasSaves', () => {
  it('restores every state a render that threw left saved, and lifts the clip it had in force', () => {
    // `preRender`'s save, `render`'s save and clip, then an image's own save: the throw comes
    // before any of their restores (`CanvasRenderer`, Phaser 3.90.0).
    const ctx = context();
    ctx.save();
    ctx.save();
    ctx.clipped = true;
    ctx.save();
    unwindCanvasSaves({ gameContext: ctx, currentContext: ctx });
    expect(ctx.saved).toEqual([]);
    expect(ctx.clipped).toBe(false);
  });

  it('restores the context a dynamic texture was being drawn to, as well as the game one', () => {
    // The game context's saves from `preRender` and `render`, then the texture's around its own
    // drawing, clipped (`DynamicTexture`, `CanvasRenderer#setContext`).
    const game = context();
    const texture = context();
    game.save();
    game.save();
    texture.save();
    texture.clipped = true;
    texture.save();
    unwindCanvasSaves({ gameContext: game, currentContext: texture });
    expect(game.saved).toEqual([]);
    expect(texture.saved).toEqual([]);
    expect(texture.clipped).toBe(false);
  });

  it('does nothing for a renderer with no 2D context (WebGL), or none at all', () => {
    expect(() => unwindCanvasSaves({})).not.toThrow();
    expect(() => unwindCanvasSaves({ gameContext: null, currentContext: null })).not.toThrow();
    expect(() => unwindCanvasSaves(null)).not.toThrow();
    expect(() => unwindCanvasSaves(undefined)).not.toThrow();
  });
});

describe('clearFailedFrame', () => {
  it('clears what either renderer was left with: the batch under WebGL, the saved states under Canvas', () => {
    const p = holding();
    clearFailedFrame(renderer(p));
    expect(p.vertexCount).toBe(0);
    const ctx = context();
    ctx.save();
    clearFailedFrame({ gameContext: ctx, currentContext: ctx });
    expect(ctx.saved).toEqual([]);
  });
});
