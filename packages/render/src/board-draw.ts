// board-draw.ts — the tower/creep draw-layer executors, extracted out of `scene.ts`'s
// `mount()` closure (M2-S5a QC round). `scene.ts` imports Phaser at module scope, which
// crashes even under jsdom (Phaser's device/canvas-feature detection runs at import
// time, per `CanvasFeatures.js`) — so `scene.ts` itself can never be imported by a plain
// Vitest test. These functions never actually needed Phaser: they only call a handful
// of drawing methods on the `Graphics` object handed to them, so `GraphicsLike` below
// captures exactly that surface structurally. `Phaser.GameObjects.Graphics` satisfies it
// for free (structural typing), so `scene.ts` passes its real Phaser Graphics through
// unchanged; `scene.test.ts` passes a plain recording fake instead — no Phaser import,
// no WebGL/canvas context, and the hexagon/droplet/poisoned-pip branches these functions
// own are no longer entirely unwitnessed (previously: `scene.ts` was coverage-excluded
// and Playwright + axe cannot see canvas cues, so deleting a branch here left every test
// green). No drawing behaviour changed — this is a pure relocation + a de-Phasered
// parameter type.

import { creepSilhouettePaintOp, slowTelegraphPaintOps, dotTelegraphPaintOps } from './creep-paint';
import { towerFootprintMarkFor } from './tower-paint';
import type { Projection } from './projection';
import type { Palette } from './palette';
import type { RenderVM, RenderOverlay } from './types';

/** The exact `Phaser.GameObjects.Graphics` surface `drawTowers`/`drawCreeps` (and their
 *  `drawCrosshair`/`drawDroplet` helpers) call — nothing more. A structural interface,
 *  never imported from `phaser`, so this module (and anything testing it) never triggers
 *  Phaser's import-time device detection. */
export interface GraphicsLike {
  fillStyle(color: number, alpha?: number): unknown;
  lineStyle(lineWidth: number, color: number, alpha?: number): unknown;
  fillRect(x: number, y: number, width: number, height: number): unknown;
  fillRoundedRect(x: number, y: number, width: number, height: number, radius?: number): unknown;
  strokeRoundedRect(x: number, y: number, width: number, height: number, radius?: number): unknown;
  fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): unknown;
  fillCircle(x: number, y: number, radius: number): unknown;
  strokeCircle(x: number, y: number, radius: number): unknown;
  fillPoints(points: readonly { x: number; y: number }[], closeShape?: boolean): unknown;
  lineBetween(x0: number, y0: number, x1: number, y1: number): unknown;
}

/** Four short spokes radiating from `(cx,cy)` out to `spoke`, with a gap at the centre
 *  (never touching it) — the `'crosshair'` footprint mark AND the ghost's blast-radius
 *  preview share this exact motif (drawn at different scales: the footprint mark at
 *  `size * 0.22`, the ghost preview at the full blast radius) so "area effect" reads as
 *  one consistent shape language, always distinct from the closed `'ringed'` circle and
 *  the smooth range ring (never colour alone — ADR 0003). */
export function drawCrosshair(g: GraphicsLike, cx: number, cy: number, spoke: number): void {
  const gap = spoke * 0.4;
  g.lineBetween(cx, cy - spoke, cx, cy - gap);
  g.lineBetween(cx, cy + gap, cx, cy + spoke);
  g.lineBetween(cx - spoke, cy, cx - gap, cy);
  g.lineBetween(cx + gap, cy, cx + spoke, cy);
}

/** A small teardrop outline at `(cx,cy)`: a circular bulb offset downward, plus two
 *  lines converging to a point above it — the `'droplet'` footprint mark (M2-S5a,
 *  `venom`), evoking "applies a lingering effect". Distinct in SHAPE from both the
 *  closed `'ringed'` circle and the radiating `'crosshair'` spokes (never colour alone
 *  — ADR 0003); `spoke` plays the same role as `drawCrosshair`'s (the mark's half-size). */
function drawDroplet(g: GraphicsLike, cx: number, cy: number, spoke: number): void {
  const bulbR = spoke * 0.55;
  const bulbCy = cy + spoke * 0.25;
  g.strokeCircle(cx, bulbCy, bulbR);
  g.lineBetween(cx - bulbR * 0.7, bulbCy - bulbR * 0.6, cx, cy - spoke);
  g.lineBetween(cx + bulbR * 0.7, bulbCy - bulbR * 0.6, cx, cy - spoke);
}

/** A thin executor over `vm.towers`/`overlay.pendingAdds`/`overlay.selection` — see the
 *  inline comments below for the per-mark rationale. `projection` is an explicit
 *  parameter (not a captured closure) so this is callable outside `mount()`. */
export function drawTowers(
  g: GraphicsLike,
  pal: Palette,
  vm: RenderVM,
  o: RenderOverlay,
  projection: Projection,
): void {
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
    // `slow`/`splash`/`venom` vs `basic` footprint mark (M2-S3, extended M2-S4a,
    // M2-S5a): all bodies share `pal.tower` — a palette decision (S3 mints no second
    // tower colour), with the per-tower distinction carried by SHAPE — an inner
    // concentric ring for `'ringed'` (slow), four short radiating spokes for
    // `'crosshair'` (splash — the same "area effect" motif the ghost's blast-radius
    // preview below draws at cell scale, per ADR 0003's redundant-encoding rule), a
    // small teardrop for `'droplet'` (venom), nothing extra for `'plain'` (basic). The
    // committed marks stroke `pal.floor` so they read against the solid `pal.tower`
    // fill; the pending branch below strokes `pal.tower` instead — its body is an
    // unfilled outline, so there is no fill to contrast against and the mark keeps the
    // pending cue's own colour + alpha (CodeRabbit #73: the two branches differ on
    // purpose).
    const mark = towerFootprintMarkFor(t.towerId);
    if (mark === 'ringed') {
      g.lineStyle(2, pal.floor, 1);
      g.strokeCircle(p.x + projection.cellPx, p.y + projection.cellPx, size * 0.22);
    } else if (mark === 'crosshair') {
      g.lineStyle(2, pal.floor, 1);
      drawCrosshair(g, p.x + projection.cellPx, p.y + projection.cellPx, size * 0.22);
    } else if (mark === 'droplet') {
      g.lineStyle(2, pal.floor, 1);
      drawDroplet(g, p.x + projection.cellPx, p.y + projection.cellPx, size * 0.22);
    }
  }
  // A queued-but-not-yet-committed build: a translucent OUTLINE (never a filled solid),
  // the dual shape+alpha cue distinguishing "pending" from a committed tower — carries
  // its own footprint mark too, so a slow tower queued while paused keeps its
  // shape-distinct identity (Codex R1-7).
  for (const p of o.pendingAdds) {
    const pt = projection.cellToPixel(p.col, p.row);
    const size = projection.cellPx * 2;
    g.lineStyle(3, pal.tower, 0.6);
    g.strokeRoundedRect(pt.x + 2, pt.y + 2, size - 4, size - 4, 6);
    const pendingMark = towerFootprintMarkFor(p.towerId);
    if (pendingMark === 'ringed') {
      g.lineStyle(1, pal.tower, 0.6);
      g.strokeCircle(pt.x + projection.cellPx, pt.y + projection.cellPx, size * 0.22);
    } else if (pendingMark === 'crosshair') {
      g.lineStyle(1, pal.tower, 0.6);
      drawCrosshair(g, pt.x + projection.cellPx, pt.y + projection.cellPx, size * 0.22);
    } else if (pendingMark === 'droplet') {
      g.lineStyle(1, pal.tower, 0.6);
      drawDroplet(g, pt.x + projection.cellPx, pt.y + projection.cellPx, size * 0.22);
    }
  }
  if (o.selection !== null) {
    const c = projection.cellToPixel(o.selection.col, o.selection.row);
    const cx = c.x + projection.cellPx; // centre of the 2×2
    const cy = c.y + projection.cellPx;
    g.lineStyle(2, pal.range, 0.9);
    g.strokeCircle(cx, cy, projection.fpLenToPixel(o.selection.rangeFp));
  }
}

/** A thin executor over the per-frame interpolated creep points — silhouette (shape
 *  keyed on `creepId`), HP pip, slowed telegraph, and DoT telegraph. `projection` is an
 *  explicit parameter for the same reason `drawTowers`' is. */
export function drawCreeps(
  g: GraphicsLike,
  pal: Palette,
  interpolated: readonly {
    x: number;
    y: number;
    hpFrac: number;
    creepId: string;
    slowed: boolean;
    poisoned: boolean;
  }[],
  reducedMotion: boolean,
  renderTimeMs: number, // MILLISECONDS — the unit lives in the name (QC r3), the tick→ms conversion happens at the call site
  projection: Projection,
): void {
  for (const c of interpolated) {
    const p = projection.fpToPixel(c.x, c.y);
    const r = Math.max(3, projection.cellPx * 0.35);
    const hpColour = c.hpFrac < 0.34 ? pal.creepLowHp : pal.creep;
    const op = creepSilhouettePaintOp(c.creepId, p.x, p.y, r, hpColour, c.hpFrac);
    g.fillStyle(op.colour, 1); // set once — used for both the silhouette and the pip
    // Silhouette keyed on `creepId`'s shape (M2-S3, extended M2-S4a, M2-S5a): `normal`
    // keeps the triangle (a shape cue distinct from the tower's rounded square);
    // `fast` draws a diamond; `swarm` draws a small square (fragile/numerous, distinct
    // from both at cell scale); `armored` draws a six-sided plated hexagon
    // (armoured/tanky, distinct from all three); an unknown id falls back to the
    // triangle (total).
    if (op.shape === 'diamond') {
      g.fillTriangle(op.x, op.y - r, op.x + r, op.y, op.x, op.y + r);
      g.fillTriangle(op.x, op.y - r, op.x - r, op.y, op.x, op.y + r);
    } else if (op.shape === 'square') {
      g.fillRect(op.x - r, op.y - r, r * 2, r * 2);
    } else if (op.shape === 'hexagon') {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 2; // apex up, like the other shapes
        pts.push({ x: op.x + r * Math.cos(angle), y: op.y + r * Math.sin(angle) });
      }
      g.fillPoints(pts, true);
    } else {
      g.fillTriangle(op.x, op.y - r, op.x + r, op.y + r, op.x - r, op.y + r);
    }
    // health pip: length AND colour encode HP (dual cue) — warning tint only when low.
    // hpFrac is already clamped to [0,1] by deriveViewModel (CreepVM invariant).
    g.fillRect(op.x - r, op.y - r - 4, r * 2 * op.hpFrac, 3);
    // Slowed telegraph (M2-S3): a shape cue (ring, opaque) ALWAYS accompanies a live
    // slow; the motion cue (pulse, radius driven by render time) yields to reduced
    // motion (WCAG 2.3.3 / GAG §2). Alphas live in the plan, not here.
    // BOTH telegraphs take the PROJECTED pixel centre `p`, never the raw `c` (Codex
    // review, PR #78). `CreepVM.x`/`y` are fixed-point sim units — 256 per cell, as the
    // silhouette's own `projection.fpToPixel(c.x, c.y)` above makes plain — so passing
    // `c` drew both cues around coordinates that are ~256× the pixel position, i.e. far
    // off-canvas. The slowed telegraph carried this from M2-S3 and has therefore never
    // actually rendered; M2-S5a reproduced it in the DoT telegraph. `scene.test.ts` now
    // pins that both plans receive the projected centre.
    for (const tel of slowTelegraphPaintOps(
      { ...p, slowed: c.slowed },
      r,
      reducedMotion,
      pal.slowed,
      renderTimeMs,
    )) {
      g.lineStyle(tel.kind === 'ring' ? 2 : 1, tel.colour, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
    // DoT ("poisoned") telegraph (M2-S5a, PLAN.md step 32 — an ESSENTIAL cue, not a
    // decorative one: HP pips show damage already TAKEN, a DoT record is
    // armor-bypassing damage already SCHEDULED, which no other surface reveals). Three
    // pips (opaque) ALWAYS accompany a live DoT record; the drift cue (radius/alpha
    // driven by render time) yields to reduced motion (WCAG 2.3.3 / GAG §2). Sits at
    // r×1.8 — deliberately OUTSIDE the slowed ring's r×1.4 above, so a creep carrying
    // BOTH statuses reads as two distinct concentric cues, never a muddle. No per-tick
    // live-region announcement accompanies this — see the rationale at
    // `dotTelegraphPaintOps` (per-tick chatter would flood a screen reader; the state,
    // not the tick, is what matters).
    for (const tel of dotTelegraphPaintOps(
      { ...p, poisoned: c.poisoned },
      r,
      reducedMotion,
      pal.poisoned,
      renderTimeMs,
    )) {
      g.fillStyle(tel.colour, tel.alpha);
      g.fillCircle(tel.x, tel.y, tel.r);
    }
  }
}
