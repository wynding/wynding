// failed-frame.ts — what a Phaser step that threw leaves half-done in the renderer, and the
// clean-up that clears it before the next frame (#181 UAT). Phaser-free: `scene.ts` hands it
// `game.renderer`, which is read through the structural shapes below.
//
// UNDER WEBGL, A BATCH. Phaser's render draws by batching: each image or shape adds quads to the
// vertex buffer of the pipeline that is current (`WebGLPipeline#vertexCount`, `#batch`), and only a
// flush draws them and empties it. A step that throws partway through the render never reaches
// that flush, and the next frame's `preRender` clears the canvas but not the batch, so the quads
// batched before the throw were drawn with the next frame's first flush (once, for a break that
// came once; piling up behind the stopped message, for one that kept coming). The rest of what a
// render can leave half-done, `preRender` resets itself: the bound framebuffer, the scissor stack
// and the mask stack (`WebGLRenderer#preRender`, Phaser 3.90.0).
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
//
// UNDER CANVAS (Phaser's fallback without WebGL), SAVED STATES. Nothing is batched: each object is
// drawn as it is reached. The renderer saves the game context's state at the end of `preRender`
// and restores it in `postRender`, saves a camera's context before `render` clips it and restores
// it at the end, and each object's canvas renderer saves and restores around its own drawing
// (`CanvasRenderer#preRender`, `#render`, `#postRender`, `#batchSprite`, 3.90.0). Between two steps
// that completed, nothing is saved. A throw skips the restores that would have matched its saves,
// so each failed step leaves a few states saved, and a clip in force at the throw outlasts it:
// `preRender` resets the transform, the alpha and the compositing, but only a restore lifts a
// clip. Phaser keeps stepping behind the stopped message, so a render that keeps failing would
// pile them up until the page went away.
//
// THE UNWIND. A 2D context cannot say how many states it has saved, but a restore with none saved
// does nothing (HTML, `CanvasRenderingContext2D#restore`). So `restore` is called
// `CANVAS_SAVE_UNWIND` times, more than any step nests, on the game context and on the context the
// render was drawing to when it threw (`CanvasRenderer#currentContext`: a camera's own, for one
// that renders to a texture). Each is left as a step that completed leaves it.

/** The part of a WebGL pipeline's batch that Phaser's `flush` resets after it draws. */
export interface BatchedPipeline {
  vertexCount: number;
  batch: unknown[];
  currentBatch: unknown;
  currentTexture: unknown;
  currentUnit: number;
}

/** The part of Phaser's renderer this reads under WebGL: its pipeline manager's registered
 *  pipelines (`PipelineManager#pipelines`, a `CustomMap` keyed by name). Absent under Canvas. */
export interface PipelineHolder {
  readonly pipelines?: {
    readonly pipelines?: {
      each(callback: (name: string, pipeline: BatchedPipeline) => void): void;
    };
  };
}

/** The part of a 2D context the unwind uses. */
export interface SavedStates {
  restore(): void;
}

/** The part of Phaser's renderer this reads under Canvas: the game canvas's context and the one
 *  being drawn to (`CanvasRenderer#gameContext`, `#currentContext`). Absent under WebGL. */
export interface ContextHolder {
  readonly gameContext?: SavedStates | null;
  readonly currentContext?: SavedStates | null;
}

/** Restores on each context: comfortably more than any step of Phaser's Canvas render nests,
 *  which is `preRender`'s save, the camera's, and an object's own two or three (one more with a
 *  mask). The ones beyond what is saved do nothing. */
export const CANVAS_SAVE_UNWIND = 16;

/** Drop every pipeline's pending batch without drawing it, as the end of a flush leaves it, so
 *  the next frame draws as it would after a normal flush. Does nothing for a renderer with no
 *  pipelines (Canvas). */
export function discardPendingBatch(renderer: PipelineHolder | null | undefined): void {
  renderer?.pipelines?.pipelines?.each((_name, pipeline) => {
    pipeline.vertexCount = 0;
    pipeline.batch.length = 0;
    pipeline.currentBatch = null;
    pipeline.currentTexture = null;
    pipeline.currentUnit = 0;
  });
}

/** Restore every state a failed step left saved on the game context and on the one it was drawing
 *  to, so each is left as a step that completed leaves it. Does nothing for a renderer with no 2D
 *  context (WebGL). */
export function unwindCanvasSaves(renderer: ContextHolder | null | undefined): void {
  for (const context of new Set([renderer?.gameContext, renderer?.currentContext])) {
    for (let i = 0; i < CANVAS_SAVE_UNWIND; i++) context?.restore();
  }
}

/** Clear what a failed step left half-done, under either renderer: each half finds nothing to do
 *  under the other. */
export function clearFailedFrame(
  renderer: (PipelineHolder & ContextHolder) | null | undefined,
): void {
  discardPendingBatch(renderer);
  unwindCanvasSaves(renderer);
}
