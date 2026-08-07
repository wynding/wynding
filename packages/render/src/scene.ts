// scene.ts — the Phaser 3 board renderer (WebGL). This is the ONLY file that touches
// Phaser; it is deliberately a dumb consumer of the pure modules (projection,
// interpolate, palette) so no real logic hides in the WebGL layer. It is excluded from
// unit-coverage (not meaningfully testable under jsdom) and exercised by the Playwright
// e2e smoke instead. Draws board-space visuals only — the HUD and all controls are a
// DOM overlay owned by apps/web (ADR 0003 §3: canvas text isn't semantic/axe-visible).

import Phaser from 'phaser';
import { MS_PER_TICK } from '@wynding/sim';
import { createProjection, type Projection } from './projection';
import { interpolateCreeps } from './interpolate';
import { resolvePalette, type Palette } from './palette';
import { boardPaintOps, type BoardPaintOp } from './board-cells';
import { createDprTracker, clampDpr } from './dpr-tracker';
import { renderTimeOf, positionTracers, tracerPaintOps } from './tracers';
import { drawTowers, drawCreeps, drawCrosshair } from './board-draw';
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

interface Spark extends SparkPoint {
  readonly bornAt: number;
}

// `drawTowers`/`drawCreeps` (plus their `drawCrosshair`/`drawDroplet` helpers) now
// live in `./board-draw` (M2-S5a QC round): they never actually needed Phaser's real
// `Graphics` type (only a handful of drawing methods on it), and `scene.ts` importing
// `Phaser` at module scope means it can NEVER be imported by a plain Vitest test —
// Phaser's device/canvas-feature detection runs at import time and crashes even under
// jsdom. Moving them to a Phaser-free module (a structural `GraphicsLike` interface
// stands in for `Phaser.GameObjects.Graphics`, which satisfies it for free) is what
// makes `scene.test.ts` possible at all. No drawing behaviour changed.

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
  // existing draw coordinate in CSS px. Phaser cameras zoom around the viewport
  // CENTRE, so `setZoom(dpr)` alone would shift the world origin — `centerOn` after
  // zoom re-centres the CSS-px world midpoint back onto the viewport midpoint,
  // landing CSS-px world (0,0) back at device-pixel canvas (0,0). Effective dpr is
  // clamped to ≤2 (ADR 0005: fill cost scales dpr²).
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
    cam.setZoom(dpr);
    cam.centerOn(cssWidth / 2, cssHeight / 2);
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
    if (gfx !== null) applyBackingStoreSize(rect.width, rect.height, dpr);
  };
  // The board paint plan (#38) depends only on geometry (static) and the palette (changes
  // only on a colour-mode switch) — precompute once and rebuild ONLY when the mode
  // changes, so the steady-state per-frame draw stays allocation-free (ADR 0005).
  let paintPlan: readonly BoardPaintOp[] | null = null;
  let paintPlanMode: ColourMode | null = null;
  const boardPlanFor = (mode: ColourMode): readonly BoardPaintOp[] => {
    if (paintPlan === null || paintPlanMode !== mode) {
      paintPlan = boardPaintOps(geometry, resolvePalette(mode));
      paintPlanMode = mode;
    }
    return paintPlan;
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

  let gfx: Phaser.GameObjects.Graphics | null = null;
  game.events.once(Phaser.Core.Events.READY, () => {
    const scene = game.scene.scenes[0];
    if (scene === undefined) return;
    gfx = scene.add.graphics();
    syncProjection(); // seed the projection from the current (post-layout) size
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => syncProjection());
      resizeObserver.observe(el); // rebuild only on actual size changes — no per-frame reflow
    }
  });

  const now = (): number => game.getTime();

  // A thin executor of `boardPaintOps`' plan verbatim (#38) — the ordering/content gate
  // lives in `board-cells.test.ts` against the plan itself, not here (this file is
  // coverage-excluded). Do not reorder or special-case ops here; change the plan instead.
  const drawBoard = (g: Phaser.GameObjects.Graphics, mode: ColourMode): void => {
    for (const op of boardPlanFor(mode)) {
      switch (op.kind) {
        case 'floor': {
          g.fillStyle(op.colour, 1);
          const topLeft = projection.cellToPixel(0, 0);
          g.fillRect(
            topLeft.x,
            topLeft.y,
            geometry.cols * projection.cellPx,
            geometry.rows * projection.cellPx,
          );
          break;
        }
        case 'border': {
          g.fillStyle(op.colour, 1);
          for (const cell of op.cells) {
            const p = projection.cellToPixel(cell.col, cell.row);
            g.fillRect(p.x, p.y, projection.cellPx, projection.cellPx);
          }
          break;
        }
        case 'entrance': {
          g.fillStyle(op.colour, 1);
          const p = projection.cellToPixel(op.cell.col, op.cell.row);
          g.fillTriangle(
            p.x,
            p.y,
            p.x + projection.cellPx,
            p.y + projection.cellPx / 2,
            p.x,
            p.y + projection.cellPx,
          );
          break;
        }
        case 'exit': {
          g.fillStyle(op.colour, 1);
          const p = projection.cellToPixel(op.cell.col, op.cell.row);
          g.fillRect(
            p.x + projection.cellPx * 0.25,
            p.y + projection.cellPx * 0.25,
            projection.cellPx * 0.5,
            projection.cellPx * 0.5,
          );
          break;
        }
      }
    }
  };

  // `drawCrosshair`/`drawDroplet`/`drawTowers`/`drawCreeps` are now MODULE-LEVEL
  // functions (above `mount()`), taking `projection` as an explicit parameter instead
  // of a captured closure — see the comment at their definition for why (M2-S5a QC
  // round). The calls below pass this scope's `projection` local explicitly.

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
      // (`board-draw.ts`), so arming a tower and selecting that same tower show the same
      // thing. They briefly diverged during M2-S9 (selection additionally required the
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
    if (gfx === null) {
      for (const pt of overlay.sparks) preReady.push({ x: pt.x, y: pt.y, radiusFp: pt.radiusFp });
      return; // Phaser not READY yet — nothing to draw into
    }
    if (resizeObserver === null) syncProjection(); // fallback only when no ResizeObserver
    const bornAt = now();
    for (const pt of preReady) sparks.push({ x: pt.x, y: pt.y, radiusFp: pt.radiusFp, bornAt }); // stamp held points
    preReady.length = 0;
    for (const pt of overlay.sparks)
      sparks.push({ x: pt.x, y: pt.y, radiusFp: pt.radiusFp, bornAt });
    const pal = resolvePalette(overlay.colourMode); // resolve once per frame, pass down
    // Computed ONCE and shared: the creep pass draws these points; the tracer pass
    // reuses the SAME interpolated points as its lerp targets (#32/P6) so a tracer
    // visibly converges on exactly where its target creep is drawn this frame.
    const interpolated = interpolateCreeps(prevVm, curVm, alpha);
    const interpolatedById = new Map(interpolated.map((c) => [c.id, { x: c.x, y: c.y }]));
    gfx.clear();
    drawBoard(gfx, overlay.colourMode);
    drawTowers(gfx, pal, curVm, overlay, projection);
    // ONE render-time derivation per frame, shared by tracers and the telegraph pulse
    // (CodeRabbit #73) — the "one clock" invariant is structural, not two calls that
    // happen to agree.
    const renderTimeTicks = renderTimeOf(prevVm, curVm, alpha);
    drawTracers(gfx, pal, overlay, renderTimeTicks, interpolatedById);
    // CLOCK DOMAIN (QC round 2): `renderTimeOf` is in fractional TICKS (tracers.test.ts:
    // `renderTimeOf(vm(5), vm(6), 0.5) === 5.5`); the paint-plan's pulse period is
    // MILLISECONDS (`renderTimeMs`) — convert here, or the 900ms breath becomes a
    // 900-TICK (45s) one and the motion cue is imperceptible inside a 40-tick slow.
    drawCreeps(
      gfx,
      pal,
      interpolated,
      overlay.reducedMotion,
      renderTimeTicks * MS_PER_TICK,
      projection,
    );
    drawGhost(gfx, pal, overlay);
    drawSparks(gfx, pal, overlay);
  };

  return {
    draw,
    reset(): void {
      sparks.length = 0;
      preReady.length = 0;
      if (gfx !== null) gfx.clear();
    },
    destroy(): void {
      sparks.length = 0;
      resizeObserver?.disconnect();
      dprTracker?.destroy();
      game.destroy(true);
    },
  };
}
