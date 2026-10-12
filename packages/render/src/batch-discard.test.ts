// batch-discard.test.ts — what a failed Phaser step leaves in the WebGL renderer's pipelines, and
// that `discardPendingBatch` clears exactly what `WebGLPipeline#flush` clears after it draws
// (Phaser 3.90.0), on every registered pipeline, and nothing else.

import { describe, it, expect } from 'vitest';
import { discardPendingBatch, type BatchedPipeline, type PipelineHolder } from './batch-discard';

/** A pipeline part-way through a frame: quads batched, none drawn. */
function holding(): BatchedPipeline & { activeTextures: unknown[]; vertexData: number[] } {
  return {
    vertexCount: 12,
    batch: [
      { start: 0, count: 6 },
      { start: 6, count: 6 },
    ],
    currentBatch: { start: 6, count: 6 },
    currentTexture: { webGLTexture: {} },
    currentUnit: 2,
    activeTextures: [{ webGLTexture: {} }],
    vertexData: [1, 2, 3],
  };
}

/** Phaser's `CustomMap#each`, over the pipelines registered by name. */
function renderer(...pipelines: BatchedPipeline[]): PipelineHolder {
  const map = new Map(pipelines.map((p, i) => [`pipeline${String(i)}`, p]));
  return {
    pipelines: {
      pipelines: {
        each: (callback) => {
          for (const [name, pipeline] of map) callback(name, pipeline);
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
    discardPendingBatch(renderer(p));
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
