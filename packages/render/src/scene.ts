// scene.ts — the Phaser 3 board renderer (WebGL). This is the ONLY file that touches
// Phaser; it is deliberately a dumb consumer of the pure modules (projection,
// interpolate, palette, bake, placement) so no real logic hides in the WebGL layer. It is
// excluded from unit-coverage (not meaningfully testable under jsdom) and exercised by the
// Playwright e2e smoke instead. Draws board-space visuals only — the HUD and all controls
// are a DOM overlay owned by apps/web (ADR 0003 §3: canvas text isn't semantic/axe-visible).
//
// STATIC ART IS BAKED, NOT RE-RECORDED (V2, #181). The board, every tower and every creep
// silhouette are painted once into textures (`bake.ts`) and shown by sprites: one board
// image, and pooled images over one atlas, placed each frame from pure placement lists
// (`placement.ts`). They are repainted only when the cell size, the effective dpr or the
// colour mode changes. Only what moves or comes and goes is still drawn live, into three
// `Graphics` — shells, effects, cues — and `layers.ts` fixes where each object sits in the
// draw order. ADR 0005's S10 finding is the reason: re-tessellating static `Graphics`
// geometry every frame was where the frame time went.

import Phaser from 'phaser';
import { MS_PER_TICK } from '@wynding/sim';
import { createProjection, type Projection } from './projection';
import { interpolateCreeps } from './interpolate';
import { resolvePalette, type Palette } from './palette';
import { boardPaintOps } from './board-cells';
import { createDprTracker, clampDpr } from './dpr-tracker';
import { renderTimeOf, positionTracers, tracerPaintOps } from './tracers';
import { drawAuraShells, drawCreepCues, drawCrosshair, drawSelection } from './board-draw';
import {
  bakedTextureKey,
  createBakeTracker,
  layoutAtlas,
  layoutBoard,
  paintAtlas,
  paintBoard,
  type AtlasLayout,
} from './bake';
import { placeCreeps, placeTowers, snapToDevicePx, type SpritePlacement } from './placement';
import { layerDepth } from './layers';
import type { RenderVM, RenderOverlay, RenderHandle, ColourMode, SparkPoint } from './types';

/** Board size in cells — the scene needs this to build its projection (RenderVM carries
 *  entities, not board dimensions). */
export interface BoardGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly entrance: { readonly col: number; readonly row: number };
  readonly exit: { readonly col: number; readonly row: number };
}

/** How long (ms) an impact-spark stays lit; damped further under reduced motion. */
const SPARK_MS = 180;

/** The texture-size limit assumed when the renderer cannot report one (Phaser's Canvas
 *  fallback): every browser canvas holds at least this. */
const FALLBACK_MAX_TEXTURE_SIZE = 4096;

interface Spark extends SparkPoint {
  readonly bornAt: number;
}

/** A baked texture's key and the canvas it was uploaded from. */
interface BakedTexture {
  readonly key: string;
  readonly canvas: HTMLCanvasElement;
}

/** Pooled atlas sprites for one layer. Images are never destroyed, only re-pointed and
 *  hidden, and sprite `i` is always the list's `i`th entry — created in index order at one
 *  depth, so Phaser's stable depth sort draws them in list order. */
interface SpritePool {
  readonly depth: number;
  readonly images: Phaser.GameObjects.Image[];
  /** The frame each image currently shows, so an unchanged frame is never re-set. */
  readonly frames: string[];
}

// The draw functions live in Phaser-free modules (`board-draw.ts`, `board-cells.ts`,
// `bake.ts`): `scene.ts` imports `Phaser` at module scope, so it can NEVER be imported by a
// plain Vitest test — Phaser's device/canvas-feature detection runs at import time and
// crashes even under jsdom. They draw through the structural `GraphicsLike`, which a real
// `Phaser.GameObjects.Graphics` satisfies for free.

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
  // effective-dpr, while pinning the canvas' CSS size to the rect and keeping every
  // existing draw coordinate in CSS px. The camera zooms by dpr about its TOP-LEFT origin
  // with no scroll, so CSS-px world (x, y) lands at device pixel (x × dpr, y × dpr)
  // EXACTLY. (Until V2 it zoomed about the viewport centre and re-centred with `centerOn`,
  // which lands world (0, 0) on device (0, 0) only when the backing store's width and
  // height are even: Phaser rounds the centre to a whole pixel, so an odd one shifted the
  // whole board by half a device pixel. Sprites snapped to whole device pixels need the
  // exact mapping, or every texel would straddle two pixels.) Effective dpr is clamped to
  // ≤2 (ADR 0005: fill cost scales dpr²).
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
    // inset:0 makes the container's own box authoritative; the canvas fills it exactly
    // without ever contributing to its size.
    game.canvas.style.position = 'absolute';
    game.canvas.style.inset = '0';
    game.canvas.style.width = `${cssWidth}px`;
    game.canvas.style.height = `${cssHeight}px`;
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
    if (cues !== null) applyBackingStoreSize(rect.width, rect.height, dpr);
  };

  const sparks: Spark[] = [];
  // Spark points that arrived before Phaser fired READY (game time not yet running).
  // They're held UNstamped and given a real bornAt on the first ready frame, so they
  // aren't lost (controller already drained them) nor stamped with a ~0 time that would
  // make them expire instantly.
  const preReady: SparkPoint[] = [];

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

  // The live layers (`layers.ts`): what moves or comes and goes, re-recorded every frame.
  let shells: Phaser.GameObjects.Graphics | null = null;
  let effects: Phaser.GameObjects.Graphics | null = null;
  let cues: Phaser.GameObjects.Graphics | null = null;
  game.events.once(Phaser.Core.Events.READY, () => {
    const scene = game.scene.scenes[0];
    if (scene === undefined) return;
    shells = scene.add.graphics().setDepth(layerDepth('shells'));
    effects = scene.add.graphics().setDepth(layerDepth('effects'));
    cues = scene.add.graphics().setDepth(layerDepth('cues'));
    syncProjection(); // seed the projection from the current (post-layout) size
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => syncProjection());
      resizeObserver.observe(el); // rebuild only on actual size changes — no per-frame reflow
    }
  });

  const now = (): number => game.getTime();

  // ---- The baked layers: the board image and the atlas sprite pools ----
  const bakeTracker = createBakeTracker();
  let boardImage: Phaser.GameObjects.Image | null = null;
  let atlas: AtlasLayout | null = null;
  /** The textures the current bake made, and the canvases they were uploaded from. */
  const baked: { board: BakedTexture | null; atlas: BakedTexture | null } = {
    board: null,
    atlas: null,
  };
  // A bake that cannot get a canvas warns once per failing streak, not once per frame.
  let bakeFailing = false;
  const towerPool: SpritePool = { depth: layerDepth('towers'), images: [], frames: [] };
  const pendingPool: SpritePool = { depth: layerDepth('pending'), images: [], frames: [] };
  const creepPool: SpritePool = { depth: layerDepth('creeps'), images: [], frames: [] };
  const pools = [towerPool, pendingPool, creepPool];

  const maxTextureSize = (): number => {
    const renderer = game.renderer;
    const max =
      renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer ? renderer.getMaxTextureSize() : NaN;
    return Number.isFinite(max) && max > 0 ? max : FALLBACK_MAX_TEXTURE_SIZE;
  };

  /** Give a canvas's backing store back NOW rather than whenever it is collected: iOS Safari
   *  counts a dropped canvas against its page-wide canvas-memory cap until GC, and a window
   *  being resized rebakes on every cell-size step. Only ever applied to a canvas no texture
   *  uses any more — a live one is what Phaser re-uploads from after a lost WebGL context. */
  const releaseCanvas = (canvas: HTMLCanvasElement): void => {
    canvas.width = 0;
    canvas.height = 0;
  };

  /** A blank canvas of `width × height` and its 2D context — or null when the browser will
   *  not give one. iOS Safari refuses a 2D context once that canvas-memory cap is reached, so
   *  this is a real path on a phone, not a typing formality. */
  const newCanvas = (
    width: number,
    height: number,
  ): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      releaseCanvas(canvas);
      return null;
    }
    return { canvas, ctx };
  };

  /** Paint the board and the atlas for the current projection and `mode`, under fresh
   *  versioned keys; repoint the board image and every pooled sprite; THEN destroy the
   *  previous textures — nothing is ever pointed at a texture that is gone. The textures are
   *  plain `Texture`s over the canvases, not `CanvasTexture`s: that class reads the whole
   *  canvas back into a retained `ImageData` on construction, a board-sized copy kept on the
   *  JS heap for nothing — these canvases are uploaded once and never read. */
  const rebake = (scene: Phaser.Scene, mode: ColourMode): void => {
    const pal = resolvePalette(mode);
    const maxTex = maxTextureSize();
    const version = bakeTracker.version;
    const cellPx = projection.cellPx;
    const board = layoutBoard(geometry, cellPx, projection.dpr, maxTex);
    const layout = layoutAtlas(cellPx, projection.dpr, maxTex);

    // Both canvases before any painting or upload, so a refusal wastes no work.
    const boardCanvas = newCanvas(board.width, board.height);
    const atlasCanvas = boardCanvas === null ? null : newCanvas(layout.width, layout.height);
    if (boardCanvas === null || atlasCanvas === null) {
      // Keep whatever art is showing and try again next frame: a canvas-memory refusal
      // clears once dropped canvases are collected, and waiting for the next resize could
      // leave a first bake's board blank for good.
      if (boardCanvas !== null) releaseCanvas(boardCanvas.canvas);
      bakeTracker.invalidate();
      if (!bakeFailing) console.warn('board art could not be baked (no 2D canvas); retrying');
      bakeFailing = true;
      return;
    }
    bakeFailing = false;
    paintBoard(boardCanvas.ctx, boardPaintOps(geometry, pal), geometry, cellPx, board);
    paintAtlas(atlasCanvas.ctx, layout, pal);

    // `addImage` accepts any canvas-image source at runtime (Phaser's TextureSource detects
    // a canvas and uploads it as one); its type names only HTMLImageElement. It returns null
    // only for a key already in use, which a fresh version never is.
    const nextBoardKey = bakedTextureKey('wy-board', version);
    const nextAtlasKey = bakedTextureKey('wy-atlas', version);
    scene.textures.addImage(nextBoardKey, boardCanvas.canvas as unknown as HTMLImageElement);
    const atlasTexture = scene.textures.addImage(
      nextAtlasKey,
      atlasCanvas.canvas as unknown as HTMLImageElement,
    ) as Phaser.Textures.Texture;
    for (const f of layout.frames.values()) atlasTexture.add(f.key, 0, f.x, f.y, f.width, f.height);

    if (boardImage === null) {
      boardImage = scene.add
        .image(0, 0, nextBoardKey)
        .setOrigin(0, 0)
        .setDepth(layerDepth('board'));
    } else {
      boardImage.setTexture(nextBoardKey);
    }
    boardImage.setScale(1 / board.scale);
    for (const pool of pools) {
      pool.images.forEach((image, i) =>
        image.setTexture(nextAtlasKey, pool.frames[i]).setScale(1 / layout.scale),
      );
    }
    for (const old of [baked.board, baked.atlas]) {
      if (old === null) continue;
      scene.textures.remove(old.key);
      releaseCanvas(old.canvas);
    }
    baked.board = { key: nextBoardKey, canvas: boardCanvas.canvas };
    baked.atlas = { key: nextAtlasKey, canvas: atlasCanvas.canvas };
    atlas = layout;
  };

  /** Show `placements` on `pool`'s sprites — sprite `i` gets placement `i` — creating
   *  sprites as the count grows and hiding the ones beyond it. */
  const syncPool = (
    scene: Phaser.Scene,
    pool: SpritePool,
    placements: readonly SpritePlacement[],
    key: string,
    scale: number,
  ): void => {
    placements.forEach((p, i) => {
      const image = pool.images[i];
      if (image === undefined) {
        pool.images.push(
          scene.add
            .image(p.x, p.y, key, p.frame)
            .setOrigin(0, 0)
            .setScale(1 / scale)
            .setDepth(pool.depth),
        );
        pool.frames.push(p.frame);
        return;
      }
      if (pool.frames[i] !== p.frame) {
        image.setFrame(p.frame);
        pool.frames[i] = p.frame;
      }
      image.setPosition(p.x, p.y);
      if (!image.visible) image.setVisible(true);
    });
    for (let i = placements.length; i < pool.images.length; i++) {
      const image = pool.images[i] as Phaser.GameObjects.Image;
      if (image.visible) image.setVisible(false);
    }
  };

  // A thin executor of `tracerPaintOps`' plan (#32/P6) — the ordering/content gate lives
  // in `tracers.test.ts` against the plan itself, not here.
  const drawTracers = (
    g: Phaser.GameObjects.Graphics,
    pal: Palette,
    overlay: RenderOverlay,
    renderTimeTicks: number, // fractional TICKS — derived ONCE per frame in `draw` (CodeRabbit #73); the unit lives in the name (QC r3)
    interpolatedById: ReadonlyMap<number, { x: number; y: number }>,
  ): void => {
    const positioned = positionTracers(overlay.tracers, interpolatedById, renderTimeTicks);
    for (const op of tracerPaintOps(positioned, overlay.reducedMotion, pal)) {
      const p = projection.fpToPixel(op.x, op.y); // op.x/y are fp-unit sim coordinates
      g.fillStyle(op.colour, 1);
      g.fillCircle(p.x, p.y, Math.max(2, projection.cellPx * 0.15));
    }
  };

  const drawGhost = (g: Phaser.GameObjects.Graphics, pal: Palette, o: RenderOverlay): void => {
    if (o.ghost === null) return;
    const p = projection.cellToPixel(o.ghost.col, o.ghost.row);
    const size = projection.cellPx * 2;
    if (o.ghost.valid) {
      g.lineStyle(3, pal.ghostValid, 1); // solid outline = valid
      g.strokeRoundedRect(p.x + 2, p.y + 2, size - 4, size - 4, 6);
      const cx = p.x + projection.cellPx;
      const cy = p.y + projection.cellPx;
      // M2-S8: a support tower (`beacon`) does not attack, so it previews no range ring —
      // this is the path
      // that bites FIRST, since arming a tower to place it is the first thing a player
      // does with it, and this call used to stroke unconditionally for every valid ghost.
      if (o.ghost.rangeFp !== null) {
        g.lineStyle(1, pal.range, 0.7);
        g.strokeCircle(cx, cy, projection.fpLenToPixel(o.ghost.rangeFp));
      }
      // Armed-splash blast-radius preview (M2-S4a step 14): a 12-bounty long-lob is an
      // informed purchase, matching the wave-preview philosophy. The ghost already draws
      // the range ring above — a SECOND plain circle at the same footprint would be
      // genuinely ambiguous (is the inner one the splash, a permanent aura, or the range?
      // — Codex R1-15), so this draws the same radiating-spoke motif the committed
      // `'crosshair'` footprint mark uses, at the full blast radius: shape-distinct from
      // the smooth range circle, never colour alone. Text carries the exact number
      // regardless (`panel.blastRadius`, Panel) — the ring itself stays decorative.
      // Gated on "has a blast at all" — the SAME condition the committed selection uses
      // (`board-draw.ts`), so arming a tower and selecting that same tower both show the
      // blast. The ghost's body is an OUTLINE rather than a fill, so its spokes sit
      // wholly on `floor`; a committed small-blast tower's inner spoke crosses its own
      // filled body and reads shorter. Same condition, same motif, slightly different
      // painted result — `board-draw.ts` carries the geometry. They briefly diverged during M2-S9 (selection additionally required the
      // blast to overreach the range ring, which only the mine does); Rob ruled for
      // consistency, 2026-08-07. Change both sites together or neither.
      if (o.ghost.blastRadiusFp !== null) {
        g.lineStyle(2, pal.range, 0.9);
        drawCrosshair(g, cx, cy, projection.fpLenToPixel(o.ghost.blastRadiusFp));
      }
    } else {
      g.lineStyle(3, pal.ghostInvalid, 1); // crossed-out = invalid (shape, not colour alone)
      g.strokeRect(p.x + 2, p.y + 2, size - 4, size - 4);
      g.lineBetween(p.x + 2, p.y + 2, p.x + size - 2, p.y + size - 2);
      g.lineBetween(p.x + size - 2, p.y + 2, p.x + 2, p.y + size - 2);
    }
  };

  const drawSparks = (g: Phaser.GameObjects.Graphics, pal: Palette, o: RenderOverlay): void => {
    const life = o.reducedMotion ? SPARK_MS * 0.4 : SPARK_MS;
    const t = now();
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      if (s === undefined) continue;
      const age = t - s.bornAt;
      if (age > life) {
        sparks.splice(i, 1);
        continue;
      }
      const p = projection.fpToPixel(s.x, s.y);
      const k = 1 - age / life; // 1 → 0 as the spark ages (both variants fade the same way)
      if (s.radiusFp === 0) {
        g.fillStyle(pal.spark, o.reducedMotion ? 0.5 * k : k);
        g.fillCircle(p.x, p.y, Math.max(2, projection.cellPx * 0.3 * k));
      } else {
        // Blast landing (M2-S4a step 13): an expanding-and-fading RING at the blast's
        // TRUE radius — grows outward from nothing to its real footprint as it fades.
        // Under reduced motion this is NOT the same posture as the targeted spark above
        // (QC round-1 #7 — a prior version wrongly claimed it was). Reduced motion cuts
        // `life` to 0.4× and alpha to 0.5× for BOTH cues. For the spark that is nearly
        // pure damping: it shrinks a fill inside a sub-cell radius, so the shorter window
        // does speed that shrink up (~2.5×), but over a distance small enough not to read
        // as motion. This ring instead SWEEPS OUTWARD across the blast's true, possibly
        // multi-tile radius — the same shortened `life` would COMPRESS that sweep,
        // making the ring travel FASTER over a LARGER area under "reduced" motion, an
        // ADR 0003 regression. So `grow` is clamped to its final value: the ring holds at
        // its full static radius and only fades. The honest summary is that `life`/alpha
        // damping is sufficient when the animated distance is sub-cell and insufficient
        // once it is not — which is why only this branch needs the clamp.
        const maxR = projection.fpLenToPixel(s.radiusFp);
        const grow = o.reducedMotion ? 1 : 1 - k; // 0 → 1 as the ring ages, opposite of the fade
        g.lineStyle(2, pal.spark, o.reducedMotion ? 0.5 * k : k);
        g.strokeCircle(p.x, p.y, Math.max(2, maxR * grow));
      }
    }
  };

  const draw = (
    prevVm: RenderVM | null,
    curVm: RenderVM,
    alpha: number,
    overlay: RenderOverlay,
  ): void => {
    // Consume drained spark points — the controller clears them on drain, so dropping them
    // here would lose those flashes permanently. Before READY, hold them unstamped.
    const scene = game.scene.scenes[0];
    if (shells === null || effects === null || cues === null || scene === undefined) {
      for (const pt of overlay.sparks) preReady.push({ x: pt.x, y: pt.y, radiusFp: pt.radiusFp });
      return; // Phaser not READY yet — nothing to draw into
    }
    if (resizeObserver === null) syncProjection(); // fallback only when no ResizeObserver
    const bornAt = now();
    for (const pt of preReady) sparks.push({ x: pt.x, y: pt.y, radiusFp: pt.radiusFp, bornAt }); // stamp held points
    preReady.length = 0;
    for (const pt of overlay.sparks)
      sparks.push({ x: pt.x, y: pt.y, radiusFp: pt.radiusFp, bornAt });
    // Rebake only when what the art depends on changed — cell size, effective dpr, colour
    // mode (`createBakeTracker`) — never per frame.
    if (
      bakeTracker.needsBake({
        cellPx: projection.cellPx,
        dpr: projection.dpr,
        mode: overlay.colourMode,
      })
    ) {
      rebake(scene, overlay.colourMode);
    }
    const atlasKey = baked.atlas?.key;
    // No bake has succeeded yet (`rebake` retries every frame until one does).
    if (atlas === null || atlasKey === undefined || boardImage === null) return;
    const pal = resolvePalette(overlay.colourMode); // resolve once per frame, pass down
    // Computed ONCE and shared: the creep pass places these points; the tracer pass
    // reuses the SAME interpolated points as its lerp targets (#32/P6) so a tracer
    // visibly converges on exactly where its target creep is drawn this frame.
    const interpolated = interpolateCreeps(prevVm, curVm, alpha);
    const interpolatedById = new Map(interpolated.map((c) => [c.id, { x: c.x, y: c.y }]));

    // board — the baked texture, at the board's corner.
    boardImage
      .setPosition(
        snapToDevicePx(projection.originX, projection.dpr),
        snapToDevicePx(projection.originY, projection.dpr),
      )
      .setVisible(true);
    shells.clear();
    effects.clear();
    cues.clear();
    // shells — under every tower body.
    drawAuraShells(shells, pal, curVm, overlay, projection);
    // towers, pending — atlas sprites.
    const towers = placeTowers(curVm, overlay, projection, atlas.frames);
    syncPool(scene, towerPool, towers.committed, atlasKey, atlas.scale);
    syncPool(scene, pendingPool, towers.pending, atlasKey, atlas.scale);
    // effects — the selection cue, then tracers.
    drawSelection(effects, pal, overlay, projection);
    // ONE render-time derivation per frame, shared by tracers and the telegraph pulse
    // (CodeRabbit #73) — the "one clock" invariant is structural, not two calls that
    // happen to agree.
    const renderTimeTicks = renderTimeOf(prevVm, curVm, alpha);
    drawTracers(effects, pal, overlay, renderTimeTicks, interpolatedById);
    // creeps — atlas sprites, in creep order.
    const creeps = placeCreeps(interpolated, pal, projection, atlas.frames);
    syncPool(scene, creepPool, creeps, atlasKey, atlas.scale);
    // cues — every pip and status cue over every silhouette, then the ghost, then sparks.
    // CLOCK DOMAIN (QC round 2): `renderTimeOf` is in fractional TICKS (tracers.test.ts:
    // `renderTimeOf(vm(5), vm(6), 0.5) === 5.5`); the paint-plan's pulse period is
    // MILLISECONDS (`renderTimeMs`) — convert here, or the 900ms breath becomes a
    // 900-TICK (45s) one and the motion cue is imperceptible inside a 40-tick slow.
    drawCreepCues(cues, pal, creeps, overlay.reducedMotion, renderTimeTicks * MS_PER_TICK);
    drawGhost(cues, pal, overlay);
    drawSparks(cues, pal, overlay);
  };

  return {
    draw,
    reset(): void {
      sparks.length = 0;
      preReady.length = 0;
      shells?.clear();
      effects?.clear();
      cues?.clear();
      boardImage?.setVisible(false);
      for (const pool of pools) for (const image of pool.images) image.setVisible(false);
    },
    destroy(): void {
      sparks.length = 0;
      resizeObserver?.disconnect();
      dprTracker?.destroy();
      game.destroy(true);
    },
  };
}
