// hud-cut.ts — Compact's chips column rests on WHOLE items (#181 QC round 2).
//
// THE DEFECT. Compact's status column is a flex column: the home mark, then the chips
// (`.wy-hud`, the one item that grows, and a scrollport), then the Dock at the bottom. The
// chips take whatever height the mark and the Dock leave, and that height has nothing to do
// with where a chip ends — so at 658×320 before Start the column showed four chips and the top
// third of a fifth, cut through its icon and value just above the Dock: half a number nobody
// can read, which looks like a rendering fault.
//
// THE RULE. At rest — the scrollport not scrolled — the column shows only whole items. Its
// visible height is cut down to the bottom edge of the last chip (or wave-strip line) that fits
// whole in the room the column gives it. The room it gives up stays empty above the Dock, which
// keeps its place at the column's bottom (`margin-top: auto`, `ui.css`), so nothing else in the
// column moves. Every chip stays reachable as before: the scrollport scrolls through all of
// them by touch, wheel and keyboard, and while it moves it may show part of an item.
//
// The cut is written as `--wy-hud-cut` on the scrollport, which the Compact stylesheet spends as
// its `max-height`. Standard owns none of it — its chips are a row with its own cap — so the
// property is cleared there.

/** The custom property the Compact stylesheet spends as the chips column's `max-height`. */
export const HUD_CUT_PROP = '--wy-hud-cut';

/** What the column holds, top to bottom: the chips, and the wave strip's title and lines. */
const ITEMS =
  ':scope > .wy-chip, :scope > .wy-wave-preview .wy-wave-preview-title, ' +
  ':scope > .wy-wave-preview .wy-preview-entry';

/** The visible height for a column whose items end at `bottoms` — px below the scrollport's
 *  padding-box top, in its content — when `room` px of it can show: the bottom edge of the last
 *  item that fits whole. `null`, no cut, where every item fits (there is nothing to hide) or none
 *  does (there is nothing whole to show, so the column keeps the room it has). */
export function chooseHudCut(room: number, bottoms: readonly number[]): number | null {
  const fit = bottoms.filter((b) => b <= room + 0.01);
  if (fit.length === 0 || fit.length === bottoms.length) return null;
  return Math.max(...fit);
}

/** Rounds UP to the 1/64px layout unit, so the last whole item is never clipped by a fraction. */
const ceil64 = (v: number): number => Math.ceil(v * 64 - 1e-6) / 64;

function px(value: string | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/** Remove the cut (Standard, and teardown). */
export function clearHudCut(hud: HTMLElement): void {
  hud.style.removeProperty(HUD_CUT_PROP);
}

/** Cut the Compact chips column at its last whole item (see the header). A column with no
 *  layout is no evidence, and changes nothing. */
export function syncHudCut(hud: HTMLElement, compact: boolean): void {
  if (!compact) {
    clearHudCut(hud);
    return;
  }
  const cs = hud.ownerDocument.defaultView?.getComputedStyle(hud);
  if (!cs) return;
  // Measured with the cut LIFTED, so the room is what the column gives the scrollport rather
  // than what the last cut left it. Lifting it can clamp the scroll position, so that is put
  // back whatever the outcome: a resize never moves the chips under a reader.
  const before = hud.style.getPropertyValue(HUD_CUT_PROP);
  const scrollTop = hud.scrollTop;
  if (before !== '') hud.style.removeProperty(HUD_CUT_PROP);
  const box = hud.getBoundingClientRect();
  const top = box.top + px(cs.borderTopWidth);
  const room = box.bottom - px(cs.borderBottomWidth) - top;
  let next = before;
  if (room > 0) {
    const bottoms = Array.from(hud.querySelectorAll<HTMLElement>(ITEMS))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .map((r) => r.bottom - top + hud.scrollTop);
    const cut = chooseHudCut(room, bottoms);
    // The cut is the PADDING box's height; `max-height` sizes whichever box `box-sizing` names.
    const frame =
      cs.boxSizing === 'border-box'
        ? px(cs.borderTopWidth) + px(cs.borderBottomWidth)
        : -(px(cs.paddingTop) + px(cs.paddingBottom));
    next = cut === null ? '' : `${ceil64(cut + frame)}px`;
  }
  if (next !== '') hud.style.setProperty(HUD_CUT_PROP, next);
  if (hud.scrollTop !== scrollTop) hud.scrollTop = scrollTop;
}
