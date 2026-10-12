// batch-discard.ts — what a Phaser step that threw leaves behind in the WebGL renderer, and the
// reset that clears it (#181 UAT). Phaser-free: `scene.ts` hands it `game.renderer`, which is
// read through the structural shapes below.
//
// THE LEFTOVER. Phaser's render draws by batching: each image or shape adds quads to the vertex
// buffer of the pipeline that is current (`WebGLPipeline#vertexCount`, `#batch`), and only a flush
// draws them and empties it. A step that throws partway through the render never reaches that
// flush, and the next frame's `preRender` clears the canvas but not the batch, so the quads
// batched before the throw were drawn with the next frame's first flush (once, for a break that
// came once; piling up behind the stopped message, for one that kept coming).
//
// THE RESET. Phaser 3.90.0 has no method that drops a batch without drawing it, so this does what
// `WebGLPipeline#flush` does after its draw calls (3.90.0, `WebGLPipeline.js`, `flush`, the
// statements after the draw loop):
//
//   this.vertexCount = 0;
//   this.batch.length = 0;
//   this.currentBatch = null;
//   this.currentTexture = null;
//   this.currentUnit = 0;
//
// `WebGLPipeline#restoreContext` resets the same five. Only the current pipeline holds vertices
// (`PipelineManager#set` flushes the one it replaces), but a throw can land between a pipeline
// being replaced and the next being bound, so every registered pipeline is reset: on one with
// nothing batched each statement leaves its value as it was. `flush` is a no-op for a pipeline
// with no vertices, so nothing else of its state (the bound buffer, `activeTextures`) is touched.

/** The part of a WebGL pipeline's batch that Phaser's `flush` resets after it draws. */
export interface BatchedPipeline {
  vertexCount: number;
  batch: unknown[];
  currentBatch: unknown;
  currentTexture: unknown;
  currentUnit: number;
}

/** The part of Phaser's renderer this reads: its pipeline manager's registered pipelines
 *  (`PipelineManager#pipelines`, a `CustomMap` keyed by name). Absent under the Canvas renderer. */
export interface PipelineHolder {
  readonly pipelines?: {
    readonly pipelines?: { each(callback: (name: string, pipeline: BatchedPipeline) => void): void };
  };
}

/** Drop every pipeline's pending batch without drawing it, as the end of a flush leaves it, so
 *  the next frame draws as it would after a normal flush. Does nothing for a renderer with no
 *  pipelines (Canvas has no batch: its mid-render state is `scene.ts`'s note). */
export function discardPendingBatch(renderer: PipelineHolder | null | undefined): void {
  renderer?.pipelines?.pipelines?.each((_name, pipeline) => {
    pipeline.vertexCount = 0;
    pipeline.batch.length = 0;
    pipeline.currentBatch = null;
    pipeline.currentTexture = null;
    pipeline.currentUnit = 0;
  });
}
