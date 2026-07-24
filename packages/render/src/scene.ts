// scene.ts — the Phaser 3 board renderer (WebGL). This is the ONLY file that touches
// Phaser; it is deliberately a dumb consumer of the pure modules (projection,
// interpolate, palette) so no real logic hides in the WebGL layer. It is excluded from
// unit-coverage (not meaningfully testable under jsdom) and exercised by the Playwright
// e2e smoke instead. Draws board-space visuals only — the HUD and all controls are a
// DOM overlay owned by apps/web (ADR 0003 §3: canvas text isn't semantic/axe-visible).

import Phaser from 'phaser';
import { createProjection, type Projection } from './projection';
import { interpolateCreeps } from './interpolate';
import { resolvePalette, type Palette } from './palette';
import { boardPaintOps, type BoardPaintOp } from './board-cells';
import type { RenderVM, RenderOverlay, RenderHandle, ColourMode } from './types';

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

interface Spark {
  x: number;
  y: number;
  bornAt: number;
}

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
  let resizeObserver: ResizeObserver | null = null;
  let projection: Projection = createProjection({
    cols: geometry.cols,
    rows: geometry.rows,
    cssWidth: 0,
    cssHeight: 0,
    dpr: 1,
  });
  const syncProjection = (): void => {
    const rect = el.getBoundingClientRect();
    if (rect.width === projW && rect.height === projH) return;
    projW = rect.width;
    projH = rect.height;
    projection = createProjection({
      cols: geometry.cols,
      rows: geometry.rows,
      cssWidth: rect.width,
      cssHeight: rect.height,
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    });
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
  const preReady: { x: number; y: number }[] = [];

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: el,
    backgroundColor: '#12141c',
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
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

  const drawTowers = (
    g: Phaser.GameObjects.Graphics,
    pal: Palette,
    vm: RenderVM,
    o: RenderOverlay,
  ): void => {
    // A committed tower whose sell is pending (paused planning, #37+#27) is hidden
    // immediately — presented as already gone, not merely "about to sell".
    const pendingSellKeys =
      o.pendingSells.length === 0 ? null : new Set(o.pendingSells.map((p) => `${p.col},${p.row}`));
    for (const t of vm.towers) {
      if (pendingSellKeys !== null && pendingSellKeys.has(`${t.col},${t.row}`)) continue;
      const p = projection.cellToPixel(t.col, t.row);
      const size = projection.cellPx * 2; // 2×2 footprint
      g.fillStyle(pal.tower, 1);
      g.fillRoundedRect(p.x + 2, p.y + 2, size - 4, size - 4, 6);
    }
    // A queued-but-not-yet-committed build: a translucent OUTLINE (never a filled solid),
    // the dual shape+alpha cue distinguishing "pending" from a committed tower.
    for (const p of o.pendingAdds) {
      const pt = projection.cellToPixel(p.col, p.row);
      const size = projection.cellPx * 2;
      g.lineStyle(3, pal.tower, 0.6);
      g.strokeRoundedRect(pt.x + 2, pt.y + 2, size - 4, size - 4, 6);
    }
    if (o.selection !== null) {
      const c = projection.cellToPixel(o.selection.col, o.selection.row);
      const cx = c.x + projection.cellPx; // centre of the 2×2
      const cy = c.y + projection.cellPx;
      g.lineStyle(2, pal.range, 0.9);
      g.strokeCircle(cx, cy, projection.fpLenToPixel(o.selection.rangeFp));
    }
  };

  const drawCreeps = (
    g: Phaser.GameObjects.Graphics,
    pal: Palette,
    prev: RenderVM | null,
    cur: RenderVM,
    alpha: number,
  ): void => {
    for (const c of interpolateCreeps(prev, cur, alpha)) {
      const p = projection.fpToPixel(c.x, c.y);
      const r = Math.max(3, projection.cellPx * 0.35);
      const hpColour = c.hpFrac < 0.34 ? pal.creepLowHp : pal.creep;
      g.fillStyle(hpColour, 1); // set once — used for both the silhouette and the pip
      // triangle silhouette — a shape cue distinct from the tower's square
      g.fillTriangle(p.x, p.y - r, p.x + r, p.y + r, p.x - r, p.y + r);
      // health pip: length AND colour encode HP (dual cue) — warning tint only when low.
      // hpFrac is already clamped to [0,1] by deriveViewModel (CreepVM invariant).
      g.fillRect(p.x - r, p.y - r - 4, r * 2 * c.hpFrac, 3);
    }
  };

  const drawGhost = (g: Phaser.GameObjects.Graphics, pal: Palette, o: RenderOverlay): void => {
    if (o.ghost === null) return;
    const p = projection.cellToPixel(o.ghost.col, o.ghost.row);
    const size = projection.cellPx * 2;
    if (o.ghost.valid) {
      g.lineStyle(3, pal.ghostValid, 1); // solid outline = valid
      g.strokeRoundedRect(p.x + 2, p.y + 2, size - 4, size - 4, 6);
      g.lineStyle(1, pal.range, 0.7);
      g.strokeCircle(
        p.x + projection.cellPx,
        p.y + projection.cellPx,
        projection.fpLenToPixel(o.ghost.rangeFp),
      );
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
      const k = 1 - age / life;
      g.fillStyle(pal.spark, o.reducedMotion ? 0.5 * k : k);
      g.fillCircle(p.x, p.y, Math.max(2, projection.cellPx * 0.3 * k));
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
      for (const pt of overlay.sparks) preReady.push({ x: pt.x, y: pt.y });
      return; // Phaser not READY yet — nothing to draw into
    }
    if (resizeObserver === null) syncProjection(); // fallback only when no ResizeObserver
    const bornAt = now();
    for (const pt of preReady) sparks.push({ x: pt.x, y: pt.y, bornAt }); // stamp held points
    preReady.length = 0;
    for (const pt of overlay.sparks) sparks.push({ x: pt.x, y: pt.y, bornAt });
    const pal = resolvePalette(overlay.colourMode); // resolve once per frame, pass down
    gfx.clear();
    drawBoard(gfx, overlay.colourMode);
    drawTowers(gfx, pal, curVm, overlay);
    drawCreeps(gfx, pal, prevVm, curVm, alpha);
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
      game.destroy(true);
    },
  };
}
