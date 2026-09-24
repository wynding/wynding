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
//   H(k)    = bottom of row k + bottom padding                   the Dock showing k whole rows
//   k       = the most rows with offset + H(k) ≤ room, and never fewer than ONE
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
// Only the first row may overrule the floor (ruling 2, "control wins"): where the Stage is too
// short for one row and the floor both, the row wins and the board yields — the single floor
// exception, recorded in `ui.css`.
//
// A bound of k < n rows is the SCROLL FORM (`wy-dock--scroll`): a vertical scrollport that
// ends exactly at row k's bottom edge — row k+1 begins a row gap further down, wholly out of
// sight — and snaps to row starts, so at rest a row is either wholly visible or wholly
// scrolled out. Its scroll cue is drawn in a gutter beside the rows (`ui.css`), so it costs
// the board no height; `wy-dock--more-below` / `--more-above` say which chevrons it shows.
//
// Compact owns none of this: its Dock is an in-flow block in the status COLUMN, a grid track
// the board never occupies, so every property is cleared there.

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
}

/** A measured wrapped row of Dock controls, in the Dock's scroll-content coordinates. */
export interface DockRow {
  readonly top: number;
  readonly bottom: number;
}

/** Rounds `v` UP to the layout engine's 1/64px unit — never past it. A bound or reserve
 *  rounded any coarser takes board height the floor was promised; one rounded down leaves a
 *  sliver of cell under the Dock. (The `1e-6` absorbs float noise in a value that is already
 *  a whole number of units, so noise never costs a unit.) Exported for its unit tests. */
export function ceil64(v: number): number {
  return Math.ceil(v * 64 - 1e-6) / 64;
}

/** Remove every property and class this module owns (Compact, and teardown). */
export function clearDockReserve(t: Pick<DockReserveTargets, 'shell' | 'dock'>): void {
  for (const prop of Object.values(DOCK_PROPS)) t.shell.style.removeProperty(prop);
  t.dock.classList.remove(DOCK_SCROLL_CLASS, DOCK_MORE_BELOW_CLASS, DOCK_MORE_ABOVE_CLASS);
}

function px(value: string | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
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
 *  room, never fewer than one. `n` rows means no bound at all. Exported for its unit tests. */
export function chooseDockRows(o: {
  readonly rows: readonly DockRow[];
  readonly room: number;
  readonly offset: number;
  readonly padBottom: number;
}): { readonly shown: number; readonly height: number } {
  const n = o.rows.length;
  if (n === 0) return { shown: 0, height: 0 };
  const height = (k: number): number => ceil64(o.rows[k - 1]!.bottom + o.padBottom);
  for (let k = n; k > 1; k--) {
    if (ceil64(o.offset + height(k)) <= o.room) return { shown: k, height: height(k) };
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

  // The float offset — the Stage band below the Dock, which the reserve pays for too. Measured
  // rather than read from `bottom`, so it is whatever the layout really resolved.
  const offset = Math.max(0, stage.bottom - t.dock.getBoundingClientRect().bottom);
  const room = stage.height - t.rows * floor;
  const rows = measureDockRows(t.dock);
  const { shown, height } = chooseDockRows({ rows, room, offset, padBottom });

  const style = t.shell.style;
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
}
