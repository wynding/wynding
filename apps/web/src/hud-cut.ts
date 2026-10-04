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
// WHERE NO ITEM FITS WHOLE. Compact's glances wrap once the column is narrower than an icon and
// its value together (#181 QC round 2), so a chip at heavy text is two lines tall — and after
// Start, on a 320px-tall phone at 150–200% text, the Dock leaves the chips less room than that.
// The column then rests on the last whole LINE of its first item: the countdown's seconds,
// which wrap above its clock (`ui.css`), the clock one scroll away — never the top half of a
// number. Only where not even one line fits does it keep the room it has.
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

/** One painted part of an item — an icon's box, or one line of its text — in px below the
 *  scrollport's padding-box top, in its content. */
export interface PaintedPart {
  readonly top: number;
  readonly bottom: number;
}

/** The visible height for a column whose items end at `bottoms` — px below the scrollport's
 *  padding-box top, in its content — when `room` px of it can show: the bottom edge of the last
 *  item that fits whole. `null`, no cut, where every item fits (there is nothing to hide). Where
 *  none fits, the last whole line of the first item, whose painted parts are `firstParts` (see
 *  the header); `null` where not even that fits, and the column keeps the room it has. */
export function chooseHudCut(
  room: number,
  bottoms: readonly number[],
  firstParts: readonly PaintedPart[] = [],
): number | null {
  const fit = bottoms.filter((b) => b <= room + 0.01);
  if (fit.length === bottoms.length) return null;
  if (fit.length > 0) return Math.max(...fit);
  return lastWholeLine(room, firstParts);
}

/** The deepest bottom edge within `room` of a painted part that no other part runs through: a
 *  cut there shows every part above it whole and none of the rest. `null` where there is none. */
export function lastWholeLine(room: number, parts: readonly PaintedPart[]): number | null {
  let best: number | null = null;
  for (const { bottom } of parts) {
    if (bottom > room + 0.01) continue;
    if (parts.some((p) => p.top < bottom - 0.01 && p.bottom > bottom + 0.01)) continue;
    if (best === null || bottom > best) best = bottom;
  }
  return best;
}

/** The painted parts of `item`, `toContent` mapping a viewport y to the scrollport's content:
 *  every SVG's box and every line of text in its visible form — a chip's or a strip line's
 *  glance, never its visually hidden sentence, or else the item itself (the strip's title). Text
 *  in a `display: none` companion has no line boxes, so it adds nothing. */
function paintedParts(item: HTMLElement, toContent: (y: number) => number): PaintedPart[] {
  const shown = item.querySelector<HTMLElement>('.wy-chip-glance, .wy-preview-glance') ?? item;
  const parts: PaintedPart[] = [];
  const add = (r: DOMRect): void => {
    if (r.width > 0 && r.height > 0)
      parts.push({ top: toContent(r.top), bottom: toContent(r.bottom) });
  };
  for (const svg of shown.querySelectorAll('svg')) add(svg.getBoundingClientRect());
  const doc = item.ownerDocument;
  const walker = doc.createTreeWalker(shown, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(n);
    // A page with no range geometry (jsdom) has no text lines to offer.
    if (typeof range.getClientRects !== 'function') continue;
    for (const r of range.getClientRects()) add(r);
  }
  return parts;
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
    const toContent = (y: number): number => y - top + hud.scrollTop;
    const items = Array.from(hud.querySelectorAll<HTMLElement>(ITEMS))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0);
    const bottoms = items.map(({ r }) => toContent(r.bottom));
    // The first item's lines are read only where no item fits whole, which is rare.
    const first = items[0];
    const none = first !== undefined && bottoms.every((b) => b > room + 0.01);
    const cut = chooseHudCut(room, bottoms, none ? paintedParts(first.el, toContent) : []);
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
