// scene.ts — the Phaser 3 board renderer (WebGL). This is the ONLY file that touches Phaser,
// and it decides nothing: it builds the Phaser objects and hands them, as structural
// interfaces, to the Phaser-free modules that do — `bake-runner.ts` (when and how the static
// art is baked, and what happens when that fails), `sprite-pool.ts` (which sprite shows what),
// `board-frame.ts` (everything drawn per frame, layer by layer) and `sparks.ts`. It is
// excluded from unit coverage (not meaningfully testable under jsdom) and exercised by the
// Playwright e2e suite instead. Draws board-space visuals only — the HUD and all controls are
// a DOM overlay owned by apps/web (ADR 0003 §3: canvas text isn't semantic/axe-visible).
//
// STATIC ART IS BAKED, NOT RE-RECORDED (V2, #181). The board, every tower and every creep
// silhouette are painted once into textures and shown by sprites: one board image, and pooled
// images over one atlas, placed each frame from pure placement lists (`placement.ts`). They
// are repainted only when the cell size, the effective dpr or the colour mode changes. Only
// what moves or comes and goes is still drawn live, into three `Graphics` — shells, effects,
// cues — and `layers.ts` fixes where each object sits in the draw order. ADR 0005's S10
// finding is the reason: re-tessellating static `Graphics` geometry every frame was where
// the frame time went.

import Phaser from 'phaser';
import { createProjection, type Projection } from './projection';
import { createDprTracker, clampDpr } from './dpr-tracker';
import { createBakeRunner, type BakedArt } from './bake-runner';
import { createSpritePool } from './sprite-pool';
import { createSparkStore } from './sparks';
import { drawBoardFrame, resetBoardFrame, type BoardTargets, type LiveLayers } from './board-frame';
import { layerDepth, type BoardLayer } from './layers';
import type { RenderVM, RenderOverlay, RenderHandle } from './types';

/** Board size in cells — the scene needs this to build its projection (RenderVM carries
 *  entities, not board dimensions). */
export interface BoardGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly entrance: { readonly col: number; readonly row: number };
  readonly exit: { readonly col: number; readonly row: number };
}

/** The texture-size limit assumed when the renderer cannot report one (Phaser's Canvas
 *  fallback): every browser canvas holds at least this. */
const FALLBACK_MAX_TEXTURE_SIZE = 4096;

// The drawing lives in Phaser-free modules (`board-frame.ts`, `board-draw.ts`, `bake.ts`, …):
// `scene.ts` imports `Phaser` at module scope, so it can NEVER be imported by a plain Vitest
// test — Phaser's device/canvas-feature detection runs at import time and crashes even under
// jsdom. They draw through structural interfaces (`GraphicsLike`, `LayerGraphics`, …) that a
// real `Phaser.GameObjects.Graphics` / `Image` satisfies for free.

/** Mount the Phaser board renderer into `el`. The returned handle is fed the last two
 *  render view-models + an alpha + the transient overlay each animation frame. */
export function mount(el: HTMLElement, geometry: BoardGeometry): RenderHandle {
  // The projection is rebuilt whenever the element's CSS size changes — checked every
  // frame in draw(), NOT only on a Phaser RESIZE event. An element that reaches its final
  // size purely by initial layout (no resize ever fires) would otherwise keep the stale
  // 0×0 → 1px-cell fallback captured at mount and render off-canvas. A ResizeObserver
  // syncs it on actual size changes (incl. the initial layout), so draw() does NOT read
  // the rect every frame — a per-frame getBoundingClientRect would force a synchronous
  // layout flush ~60×/s. Only when ResizeObserver is unavailable does draw() fall back to
  // a per-frame sync.
  let projW = -1;
  let projH = -1;
  let projDpr = -1;
  let resizeObserver: ResizeObserver | null = null;
  let projection: Projection = createProjection({
    cols: geometry.cols,
    rows: geometry.rows,
    cssWidth: 0,
    cssHeight: 0,
    dpr: 1,
  });

  // HiDPI backing store (#28/P5): size the game's actual pixel buffer to CSS-rect ×
  // effective-dpr while keeping every draw coordinate in CSS px. The camera zooms by dpr
  // about its TOP-LEFT origin with no scroll, so CSS-px world (x, y) lands at device pixel
  // (x × dpr, y × dpr) EXACTLY. (Until V2 it zoomed about the viewport centre and
  // re-centred with `centerOn`, which lands world (0, 0) on device (0, 0) only when the
  // backing store's width and height are even: Phaser rounds the centre to a whole pixel,
  // so an odd one shifted the whole board by half a device pixel. Sprites snapped to whole
  // device pixels need the exact mapping, or every texel would straddle two pixels.)
  // Effective dpr is clamped to ≤2 (ADR 0005: fill cost scales dpr²).
  //
  // The canvas's CSS box is the backing store ÷ dpr — whole device pixels — not the
  // element's rect. A fractional rect (934.40625 px, say) would have the compositor rescale
  // the whole canvas by rect × dpr ÷ round(rect × dpr) every frame, resampling every texel
  // the bake put on a device pixel. The two differ by under half a device pixel and share
  // their top-left corner (inset 0), so no board coordinate moves — nor the pointer mapping,
  // which projects the element's rect, exactly as this file's projection does.
  const applyBackingStoreSize = (cssWidth: number, cssHeight: number, dpr: number): void => {
    const scene = game.scene.scenes[0];
    if (scene === undefined) return;
    const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
    const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
    game.scale.resize(backingWidth, backingHeight);
    // Take the canvas out of normal flow: `el` (.wy-board) sizes itself from
    // `aspect-ratio`, which is only a PREFERRED size — a normal-flow canvas whose CSS
    // height we set can still make the container grow to fit it (any rounding
    // difference compounds every resize into a runaway feedback loop). Absolute +
    // inset:0 makes the container's own box authoritative; the canvas sits at its
    // top-left without ever contributing to its size.
    game.canvas.style.position = 'absolute';
    game.canvas.style.inset = '0';
    game.canvas.style.width = `${backingWidth / dpr}px`;
    game.canvas.style.height = `${backingHeight / dpr}px`;
    const cam = scene.cameras.main;
    cam.setOrigin(0, 0);
    cam.setZoom(dpr);
    cam.setScroll(0, 0);
  };

  // Live DPR-change tracking (monitor move / browser zoom, #28/P5): re-arms on every
  // sync to the CURRENT raw dpr (a resolution query only reports LEAVING its own
  // value, so a stale query goes silent after a 1→2→3 sequence). Destroyed with the
  // scene. See dpr-tracker.ts for the pure, independently-tested logic.
  const dprTracker =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? createDprTracker(
          () => syncProjection(),
          (q) => window.matchMedia(q),
        )
      : null;

  const syncProjection = (): void => {
    const rect = el.getBoundingClientRect();
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = clampDpr(rawDpr);
    dprTracker?.rearm(rawDpr); // always re-arm to the CURRENT raw value, even if unchanged
    if (rect.width === projW && rect.height === projH && dpr === projDpr) return;
    projW = rect.width;
    projH = rect.height;
    projDpr = dpr;
    projection = createProjection({
      cols: geometry.cols,
      rows: geometry.rows,
      cssWidth: rect.width,
      cssHeight: rect.height,
      dpr,
    });
    if (targets !== null) applyBackingStoreSize(rect.width, rect.height, dpr);
  };

  // Scale.NONE (not RESIZE, #28/P5): RESIZE auto-stretches the canvas' CSS AND backing
  //-store size to the parent on its own internal ResizeObserver, which would fight
  // `applyBackingStoreSize`'s explicit device-px backing store + pinned-CSS-size
  // recipe. Under NONE, `game.scale.resize()` and the canvas style are the only things
  // that ever touch the canvas' size — sizing is fully explicit.
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: el,
    backgroundColor: '#12141c',
    scale: { mode: Phaser.Scale.NONE, width: 1, height: 1 },
    render: { antialias: true },
    scene: { create() {}, update() {} },
  });
  const sceneOf = (): Phaser.Scene => game.scene.scenes[0] as Phaser.Scene;

  const sparks = createSparkStore();
  const now = (): number => game.getTime();

  // The art the sprites are showing this frame — what a sprite created mid-frame is given.
  let art: BakedArt | null = null;
  const spritePool = (layer: BoardLayer) =>
    createSpritePool<Phaser.GameObjects.Image>((p) => {
      const current = art as BakedArt; // pools are synced only once a bake has succeeded
      return sceneOf()
        .add.image(p.x, p.y, current.atlasKey, p.frame)
        .setOrigin(0, 0)
        .setScale(1 / current.atlas.scale)
        .setDepth(layerDepth(layer));
    });
  const pools = {
    towers: spritePool('towers'),
    pending: spritePool('pending'),
    creeps: spritePool('creeps'),
  };
  let boardImage: Phaser.GameObjects.Image | null = null;

  const maxTextureSize = (): number => {
    const renderer = game.renderer;
    const max =
      renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer ? renderer.getMaxTextureSize() : NaN;
    return Number.isFinite(max) && max > 0 ? max : FALLBACK_MAX_TEXTURE_SIZE;
  };

  const bakeRunner = createBakeRunner<HTMLCanvasElement>(geometry, {
    createCanvas(width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        canvas.width = 0;
        canvas.height = 0;
        return null;
      }
      return { canvas, ctx };
    },
    // Shrinking a canvas gives its backing store back NOW rather than at GC: iOS Safari
    // counts a dropped canvas against its page-wide canvas-memory cap until then, and a
    // window being resized rebakes on every cell-size step.
    releaseCanvas(canvas) {
      canvas.width = 0;
      canvas.height = 0;
    },
    // A plain `Texture` over the canvas, not a `CanvasTexture`: that class reads the whole
    // canvas back into a retained `ImageData` on construction, a board-sized copy kept on the
    // JS heap for nothing — these canvases are uploaded once and never read. `addImage`
    // accepts any canvas-image source at runtime (Phaser's TextureSource detects a canvas
    // and uploads it as one); its type names only HTMLImageElement.
    addTexture(key, canvas, frames) {
      const texture = game.textures.addImage(key, canvas as unknown as HTMLImageElement);
      if (texture === null) throw new Error(`texture key '${key}' is already in use`);
      for (const f of frames) texture.add(f.key, 0, f.x, f.y, f.width, f.height);
    },
    removeTexture(key) {
      if (game.textures.exists(key)) game.textures.remove(key);
    },
    show(next) {
      if (boardImage === null) {
        boardImage = sceneOf()
          .add.image(0, 0, next.boardKey)
          .setOrigin(0, 0)
          .setDepth(layerDepth('board'));
      } else {
        boardImage.setTexture(next.boardKey);
      }
      boardImage.setScale(1 / next.board.scale);
      for (const pool of [pools.towers, pools.pending, pools.creeps]) {
        pool.forEach((sprite, frame) =>
          sprite.setTexture(next.atlasKey, frame).setScale(1 / next.atlas.scale),
        );
      }
    },
    log: console,
  });

  // The live layers (`layers.ts`), created at READY.
  let targets: BoardTargets | null = null;
  game.events.once(Phaser.Core.Events.READY, () => {
    const scene = sceneOf();
    const layers: LiveLayers = {
      shells: scene.add.graphics().setDepth(layerDepth('shells')),
      effects: scene.add.graphics().setDepth(layerDepth('effects')),
      cues: scene.add.graphics().setDepth(layerDepth('cues')),
    };
    // The board image is made by the first successful bake (`show`); until then nothing is
    // drawn, so this stand-in is never touched.
    const board = {
      setPosition: (x: number, y: number) => boardImage?.setPosition(x, y),
      setVisible: (visible: boolean) => boardImage?.setVisible(visible),
    };
    targets = { board, layers, ...pools };
    syncProjection(); // seed the projection from the current (post-layout) size
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => syncProjection());
      resizeObserver.observe(el); // rebuild only on actual size changes — no per-frame reflow
    }
  });

  const draw = (
    prevVm: RenderVM | null,
    curVm: RenderVM,
    alpha: number,
    overlay: RenderOverlay,
  ): void => {
    // Spark points arrive drained — the controller clears them — so dropping them here would
    // lose those flashes for good. Before READY there is no game clock: hold them unstamped.
    if (targets === null) {
      sparks.hold(overlay.sparks);
      return; // Phaser not READY yet — nothing to draw into
    }
    if (resizeObserver === null) syncProjection(); // fallback only when no ResizeObserver
    sparks.intake(overlay.sparks, now(), overlay.reducedMotion);
    art = bakeRunner.ensure(
      { cellPx: projection.cellPx, dpr: projection.dpr, mode: overlay.colourMode },
      maxTextureSize(),
    );
    if (art === null) return; // no bake has succeeded yet — `ensure` retries next frame
    drawBoardFrame(targets, {
      prevVm,
      curVm,
      alpha,
      overlay,
      projection,
      frames: art.atlas.frames,
      sparks: sparks.live(now(), overlay.reducedMotion),
    });
  };

  return {
    draw,
    reset(): void {
      sparks.clear();
      if (targets !== null) resetBoardFrame(targets);
    },
    destroy(): void {
      sparks.clear();
      resizeObserver?.disconnect();
      dprTracker?.destroy();
      // Free the bake's canvases once Phaser has torn down, not before: its destroy runs at
      // its next step, and a Canvas-renderer fallback draws straight from them until then.
      game.events.once(Phaser.Core.Events.DESTROY, () => bakeRunner.destroy());
      game.destroy(true);
    },
  };
}
