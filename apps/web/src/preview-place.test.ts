// preview-place.test.ts — the ratified placement rule as arithmetic (#101).
//
// Every geometry below is MEASURED off the shipped build at a viewport this repo's e2e
// suite actually pins, not invented: the point of the module is that real Standard stages
// leave real dead space, and a fixture nobody can reach would prove nothing about that.

import { describe, it, expect } from 'vitest';
import {
  placePreviewFloat,
  PREVIEW_FLOAT_CAP_PX,
  PREVIEW_FLOAT_GAP_PX,
  PREVIEW_FLOAT_MIN_W_PX,
  type PreviewFloatInput,
} from './preview-place';

/** A stage whose board fills it exactly — the shipped layout (`.wy-board` is `inset: 0`
 *  inside `.wy-stage`), so the letterbox is the projection's, not the element's. */
function stage(width: number, height: number): PreviewFloatInput {
  return {
    stageWidth: width,
    stageHeight: height,
    boardLeft: 0,
    boardWidth: width,
    boardHeight: height,
    cols: 28,
    rows: 24,
  };
}

describe('preview-place — the compliant band (#101)', () => {
  it('takes the LETTERBOX margin when it fits, covering no grid cell at all (1512×854)', () => {
    // 1144×810 stage → 33px cells → a 924×792 grid centred with 110px margins.
    expect(placePreviewFloat(stage(1144, 810))).toEqual({
      kind: 'band',
      side: 'left',
      inset: PREVIEW_FLOAT_GAP_PX,
      maxWidth: 102, // 110 − the 8px gap
      overBoard: false,
    });
  });

  it('borrows the BLOCKED BORDER ring only when the letterbox alone is too narrow (1440×900)', () => {
    // 1072×856 stage → 35px cells → 46px margins. 38px of letterbox is under the floor;
    // one cell of blocked ring lifts it to 81px, i.e. 73px usable.
    expect(placePreviewFloat(stage(1072, 856))).toEqual({
      kind: 'band',
      side: 'left',
      inset: PREVIEW_FLOAT_GAP_PX,
      maxWidth: 73,
      overBoard: true,
    });
  });

  it('gives up when even the borrowed ring is under the legibility floor (1000×720)', () => {
    // 820×676 stage → 28px cells → an 18px margin; 46px with the ring borrowed, 38px
    // usable. A card that narrow wraps the diet's shortest row per word, so the hud takes
    // it — the ratified escape hatch, reached by measurement rather than by a threshold.
    expect(placePreviewFloat(stage(820, 676))).toEqual({ kind: 'none' });
  });

  it('reads a degenerate box as NO SIGNAL, never as no room (jsdom, and a stage mid-resize)', () => {
    // The distinction is load-bearing: `none` re-homes the card to the hud, which on a wide
    // Standard stage costs the board a third of its cells. An unlaid-out box must never
    // trigger that — it must leave the stylesheet's own default placement alone.
    for (const degenerate of [
      stage(0, 0),
      { ...stage(1144, 810), stageWidth: 0 },
      { ...stage(1144, 810), stageHeight: 0 },
      { ...stage(1144, 810), boardWidth: 0 },
      { ...stage(1144, 810), boardHeight: 0 },
    ]) {
      expect(placePreviewFloat(degenerate)).toEqual({ kind: 'unmeasured' });
    }
  });

  it('never stretches the card past its own stylesheet cap, however wide the band', () => {
    // A very wide, short stage letterboxes hugely on the horizontal axis. The card's box is
    // still `min(256px, …)` — a band wider than the cap must not grow it.
    const wide = placePreviewFloat(stage(2400, 700));
    expect(wide).toMatchObject({ kind: 'band', maxWidth: PREVIEW_FLOAT_CAP_PX });
  });

  it('follows the WIDER band and ties go LEFT — the card’s historical corner, away from the Rail', () => {
    const centred = placePreviewFloat(stage(1144, 810));
    expect(centred).toMatchObject({ side: 'left' });
    // Push the board right inside the stage: now the left margin is the wide one still, so
    // shift it the other way to prove the choice is measured rather than hardcoded.
    const boardOnLeft = placePreviewFloat({
      ...stage(1144, 810),
      boardLeft: 0,
      boardWidth: 900, // a 900-wide board pinned at the stage's left edge
    });
    expect(boardOnLeft).toMatchObject({ side: 'right' });
  });

  it('the legibility floor is a real edge — one pixel decides float vs hud', () => {
    // Straddle the cliff that actually matters: the LAST tier (letterbox + the borrowed
    // blocked ring) landing either side of the floor, which is what decides whether the
    // card keeps the Stage at all. A 720-tall board puts 24 rows at exactly 30px cells and
    // 28 cols at 840px, so the margin is `(boardWidth − 840) / 2` and cellPx holds still
    // while the width moves. Floor is cleared when `margin + cellPx − gap ≥ 64`.
    const stripe = (margin: number): PreviewFloatInput => {
      const width = 840 + 2 * margin;
      return { ...stage(width, 720), boardWidth: width, boardHeight: 720 };
    };
    // margin 42 → 42 + 30 − 8 = 64, exactly the floor.
    expect(placePreviewFloat(stripe(42))).toMatchObject({
      kind: 'band',
      maxWidth: PREVIEW_FLOAT_MIN_W_PX,
      overBoard: true,
    });
    // margin 41 → 63, one pixel under it, and the hud takes the card.
    expect(placePreviewFloat(stripe(41))).toEqual({ kind: 'none' });
    // ...and the letterbox alone would have needed `64 + gap` of margin to skip the ring.
    expect(placePreviewFloat(stripe(PREVIEW_FLOAT_MIN_W_PX + PREVIEW_FLOAT_GAP_PX))).toMatchObject({
      maxWidth: PREVIEW_FLOAT_MIN_W_PX,
      overBoard: false,
    });
  });

  it('is a pure function of the STAGE and the BOARD — the card’s own box is not an input', () => {
    // The stability property `main.ts`'s ResizeObserver depends on: capping the card's
    // width changes its height, the observer fires, and re-running must return the SAME
    // answer or the two would chase each other forever. There is no card parameter to pass,
    // which is the strongest form of that guarantee — this asserts the shape stays that way.
    const input = stage(1144, 810);
    expect(placePreviewFloat(input)).toEqual(placePreviewFloat({ ...input }));
    expect(Object.keys(input).sort()).toEqual([
      'boardHeight',
      'boardLeft',
      'boardWidth',
      'cols',
      'rows',
      'stageHeight',
      'stageWidth',
    ]);
  });
});
