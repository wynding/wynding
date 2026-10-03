// dock-ring.ts — whether the countdown ring and its hint fit beside the Standard Dock (#181 H1).
//
// The ring's slot (`ShellRing.root`) is a ZERO-WIDTH in-flow item on the primary control's row,
// so it can never wrap the Dock or raise a row (`ui.css`, `.wy-dock-ring`). Its visible ring and
// hint, though, are painted BESIDE the Dock — in the Stage band the Dock reserve already keeps
// clear of the board (#152, `dock-reserve.ts`) — and that band ends where the Rail begins. This
// module measures whether they fit before that edge and says so with two classes: `ui.css`
// drops the hint first (the brief's "drop the hint, never wrap the Dock") and the ring only when
// even the ring itself would reach the Rail.
//
// Measured, not styled, because only a layout pass knows where the primary control's row ends:
// labels wrap under zoom, change with the run ("Start" → "Call wave"), and translate.
//
// No feedback loop: both classes toggle `visibility` on boxes that are absolutely positioned, so
// neither moves any box the Dock pass observes. The hidden boxes keep their size precisely so the
// next pass can measure them again — that is what lets a hint come back when room returns.

/** Set while the hint would reach past the Stage's right edge. */
export const RING_NO_HINT_CLASS = 'wy-dock-ring--no-hint';

/** Set while even the ring would reach past it. */
export const RING_OFF_CLASS = 'wy-dock-ring--off';

/** Room kept between the ring's ink and the Stage's right edge (the Rail's left edge) — the
 *  Dock's own float offset, so the ring sits off the Rail by the margin the Dock sits off the
 *  viewport. */
export const RING_EDGE_GAP_PX = 8;

export interface RingFitInput {
  /** Right edge of the ring graphic, in viewport px. */
  readonly ringRight: number;
  /** Right edge of the hint text, in viewport px. */
  readonly hintRight: number;
  /** Right edge of the Stage, in viewport px. */
  readonly stageRight: number;
}

/** What fits: the ring when its right edge clears the Stage edge by the gap, and the hint only
 *  when the ring does too (a hint with no ring beside it would be a caption for nothing). */
export function ringFit(i: RingFitInput): { readonly ring: boolean; readonly hint: boolean } {
  const limit = i.stageRight - RING_EDGE_GAP_PX;
  const ring = i.ringRight <= limit;
  return { ring, hint: ring && i.hintRight <= limit };
}

/** The parts this pass reads. */
export interface RingTargets {
  readonly root: HTMLElement;
  readonly ring: { readonly svg: Element };
  readonly hint: HTMLElement;
}

/** One measurement pass. Clears both classes whenever the ring is not rendered at all (hidden
 *  with no countdown to show, or `display: none` — Compact, and the Dock's scroll form), so no
 *  stale verdict outlives the layout it was measured in. A Stage with no layout box is no
 *  evidence, so it changes nothing. */
export function syncDockRing(t: RingTargets, stage: HTMLElement): void {
  const root = t.root;
  if (root.hidden || root.getClientRects().length === 0) {
    // `toggle(…, false)`, never `remove`: `remove` rewrites the class attribute even when
    // neither class is present, and this runs on every Dock pass the ring sits out.
    root.classList.toggle(RING_OFF_CLASS, false);
    root.classList.toggle(RING_NO_HINT_CLASS, false);
    return;
  }
  const stageBox = stage.getBoundingClientRect();
  if (stageBox.width <= 0) return;
  const fit = ringFit({
    ringRight: t.ring.svg.getBoundingClientRect().right,
    hintRight: t.hint.getBoundingClientRect().right,
    stageRight: stageBox.right,
  });
  root.classList.toggle(RING_OFF_CLASS, !fit.ring);
  root.classList.toggle(RING_NO_HINT_CLASS, !fit.hint);
}
