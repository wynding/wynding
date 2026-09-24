// dock-reserve.test.ts — the Standard Dock footprint pass (#152). jsdom lays nothing out, so
// every box is driven at the element seam; the rendered outcome (no buildable cell under the
// Dock, the 12px floor and its one exception, whole rows at rest, the scroll cue, keyboard
// reach inside the bounded scrollport) is `dock-overlap.spec.ts`'s.
import { describe, it, expect } from 'vitest';
import {
  ceil64,
  CELL_FLOOR_TOKEN,
  chooseDockRows,
  clearDockReserve,
  DOCK_MORE_ABOVE_CLASS,
  DOCK_MORE_BELOW_CLASS,
  DOCK_PROPS,
  DOCK_SCROLL_CLASS,
  measureDockRows,
  syncDockCue,
  syncDockReserve,
  type DockReserveTargets,
} from './dock-reserve';

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    width: 100,
    height,
    right: 100,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

interface Rig extends DockReserveTargets {
  readonly buttons: HTMLButtonElement[];
  scrollTop: number;
}

/** A Stage whose bottom edge is at `stageTop + stageHeight`, and a Dock floating `offset` above
 *  it whose controls sit at `controls` (top, height) in the Dock's CONTENT coordinates. The
 *  Dock's box behaves as the browser's does: as tall as its content, unless `--wy-dock-max-h`
 *  bounds it — so a test can prove the reserve is read from the BOUNDED box. */
function rig(opts: {
  stageTop?: number;
  stageHeight: number;
  offset?: number;
  controls: [number, number][];
  padBottom?: number;
  rows?: number;
  floor?: string | null;
}): Rig {
  const shell = document.createElement('div');
  const stage = document.createElement('div');
  const dock = document.createElement('div');
  shell.append(stage, dock);
  document.body.append(shell);
  if (opts.floor !== null) shell.style.setProperty(CELL_FLOOR_TOKEN, opts.floor ?? '12px');
  const padBottom = opts.padBottom ?? 0;
  dock.style.paddingBottom = `${padBottom}px`;
  const stageTop = opts.stageTop ?? 0;
  const stageBottom = stageTop + opts.stageHeight;
  const dockBottom = stageBottom - (opts.offset ?? 8);
  const natural =
    Math.max(0, ...opts.controls.map(([top, h]) => top + h)) +
    (opts.controls.length ? padBottom : 0);
  const r: Rig = {
    shell,
    stage,
    dock,
    rows: opts.rows ?? 24,
    buttons: [],
    scrollTop: 0,
  };
  const height = (): number => {
    const max = parseFloat(shell.style.getPropertyValue(DOCK_PROPS.maxHeight));
    return Number.isFinite(max) ? Math.min(natural, max) : natural;
  };
  const dockTop = (): number => dockBottom - height();
  stage.getBoundingClientRect = () => rect(stageTop, opts.stageHeight);
  dock.getBoundingClientRect = () => rect(dockTop(), height());
  Object.defineProperty(dock, 'scrollTop', {
    get: () => r.scrollTop,
    set: (v: number) => void (r.scrollTop = v),
  });
  Object.defineProperty(dock, 'scrollHeight', { get: () => natural });
  Object.defineProperty(dock, 'clientHeight', { get: () => height() });
  for (const [top, h] of opts.controls) {
    const b = document.createElement('button');
    b.getBoundingClientRect = () => rect(dockTop() + top - r.scrollTop, h);
    dock.append(b);
    r.buttons.push(b);
  }
  return r;
}

const prop = (el: HTMLElement, name: string): string => el.style.getPropertyValue(name);

/** Two wrapped rows of 44px controls with an 8px row gap: the started Dock at 540×556, 100%. */
const TWO_ROWS: [number, number][] = [
  [0, 44],
  [0, 44],
  [0, 44],
  [52, 44],
];

describe('measureDockRows (#152)', () => {
  it('groups the visible controls into their wrapped rows, in scroll-content coordinates', () => {
    const r = rig({
      stageHeight: 400,
      controls: [
        [0, 44],
        [0.6, 43], // a sub-pixel-offset control is still in the first flex line
        [52, 44],
        [104, 49],
      ],
    });
    r.buttons[2]!.hidden = true; // a hidden control (Pause pre-start) takes no row
    r.scrollTop = 30; // scrolled: rows are still read from the content's own origin
    expect(measureDockRows(r.dock)).toEqual([
      { top: 0, bottom: 44 },
      { top: 104, bottom: 153 },
    ]);
  });

  it('ignores a control with no box', () => {
    const r = rig({ stageHeight: 400, controls: [[0, 0]] });
    expect(measureDockRows(r.dock)).toEqual([]);
  });
});

describe('chooseDockRows (#152)', () => {
  const rows = [
    { top: 0, bottom: 44 },
    { top: 52, bottom: 96 },
    { top: 104, bottom: 148 },
  ];

  it('shows every row — no bound — when the whole Dock fits the room', () => {
    expect(chooseDockRows({ rows, room: 156, offset: 8, padBottom: 0 })).toEqual({
      shown: 3,
      height: 148,
    });
  });

  it('otherwise shows the most WHOLE rows that fit, ending exactly at a row edge', () => {
    expect(chooseDockRows({ rows, room: 155.9, offset: 8, padBottom: 0 })).toEqual({
      shown: 2,
      height: 96,
    });
    // The bottom padding (the safe-area inset) is part of the Dock's rendered height.
    expect(chooseDockRows({ rows, room: 124, offset: 8, padBottom: 20 })).toEqual({
      shown: 2,
      height: 116,
    });
    expect(chooseDockRows({ rows, room: 123.9, offset: 8, padBottom: 20 }).shown).toBe(1);
  });

  it('never fewer than one row: the floor exception (owner ruling 2, "control wins")', () => {
    expect(chooseDockRows({ rows, room: 40, offset: 8, padBottom: 0 })).toEqual({
      shown: 1,
      height: 44,
    });
  });

  it('judges a fractional row by its reserve rounded to the layout unit — never to a whole px', () => {
    const frac = [
      { top: 0, bottom: 49.3 },
      { top: 57.3, bottom: 106.6 },
    ];
    // 106.6 → 106.609375 (1/64px), so the reserve is 7.2 + 106.609375 → 113.8125.
    expect(chooseDockRows({ rows: frac, room: 113.8125, offset: 7.2, padBottom: 0 })).toEqual({
      shown: 2,
      height: 106.609375,
    });
    // A whole-px rounding (114) would have refused this room, and a 1/64 short one fits nothing.
    expect(chooseDockRows({ rows: frac, room: 113.8, offset: 7.2, padBottom: 0 }).shown).toBe(1);
  });

  it('an empty Dock shows nothing', () => {
    expect(chooseDockRows({ rows: [], room: 100, offset: 8, padBottom: 0 })).toEqual({
      shown: 0,
      height: 0,
    });
  });
});

describe('ceil64 (#152)', () => {
  it('rounds UP to the 1/64px layout unit, and no further', () => {
    expect(ceil64(52.4)).toBe(52.40625);
    expect(ceil64(51.203125)).toBe(51.203125); // already a whole unit
    expect(ceil64(52 + 1e-9)).toBe(52); // float noise in a whole unit costs nothing
  });
});

describe('syncDockReserve (#152)', () => {
  it('reserves everything from the Dock top edge to the Stage bottom, rounded UP to the layout unit', () => {
    const r = rig({ stageTop: 44, stageHeight: 676, offset: 8.4, controls: [[0, 44]] });
    syncDockReserve(r, false);
    // 8.4 + 44 = 52.4 → 52.40625: never under (a sliver of cell under the Dock), and never a
    // whole px over (the floor's pixel — see the next case).
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('52.40625px');
  });

  it('a whole-px reserve would break the floor at a fractional Stage — this one does not (the QC P1 rounding)', () => {
    // 540×506 at 90% text: the offset is 7.2px (0.5rem), one 44px row, Stage 339.625. The
    // reserve is 51.203125 and the board keeps 288.42px; rounded to 52px it kept 287.625 —
    // an 11px cell at a size the floor exception does not cover (339.625 ≥ 288 + 7.2 + 44).
    const r = rig({ stageHeight: 339.625, offset: 7.2, controls: [[0, 44]] });
    syncDockReserve(r, false);
    const reserve = parseFloat(prop(r.shell, DOCK_PROPS.reserve));
    expect(reserve).toBe(51.203125);
    expect(339.625 - reserve).toBeGreaterThanOrEqual(24 * 12);
  });

  it('keeps the board at rows × floor at a FRACTIONAL Stage height when the Dock wraps (the QC P1 case)', () => {
    // 540×556 after Start: Stage 373.61, room 85.61; both rows need 8 + 96 = 104, so ONE row is
    // shown. The CSS-only bound this replaced left 287.61px — an 11px cell.
    const r = rig({ stageHeight: 373.61, controls: TWO_ROWS });
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.maxHeight)).toBe('44px');
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);
    const reserve = parseFloat(prop(r.shell, DOCK_PROPS.reserve));
    expect(reserve).toBe(52);
    expect(373.61 - reserve).toBeGreaterThanOrEqual(24 * 12);
  });

  it('the floor is the stylesheet token, read not assumed, and the rows are the board data', () => {
    // A 16px floor on a 20-row board: room 400 − 320 = 80 → one row (8 + 96 > 80).
    const r = rig({ stageHeight: 400, controls: TWO_ROWS, floor: '16px', rows: 20 });
    syncDockReserve(r, false);
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);
    // The same Dock with a 12px floor fits both rows: room 400 − 240 = 160.
    const r2 = rig({ stageHeight: 400, controls: TWO_ROWS, floor: '12px', rows: 20 });
    syncDockReserve(r2, false);
    expect(r2.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(false);
    expect(prop(r2.shell, DOCK_PROPS.maxHeight)).toBe('');
  });

  it('writes the bound BEFORE reading the Dock, so the reserve describes the bounded box', () => {
    const r = rig({ stageHeight: 373.61, controls: TWO_ROWS });
    syncDockReserve(r, false);
    // Unbounded, the Dock would be 96px tall and the reserve 104.
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('52px');
  });

  it('writes ONE row height for every row: the tallest visible control, read at its natural height', () => {
    // 320×640 at 200% after Start: "Call wave" wraps to two lines (86px), its neighbours do
    // not (49px). A stale, larger value from an earlier pass must not ratchet: it is lifted
    // before the controls are read.
    const r = rig({
      stageHeight: 464,
      controls: [
        [0, 49],
        [57, 86.3],
        [151, 49],
        [208, 120],
      ],
    });
    r.buttons[3]!.hidden = true; // a hidden control takes no part
    let liftedBeforeRead: boolean | undefined; // at the FIRST read, the tallest-control scan
    const read = r.buttons[1]!.getBoundingClientRect.bind(r.buttons[1]);
    r.buttons[1]!.getBoundingClientRect = () => {
      liftedBeforeRead ??= prop(r.shell, DOCK_PROPS.rowHeight) === '';
      return read();
    };
    r.shell.style.setProperty(DOCK_PROPS.rowHeight, '200px');
    syncDockReserve(r, false);
    expect(liftedBeforeRead).toBe(true);
    expect(prop(r.shell, DOCK_PROPS.rowHeight)).toBe(`${ceil64(86.3)}px`);
  });

  it('a Dock that fits carries no bound and no scroll form', () => {
    const r = rig({ stageHeight: 700, controls: TWO_ROWS });
    r.shell.style.setProperty(DOCK_PROPS.maxHeight, '44px'); // stale, from a shorter Stage
    r.dock.classList.add(DOCK_SCROLL_CLASS, DOCK_MORE_BELOW_CLASS);
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.maxHeight)).toBe('');
    expect(r.dock.className).toBe('');
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('104px');
  });

  it('the floor exception: a Stage too short for one row AND the floor keeps the row', () => {
    // 900×501 at 175%: Stage 333.61, room 45.61 < 8 + 44. The row wins.
    const r = rig({ stageHeight: 333.61, controls: TWO_ROWS });
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.maxHeight)).toBe('44px');
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('52px');
    expect(333.61 - 52).toBeLessThan(24 * 12); // the board yields — this case only
  });

  it('points the cue while the scroll form has rows beyond the scrollport', () => {
    const r = rig({ stageHeight: 373.61, controls: TWO_ROWS });
    syncDockReserve(r, false);
    expect(r.dock.classList.contains(DOCK_MORE_BELOW_CLASS)).toBe(true);
    expect(r.dock.classList.contains(DOCK_MORE_ABOVE_CLASS)).toBe(false);
  });

  it('moves nothing without a laid-out Stage — no evidence is not a zero reserve', () => {
    const r = rig({ stageHeight: 0, controls: [[0, 44]] });
    r.shell.style.setProperty(DOCK_PROPS.reserve, '52px');
    r.dock.classList.add(DOCK_SCROLL_CLASS);
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('52px');
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);
  });

  it('never writes a negative reserve', () => {
    // A Dock below the Stage's bottom edge (a transient mid-resize).
    const r = rig({ stageHeight: 100, offset: -100, controls: [[0, 44]] });
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('0px');
  });

  it('Compact owns none of it: every property and class is cleared', () => {
    const r = rig({ stageHeight: 373.61, controls: TWO_ROWS });
    syncDockReserve(r, false);
    for (const p of Object.values(DOCK_PROPS)) expect(prop(r.shell, p)).not.toBe('');
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);

    syncDockReserve(r, true);
    for (const p of Object.values(DOCK_PROPS)) expect(prop(r.shell, p)).toBe('');
    expect(r.dock.className).toBe('');
  });

  it('clearDockReserve is the same clear, for teardown', () => {
    const r = rig({ stageHeight: 373.61, controls: TWO_ROWS });
    syncDockReserve(r, false);
    r.dock.classList.add(DOCK_MORE_ABOVE_CLASS);
    clearDockReserve(r);
    for (const p of Object.values(DOCK_PROPS)) expect(prop(r.shell, p)).toBe('');
    expect(r.dock.className).toBe('');
  });

  it('with no floor token and no window to compute styles in, it reads both as zero', () => {
    const doc = document.implementation.createHTMLDocument('detached');
    const shell = doc.createElement('div');
    const stage = doc.createElement('div');
    const dock = doc.createElement('div');
    const btn = doc.createElement('button');
    btn.getBoundingClientRect = () => rect(348, 44);
    dock.append(btn);
    stage.getBoundingClientRect = () => rect(0, 400);
    dock.getBoundingClientRect = () => rect(348, 44);
    syncDockReserve({ shell, stage, dock, rows: 24 }, false);
    expect(shell.style.getPropertyValue(DOCK_PROPS.reserve)).toBe('52px');
    expect(shell.style.getPropertyValue(DOCK_PROPS.maxHeight)).toBe('');
  });
});

describe('syncDockCue (#152)', () => {
  function port(scrollTop: number, scroll = true): HTMLElement {
    const el = document.createElement('div');
    if (scroll) el.classList.add(DOCK_SCROLL_CLASS);
    Object.defineProperty(el, 'scrollHeight', { value: 96 });
    Object.defineProperty(el, 'clientHeight', { value: 44 });
    el.scrollTop = scrollTop;
    Object.defineProperty(el, 'scrollTop', { value: scrollTop });
    return el;
  }
  const cls = (el: HTMLElement): [boolean, boolean] => [
    el.classList.contains(DOCK_MORE_ABOVE_CLASS),
    el.classList.contains(DOCK_MORE_BELOW_CLASS),
  ];

  it('down at the top, both mid-range, up at the end — with 1px of rounding slack', () => {
    const top = port(0);
    syncDockCue(top);
    expect(cls(top)).toEqual([false, true]);
    const mid = port(26);
    syncDockCue(mid);
    expect(cls(mid)).toEqual([true, true]);
    const end = port(51.5); // 0.5px short of the 52px range: rounding, not a row
    syncDockCue(end);
    expect(cls(end)).toEqual([true, false]);
  });

  it('points nowhere outside the scroll form', () => {
    const el = port(10, false);
    el.classList.add(DOCK_MORE_BELOW_CLASS, DOCK_MORE_ABOVE_CLASS);
    syncDockCue(el);
    expect(cls(el)).toEqual([false, false]);
  });
});
