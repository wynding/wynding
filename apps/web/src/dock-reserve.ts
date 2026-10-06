// dock-reserve.ts — the Standard Dock's footprint, measured and handed to `ui.css` (#152).
//
// THE DEFECT. The Standard Dock floats over the Stage's bottom-left (`.wy-dock` is
// `position: absolute` against `.wy-shell`, with `z-index: 1`), and the board used to fill the
// whole Stage beneath it. Every cell under the cluster was unreachable by pointer: a tap there
// hit a Dock control instead — on a landscape tablet the Start button, which silently began
// the wave instead of placing the tower the player had armed.
//
// THE FIX (owner ruling on #152). Nothing about the Dock moves — same parent, same z-index,
// same paint order, same focus order. Instead the Standard board STOPS SHORT of it: `ui.css`
// spends `--wy-dock-reserve` as `.wy-main .wy-board { bottom: … }`, so the letterboxed grid is
// laid out in the Stage minus the Dock's band and no playable cell renders beneath it. The
// Dock is TEXT-sized (it wraps into more rows under text zoom, and wraps again when Start
// gives way to Pause + Call wave), so the band is measured rather than assumed.
//
// THE BOUND — WHOLE ROWS (owner rulings on #152: "harden the scrollport", "control wins").
// A measured reserve could grow without limit under zoom and crush the board below its cell
// floor, so the Standard Dock gets its own bounded height. The bound is chosen HERE, in whole
// rows of controls, because only a layout pass can see where the wrapped rows fall:
//
//   room    = Stage height − board rows × cell floor             the most the reserve may take
//   H(k)    = bottom of row k                                    the scroll form's bound
//   k       = the most rows with offset + inset + H(k) ≤ room, and never fewer than ONE
//
// THE INSET IS PAID FOR ONCE, WHEREVER IT LIVES. The bottom safe-area inset is the unbounded
// Dock's bottom PADDING, but the scroll form moves it to the float OFFSET (`ui.css`, THE SCROLL
// FORM), so a pass measures it as `padBottom` from one state and inside `offset` from the other
// — their sum is the same Stage band either way, which is what the fit check charges. The
// BOUND is different: it is only ever written for the scroll form, whose box has no bottom
// padding, so it ends at row k's edge and never carries the inset. Adding the inset to it — as
// a pass entering the scroll form from the unbounded Dock once did — let `inset − gap` px of
// row k+1 show under the bound for a frame, and over-counted the reserve by the inset.
//
// ROUNDING (the QC P1 defect). The board is what the Stage has left after the reserve, and the
// projection FLOORS `height / rows`: a board 0.4px short of 288 is an 11px cell, not a 12px
// one. The reserve used to be rounded up to a whole pixel, which could take up to a pixel the
// floor had been promised — 287.6px at 540×556 after Start. Now nothing is rounded past the
// layout engine's own 1/64px unit, on EITHER side of the comparison: a bound is written only
// if its rounded reserve fits the Stage's exact remainder, and the reserve is written as
// exactly that rounded value. So the board keeps `rows × floor` at any fractional Stage
// height, and it falls short only where ruling 2 says it may.
//
// Only ONE row may overrule the floor (ruling 2, "control wins"), and that row is as tall as
// the TALLEST visible control (owner ruling on #152, 2026-09-24: "one full Dock row" is the
// uniform, tallest-control row — see EVERY ROW IS ONE HEIGHT below). Where one row at that
// height does not fit beside the floor, the row wins and the board yields — the single floor
// exception, recorded in `ui.css`. It is not confined to windows just above the Compact
// trigger: on ordinary phone portrait sizes at 200–300% text a two-line label sets the row
// and the cells drop to ~11px (320×560 at 200%), which the owner accepted.
//
// EVERY ROW IS ONE HEIGHT (round-2 QC). A label can wrap — "Call wave" takes two lines at
// 320px wide and 200% text while its neighbours take one — so left alone a row can be nearly
// twice the height of the row above it. Then a bound sized to the first k rows is not a bound
// on any other k rows: a snapped scroll position shows a sliver of the next row, a row taller
// than the scrollport is never whole, and the end of the range is not a row start. So each
// pass first measures the tallest control's NATURAL height (with the previous equaliser
// lifted) and writes it as `--wy-dock-row-h`, which `ui.css` spends as every Standard Dock
// control's `min-height`: flex lines stretch to their tallest item, so every row is then
// exactly that tall. With rows of height h and gaps of g, k rows span k·h + (k−1)·g, every
// snap position is a multiple of h + g, and the range ends at (n − k)(h + g) — itself a row
// start. Labels of any length keep this: a longer translation raises h for every row alike.
// Nowrap was the alternative, and would overflow the Dock on a long label instead.
//
// A bound of k < n rows is the SCROLL FORM (`wy-dock--scroll`): a vertical scrollport that
// ends exactly at row k's bottom edge — row k+1 begins a row gap further down, wholly out of
// sight — and snaps to row starts, so at rest a row is either wholly visible or wholly
// scrolled out. A single row (at the uniform height) taller than the room the floor leaves is
// ruling 2's exception: that one row is shown whole and the board yields. Its scroll cue is drawn in a gutter beside the rows (`ui.css`), so it costs
// the board no height; `wy-dock--more-below` / `--more-above` say which chevrons it shows.
//
// Compact owns none of this: its Dock is an in-flow block in the status COLUMN, a grid track
// the board never occupies, so every property is cleared there.
//
// THE COUNTDOWN DIAL'S ROOM (#181 QC round 2). The dial (`hud-icons.ts`) is drawn in the
// primary control's inline-start padding, which the control REDISTRIBUTES while the dial shows —
// the start side grows by a shift, the end side gives up exactly as much (`ui.css`) — so the
// control's box, every row and the reserve above are the same with or without it. This pass
// sizes the dial from the control's own font size and decides, from a MEASUREMENT, whether it
// may show at all: the label's ink, moved by the shift, must clear the dial by a real gap and
// stay clear of the control's end edge. A font assumption was the earlier gate, and CI's font
// metrics broke it (the label ran into the dial at 320×900 and 300% text, and past the border on
// narrower windows); a measurement holds on any stack. The dial shows only where the control
// carries `wy-primary--dial`, which the pass sets on a measured fit: anywhere else — no room, a
// page not yet measured, a browser with no layout to measure — the dial and its shift are both
// withheld, and the label sits exactly where it would with no dial at all. Every length is a
// whole px, so the redistribution keeps the same total at any root size: a shift in rem
// rounded each side to the layout unit separately, and moved the control's width by 1/64px at
// 110–130% text.

import { ceil64, px } from './layout-units';

/** The class `ui.css` keys the Standard Dock's scroll form on. */
export const DOCK_SCROLL_CLASS = 'wy-dock--scroll';

/** Set while the scroll form has rows below its scrollport — the cue's down chevron. */
export const DOCK_MORE_BELOW_CLASS = 'wy-dock--more-below';

/** Set while the scroll form has rows above its scrollport — the cue's up chevron. */
export const DOCK_MORE_ABOVE_CLASS = 'wy-dock--more-above';

/** The custom properties this module writes on the Shell — exported so tests and teardown
 *  name them from one place. */
export const DOCK_PROPS = {
  reserve: '--wy-dock-reserve',
  maxHeight: '--wy-dock-max-h',
  rowHeight: '--wy-dock-row-h',
} as const;

/** The stylesheet token this module READS (on `.wy-shell`, inherited from `:root`): the
 *  board's minimum cell size — geometry `ui.css` owns. */
export const CELL_FLOOR_TOKEN = '--wy-cell-floor';

export interface DockReserveTargets {
  /** `.wy-shell` — where the custom properties are written. */
  readonly shell: HTMLElement;
  /** `.wy-stage` — the box the board is laid out in; its bottom edge is the Shell's. */
  readonly stage: HTMLElement;
  /** `.wy-dock` — the cluster whose footprint is reserved. */
  readonly dock: HTMLElement;
  /** The board's row count — board data, the one input no stylesheet can hold. */
  readonly rows: number;
  /** The primary control (Start / Call wave), whose countdown dial this pass sizes and gates
   *  (see THE COUNTDOWN DIAL'S ROOM). Absent, the pass leaves the dial alone. */
  readonly primary?: HTMLElement;
}

/** A measured wrapped row of Dock controls, in the Dock's scroll-content coordinates. */
export interface DockRow {
  readonly top: number;
  readonly bottom: number;
}

/** Remove every property and class this module owns (Compact, and teardown). */
export function clearDockReserve(
  t: Pick<DockReserveTargets, 'shell' | 'dock'> & { readonly primary?: HTMLElement },
): void {
  for (const prop of Object.values(DOCK_PROPS)) t.shell.style.removeProperty(prop);
  t.dock.classList.remove(DOCK_SCROLL_CLASS, DOCK_MORE_BELOW_CLASS, DOCK_MORE_ABOVE_CLASS);
  if (t.primary) {
    for (const prop of Object.values(DIAL_PROPS)) t.primary.style.removeProperty(prop);
    t.primary.classList.remove(DIAL_ROOM_CLASS);
  }
}

// --- The countdown dial's room (see the header) --------------------------------------------

/** Set on the primary control where the pass MEASURED room for the dial: `ui.css` draws the
 *  dial and makes its padding shift only then. */
export const DIAL_ROOM_CLASS = 'wy-primary--dial';

/** The custom properties the pass writes on the primary control, all whole px. */
export const DIAL_PROPS = {
  size: '--wy-dial-size',
  inset: '--wy-dial-inset',
  shift: '--wy-dial-shift',
} as const;

/** The dial's proportions, in the control's em: its box (crown included), its inset from the
 *  control's padding edge, and the gap it keeps from the label — never under `DIAL_GAP_MIN_PX`,
 *  the gap `dock-overlap.spec.ts` holds the label to in the rendered page. */
export const DIAL_SIZE_EM = 0.9;
export const DIAL_INSET_EM = 0.25;
export const DIAL_GAP_EM = 0.25;
export const DIAL_GAP_MIN_PX = 2;

export interface DialGeometry {
  readonly size: number;
  readonly inset: number;
  readonly gap: number;
  /** How far the redistribution moves the label: enough that a label filling the control's
   *  content box starts `gap` past the dial. */
  readonly shift: number;
  /** The unshifted inline padding each side, which the end side gives the shift out of. */
  readonly padding: number;
}

/** The dial's geometry for a control set in `fontPx` with `padding` of unshifted inline padding
 *  each side. Whole px throughout (see the header). */
export function dialGeometry(fontPx: number, padding: number): DialGeometry {
  const size = Math.round(DIAL_SIZE_EM * fontPx);
  const inset = Math.round(DIAL_INSET_EM * fontPx);
  const gap = Math.max(DIAL_GAP_MIN_PX, Math.round(DIAL_GAP_EM * fontPx));
  const shift = Math.max(0, Math.ceil(inset + size + gap - padding - 1e-6));
  return { size, inset, gap, shift, padding };
}

/** One line of the label's ink along the inline axis, from the control's padding-box START
 *  edge, as it lies with NO shift applied. */
export interface InkSpan {
  readonly start: number;
  readonly end: number;
}

/** Whether the dial may show: every line of the label, moved by the shift, starts at least
 *  `gap` past the dial and ends at least the dial's own inset short of the padding box's end
 *  edge — so the label never meets the dial or the control's border — and the end padding can
 *  give the shift without going negative (a clamped padding would change the control's width).
 *  No ink, no dial. */
export function dialFits(geo: DialGeometry, boxWidth: number, ink: readonly InkSpan[]): boolean {
  if (ink.length === 0 || !(boxWidth > 0) || geo.shift > geo.padding) return false;
  const start = Math.min(...ink.map((r) => r.start)) + geo.shift;
  const end = Math.max(...ink.map((r) => r.end)) + geo.shift;
  return start - (geo.inset + geo.size) >= geo.gap - 0.01 && boxWidth - end >= geo.inset - 0.01;
}

/** The label's ink as line boxes: a range over its text gives one per wrapped line; a page with
 *  no range geometry (jsdom) gets the label's own box. */
function inkRects(label: Element): DOMRect[] {
  const range = label.ownerDocument.createRange();
  range.selectNodeContents(label);
  const rects =
    typeof range.getClientRects === 'function'
      ? Array.from(range.getClientRects()).filter((r) => r.width > 0)
      : [];
  return rects.length > 0 ? rects : [label.getBoundingClientRect()];
}

/** A change-gated custom property write: a value that did not move touches nothing. */
function setPx(el: HTMLElement, prop: string, value: number): void {
  const v = `${value}px`;
  if (el.style.getPropertyValue(prop) !== v) el.style.setProperty(prop, v);
}

/** Size the primary control's dial and decide whether it may show (see the header). A hidden
 *  or unlaid-out control is no evidence, and changes nothing. */
export function syncDockDial(primary: HTMLElement | undefined): void {
  if (!primary || primary.hidden) return;
  const cs = primary.ownerDocument.defaultView?.getComputedStyle(primary);
  const label = primary.querySelector('.wy-btn-text');
  const box = primary.getBoundingClientRect();
  if (!cs || !label || !(box.width > 0)) return;
  const rtl = cs.direction === 'rtl';
  const padStart = px(rtl ? cs.paddingRight : cs.paddingLeft);
  const padEnd = px(rtl ? cs.paddingLeft : cs.paddingRight);
  // Measured from the UNSHIFTED layout whatever this pass decided last time, so its verdict is
  // the same from either state and can never flip back and forth: the shift in force now is
  // half the difference between the two sides, and the ink is read back by that much.
  const shiftNow = (padStart - padEnd) / 2;
  // The padding box's edges, unrounded (`clientLeft` / `clientWidth` are whole px, and the end
  // clearance is decided to a fraction of one).
  const left = box.left + px(cs.borderLeftWidth);
  const right = box.right - px(cs.borderRightWidth);
  const width = right - left;
  const ink = inkRects(label).map((r): InkSpan =>
    rtl
      ? { start: right - r.right - shiftNow, end: right - r.left - shiftNow }
      : { start: r.left - left - shiftNow, end: r.right - left - shiftNow },
  );
  const geo = dialGeometry(px(cs.fontSize), (padStart + padEnd) / 2);
  setPx(primary, DIAL_PROPS.size, geo.size);
  setPx(primary, DIAL_PROPS.inset, geo.inset);
  setPx(primary, DIAL_PROPS.shift, geo.shift);
  const fits = dialFits(geo, width, ink);
  if (primary.classList.contains(DIAL_ROOM_CLASS) !== fits) {
    primary.classList.toggle(DIAL_ROOM_CLASS, fits);
  }
}

/** The Dock's visible controls grouped into their wrapped rows, top to bottom. A control is in
 *  the row whose top it shares (1px tolerance: flex lines start on one edge). */
export function measureDockRows(dock: HTMLElement): DockRow[] {
  const box = dock.getBoundingClientRect();
  const origin = box.top + dock.clientTop - dock.scrollTop;
  const rows: { top: number; bottom: number }[] = [];
  for (const btn of Array.from(dock.children) as HTMLElement[]) {
    if (btn.hidden) continue;
    const r = btn.getBoundingClientRect();
    if (r.height <= 0) continue;
    const top = r.top - origin;
    const bottom = r.bottom - origin;
    const row = rows.find((x) => Math.abs(x.top - top) <= 1);
    if (row === undefined) rows.push({ top, bottom });
    else row.bottom = Math.max(row.bottom, bottom);
  }
  return rows.sort((a, b) => a.top - b.top);
}

/** How many whole rows the Dock may show (see the header): the most whose reserve fits the
 *  room, never fewer than one. `n` rows means no bound at all. `height` is the scroll form's
 *  bound for that many rows — row k's bottom edge, with NO bottom padding, because the scroll
 *  form has none (the inset rides on its offset instead; see THE INSET IS PAID FOR ONCE). The
 *  fit check still charges `padBottom`: from the unbounded state that is where the inset is
 *  measured, and from the scroll form it is zero and the inset is inside `offset`. Exported for
 *  its unit tests. */
export function chooseDockRows(o: {
  readonly rows: readonly DockRow[];
  readonly room: number;
  readonly offset: number;
  readonly padBottom: number;
}): { readonly shown: number; readonly height: number } {
  const n = o.rows.length;
  if (n === 0) return { shown: 0, height: 0 };
  const height = (k: number): number => ceil64(o.rows[k - 1]!.bottom);
  for (let k = n; k > 1; k--) {
    if (ceil64(o.offset + o.padBottom + height(k)) <= o.room) {
      return { shown: k, height: height(k) };
    }
  }
  return { shown: 1, height: height(1) };
}

/** Point the scroll cue: a down chevron while rows remain below the scrollport, an up one
 *  while rows remain above it (both, mid-range). 1px slack: fractional rounding, not a row. */
export function syncDockCue(dock: HTMLElement): void {
  const scroll = dock.classList.contains(DOCK_SCROLL_CLASS);
  const below = dock.scrollHeight - dock.clientHeight - dock.scrollTop > 1;
  dock.classList.toggle(DOCK_MORE_BELOW_CLASS, scroll && below);
  dock.classList.toggle(DOCK_MORE_ABOVE_CLASS, scroll && dock.scrollTop > 1);
}

/** One measurement pass. Order matters and is load-bearing: the bound is written FIRST, so the
 *  Dock rect read afterwards is the BOUNDED one — the reserve then describes the box that will
 *  actually paint, not the unbounded box it replaced. */
export function syncDockReserve(t: DockReserveTargets, compact: boolean): void {
  if (compact) {
    clearDockReserve(t);
    return;
  }
  const stage = t.stage.getBoundingClientRect();
  // No layout, no evidence (jsdom, a detached or collapsed Shell): move nothing, rather than
  // write a reserve measured against a box that does not exist.
  if (stage.height <= 0) return;
  const view = t.dock.ownerDocument.defaultView;
  const shellCs = view?.getComputedStyle(t.shell);
  const dockCs = view?.getComputedStyle(t.dock);
  const floor = px(shellCs?.getPropertyValue(CELL_FLOOR_TOKEN));
  const padBottom = px(dockCs?.paddingBottom);
  const style = t.shell.style;

  // One row height for every row (see the header). Lifted first, so the tallest control is
  // read at its natural height rather than at the height the last pass imposed — a shorter
  // label (Start coming back, a smaller zoom) must be able to lower it again.
  style.removeProperty(DOCK_PROPS.rowHeight);
  let tallest = 0;
  for (const btn of Array.from(t.dock.children) as HTMLElement[]) {
    if (!btn.hidden) tallest = Math.max(tallest, btn.getBoundingClientRect().height);
  }
  if (tallest > 0) style.setProperty(DOCK_PROPS.rowHeight, `${ceil64(tallest)}px`);

  // The float offset — the Stage band below the Dock, which the reserve pays for too. Measured
  // rather than read from `bottom`, so it is whatever the layout really resolved.
  const offset = Math.max(0, stage.bottom - t.dock.getBoundingClientRect().bottom);
  const room = stage.height - t.rows * floor;
  const rows = measureDockRows(t.dock);
  const { shown, height } = chooseDockRows({ rows, room, offset, padBottom });

  if (shown < rows.length) {
    style.setProperty(DOCK_PROPS.maxHeight, `${height}px`);
    t.dock.classList.add(DOCK_SCROLL_CLASS);
  } else {
    style.removeProperty(DOCK_PROPS.maxHeight);
    t.dock.classList.remove(DOCK_SCROLL_CLASS);
  }

  // Everything from the Dock's top edge down to the Stage's bottom edge — the Dock itself,
  // plus the offset it floats above the viewport edge. Rounded UP, so no sliver of cell sits
  // under the cluster — but only to the layout unit, so the floor keeps every px it was
  // promised (see ROUNDING in the header).
  const dock = t.dock.getBoundingClientRect();
  const reserve = Math.max(0, ceil64(stage.bottom - dock.top));
  style.setProperty(DOCK_PROPS.reserve, `${reserve}px`);
  syncDockCue(t.dock);
  // Last, on the bounded layout: the dial moves no box (see the header), so nothing above
  // depends on it.
  syncDockDial(t.primary);
}
