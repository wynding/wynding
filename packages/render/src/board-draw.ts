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

import {
  creepSilhouettePaintOp,
  slowTelegraphPaintOps,
  dotTelegraphPaintOps,
  stunTelegraphPaintOps,
  wardPaintOps,
  airborneCuePaintOps,
} from './creep-paint';
import { towerFootprintMarkFor, type TowerFootprintMark } from './tower-paint';
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

/** A closed circle at `(cx,cy,halfSize)` — the `'ringed'` footprint mark's own radius —
 *  plus four short spokes radiating OUTWARD from that ring to `halfSize * 1.5`, one per
 *  cardinal direction — the `'ringed-crosshair'` footprint mark (M2-S10, `frost-splash`),
 *  composing `'ringed'` (the ring, unchanged radius) and `'crosshair'` (the radiating-
 *  spoke motif) into one shape that reads as its two parents (m2.md:299) while staying
 *  distinct from both: unlike `'crosshair'` above, the spokes start at the ring's edge
 *  and point away from it, not from the centre outward with a gap. `halfSize` is the
 *  ring's radius, mirroring `drawCrosshair`'s own half-size parameter. */
export function drawRingedCrosshair(
  g: GraphicsLike,
  cx: number,
  cy: number,
  halfSize: number,
): void {
  g.strokeCircle(cx, cy, halfSize);
  const spokeOuter = halfSize * 1.5;
  g.lineBetween(cx, cy - halfSize, cx, cy - spokeOuter);
  g.lineBetween(cx, cy + halfSize, cx, cy + spokeOuter);
  g.lineBetween(cx - halfSize, cy, cx - spokeOuter, cy);
  g.lineBetween(cx + halfSize, cy, cx + spokeOuter, cy);
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

/** A three-segment zigzag polyline through `(cx,cy)`, evoking a lightning bolt — the
 *  `'bolt'` footprint mark (M2-S6, `stun`). `halfSize` is the footprint's HALF-SIZE
 *  (unlike `drawCrosshair`/`drawDroplet`'s `spoke`, which is `size * 0.22`): the
 *  vertices are pinned in the plan as fractions of the footprint half-size, so this
 *  reads at roughly cell scale rather than the other marks' smaller motif. Distinct
 *  from `'crosshair'`'s spokes by not being radial — never colour alone (ADR 0003). */
function drawBolt(g: GraphicsLike, cx: number, cy: number, halfSize: number): void {
  const verts: readonly (readonly [number, number])[] = [
    [-0.35, -0.5],
    [0.15, -0.1],
    [-0.15, 0.1],
    [0.35, 0.5],
  ];
  for (let i = 0; i < verts.length - 1; i++) {
    const [x0, y0] = verts[i]!;
    const [x1, y1] = verts[i + 1]!;
    g.lineBetween(cx + x0 * halfSize, cy + y0 * halfSize, cx + x1 * halfSize, cy + y1 * halfSize);
  }
}

/** An upward arrow at `(cx,cy)` — a vertical shaft with two barbs at its tip — the
 *  `'arrow'` footprint mark (M2-S7, `antiair`), evoking "shoots skyward". `halfSize`
 *  plays the same role as `'crosshair'`/`'droplet'`'s — both call sites pass
 *  `size * 0.22`, NOT `drawBolt`'s `size * 0.5`, which an earlier version of this line
 *  named and which would produce a mark twice the size of every other footprint mark.
 *  Distinct in shape from `'crosshair'`'s four radiating spokes (this is a single
 *  unbroken shaft through the centre plus two barbs, not four strokes around a centre
 *  gap), `'bolt'`'s zigzag (straight, not staggered), `'ringed'`'s closed circle, and
 *  `'droplet'`'s teardrop — never colour alone (ADR 0003).
 *
 *  The shaft and the barbs' downward fan are BOTH load-bearing, which is why this is not
 *  the bare "^" it started as: `airborneCuePaintOps` (`creep-paint.ts`) draws the
 *  airborne creep cue as exactly that apex-plus-two-strokes glyph, and its r×3.4 offset
 *  puts it ≈1 cell ABOVE the creep — so a flyer on the shipped board's row-11 lane paints
 *  its cue over a row-10 footprint, a tenth of a cell from this mark. An `antiair` tower
 *  plus a flying wave is the normal case, not a corner one, so two upward chevrons would
 *  have left `pal.floor` vs `pal.airborne` as the only channel telling tower from creep. */
function drawArrow(g: GraphicsLike, cx: number, cy: number, halfSize: number): void {
  g.lineBetween(cx, cy + halfSize, cx, cy - halfSize); // shaft, tip up
  g.lineBetween(cx - halfSize * 0.55, cy - halfSize * 0.35, cx, cy - halfSize);
  g.lineBetween(cx + halfSize * 0.55, cy - halfSize * 0.35, cx, cy - halfSize);
}

/** An upright post through `(cx,cy)` with a short crossbar near its top and a wider bar
 *  at its base — the `'pylon'` footprint mark (M2-S8, `beacon`), evoking a broadcasting
 *  mast. `halfSize` plays the same role as `drawArrow`'s. Distinct from `'arrow'` (no
 *  convergent tip; the bars are horizontal and the base one is the WIDEST feature, where
 *  an arrow's widest point is at its tip) and from `'bolt'` (a straight post, not a
 *  three-segment stagger) — never colour alone (ADR 0003). */
function drawPylon(g: GraphicsLike, cx: number, cy: number, halfSize: number): void {
  g.lineBetween(cx, cy - halfSize, cx, cy + halfSize); // mast
  g.lineBetween(
    cx - halfSize * 0.45,
    cy - halfSize * 0.55,
    cx + halfSize * 0.45,
    cy - halfSize * 0.55,
  ); // crossbar
  g.lineBetween(cx - halfSize * 0.8, cy + halfSize, cx + halfSize * 0.8, cy + halfSize); // base
}

/** A four-pointed star (✦) at `(cx,cy)`: two axial strokes crossed by two shorter
 *  diagonals — the BUFFED-RECIPIENT mark (M2-S8), drawn in the footprint's top-left
 *  QUADRANT so it never overlaps the tower's own centred `TowerFootprintMark`. Its own
 *  shape carries the state; the colour channel is redundant (ADR 0003). */
function drawSparkle(g: GraphicsLike, cx: number, cy: number, r: number): void {
  g.lineBetween(cx, cy - r, cx, cy + r);
  g.lineBetween(cx - r, cy, cx + r, cy);
  const d = r * 0.45;
  g.lineBetween(cx - d, cy - d, cx + d, cy + d);
  g.lineBetween(cx + d, cy - d, cx - d, cy + d);
}

/** The alpha the support-aura shell strokes at — pinned here rather than inlined
 *  because `palette.test.ts` gates `aura` COMPOSITED at exactly this value, and a
 *  change at this one draw site must move the gate with it (the same discipline
 *  `RANGE_GHOST_PREVIEW_ALPHA` already carries for `range`). */
/** THE footprint-mark dispatch (#89): the committed-body chain (`2, pal.floor, 1`), the
 *  pending-outline chain (`1, pal.tower, 0.6`), and the Card swatch (`apps/web/src/
 *  swatch.ts`) all draw the nine-mark vocabulary through this one table, so a new mark
 *  lands everywhere at once or nowhere. Per-mark scale stays internal: every mark draws at
 *  `size * 0.22` except `'bolt'`, whose zigzag deliberately spans the whole footprint
 *  (`size * 0.5` — its comment in `drawBolt` carries the reasoning). `'charge'` is the
 *  vocabulary's ONE fill (that is its whole distinctness argument at the narrow floor), so
 *  it consumes the (width, colour, alpha) triple as a fill — width unused — and every
 *  other mark as a stroke. `'plain'` draws nothing: total over the union, and the reason
 *  callers need no pre-check. */
export function drawFootprintMark(
  g: GraphicsLike,
  mark: TowerFootprintMark,
  cx: number,
  cy: number,
  size: number,
  lineWidth: number,
  color: number,
  alpha: number,
): void {
  if (mark === 'plain') return;
  if (mark === 'charge') {
    g.fillStyle(color, alpha);
    g.fillCircle(cx, cy, size * 0.22);
    return;
  }
  g.lineStyle(lineWidth, color, alpha);
  if (mark === 'ringed') g.strokeCircle(cx, cy, size * 0.22);
  else if (mark === 'crosshair') drawCrosshair(g, cx, cy, size * 0.22);
  else if (mark === 'droplet') drawDroplet(g, cx, cy, size * 0.22);
  else if (mark === 'bolt') drawBolt(g, cx, cy, size * 0.5);
  else if (mark === 'arrow') drawArrow(g, cx, cy, size * 0.22);
  else if (mark === 'pylon') drawPylon(g, cx, cy, size * 0.22);
  else if (mark === 'ringed-crosshair') drawRingedCrosshair(g, cx, cy, size * 0.22);
  else {
    // Exhaustiveness — the header's "everywhere at once or nowhere" made compile-time: a
    // tenth mark must fail HERE, never silently borrow the last glyph in the chain.
    const unreachable: never = mark;
    void unreachable;
  }
}

export const AURA_SHELL_ALPHA = 0.9;

/** The buffed-recipient ✦'s centre and radius, both as fractions of ONE cell — pinned
 *  here because they are a CONTAINMENT constraint, not a taste choice, and the test that
 *  proves it reads these same two numbers.
 *
 *  The mark strokes `pal.floor` against the solid `pal.tower` fill, so any part of it
 *  that lands outside the body is floor-on-floor and simply vanishes. The body is
 *  `fillRoundedRect(p+2, size-4, radius 6)`, and at the smallest supported cell
 *  (`CELL_PX_MIN_NARROW` = 10, the 568×320 compact floor) that rect is only 16px across
 *  with a 6px corner radius — so the corner arc, not the straight edge, is what binds.
 *  The first version of this mark sat at 0.42 with r = 0.26, which put its top and left
 *  tips 1.6px from the anchor against a body starting at 2px: most of the ✦ rendered
 *  invisibly and what survived read as an asymmetric half-mark. These values keep all
 *  four tips inside the rounded body at that floor, with margin, and — being fractions
 *  of the cell — keep the same relationship at every larger size.
 *
 *  THE STROKE WIDTH IS PART OF THE CONSTRAINT, not a detail: the mark is drawn with a 2px
 *  line, so every tip carries 1px of half-width beyond its centreline, and it is the OUTER
 *  EDGE that has to clear the arc. A prior pair (0.5 / 0.15) satisfied a centreline-only
 *  test and still clipped — the axial tips sat 5.41 from the corner arc centre against a
 *  6px radius, leaving 0.59px for a 1px half-width. That is the same disappearing-mark
 *  failure these constants exist to prevent, reintroduced by a test measuring the wrong
 *  thing; `scene.test.ts` now measures the endpoints `drawSparkle` actually emits and
 *  subtracts {@link SPARKLE_STROKE_PX} / 2 before checking, so it pins the DRAWING rather
 *  than these two numbers — which is why they are module-private: the test no longer needs
 *  them, and an export with no consumer is surface without a reason. */
const SPARKLE_CENTRE_FRAC = 0.55;
const SPARKLE_RADIUS_FRAC = 0.13;
/** The ✦'s stroke width, exported so the containment test reasons about the OUTER EDGE
 *  rather than the centreline, and cannot drift from the draw site. */
export const SPARKLE_STROKE_PX = 2;

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
  /** A committed tower whose sell is queued is presented as already gone — checked inline
   *  in both passes rather than materialized into a filtered array.
   *
   *  Honest accounting, since the two-pass split changed the arithmetic this choice was
   *  originally argued on: with a sell queued this now builds a key string twice per
   *  tower per frame (once per pass), which is MORE transient allocation than the single
   *  array it replaces, not less. It is kept because `pendingSellKeys !== null`
   *  short-circuits first, so the ordinary frame — no queued sell — allocates nothing at
   *  all, where the filtered array would allocate on every frame regardless. The trade is
   *  "free in the common case, slightly worse in the rare one", not "cheaper always". */
  const hidden = (t: RenderVM['towers'][number]): boolean =>
    pendingSellKeys !== null && pendingSellKeys.has(`${t.col},${t.row}`);
  // PASS 1 — every support shell, BEFORE any tower body (M2-S8).
  //
  // The shell is an OVER-APPROXIMATION of the region it marks, and the difference matters
  // at exactly the case the rule turns on: the stamped aura is a plus-shaped ring of 8
  // cells, because the four DIAGONAL corners are excluded (corner-only touch never buffs),
  // while a rounded rect encloses all twelve cells of the surrounding block. A corner-only
  // neighbour therefore sits partly inside a boundary that does not reach it. The
  // authoritative signal is the recipient mark below — derived from the sim's own rule and
  // drawn only on towers genuinely being buffed; the shell is the coarser "roughly here"
  // cue. Drawing the true plus outline instead would change the aura's approved visual
  // shape, so it is a product decision rather than a refactor (docs/accessibility-
  // checklist.md carries it as a recorded residual).
  //
  // WHY IT IS ITS OWN PASS: the shell extends one cell out from its beacon, so its edge
  // falls exactly on the boundary between an edge-adjacent recipient's two footprint
  // columns — straight down the middle of the very tower it points at. Drawn inside the
  // body loop, whether that segment was visible depended on SoA order: build the beacon
  // first and the recipient's opaque fill paints over it, build it second and the shell
  // stripes across the tower. Same board, two renderings. Hoisting every shell into its
  // own earlier pass makes bodies always win,
  // so the result is order-independent and the shell never crosses a tower body — which
  // also keeps `pal.aura` off `pal.tower`, a pairing it does not clear 3:1 against and
  // which `palette.test.ts` therefore does not gate.
  for (const t of vm.towers) {
    if (!t.support || hidden(t)) continue;
    const p = projection.cellToPixel(t.col, t.row);
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
  // PASS 2 — bodies, footprint marks, and the buffed-recipient ✦.
  for (const t of vm.towers) {
    if (hidden(t)) continue;
    const p = projection.cellToPixel(t.col, t.row);
    const size = projection.cellPx * 2; // 2×2 footprint
    g.fillStyle(pal.tower, 1);
    g.fillRoundedRect(p.x + 2, p.y + 2, size - 4, size - 4, 6);
    // `slow`/`splash`/`venom`/`stun`/`antiair`/`beacon`/`mine` vs `basic` footprint mark
    // (M2-S3, extended M2-S4a, M2-S5a, M2-S6, M2-S7, M2-S8, M2-S9): all bodies share
    // `pal.tower` — a palette decision (S3 mints no second tower colour), with the
    // per-tower distinction carried by SHAPE — an inner concentric ring for `'ringed'`
    // (slow), four short radiating spokes for `'crosshair'` (splash — the same "area
    // effect" motif the ghost's blast-radius preview below draws at cell scale, per ADR
    // 0003's redundant-encoding rule), a small teardrop for `'droplet'` (venom), a
    // three-segment zigzag for `'bolt'` (stun), an upward arrow for `'arrow'`
    // (antiair), an upright mast for `'pylon'` (beacon), a FILLED disc for `'charge'`
    // (mine — M2-S9, the only filled mark in the vocabulary, so it survives at the
    // narrow floor where every other mark's fine detail has collapsed), nothing extra
    // for `'plain'` (basic). The committed marks stroke (or, for `'charge'` alone,
    // FILL) `pal.floor` so they read against the solid `pal.tower` fill; the pending
    // branch below uses `pal.tower` instead — its body is an unfilled outline, so
    // there is no fill to contrast against and the mark keeps the pending cue's own
    // colour + alpha (CodeRabbit #73: the two branches differ on purpose).
    drawFootprintMark(
      g,
      towerFootprintMarkFor(t.towerId),
      p.x + projection.cellPx,
      p.y + projection.cellPx,
      size,
      2,
      pal.floor,
      1,
    );
    // The recipient ✦ sits in the footprint's top-left CELL, while every
    // `TowerFootprintMark` is anchored at the footprint CENTRE — separated by position,
    // which is what keeps both readable in one 2×2 body.
    //
    // Separation is positional, NOT a guarantee that the two never touch, and the
    // difference is worth stating because an earlier version of this comment claimed the
    // stronger thing: a `size * 0.22` mark reaches 0.56 × cell from the anchor while the ✦
    // reaches 0.68, so they overlap slightly before stroke width is even counted, and
    // `'bolt'` is drawn at `size * 0.5` — deliberately spanning the WHOLE footprint, so it
    // crosses this cell by design and no placement inside the body could avoid it. What is
    // actually guaranteed, and tested, is that the ✦ stays inside the body and inside the
    // top-left cell; legibility where the two marks abut at the narrow floor is a recorded
    // residual (docs/accessibility-checklist.md), not a solved problem.
    //
    // It strokes `pal.floor` for the same reason every footprint mark above does: it is
    // drawn over the solid `pal.tower` fill — which is also exactly why its containment
    // inside that fill is a correctness constraint rather than polish (see
    // `SPARKLE_CENTRE_FRAC`).
    if (t.buffed) {
      g.lineStyle(SPARKLE_STROKE_PX, pal.floor, 1);
      drawSparkle(
        g,
        p.x + projection.cellPx * SPARKLE_CENTRE_FRAC,
        p.y + projection.cellPx * SPARKLE_CENTRE_FRAC,
        projection.cellPx * SPARKLE_RADIUS_FRAC,
      );
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
    drawFootprintMark(
      g,
      towerFootprintMarkFor(p.towerId),
      pt.x + projection.cellPx,
      pt.y + projection.cellPx,
      size,
      1,
      pal.tower,
      0.6,
    );
  }
  if (o.selection !== null) {
    const c = projection.cellToPixel(o.selection.col, o.selection.row);
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
    g.lineStyle(2, pal.range, 0.9);
    if (o.selection.rangeFp === null) {
      const size = projection.cellPx * 2;
      // Inset 1, NOT 2. A canvas stroke is centred on its path, so tracing the body's own
      // `fillRoundedRect(p + 2, size - 4)` geometry would put the inner half of a 2px
      // stroke on the solid `pal.tower` fill — where `range` measures 1.06:1 (default;
      // 1.55 protan/deutan, 1.42 tritan) and is simply not there — leaving 1px of cue at
      // the narrow floor. At inset 1 the whole 2px stroke sits in the 2px margin between
      // the body edge and the cell boundary, i.e. entirely on `floor`, where `range`
      // clears 4.61:1. Neighbouring footprints are 4px apart, so it cannot reach one.
      g.strokeRoundedRect(c.x + 1, c.y + 1, size - 2, size - 2, 6);
    } else {
      g.strokeCircle(cx, cy, projection.fpLenToPixel(o.selection.rangeFp));
      // M2-S9: a selected AoE tower draws its blast too — the SAME condition and the
      // SAME `drawCrosshair` motif the ghost preview uses (`scene.ts`), so arming a
      // tower and selecting that same tower both answer "where does my blast land".
      //
      // The CONDITION is identical; the painted result is not quite, and the difference is
      // worth stating rather than implying parity the pixels do not have (ship-review).
      // `drawCrosshair` leaves a centre gap of `spoke * 0.4`, and the committed body is a FILLED rounded rect whose edge sits ~`cellPx` from the footprint centre. For the mine (blast 2.5 tiles) the gap lands at `1.0 * cellPx` — exactly the body edge — so its spokes are wholly on `floor`. For `splash`/`frost-splash` (blast 1.5 tiles) the gap is `0.6 * cellPx`, so each spoke's inner ~22-44% is painted over `pal.tower`, where `pal.range` measures 1.06:1 (the same surface the attackless-selection branch above rejects an inset-2 stroke over). The ghost has no such band because its body is an OUTLINE, not a fill.
      // The spoke TIP — which is what marks the radius — is always on `floor` in both
      // surfaces, so the cue reads either way; a small-blast tower simply shows a shorter
      // visible spoke when committed than when previewed. The mine is what forced the question: it is the only tower whose blast
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
    domain: 'ground' | 'air';
    slowed: boolean;
    poisoned: boolean;
    stunned: boolean;
    warded: boolean;
    boss: boolean;
  }[],
  reducedMotion: boolean,
  renderTimeMs: number, // MILLISECONDS — the unit lives in the name (QC r3), the tick→ms conversion happens at the call site
  projection: Projection,
): void {
  for (const c of interpolated) {
    const p = projection.fpToPixel(c.x, c.y);
    // BOSS_SCALE applies AFTER the floor — see the constant's own comment for why the
    // ordering is load-bearing.
    const r = Math.max(3, projection.cellPx * 0.35) * (c.boss ? BOSS_SCALE : 1);
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
    // Stun telegraph (M2-S6): a thick OUTER ring (`'jolt'`, r×1.15, ALWAYS accompanies a
    // live stun) plus a SMALLER alpha-animated inner ring (`'flicker'`, r×0.85, motion-cue,
    // yields to reduced motion) — mirrors the slow/DoT telegraphs' shape+motion posture.
    // The guaranteed cue is the outer one so its contrast partner is the board floor
    // rather than the creep fill; see `creep-paint.ts`'s builder for why that is
    // load-bearing rather than cosmetic.
    // BOTH take the PROJECTED pixel centre `p`, never the raw `c` — same rationale as
    // the two loops above.
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
    // Airborne cue (M2-S7): a wing chevron layered OVER whatever base silhouette was
    // just drawn above — an independent paint plan, not a fourth `CreepShape`, so
    // `armored-flyer` (S10) reads as armored (the hexagon above) AND airborne (this) at
    // once. Catalog-derived (`CreepVM.domain === 'air'`), so — like the ward cue right
    // above — it takes no `renderTimeMs` and has no reduced-motion branch.
    // The `0` is the canvas top: the cue mirrors below the creep rather than drawing
    // off-screen, for a flyer on a board whose openings sit on row 0 (Codex P2, PR #87).
    for (const tel of airborneCuePaintOps(
      { ...p, airborne: c.domain === 'air' },
      r,
      pal.airborne,
      0,
    )) {
      g.lineStyle(2, tel.colour, tel.alpha);
      g.lineBetween(tel.apexX, tel.apexY, tel.leftX, tel.leftY);
      g.lineBetween(tel.apexX, tel.apexY, tel.rightX, tel.rightY);
    }
  }
}
