// board-draw.ts — the board's drawing vocabulary, Phaser-free. Extracted out of `scene.ts`'s
// `mount()` closure (M2-S5a QC round): `scene.ts` imports Phaser at module scope, which
// crashes even under jsdom (Phaser's device/canvas-feature detection runs at import time,
// per `CanvasFeatures.js`), so nothing in it can be unit-tested. Nothing here needs Phaser —
// every function draws through `GraphicsLike` below, a structural slice of
// `Phaser.GameObjects.Graphics` that a real Graphics satisfies for free and that
// `scene.test.ts` satisfies with a recording fake. That is what keeps the hexagon and
// poisoned-pip branches witnessed: `scene.ts` is coverage-excluded and Playwright + axe
// cannot see canvas cues.
//
// Two kinds of function live here since the visual pass's V2 (#181), which bakes static art
// into textures instead of re-recording it every frame:
//
//  - A STATIC-ART PAINTER (`paintCreepSilhouette`) runs at BAKE time only, into a
//    Canvas2D-backed `GraphicsLike` (`canvas-graphics.ts`), once per atlas frame
//    (`art-frames.ts`). Its geometry is the per-frame draw's, unchanged — the centre it is
//    handed is simply frame-local now. Towers are no longer drawn here: since the visual
//    pass they are vector art (`tower-art.ts`), painted by the art kit (`art-paint.ts`).
//  - PER-FRAME EXECUTORS (`drawAuraShells`, `drawSelection`, `drawCreepCues`) still draw into
//    a Phaser `Graphics` every frame: what moves, or comes and goes, stays live. Which layer
//    each one draws into is decided by `board-frame.ts` (and pinned by its test), and where
//    that layer sits is `layers.ts`'s business — neither is call order's.

import {
  slowTelegraphPaintOps,
  dotTelegraphPaintOps,
  stunTelegraphPaintOps,
  wardPaintOps,
  airborneCuePaintOps,
  type CreepSilhouettePaintOp,
} from './creep-paint';
import { snapToDevicePx } from './device-px';
import type { Projection } from './projection';
import type { Palette } from './palette';
import type { RenderVM, RenderOverlay, TowerVM } from './types';

/** The exact `Phaser.GameObjects.Graphics` surface this module's functions (and their
 *  `drawCrosshair` helper) call — nothing more. A structural interface,
 *  never imported from `phaser`, so this module (and anything testing it) never triggers
 *  Phaser's import-time device detection. `canvas-graphics.ts` implements it over a 2D
 *  context for the bake. */
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
 *  (never touching it) — the ghost's and the selection's blast-radius cue, the same motif
 *  the area-effect towers' heads carry in their glyph (`splash`'s spokes, `tower-art.ts`), so
 *  "area effect" reads as one consistent shape language, always distinct from the smooth
 *  range ring (never colour alone — ADR 0003). */
export function drawCrosshair(g: GraphicsLike, cx: number, cy: number, spoke: number): void {
  const gap = spoke * 0.4;
  g.lineBetween(cx, cy - spoke, cx, cy - gap);
  g.lineBetween(cx, cy + gap, cx, cy + spoke);
  g.lineBetween(cx - spoke, cy, cx - gap, cy);
  g.lineBetween(cx + gap, cy, cx + spoke, cy);
}

/** The alpha the support-aura shell strokes at — pinned here rather than inlined
 *  because `palette.test.ts` gates `aura` COMPOSITED at exactly this value, and a
 *  change at this one draw site must move the gate with it (the same discipline
 *  `RANGE_GHOST_PREVIEW_ALPHA` already carries for `range`). */
export const AURA_SHELL_ALPHA = 0.9;

/** The alpha the selection cue strokes at — its range ring, blast spokes and attackless
 *  outline. Pinned for the same reason as `AURA_SHELL_ALPHA`: `palette.test.ts` gates
 *  `range` composited at this value over the tower PLATE, the surface the outline's inner
 *  edge and the spokes lie on. */
export const SELECTION_ALPHA = 0.9;

/** The committed towers a frame presents: every one EXCEPT a tower whose sell is pending
 *  (paused planning, #37+#27) — hidden immediately, presented as already gone, not merely
 *  "about to sell". Both tower passes apply it independently — the aura shells below and
 *  the sprite placement in `placement.ts` — because hoisting one pass away from the other is
 *  exactly the kind of change that drops the guard on one side.
 *
 *  Free in the common case: with no sell queued the input array is returned as-is and
 *  nothing is allocated; only a frame with a queued sell builds the key set and a filtered
 *  copy. */
export function visibleTowers(
  towers: readonly TowerVM[],
  pendingSells: RenderOverlay['pendingSells'],
): readonly TowerVM[] {
  if (pendingSells.length === 0) return towers;
  const sold = new Set(pendingSells.map((p) => `${p.col},${p.row}`));
  return towers.filter((t) => !sold.has(`${t.col},${t.row}`));
}

/** Every support shell (M2-S8), one cell out from its beacon's footprint.
 *
 *  The shell is an OVER-APPROXIMATION of the region it marks, and the difference matters
 *  at exactly the case the rule turns on: the stamped aura is a plus-shaped ring of 8
 *  cells, because the four DIAGONAL corners are excluded (corner-only touch never buffs),
 *  while a rounded rect encloses all twelve cells of the surrounding block. A corner-only
 *  neighbour therefore sits partly inside a boundary that does not reach it. The
 *  authoritative signal is the boost glow on each recipient's head (`BOOST_ART`,
 *  `tower-art.ts`) — derived from the sim's own rule (`TowerVM.buffed`) and drawn only on
 *  towers genuinely being buffed; the shell is the coarser
 *  "roughly here" cue. Drawing the true plus outline instead would change the aura's
 *  approved visual shape, so it is a product decision rather than a refactor
 *  (docs/accessibility-checklist.md carries it as a recorded residual).
 *
 *  WHY SHELLS SIT UNDER EVERY BODY: the shell extends one cell out from its beacon, so its
 *  edge falls exactly on the boundary between an edge-adjacent recipient's two footprint
 *  columns — straight down the middle of the very tower it points at. Drawn inside the body
 *  loop, whether that segment was visible depended on SoA order: build the beacon first and
 *  the recipient's opaque fill paints over it, build it second and the shell stripes across
 *  the tower. Same board, two renderings. M2-S8 hoisted every shell into its own earlier
 *  pass; since V2 (#181) the guarantee is STRUCTURAL — this draws into the shells layer,
 *  which `layers.ts` puts below the tower sprites, so no call order can put a shell over a
 *  body. The result is order-independent and the shell never crosses a tower — its plate,
 *  rim or head — which keeps `pal.aura` off the plate rim (`pal.tower`, 2.23:1) and the
 *  light role-coloured heads, pairings it does not clear 3:1 against and which
 *  `palette.test.ts` therefore does not gate.
 *
 *  The footprint corner is snapped to a whole device pixel exactly as the tower sprite's is
 *  (`placement.ts`), so the shell stays concentric with its beacon at any dpr. */
export function drawAuraShells(
  g: GraphicsLike,
  pal: Palette,
  vm: RenderVM,
  o: RenderOverlay,
  projection: Projection,
): void {
  for (const t of visibleTowers(vm.towers, o.pendingSells)) {
    if (!t.support) continue;
    const raw = projection.cellToPixel(t.col, t.row);
    const p = {
      x: snapToDevicePx(raw.x, projection.dpr),
      y: snapToDevicePx(raw.y, projection.dpr),
    };
    const size = projection.cellPx * 2; // 2×2 footprint
    g.lineStyle(2, pal.aura, AURA_SHELL_ALPHA);
    g.strokeRoundedRect(
      p.x - projection.cellPx + 2,
      p.y - projection.cellPx + 2,
      size + projection.cellPx * 2 - 4,
      size + projection.cellPx * 2 - 4,
      6,
    );
  }
}

/** The selected tower's board-side cue: its range ring, its blast spokes, or — for an
 *  attackless tower — a footprint outline. Per-frame (selection comes and goes). */
export function drawSelection(
  g: GraphicsLike,
  pal: Palette,
  o: RenderOverlay,
  projection: Projection,
): void {
  if (o.selection === null) return;
  const raw = projection.cellToPixel(o.selection.col, o.selection.row);
  // Snapped exactly as the tower sprite's corner is (`placement.ts`), so the geometry
  // relations below hold at any dpr.
  const c = { x: snapToDevicePx(raw.x, projection.dpr), y: snapToDevicePx(raw.y, projection.dpr) };
  const cx = c.x + projection.cellPx; // centre of the 2×2
  const cy = c.y + projection.cellPx;
  // M2-S8: a support tower (`beacon`) does not attack, so it has no range and there is
  // no ring to draw —
  // but the ring is the ONLY board-side rendering of `selection`, so simply skipping it
  // left a selected beacon with no on-board cue whatsoever. Two beacons side by side
  // draw identically whether selected or not, and Sell would then remove a tower the
  // board never identified. It gets a footprint outline instead: same `pal.range`
  // colour and weight so it reads as the same "this is selected" channel, a different
  // SHAPE because the thing it marks is different (no radius to communicate). Drawn at
  // the body's own inset so it traces the tower rather than floating around it, and
  // never at radius 0 — a dot at the footprint centre would be a cue the player has to
  // decode, and it would collide with the tower's own centred mark.
  g.lineStyle(2, pal.range, SELECTION_ALPHA);
  if (o.selection.rangeFp === null) {
    const size = projection.cellPx * 2;
    // Inset 1: the 2px stroke (centred on its path) covers the footprint's outermost 2px,
    // so its OUTER edge is the footprint's edge, never inside the plate's rim: beyond it
    // lies the floor, where `range` clears 4.61:1 composited. Inward it meets the rim,
    // which sits 3/64 of the footprint in (`PLATE_RECT`, `tower-art.ts`), drawn on whole
    // device pixels, and which `range` measures only 1.32:1 against (1.75 tritan). The
    // stroke is drawn OVER the rim (the effects layer sits above the tower sprites). At dpr
    // 1 it covers the whole rim at cells up to 21 px, so its inner edge lies on the plate,
    // where `range` clears 3.70:1 composited (4.83 tritan; gated, `palette.test.ts`); at 22
    // to 24 px, and from 28 px, the floor margin outside the rim is at least the stroke's
    // width, so it lies wholly on the floor; at 25 to 27 px, where the rim's own width
    // rounds up to two pixels and widens outward, its inner edge ends on the rim, and its
    // floor-side edge is what carries the cue. (A fractional dpr moves those bands, the rim
    // being on whole device pixels. At small cells a side of the rim can land on the
    // footprint's outermost pixel, which the stroke covers: at dpr 1 only at 10px cells, but
    // at other dprs at more sizes, on the near side or the far —
    // docs/accessibility-checklist.md lists them. Where a neighbouring tower's rim does the
    // same, the floor beyond the stroke gives way to that rim.) It stays clear of a
    // neighbour: the next footprint starts beyond this one's edge. These relations hold only
    // because `c` is snapped exactly as the tower sprite's corner is.
    g.strokeRoundedRect(c.x + 1, c.y + 1, size - 2, size - 2, 6);
  } else {
    g.strokeCircle(cx, cy, projection.fpLenToPixel(o.selection.rangeFp));
    // M2-S9: a selected AoE tower draws its blast too — the SAME condition and the
    // SAME `drawCrosshair` motif the ghost preview uses (`scene.ts`), so arming a
    // tower and selecting that same tower both answer "where does my blast land".
    //
    // The CONDITION is identical; the painted result is not quite, and the difference is
    // worth stating rather than implying parity the pixels do not have (ship-review).
    // `drawCrosshair` leaves a centre gap of `spoke * 0.4`. For the mine (blast 2.5 tiles)
    // the gap lands at `1.0 * cellPx` — the footprint's edge, and the mine has no plate —
    // so its spokes are wholly on `floor`. For `splash`/`frost-splash` (blast 1.5 tiles) the
    // gap is `0.6 * cellPx`: just clear of both heads along the axes the spokes take
    // (`splash`'s octagon reaches 0.55 of a cell there, `frost-splash`'s arms 0.59, outlines
    // included — `tower-art.ts`). Each spoke is painted over the plate, where `pal.range`
    // clears 3.70:1 composited at `SELECTION_ALPHA` (4.83 tritan; gated), then over the
    // rim, and out onto the floor.
    // The spoke TIP — which is what marks the radius — is always on `floor`, so the cue
    // reads at its end on every tower; the ghost differs only in having no plate under its
    // spokes. The mine is what forced the question: it is the only tower whose blast
    // (2.5 tiles) reaches PAST its own ring (2.25), so a selected mine drawing the
    // ring alone would actively understate it.
    //
    // Gated on `blastRadiusFp !== null` — has a blast at all — and nothing more.
    // An earlier revision gated on `blastRadiusFp > rangeFp` so that only the mine
    // qualified and `splash` was left untouched; ship-review flagged the consequence
    // (arming a `splash` previewed spokes, selecting it did not — same tower, two
    // pictures), and Rob ruled for consistency over leaving `splash` alone (2026-08-07,
    // superseding the narrower gate in that story's own plan). `splash` and S10's
    // `frost-splash` therefore DO gain a cue on selection that they did not draw
    // before. That is a deliberate, ruled change, not a side effect.
    //
    // Shape-distinct from the smooth range circle rather than a second concentric
    // circle — the Codex R1-15 ruling this project already made and has not reopened.
    if (o.selection.blastRadiusFp !== null) {
      drawCrosshair(g, cx, cy, projection.fpLenToPixel(o.selection.blastRadiusFp));
    }
  }
}

/** The boss's size multiplier (M2-S10, ruling 2 — size is the ONLY boss cue, no new
 *  `CreepShape` and no new cue ring, since the concentric budget `creep-paint.ts`
 *  documents is already exhausted). Applied AFTER `Math.max(3, cellPx * 0.35)`'s floor,
 *  never inside it — that ordering is LOAD-BEARING, not cosmetic. Below `cellPx ≈ 8.57`
 *  the floor binds and `r` is pinned at 3px regardless of `cellPx`; scaling inside the
 *  floor would then multiply the ALREADY-CLAMPED 3px, giving the boss 3px too (no cue at
 *  all) at exactly the cell size where legibility is worst. Scaling after the floor
 *  always gives the boss 4.5px there — visibly larger than every other creep's 3px,
 *  which is the entire point of a size-only cue. */
const BOSS_SCALE = 1.5;

/** A creep silhouette's half-size in CSS px — the board's `max(3, cellPx * 0.35)`, then
 *  `BOSS_SCALE` for a boss, AFTER the floor (see the constant's own comment for why that
 *  ordering is load-bearing). One function, because the baked silhouette (`art-frames.ts`)
 *  and the live cues drawn around it (`drawCreepCues`) must agree on it exactly. */
export function creepRadius(cellPx: number, boss: boolean): number {
  return Math.max(3, cellPx * 0.35) * (boss ? BOSS_SCALE : 1);
}

/** Below this remaining-health fraction a creep's silhouette AND its health pip switch to
 *  the warning tint (`pal.creepLowHp`). The pip's LENGTH carries health too, so the colour
 *  is the redundant channel of a dual cue, never the only one. */
export const CREEP_LOW_HP_FRAC = 0.34;

/** Whether a creep at `hpFrac` wears the low-health tint — the ONE threshold test, shared
 *  by the baked silhouette's frame choice and the live pip's colour. */
export function isLowHp(hpFrac: number): boolean {
  return hpFrac < CREEP_LOW_HP_FRAC;
}

/** The fill a creep's silhouette and health pip share. */
export function creepFillColour(pal: Palette, lowHp: boolean): number {
  return lowHp ? pal.creepLowHp : pal.creep;
}

/** One creep silhouette — keyed on its catalog id's shape (M2-S3, extended M2-S4a, M2-S5a):
 *  `normal` keeps the triangle (a shape cue distinct from the tower's rounded square); `fast`
 *  draws a diamond; `swarm` draws a small square (fragile/numerous, distinct from both at
 *  cell scale); `armored` draws a six-sided plated hexagon (armoured/tanky, distinct from
 *  all three); `resolute` a regular pentagon; an unknown id falls back to the triangle
 *  (total). A STATIC-ART painter: it runs at bake time into an atlas frame, centred where
 *  the frame says; the geometry is the per-frame draw's, unchanged. */
export function paintCreepSilhouette(
  g: GraphicsLike,
  op: Pick<CreepSilhouettePaintOp, 'shape' | 'x' | 'y' | 'r' | 'colour'>,
): void {
  const r = op.r;
  g.fillStyle(op.colour, 1);
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
  } else if (op.shape === 'pentagon') {
    // Regular pentagon (M2-S6, `resolute`): vertex k at angle -90° + k×72°, apex up
    // like every other shape, generated the way the hexagon loop above already is.
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = ((2 * Math.PI) / 5) * i - Math.PI / 2;
      pts.push({ x: op.x + r * Math.cos(angle), y: op.y + r * Math.sin(angle) });
    }
    g.fillPoints(pts, true);
  } else {
    g.fillTriangle(op.x, op.y - r, op.x + r, op.y + r, op.x - r, op.y + r);
  }
}

/** What `drawCreepCues` needs of one creep: where its silhouette is DRAWN (`cx`/`cy`, the
 *  centre `placement.ts` snapped its sprite to — PIXELS, never the fixed-point `CreepVM`
 *  point), its radius, its silhouette fill, its health and its cue states. */
export interface CreepCueInput {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly colour: number;
  readonly hpFrac: number;
  readonly slowed: boolean;
  readonly poisoned: boolean;
  readonly stunned: boolean;
  readonly warded: boolean;
  readonly airborne: boolean;
}

/** Every creep's health pip and status cues, drawn over EVERY creep's silhouette: the
 *  silhouettes are sprites in the layer below (`layers.ts`), so a creep's cues can never be
 *  hidden under a neighbouring creep's body. That is the one ordering V2 (#181) changed on
 *  purpose — creeps used to draw one whole stack at a time (silhouette, pip, cues, then the
 *  next creep), which let a later creep's body cover an earlier creep's rings.
 *
 *  Per creep, in the old order: the pip, then the slowed, DoT, stun, ward and airborne cues.
 *  Every cue is centred on the creep's DRAWN centre, so cue and body cannot drift apart by
 *  the sprite's device-pixel snap. */
export function drawCreepCues(
  g: GraphicsLike,
  pal: Palette,
  creeps: readonly CreepCueInput[],
  reducedMotion: boolean,
  renderTimeMs: number, // MILLISECONDS — the unit lives in the name (QC r3), the tick→ms conversion happens at the call site
): void {
  for (const c of creeps) {
    const p = { x: c.cx, y: c.cy };
    const r = c.r;
    // Health pip: length AND colour encode HP (dual cue) — warning tint only when low,
    // the silhouette's own fill. hpFrac is already clamped to [0,1] by deriveViewModel
    // (CreepVM invariant).
    g.fillStyle(c.colour, 1);
    g.fillRect(p.x - r, p.y - r - 4, r * 2 * c.hpFrac, 3);
    // Slowed telegraph (M2-S3): a shape cue (ring, opaque) ALWAYS accompanies a live
    // slow; the motion cue (pulse, radius driven by render time) yields to reduced
    // motion (WCAG 2.3.3 / GAG §2). Alphas live in the plan, not here.
    // EVERY telegraph takes the drawn PIXEL centre `p`, never the raw `CreepVM` (Codex
    // review, PR #78). `CreepVM.x`/`y` are fixed-point sim units — 256 per cell — so
    // passing the creep itself drew both of the first two cues around coordinates ~256×
    // the pixel position, i.e. far off-canvas. The slowed telegraph carried this from
    // M2-S3 and had therefore never actually rendered; M2-S5a reproduced it in the DoT
    // telegraph. `scene.test.ts` pins that every plan receives the drawn centre.
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
    // Stun telegraph (M2-S6): a thick OUTER ring (`'jolt'`, r×1.15, ALWAYS accompanies a
    // live stun) plus a SMALLER alpha-animated inner ring (`'flicker'`, r×0.85, motion-cue,
    // yields to reduced motion) — mirrors the slow/DoT telegraphs' shape+motion posture.
    // The guaranteed cue is the outer one so its contrast partner is the board floor
    // rather than the creep fill; see `creep-paint.ts`'s builder for why that is
    // load-bearing rather than cosmetic.
    for (const tel of stunTelegraphPaintOps(
      { ...p, stunned: c.stunned },
      r,
      reducedMotion,
      pal.stunned,
      renderTimeMs,
    )) {
      g.lineStyle(tel.kind === 'jolt' ? 4 : 2, tel.colour, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
    // Ward cue (M2-S6): a single opaque outer ring for a creep whose catalog
    // definition carries an immunity — NOT a timed status, so no motion cue and no
    // reduced-motion branch (`wardPaintOps` takes no `renderTimeMs`). Sits at r×2.2,
    // outside every other cue here, so a warded+slowed+stunned creep still reads as
    // three distinct concentric rings.
    for (const tel of wardPaintOps({ ...p, warded: c.warded }, r, pal.warded)) {
      g.lineStyle(2, tel.colour, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
    // Airborne cue (M2-S7): a wing chevron layered OVER the creep's base silhouette — an
    // independent paint plan, not a fourth `CreepShape`, so `armored-flyer` (S10) reads
    // as armored (the hexagon) AND airborne (this) at once. Catalog-derived
    // (`CreepVM.domain === 'air'`), so — like the ward cue right above — it takes no
    // `renderTimeMs` and has no reduced-motion branch.
    // The `0` is the canvas top: the cue mirrors below the creep rather than drawing
    // off-screen, for a flyer on a board whose openings sit on row 0 (Codex P2, PR #87).
    // Ink outline first, then the light strokes over it (QC round 1, #181): the cue lands
    // on tower heads, and over a light role colour only the ink edge reads.
    for (const tel of airborneCuePaintOps({ ...p, airborne: c.airborne }, r, pal.airborne, 0)) {
      const wings = [
        [tel.leftX, tel.leftY],
        [tel.rightX, tel.rightY],
      ] as const;
      g.lineStyle(tel.strokePx + 2 * tel.outlinePx, tel.outlineColour, tel.alpha);
      for (const [tx, ty] of wings) {
        // A line quad ends square at its points, so the outline runs `outlinePx` past both
        // ends to ring the tips and the apex too.
        const len = Math.hypot(tx - tel.apexX, ty - tel.apexY);
        const ux = ((tx - tel.apexX) / len) * tel.outlinePx;
        const uy = ((ty - tel.apexY) / len) * tel.outlinePx;
        g.lineBetween(tel.apexX - ux, tel.apexY - uy, tx + ux, ty + uy);
      }
      g.lineStyle(tel.strokePx, tel.colour, tel.alpha);
      for (const [tx, ty] of wings) g.lineBetween(tel.apexX, tel.apexY, tx, ty);
    }
  }
}
