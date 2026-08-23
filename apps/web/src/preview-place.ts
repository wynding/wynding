// preview-place.ts — where the Standard wave-preview float is allowed to sit (#101).
//
// THE RULE, owner-ratified 2026-08-17: **the preview never occludes a structurally
// buildable cell.** "Structurally" means a cell a tower could EVER be placed on, not one
// that happens to be empty right now — a rule keyed to what is currently empty would
// loosen as the board fills, letting the card drift back over exactly the corner the issue
// was opened about, and it would pass its own test while doing it.
//
// WHAT "STRUCTURALLY BUILDABLE" RESOLVES TO, derived rather than assumed. `packages/sim`'s
// `footprintBuildable` accepts a 2×2 footprint only where all four cells are
// `buildable-open` base terrain, and `buildGrid` marks the whole outer ring blocked (the
// entrance/exit openings are `walkable-unbuildable`, also never buildable). So the anchor
// range is `col ∈ [1, cols-3] × row ∈ [1, rows-3]`, and the union of the cells those
// footprints cover is exactly the grid INSET BY ONE CELL on every side. That single fact is
// what both this module and `e2e/layout-probe.ts`'s gate are built on.
//
// WHY THE CARD IS CAPPED RATHER THAN MERELY MOVED. Measured on the shipped build, the
// letterbox margins run 18-110 CSS px at the Standard viewports this suite pins, while the
// card measures 119 px at 100% zoom and 229 px at 200%. So "re-home to true dead space"
// is unreachable by translation alone at EVERY measured viewport — the card has to be
// narrowed to fit the space it is being moved into. The alternative (fall straight through
// to the hud home) was measured too, and it is not a smaller cost: the hud's row
// reservation spends the full 40dvh budget, taking the board from cellPx 33 → 23 at
// 1512×854 and 28 → 19 at 1000×720. Losing a third of the board to protect a corner of it
// is not the trade this issue asked for.
//
// STABILITY BY CONSTRUCTION, the property `main.ts`'s ResizeObserver depends on: every
// input below comes from the STAGE and the BOARD, never from the card's own box. Capping
// the card's width changes its height, which the observer sees — and re-running this
// function with that new height yields the identical answer, because the height is not an
// input. That is also why the vertical (top/bottom) letterbox bands are deliberately NOT
// candidates: judging them needs the card's height, and they measure 1-10 px at every
// Standard viewport probed (35 px at the widest, against a 65 px card), so they would buy
// a feedback loop and nothing else.

import { createProjection } from '@wynding/render';

/** Gap held between the card and the stage edge, in CSS px — the `0.5rem` inset the card
 *  already used at 100% zoom, pinned as a px constant for the same reason the card's own
 *  width cap is px: a rem-scaled gap would eat a fixed-px dead band as text grows. */
export const PREVIEW_FLOAT_GAP_PX = 8;

/** The card's own width cap from `ui.css` (`max-width: min(256px, 45%)`), mirrored here
 *  because a band WIDER than the cap must not stretch the card past it. `layout.test.ts`
 *  asserts the stylesheet still carries this number, so the two cannot drift. */
export const PREVIEW_FLOAT_CAP_PX = 256;

/** How much wider the right band must be before it actually beats the left one, in CSS px.
 *
 *  A TIE TOLERANCE, not a preference weight, and it is load-bearing rather than cosmetic.
 *  `.wy-board` is `inset: 0` inside `.wy-stage`, so the letterbox is the projection's own:
 *  with `rem = stageWidth - cellPx*cols`, the grid starts at `floor(rem/2)` and the two
 *  bands come out at `floor(rem/2) + borrow - gap` and `ceil(rem/2) + borrow - gap`. Their
 *  difference is therefore `ceil(rem/2) - floor(rem/2)`, which is **0 for an even integer
 *  remainder, 1 for an odd one, and under 2 for any fractional one** — so the right band is
 *  never narrower, and a bare `leftRoom >= rightRoom` test hands it every odd remainder.
 *  "Ties go left" then described only the even half of reality.
 *
 *  The failure that makes this a defect rather than a nit: dragging a window horizontally
 *  moves `rem` one pixel at a time, so its parity ALTERNATES, so the card would jump from
 *  one side of the Stage to the other on consecutive ResizeObserver ticks — a strobe across
 *  the board for the whole drag. A tolerance strictly greater than the largest possible
 *  difference removes the parity from the decision entirely: the side stops depending on a
 *  bit that flips every pixel. Every fixture this suite had happened to land on an even
 *  remainder, which is why sixteen green viewport sweeps never witnessed it. */
export const PREVIEW_FLOAT_SIDE_BIAS_PX = 2;

/** The narrowest card this module will place. Below it the float is abandoned for the hud
 *  home: at 64 px even the content diet's shortest row ("10 × Creep") wraps per word at
 *  100% zoom, and a card that cannot render one row is not a surface — it is a smear over
 *  the board's border ring. Deliberately a px constant, not a rem one: the card is
 *  px-capped precisely so zoom grows its wrapping and never its box (#96 P1), and a
 *  rem-scaled floor would re-home the float at 200% zoom on stages where it fits fine. */
export const PREVIEW_FLOAT_MIN_W_PX = 64;

/** Everything the placement needs, all of it read off the STAGE and the BOARD. */
export interface PreviewFloatInput {
  readonly stageWidth: number;
  readonly stageHeight: number;
  /** The board element's box relative to the stage's own box. */
  readonly boardLeft: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  /** Board size in cells — `ruleset.board.grid`'s width/height. */
  readonly cols: number;
  readonly rows: number;
}

/** Where the float goes, or that it has nowhere compliant to go.
 *
 *  `unmeasured` is NOT a failure: jsdom lays nothing out and reports zeroes, and a stage
 *  mid-resize can report a degenerate box. Both mean "no signal", which must leave the
 *  stylesheet's own default placement alone rather than be read as "no room". */
export type PreviewFloat =
  | { readonly kind: 'unmeasured' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'band';
      /** Which stage edge the card is pinned to. */
      readonly side: 'left' | 'right';
      /** Distance from that edge, CSS px. */
      readonly inset: number;
      /** The width cap the card takes in this band, CSS px. */
      readonly maxWidth: number;
      /** True when the band borrows the board's blocked border ring (the second
       *  preference). Drives the reduced-weight companion form. */
      readonly overBoard: boolean;
    };

/** Place the Standard float, or report that nothing compliant fits.
 *
 *  Preference order, exactly as ratified: the LETTERBOX margins first (the card touches no
 *  grid cell at all), then the board's BLOCKED BORDER band (one cell of permanently
 *  unbuildable terrain — the ring, and the two openings that sit in it), then nothing, at
 *  which point `main.ts` sends the card to its in-flow hud home. Within a tier the WIDER of
 *  the two side bands wins, since the whole constraint here is horizontal room — but only
 *  by a margin worth having: anything inside `PREVIEW_FLOAT_SIDE_BIAS_PX` counts as a tie
 *  and goes left, the card's historical corner and the side away from the Rail. */
export function placePreviewFloat(input: PreviewFloatInput): PreviewFloat {
  const { stageWidth, stageHeight, boardLeft, boardWidth, boardHeight, cols, rows } = input;
  if (stageWidth <= 0 || stageHeight <= 0 || boardWidth <= 0 || boardHeight <= 0) {
    return { kind: 'unmeasured' };
  }

  const projection = createProjection({
    cols,
    rows,
    cssWidth: boardWidth,
    cssHeight: boardHeight,
    dpr: 1,
  });
  const gridLeft = boardLeft + projection.originX;
  const gridRight = gridLeft + projection.cellPx * cols;

  for (const overBoard of [false, true]) {
    // The blocked border ring is one cell deep on every side, so the second tier simply
    // moves the forbidden edge one cell inward.
    const borrow = overBoard ? projection.cellPx : 0;
    const leftRoom = gridLeft + borrow - PREVIEW_FLOAT_GAP_PX;
    const rightRoom = stageWidth - (gridRight - borrow) - PREVIEW_FLOAT_GAP_PX;
    const side = leftRoom + PREVIEW_FLOAT_SIDE_BIAS_PX >= rightRoom ? 'left' : 'right';
    // The room of the band actually CHOSEN, never `max(left, right)`. With a tie tolerance
    // in play those two stop agreeing — left can now win while right is up to 2px wider —
    // and a cap taken from the other side's room would let the card reach exactly that far
    // past its own band, i.e. onto the buildable cells this whole module exists to keep
    // clear. The bug the tolerance would otherwise introduce, closed in the same line.
    const room = Math.floor(side === 'left' ? leftRoom : rightRoom);
    if (room >= PREVIEW_FLOAT_MIN_W_PX) {
      return {
        kind: 'band',
        side,
        inset: PREVIEW_FLOAT_GAP_PX,
        maxWidth: Math.min(PREVIEW_FLOAT_CAP_PX, room),
        overBoard,
      };
    }
  }
  return { kind: 'none' };
}
