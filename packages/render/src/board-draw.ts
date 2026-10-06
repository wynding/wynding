// board-draw.ts — the board's drawing vocabulary, Phaser-free. Extracted out of `scene.ts`'s
// `mount()` closure (M2-S5a QC round): `scene.ts` imports Phaser at module scope, which
// crashes even under jsdom (Phaser's device/canvas-feature detection runs at import time,
// per `CanvasFeatures.js`), so nothing in it can be unit-tested. Nothing here needs Phaser —
// every function draws through `GraphicsLike` below, a structural slice of
// `Phaser.GameObjects.Graphics` that a real Graphics satisfies for free and that
// `scene.test.ts` satisfies with a recording fake. That is what keeps branches like the
// poisoned pips witnessed: `scene.ts` is coverage-excluded and Playwright + axe cannot see
// canvas cues.
//
// Since the visual pass's V2 (#181) baked static art into textures, what lives here are the
// PER-FRAME EXECUTORS (`drawAuraShells`, `drawSelection`, `drawCreepCues`): they draw into a
// Phaser `Graphics` every frame, because what moves, or comes and goes, stays live. Towers
// and creeps are not drawn here: they are vector art (`tower-art.ts`, `creep-art.ts`),
// painted once into the board atlas by the art kit (`art-paint.ts`). Which layer each
// executor draws into is decided by `board-frame.ts` (and pinned by its test), and where that
// layer sits is `layers.ts`'s business — neither is call order's.

import {
  slowTelegraphPaintOps,
  dotTelegraphPaintOps,
  stunTelegraphPaintOps,
  wardPaintOps,
  hpBarPaintOp,
  type DotTelegraphPaintOp,
  type SlowTelegraphPaintOp,
  type StunTelegraphPaintOp,
  type WardPaintOp,
} from './creep-paint';
import { snapToDevicePx } from './device-px';
import { ART_INK } from './tower-art';
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
    // to 24 px, and from 29 px (its near sides from 28), the floor margin outside the rim is
    // at least the stroke's width, so it lies wholly on the floor; at 25 to 27 px, where the
    // rim's own width rounds up to two pixels and widens outward — and on the far sides at 28
    // px, where the widened rim's place is an exact tie that rounds outward there — its inner
    // edge ends on the rim, and its floor-side edge carries the cue. (A fractional dpr moves
    // those bands, the rim being on whole device pixels. At small cells a side of the rim can
    // land on the footprint's outermost pixel, which the stroke covers: at dpr 1 only at 10px
    // cells, but at other dprs at more sizes, on the near side or the far —
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

/** What `drawCreepCues` needs of one creep: where its cues are centred (`cx`/`cy` — its BODY
 *  as drawn: the centre `placement.ts` snapped its sprite to, lifted for a flyer — PIXELS,
 *  never the fixed-point `CreepVM` point), its radius (its family's size step included), its
 *  family's hue (the HP bar's fill), its HP and its cue states. */
export interface CreepCueInput {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly hue: number;
  readonly hpFrac: number;
  readonly slowed: boolean;
  readonly poisoned: boolean;
  readonly stunned: boolean;
  readonly warded: boolean;
}

/** How much wider than its cue an ink under-stroke reaches on each side, CSS px (C3, #181):
 *  the established way a cue reads on every surface it lands on — its own colour against the
 *  dark floor and plate, its ink edge against a light tower head, a rim or another creep's
 *  body (`palette.test.ts` gates both halves). The airborne chevron carried one first (#181
 *  QC round 1); since C3 every guaranteed cue, and the flicker, does. */
export const CUE_INK_PX = 1;

/** The slow ring's, the jolt's, the flicker's and the ward's stroke widths, CSS px. */
const SLOW_RING_PX = 2;
const SLOW_PULSE_PX = 1;
const JOLT_PX = 4;
const FLICKER_PX = 2;
const WARD_PX = 2;

/** One creep's cue plans for this frame. */
interface CreepCuePlans {
  readonly slow: readonly SlowTelegraphPaintOp[];
  readonly dot: readonly DotTelegraphPaintOp[];
  readonly stun: readonly StunTelegraphPaintOp[];
  readonly ward: readonly WardPaintOp[];
}

/** The plans every creep's cues are drawn from, made once per frame. Every plan takes the
 *  drawn PIXEL centre, never the raw `CreepVM` (Codex review, PR #78): `CreepVM.x`/`y` are
 *  fixed-point sim units — 256 per cell — and passing the creep itself drew the first two
 *  cues ~256× its pixel position, far off-canvas. The slowed telegraph carried that from
 *  M2-S3 and so had never rendered; M2-S5a reproduced it in the DoT telegraph.
 *  `scene.test.ts` pins that every plan receives the drawn centre. */
function cuePlans(
  pal: Palette,
  c: CreepCueInput,
  reducedMotion: boolean,
  renderTimeMs: number,
): CreepCuePlans {
  const x = c.cx;
  const y = c.cy;
  return {
    slow: slowTelegraphPaintOps(
      { x, y, slowed: c.slowed },
      c.r,
      reducedMotion,
      pal.slowed,
      renderTimeMs,
    ),
    dot: dotTelegraphPaintOps(
      { x, y, poisoned: c.poisoned },
      c.r,
      reducedMotion,
      pal.poisoned,
      renderTimeMs,
    ),
    stun: stunTelegraphPaintOps(
      { x, y, stunned: c.stunned },
      c.r,
      reducedMotion,
      pal.stunned,
      renderTimeMs,
    ),
    ward: wardPaintOps({ x, y, warded: c.warded }, c.r, pal.warded),
  };
}

/** Every creep's HP bar and status cues, drawn over EVERY creep's body: the bodies are
 *  sprites in the paint layer below (`layers.ts`), so a creep's cues can never be hidden under
 *  a neighbouring creep's body — the one ordering V2 (#181) changed on purpose, when creeps
 *  stopped drawing one whole stack at a time.
 *
 *  Since C3 the cues are drawn in PASSES over every creep, each pass over the one before
 *  (`creep-paint.ts`'s CUE-RADIUS ORDERING block derives why):
 *   1. the ink under-strokes of the rings — the slow ring, the stun jolt and flicker, the
 *      ward — `CUE_INK_PX` wider on each side, so no ring's own ink covers a ring's colour (the HP
 *      bars and the pips' ink discs, drawn later, do lie over every ring, a neighbour's included);
 *   2. the rings in their colours: the slowed telegraph (M2-S3; its ring ALWAYS, its pulse
 *      only when motion is allowed — WCAG 2.3.3 / GAG §2), the stun telegraph (M2-S6; the
 *      jolt OUTSIDE the silhouette always, the flicker inside it with motion), the ward
 *      (M2-S6; catalog-derived, so no motion cue and no reduced-motion branch);
 *   3. the HP bar (`hpBarPaintOp`), over the rings, so the arc of a ring under it is hidden
 *      rather than the bar's length;
 *   4. the DoT pips (M2-S5a — an ESSENTIAL cue: HP shows damage already TAKEN, a DoT record
 *      armor-bypassing damage already SCHEDULED, which no other surface reveals), each on
 *      its own ink disc, on top of everything: every pip's ink, then every pip, so no creep's
 *      ink disc lands on a pip, then their drift when motion is allowed. No
 *      per-tick live-region announcement accompanies them (`dotTelegraphPaintOps` says why).
 *  Every cue is centred on the creep's drawn body, so cue and body cannot drift apart by the
 *  sprite's device-pixel snap. */
export function drawCreepCues(
  g: GraphicsLike,
  pal: Palette,
  creeps: readonly CreepCueInput[],
  reducedMotion: boolean,
  renderTimeMs: number, // MILLISECONDS — the unit lives in the name (QC r3), the tick→ms conversion happens at the call site
): void {
  const plans = creeps.map((c) => cuePlans(pal, c, reducedMotion, renderTimeMs));
  const ink = CUE_INK_PX * 2;
  // 1. The rings' ink under-strokes.
  for (const p of plans) {
    for (const tel of p.slow) {
      if (tel.kind !== 'ring') continue; // the pulse is a motion cue, faded by design
      g.lineStyle(SLOW_RING_PX + ink, ART_INK, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
    for (const tel of p.stun) {
      g.lineStyle((tel.kind === 'jolt' ? JOLT_PX : FLICKER_PX) + ink, ART_INK, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
    for (const tel of p.ward) {
      g.lineStyle(WARD_PX + ink, ART_INK, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
  }
  // 2. The rings in their colours. Alphas live in the plans, not here.
  for (const p of plans) {
    for (const tel of p.slow) {
      g.lineStyle(tel.kind === 'ring' ? SLOW_RING_PX : SLOW_PULSE_PX, tel.colour, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
    for (const tel of p.stun) {
      g.lineStyle(tel.kind === 'jolt' ? JOLT_PX : FLICKER_PX, tel.colour, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
    for (const tel of p.ward) {
      g.lineStyle(WARD_PX, tel.colour, tel.alpha);
      g.strokeCircle(tel.x, tel.y, tel.r);
    }
  }
  // 3. The HP bars: length AND colour carry HP (dual cue). `hpFrac` is already clamped to
  //    [0, 1] by `deriveViewModel` (CreepVM invariant).
  for (const c of creeps) {
    const bar = hpBarPaintOp({ x: c.cx, y: c.cy }, c.r, c.hpFrac, c.hue, pal.creepLowHp, ART_INK);
    g.fillStyle(bar.backing.colour, 1);
    g.fillRect(bar.backing.x, bar.backing.y, bar.backing.w, bar.backing.h);
    if (bar.fill.w > 0) {
      g.fillStyle(bar.fill.colour, 1);
      g.fillRect(bar.fill.x, bar.fill.y, bar.fill.w, bar.fill.h);
    }
  }
  // 4. The DoT pips: every pip's ink disc, then every pip, then their drift, so no creep's ink
  //    disc lands on another creep's pip. (They lie over every ring and bar, as designed.)
  for (const p of plans) {
    for (const tel of p.dot) {
      if (tel.kind !== 'pip') continue;
      g.fillStyle(ART_INK, tel.alpha);
      g.fillCircle(tel.x, tel.y, tel.r + CUE_INK_PX);
    }
  }
  for (const p of plans) {
    for (const tel of p.dot) {
      if (tel.kind !== 'pip') continue;
      g.fillStyle(tel.colour, tel.alpha);
      g.fillCircle(tel.x, tel.y, tel.r);
    }
  }
  for (const p of plans) {
    for (const tel of p.dot) {
      if (tel.kind !== 'drift') continue;
      g.fillStyle(tel.colour, tel.alpha);
      g.fillCircle(tel.x, tel.y, tel.r);
    }
  }
}
