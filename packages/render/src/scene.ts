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
import { createScorchTracker } from './scorches';
import {
  createLiveLayers,
  createSpriteLayers,
  drawBoardFrame,
  forEachLayerSprite,
  resetBoardFrame,
  type BoardTargets,
} from './board-frame';
import {
  backingStoreSize,
  devicePixelReport,
  observesDevicePixels,
  type DevicePixelReport,
} from './device-px';
import { layerDepth } from './layers';
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
  // Set first thing in `destroy()`: Phaser only marks its game for destruction, and READY
  // still fires after, so a mount destroyed before READY must make no observer and arm no
  // dpr listener there.
  let destroyed = false;
  let projection: Projection = createProjection({
    cols: geometry.cols,
    rows: geometry.rows,
    cssWidth: 0,
    cssHeight: 0,
    dpr: 1,
  });

  // HiDPI backing store (#28/P5): size the game's actual pixel buffer to the device pixels
  // the element's CSS rect covers at the effective dpr (below), while keeping every draw
  // coordinate in CSS px. The camera zooms by dpr about its TOP-LEFT origin with no scroll,
  // so CSS-px world (x, y) lands at device pixel (x × dpr, y × dpr) of the canvas EXACTLY.
  // (Until V2 it zoomed about the viewport centre and re-centred with `centerOn`, which
  // lands world (0, 0) on device (0, 0) only when the backing store's width and height are
  // even: Phaser rounds the centre to a whole pixel, so an odd one shifted the whole board
  // by half a device pixel. Sprites snapped to whole device pixels need the exact mapping,
  // or every texel would straddle two pixels.)
  // Effective dpr is clamped to ≤2 (ADR 0005: fill cost scales dpr²).
  //
  // The canvas's CSS box stays the element's rect, as hidpi.spec.ts pins it, and its backing
  // store is exactly the device pixels the browser draws that box into. The browser snaps the
  // box to whole device pixels, and how many it covers depends on where the box sits, not
  // only on its size: at 525×320 the board sits at x = 52.5 with w = 328.5, so it covers 328
  // device pixels, where round(328.5 × dpr) is 329. A backing store of any other size is
  // scaled into the box, which smears every one-pixel line of the baked art across two at
  // about half its contrast: sized by round(rect × dpr), the plate rim measured as low as
  // 1.88:1 against its colour's 4.08:1 (#181). Matched, the canvas is shown pixel for pixel
  // wherever the browser lays the page out in device pixels — at a real device scale or a
  // browser zoom (plate-rim.spec.ts measures the first on screen); past the clamp (a raw dpr
  // over 2) it is scaled up by design. (Chromium's device-scale EMULATION, Playwright's
  // `deviceScaleFactor`, lays the page out in CSS px and scales its picture instead, so at
  // any scale but 1 — a whole one too — it resamples the canvas, whatever its size, wherever
  // the box is not on whole CSS px.) World (0, 0) lands on the device pixel the box's left
  // edge snaps to, at most half a pixel from its CSS position, as it did when the store was
  // scaled into the box.
  //
  // The count is the browser's own where it gives one: a `device-pixel-content-box` observer
  // on the canvas (Chromium, Firefox) reports it, and again whenever it changes — after a
  // move that changes it, too, which no size observer sees. Elsewhere (WebKit), past the
  // clamp, and under device-scale emulation (whose count is the screen's own pixels, not the
  // emulated ones: `backingStoreSize` sets a count off the page's own scale aside, and nothing else
  // — not the CSS size it was taken at), it is worked out from where the box
  // sits, re-read on every sync; there a move with no resize keeps the last count until the
  // next sync. The canvas is reallocated only when the count, the CSS size or the dpr
  // changes.
  let devicePixels: DevicePixelReport | null = null;
  let devicePixelObserver: ResizeObserver | null = null;
  let applied = { width: 0, height: 0, cssWidth: -1, cssHeight: -1, dpr: -1 };
  const applyBackingStoreSize = (
    cssWidth: number,
    cssHeight: number,
    dpr: number,
    rawDpr: number,
  ): void => {
    const scene = game.scene.scenes[0];
    if (scene === undefined) return;
    // Take the canvas out of normal flow: a normal-flow canvas whose CSS size we set can make
    // its container grow to fit it (any rounding difference compounding every resize into a
    // runaway feedback loop). Absolute + inset:0 makes the container's own box
    // authoritative; the canvas fills it exactly without ever contributing to its size.
    // (Phaser's `resize` leaves this CSS size alone: in Scale.NONE it writes the canvas's
    // style only after a Scale Manager zoom change, which this renderer never makes.)
    const canvas = game.canvas;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const box = canvas.getBoundingClientRect(); // where the canvas sits now
    const { width, height } = backingStoreSize(box, dpr, rawDpr, devicePixels);
    if (
      width === applied.width &&
      height === applied.height &&
      cssWidth === applied.cssWidth &&
      cssHeight === applied.cssHeight &&
      dpr === applied.dpr
    ) {
      return;
    }
    applied = { width, height, cssWidth, cssHeight, dpr };
    game.scale.resize(width, height);
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
    if (destroyed) return;
    const rect = el.getBoundingClientRect();
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = clampDpr(rawDpr);
    dprTracker?.rearm(rawDpr); // always re-arm to the CURRENT raw value, even if unchanged
    if (rect.width !== projW || rect.height !== projH || dpr !== projDpr) {
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
    }
    // On every sync, not only when the CSS size changes: the device pixels the box covers
    // depend on where it sits too (`applyBackingStoreSize`, which does nothing if they and
    // the size are unchanged).
    if (targets !== null) applyBackingStoreSize(rect.width, rect.height, dpr, rawDpr);
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
  // Where mines went off, fading (`scorches.ts`): fed by every frame, forgotten with the run.
  const scorches = createScorchTracker();
  const now = (): number => game.getTime();

  // The art the sprites are showing this frame — what a sprite created mid-frame is given.
  let art: BakedArt | null = null;
  // Each pool's sprites take their depth from the name the pool was made under.
  const pools = createSpriteLayers((layer) =>
    createSpritePool<Phaser.GameObjects.Image>((p) => {
      const current = art as BakedArt; // pools are synced only once a bake has succeeded
      return sceneOf()
        .add.image(p.x, p.y, current.atlasKey, p.frame)
        .setOrigin(0, 0)
        .setScale(1 / current.atlas.scale)
        .setDepth(layerDepth(layer)); // the pool gives it its placement's alpha
    }),
  );
  // The board image, made at READY: hidden, on Phaser's blank default texture, until a bake
  // succeeds — `show` only ever repoints it. Made up front rather than by the first `show`, so
  // a show that fails partway (the runner then removes that attempt's textures) can never
  // leave a VISIBLE image on a removed texture: nothing shows it before a bake has succeeded.
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
      boardImage?.setTexture(next.boardKey).setScale(1 / next.board.scale);
      forEachLayerSprite(pools, (sprite, frame) =>
        sprite.setTexture(next.atlasKey, frame).setScale(1 / next.atlas.scale),
      );
    },
    makePath: (d) => new Path2D(d),
    log: console,
  });

  // What a frame draws into — the board image, the live layers and the sprite pools, each at
  // its depth in `layers.ts` — complete at READY.
  let targets: BoardTargets | null = null;
  game.events.once(Phaser.Core.Events.READY, () => {
    if (destroyed) return;
    const scene = sceneOf();
    // Each live layer's depth comes from the name it was made under.
    const layers = createLiveLayers((layer) => scene.add.graphics().setDepth(layerDepth(layer)));
    const board = scene.add
      .image(0, 0, '__DEFAULT')
      .setOrigin(0, 0)
      .setDepth(layerDepth('board'))
      .setVisible(false);
    boardImage = board;
    targets = { board, layers, ...pools };
    syncProjection(); // seed the projection from the current (post-layout) size
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => syncProjection());
      resizeObserver.observe(el); // rebuild only on actual size changes — no per-frame reflow
      if (observesDevicePixels(window)) {
        // The browser's own count of the device pixels the canvas is drawn into, reported
        // again whenever it changes (`applyBackingStoreSize`).
        devicePixelObserver = new ResizeObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (entry === undefined) return;
          devicePixels = devicePixelReport(entry, window.devicePixelRatio || 1);
          syncProjection();
        });
        devicePixelObserver.observe(game.canvas, { box: 'device-pixel-content-box' });
      }
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
    if (art === null) return; // no bake has succeeded yet — `ensure` keeps trying (bake-runner.ts)
    drawBoardFrame(targets, {
      prevVm,
      curVm,
      alpha,
      overlay,
      projection,
      frames: art.atlas.frames,
      sparks: sparks.live(now(), overlay.reducedMotion),
      scorches,
    });
  };

  return {
    draw,
    reset(): void {
      sparks.clear();
      // (Before READY no frame has fed the scorch tracker, so there is nothing to forget.)
      if (targets !== null) resetBoardFrame(targets, { scorches });
    },
    destroy(): void {
      destroyed = true;
      sparks.clear();
      resizeObserver?.disconnect();
      devicePixelObserver?.disconnect();
      dprTracker?.destroy();
      // Free the bake's canvases once Phaser has torn down, not before: its destroy runs at
      // its next step, and a Canvas-renderer fallback draws straight from them until then.
      game.events.once(Phaser.Core.Events.DESTROY, () => bakeRunner.destroy());
      game.destroy(true);
    },
  };
}
