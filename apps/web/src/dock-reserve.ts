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
// Dock is TEXT-sized (it wraps into more rows under text zoom), so the band is measured rather
// than assumed.
//
// THE BOUND. A measured reserve could grow without limit under heavy zoom and crush the board
// below its 12px cell floor, so the Standard Dock also gets its own bounded height (the
// Compact Dock has had one since Story 11). `ui.css` derives it from the geometry — Stage
// height, minus the Dock's bottom offset, minus the board's floor height — and this module
// supplies the two inputs CSS cannot see: the Stage's height, and the tallest Dock control
// (the bound never drops below one whole control, so a focused control always fits).
// Whatever no longer fits scrolls inside the Dock; `wy-dock--scroll` is set exactly while it
// does, which is also what switches the Dock's focus rings inside their own border boxes so
// the scrollport cannot clip them.
//
// Compact owns none of this: its Dock is an in-flow block in the status COLUMN, a grid track
// the board never occupies, so every property is cleared there.

/** The class `ui.css` keys the Standard Dock's scroll form on. */
export const DOCK_SCROLL_CLASS = 'wy-dock--scroll';

/** The custom properties this module writes on the Shell — exported so tests and teardown
 *  name them from one place. */
export const DOCK_PROPS = {
  reserve: '--wy-dock-reserve',
  stageHeight: '--wy-stage-h',
  minHeight: '--wy-dock-min-h',
} as const;

export interface DockReserveTargets {
  /** `.wy-shell` — where the custom properties are written. */
  readonly shell: HTMLElement;
  /** `.wy-stage` — the box the board is laid out in; its bottom edge is the Shell's. */
  readonly stage: HTMLElement;
  /** `.wy-dock` — the cluster whose footprint is reserved. */
  readonly dock: HTMLElement;
}

/** Remove every property and class this module owns (Compact, and teardown). */
export function clearDockReserve(t: DockReserveTargets): void {
  for (const prop of Object.values(DOCK_PROPS)) t.shell.style.removeProperty(prop);
  t.dock.classList.remove(DOCK_SCROLL_CLASS);
}

/** One measurement pass. Order matters and is load-bearing: the bound's inputs are written
 *  FIRST, so the Dock rect read afterwards is the BOUNDED one — the reserve then describes the
 *  box that will actually paint, not the unbounded box it replaced. */
export function syncDockReserve(t: DockReserveTargets, compact: boolean): void {
  if (compact) {
    clearDockReserve(t);
    return;
  }
  const stage = t.stage.getBoundingClientRect();
  // No layout, no evidence (jsdom, a detached or collapsed Shell): move nothing, rather than
  // write a reserve measured against a box that does not exist.
  if (stage.height <= 0) return;
  const style = t.shell.style;
  style.setProperty(DOCK_PROPS.stageHeight, `${stage.height}px`);

  // The tallest visible control plus the Dock's own block padding (the bottom safe-area inset
  // lives there): the smallest scrollport that still shows one whole control.
  let tallest = 0;
  for (const btn of Array.from(t.dock.children) as HTMLElement[]) {
    if (btn.hidden) continue;
    tallest = Math.max(tallest, btn.getBoundingClientRect().height);
  }
  const view = t.dock.ownerDocument.defaultView;
  const cs = view?.getComputedStyle(t.dock);
  const padBlock =
    (parseFloat(cs?.paddingTop ?? '') || 0) + (parseFloat(cs?.paddingBottom ?? '') || 0);
  style.setProperty(DOCK_PROPS.minHeight, `${Math.ceil(tallest + padBlock)}px`);

  // Everything from the Dock's top edge down to the Stage's bottom edge — the Dock itself,
  // plus the offset it floats above the viewport edge. Rounded UP: a sub-pixel under-reserve
  // is a sliver of cell under the cluster, which is the defect.
  const dock = t.dock.getBoundingClientRect();
  const reserve = Math.max(0, Math.ceil(stage.bottom - dock.top));
  style.setProperty(DOCK_PROPS.reserve, `${reserve}px`);

  // The scroll form. The 1px slack absorbs fractional-height rounding between the two
  // integer-valued reads, so a Dock that fits does not flicker into a 1px scrollport.
  t.dock.classList.toggle(DOCK_SCROLL_CLASS, t.dock.scrollHeight > t.dock.clientHeight + 1);
}
