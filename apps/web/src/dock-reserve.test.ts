// dock-reserve.test.ts — the Standard Dock footprint pass (#152). jsdom lays nothing out, so
// every box is driven at the element seam; the rendered outcome (no buildable cell under the
// Dock, the 12px floor and its one exception, whole rows at rest, the scroll cue, keyboard
// reach inside the bounded scrollport) is `dock-overlap.spec.ts`'s.
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ceil64,
  CELL_FLOOR_TOKEN,
  chooseDockRows,
  clearDockReserve,
  DIAL_GAP_MIN_PX,
  DIAL_PROPS,
  DIAL_ROOM_CLASS,
  dialFits,
  dialGeometry,
  DOCK_MORE_ABOVE_CLASS,
  DOCK_MORE_BELOW_CLASS,
  DOCK_PROPS,
  DOCK_SCROLL_CLASS,
  measureDockRows,
  syncDockCue,
  syncDockDial,
  syncDockReserve,
  type DialGeometry,
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
  /** The bottom safe-area inset, modelled as `ui.css` places it: the unbounded Dock's bottom
   *  PADDING, which the scroll form (`wy-dock--scroll`) zeroes and adds to its float offset
   *  instead. Replaces `padBottom`, which stays put in both forms. */
  inset?: number;
  rows?: number;
  floor?: string | null;
}): Rig {
  const shell = document.createElement('div');
  const stage = document.createElement('div');
  const dock = document.createElement('div');
  shell.append(stage, dock);
  document.body.append(shell);
  if (opts.floor !== null) shell.style.setProperty(CELL_FLOOR_TOKEN, opts.floor ?? '12px');
  const inset = opts.inset ?? 0;
  const scrolled = (): boolean => dock.classList.contains(DOCK_SCROLL_CLASS);
  const padBottom = (): number => (opts.padBottom ?? 0) + (scrolled() ? 0 : inset);
  const restyle = (): void => void (dock.style.paddingBottom = `${padBottom()}px`);
  restyle();
  // The class is the stylesheet's switch, so every write to it re-applies the padding rule.
  const classes = dock.classList;
  for (const method of ['add', 'remove', 'toggle'] as const) {
    const original = classes[method].bind(classes) as (...args: never[]) => unknown;
    Object.defineProperty(classes, method, {
      value: (...args: never[]) => {
        const out = original(...args);
        restyle();
        return out;
      },
    });
  }
  const stageTop = opts.stageTop ?? 0;
  const stageBottom = stageTop + opts.stageHeight;
  const dockBottom = (): number => stageBottom - (opts.offset ?? 8) - (scrolled() ? inset : 0);
  const natural = (): number =>
    Math.max(0, ...opts.controls.map(([top, h]) => top + h)) +
    (opts.controls.length ? padBottom() : 0);
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
    return Number.isFinite(max) ? Math.min(natural(), max) : natural();
  };
  const dockTop = (): number => dockBottom() - height();
  stage.getBoundingClientRect = () => rect(stageTop, opts.stageHeight);
  dock.getBoundingClientRect = () => rect(dockTop(), height());
  Object.defineProperty(dock, 'scrollTop', {
    get: () => r.scrollTop,
    set: (v: number) => void (r.scrollTop = v),
  });
  Object.defineProperty(dock, 'scrollHeight', { get: () => natural() });
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
    // The bottom padding (the safe-area inset, measured on the unbounded Dock) is part of the
    // Stage band the reserve pays for — so it counts in the FIT (8 + 20 + 96 = 124)...
    expect(chooseDockRows({ rows, room: 124, offset: 8, padBottom: 20 })).toEqual({
      shown: 2,
      // ...but never in the BOUND: the scroll form has no bottom padding (the inset moves to
      // its offset), so a bound of 96 + 20 would show 20 − 8 = 12px of row 3 under it.
      height: 96,
    });
    expect(chooseDockRows({ rows, room: 123.9, offset: 8, padBottom: 20 })).toEqual({
      shown: 1,
      height: 44,
    });
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

  it('entering the scroll form with a bottom inset bounds at the row edge, not row edge + inset', () => {
    // An unbounded Dock of two 44px rows (8px gap) over a 20px inset, on a Stage whose room
    // (388 − 288 = 100) fits one row's band (8 + 20 + 44 = 72) but not two (8 + 20 + 96 = 124).
    // The pass starts UNBOUNDED, so it measures the inset as bottom padding — and the scroll form
    // it switches to has none. A bound of 44 + 20 would show 12px of row 2 for a frame and
    // reserve 92.
    const r = rig({ stageHeight: 388, controls: TWO_ROWS, inset: 20 });
    syncDockReserve(r, false);
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);
    expect(prop(r.shell, DOCK_PROPS.maxHeight)).toBe('44px');
    expect(r.dock.getBoundingClientRect().height).toBe(44); // row 1, whole, and nothing of row 2
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('72px'); // 8 + 20 + 44: the inset once
    // The next pass reads the scroll form (inset now inside the offset) and writes the same.
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.maxHeight)).toBe('44px');
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('72px');
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

// --- The countdown dial's measured room (#181 QC round 2) ------------------------------------

describe('dialGeometry (#181 QC round 2)', () => {
  it('sizes the dial from the control’s font in WHOLE px, and shifts the label just past it', () => {
    // The base `.wy-btn` padding is 0.9rem a side and the control's font 1rem: 100%, 110%, 200%
    // and 300% text.
    expect(dialGeometry(16, 14.4)).toEqual({ size: 14, inset: 4, gap: 4, shift: 8, padding: 14.4 });
    expect(dialGeometry(17.6, 15.84)).toEqual({
      size: 16,
      inset: 4,
      gap: 4,
      shift: 9,
      padding: 15.84,
    });
    expect(dialGeometry(32, 28.8)).toEqual({
      size: 29,
      inset: 8,
      gap: 8,
      shift: 17,
      padding: 28.8,
    });
    expect(dialGeometry(48, 43.2)).toEqual({
      size: 43,
      inset: 12,
      gap: 12,
      shift: 24,
      padding: 43.2,
    });
  });

  it('at every text size, a label filling its content box starts at least the gap past the dial, and the end padding can pay the shift', () => {
    for (let font = 8; font <= 64; font += 0.4) {
      const padding = 0.9 * font;
      const g = dialGeometry(font, padding);
      for (const v of [g.size, g.inset, g.gap, g.shift])
        expect(Number.isInteger(v), `${font}`).toBe(true);
      expect(g.gap, `${font}`).toBeGreaterThanOrEqual(DIAL_GAP_MIN_PX);
      // The content box's start edge, moved by the shift, against the dial's far edge.
      expect(padding + g.shift - (g.inset + g.size), `${font}`).toBeGreaterThanOrEqual(
        g.gap - 1e-9,
      );
      // …by the least whole px that does it.
      expect(padding + g.shift - 1 - (g.inset + g.size), `${font}`).toBeLessThan(g.gap);
      expect(g.shift, `${font}`).toBeLessThanOrEqual(padding);
    }
  });

  it('never keeps less than a 2px gap, however small the text', () => {
    expect(DIAL_GAP_MIN_PX).toBe(2);
    expect(dialGeometry(4, 3.6).gap).toBe(2);
    expect(dialGeometry(7, 6.3).gap).toBe(2);
    expect(dialGeometry(10, 9).gap).toBe(3);
  });
});

describe('dialFits (#181 QC round 2)', () => {
  // 100% text: a 14px dial 4px in, the label moved 8px; a 96px padding box.
  const g: DialGeometry = dialGeometry(16, 14.4);
  const W = 96;

  it('fits a label that, moved by the shift, clears the dial by the gap and the end by the inset', () => {
    // A 40px label centred in the content box (14.4 → 81.6): unshifted at 28 → 68.
    expect(dialFits(g, W, [{ start: 28, end: 68 }])).toBe(true);
  });

  it('the dial side: exactly the gap fits, a hair less does not', () => {
    const atGap = g.inset + g.size + g.gap - g.shift; // 14
    expect(dialFits(g, W, [{ start: atGap, end: 60 }])).toBe(true);
    expect(dialFits(g, W, [{ start: atGap - 0.02, end: 60 }])).toBe(false);
    // A word that spills into the start padding meets the dial outright.
    expect(dialFits(g, W, [{ start: 2, end: 60 }])).toBe(false);
  });

  it('the end side: the label must stay the dial’s inset short of the padding box’s end edge', () => {
    const atEnd = W - g.inset - g.shift; // 84
    expect(dialFits(g, W, [{ start: 30, end: atEnd }])).toBe(true);
    expect(dialFits(g, W, [{ start: 30, end: atEnd + 0.02 }])).toBe(false);
  });

  it('every line of a wrapped label counts', () => {
    expect(
      dialFits(g, W, [
        { start: 30, end: 60 },
        { start: 20, end: 70 },
      ]),
    ).toBe(true);
    expect(
      dialFits(g, W, [
        { start: 30, end: 60 },
        { start: 10, end: 70 },
      ]),
    ).toBe(false);
  });

  it('no ink, no box, or a shift the end padding cannot pay: no dial', () => {
    expect(dialFits(g, W, [])).toBe(false);
    expect(dialFits(g, 0, [{ start: 28, end: 68 }])).toBe(false);
    expect(dialFits({ ...g, padding: g.shift - 0.5 }, W, [{ start: 28, end: 68 }])).toBe(false);
  });
});

describe('syncDockDial (#181 QC round 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  /** A primary control at x = 50: a 2px border, `pad` inline padding a side (as the base rule
   *  sets it), `font` px text, and a label whose ink lines sit at `ink` — each [start, end] from
   *  the padding box's START edge as the label lies UNSHIFTED. `applied` is the shift the
   *  stylesheet has in force right now: it redistributes the paddings and moves the ink, as the
   *  browser lays the control out. */
  function primaryRig(opts: {
    width?: number;
    font?: number;
    pad?: number;
    ink: [number, number][];
    applied?: number;
    rtl?: boolean;
    hidden?: boolean;
  }): { primary: HTMLButtonElement; label: HTMLSpanElement } {
    const width = opts.width ?? 100;
    const pad = opts.pad ?? 14.4;
    const applied = opts.applied ?? 0;
    const rtl = opts.rtl ?? false;
    const primary = document.createElement('button');
    primary.className = 'wy-btn wy-primary';
    primary.hidden = opts.hidden ?? false;
    const label = document.createElement('span');
    label.className = 'wy-btn-text';
    label.textContent = 'Call wave';
    primary.append(label);
    document.body.append(primary);
    primary.style.fontSize = `${opts.font ?? 16}px`;
    primary.style.border = '2px solid';
    primary.style.direction = rtl ? 'rtl' : 'ltr';
    primary.style.paddingLeft = `${rtl ? pad - applied : pad + applied}px`;
    primary.style.paddingRight = `${rtl ? pad + applied : pad - applied}px`;
    const x0 = 50;
    primary.getBoundingClientRect = () =>
      ({
        x: x0,
        y: 0,
        left: x0,
        top: 0,
        width,
        height: 44,
        right: x0 + width,
        bottom: 44,
      }) as DOMRect;
    const left = x0 + 2;
    const right = x0 + width - 2;
    const rects = opts.ink.map(([start, end], i) => {
      const [a, b] = rtl
        ? [right - (end + applied), right - (start + applied)]
        : [left + start + applied, left + end + applied];
      return { left: a, right: b, width: b - a, top: 10 + 12 * i, height: 12 } as DOMRect;
    });
    // jsdom's Range has no geometry, so the label's ink lines come from a stand-in range.
    const range = { selectNodeContents: () => undefined, getClientRects: () => rects };
    vi.spyOn(document, 'createRange').mockReturnValue(range as unknown as Range);
    return { primary, label };
  }

  const room = (el: HTMLElement): boolean => el.classList.contains(DIAL_ROOM_CLASS);

  it('sizes the dial in whole px and opens its room where the moved label clears it', () => {
    const { primary } = primaryRig({ ink: [[28, 68]] });
    syncDockDial(primary);
    expect(prop(primary, DIAL_PROPS.size)).toBe('14px');
    expect(prop(primary, DIAL_PROPS.inset)).toBe('4px');
    expect(prop(primary, DIAL_PROPS.shift)).toBe('8px');
    expect(room(primary)).toBe(true);
  });

  it('withholds the dial — and so its shift — where the moved label would meet it', () => {
    const { primary } = primaryRig({ ink: [[8, 88]] });
    primary.classList.add(DIAL_ROOM_CLASS); // a stale verdict from a wider control
    syncDockDial(primary);
    expect(room(primary)).toBe(false);
    // Sized all the same, so the dial is ready the moment there is room.
    expect(prop(primary, DIAL_PROPS.shift)).toBe('8px');
  });

  it('withholds it where the moved label would run into the control’s end', () => {
    // Clears the dial (starts 12px past it once moved) but would end 2px from the border.
    const { primary } = primaryRig({ ink: [[22, 86]] });
    primary.classList.add(DIAL_ROOM_CLASS);
    syncDockDial(primary);
    expect(room(primary)).toBe(false);
  });

  it('reads the same verdict from the SHIFTED layout as from the unshifted one — it can never flip back and forth', () => {
    // The shift is in force exactly while the control carries the class (`ui.css`), so a pass
    // after a room verdict reads a SHIFTED layout and must read it back to the unshifted one.
    // Counted twice, the shift would spend the end clearance of a label that fits — [28, 80],
    // 8px clear — and drop the dial it just drew, then draw it again: a flip every pass. And a
    // class left by a wider label must come off a label that meets the dial — [8, 60], which a
    // second shift would carry clear of it.
    const cases: [[number, number][], boolean][] = [
      [[[28, 68]], true],
      [[[8, 88]], false],
      [[[22, 86]], false],
      [[[28, 80]], true],
      [[[8, 60]], false],
    ];
    for (const [ink, fits] of cases) {
      document.body.replaceChildren();
      vi.restoreAllMocks();
      const plain = primaryRig({ ink }).primary;
      syncDockDial(plain);
      expect(room(plain), `unshifted ${JSON.stringify(ink)}`).toBe(fits);
      vi.restoreAllMocks();
      const shifted = primaryRig({ ink, applied: 8 }).primary;
      shifted.classList.add(DIAL_ROOM_CLASS); // the shift is in force only under the class
      syncDockDial(shifted);
      expect(room(shifted), `shifted ${JSON.stringify(ink)}`).toBe(fits);
      expect(prop(shifted, DIAL_PROPS.shift)).toBe('8px');
    }
  });

  it('measures from the inline START edge in a right-to-left control', () => {
    // Each ink is [start, end] from the inline-START edge, and right to left that edge is the
    // control's RIGHT one: the verdict must be the left-to-right verdict for the same ink. A
    // centred label reads the same from either edge, so the lopsided ones carry this — and a
    // label is lopsided exactly where the dial is in question, since one too wide for its
    // control is start-aligned and overflows at its end (CSS Text). [20, 83] fits, 5px short of
    // the end; [13, 60] starts 3px from the dial. Read from the wrong edge, each flips.
    const cases: [[number, number][], boolean][] = [
      [[[28, 68]], true],
      [[[8, 88]], false],
      [[[20, 83]], true],
      [[[13, 60]], false],
    ];
    for (const [ink, fits] of cases) {
      for (const rtl of [false, true]) {
        vi.restoreAllMocks();
        document.body.replaceChildren();
        // From the other verdict, as the page holds it: a first, unshifted pass for a label that
        // fits; a class left by a wider label — its shift still in force — for one that does not.
        const { primary } = primaryRig({ ink, rtl, applied: fits ? 0 : 8 });
        primary.classList.toggle(DIAL_ROOM_CLASS, !fits);
        syncDockDial(primary);
        expect(room(primary), `${JSON.stringify(ink)} ${rtl ? 'rtl' : 'ltr'}`).toBe(fits);
      }
    }
  });

  it('every line of a wrapped label counts', () => {
    const { primary } = primaryRig({
      ink: [
        [30, 60],
        [10, 70],
      ],
    });
    syncDockDial(primary);
    expect(room(primary)).toBe(false);
  });

  it('a hidden or unlaid-out control is no evidence: nothing changes', () => {
    const { primary } = primaryRig({ ink: [[8, 88]], hidden: true });
    primary.classList.add(DIAL_ROOM_CLASS);
    syncDockDial(primary);
    expect(room(primary)).toBe(true);
    expect(prop(primary, DIAL_PROPS.size)).toBe('');
    primary.hidden = false;
    primary.getBoundingClientRect = () => ({ width: 0 }) as DOMRect;
    syncDockDial(primary);
    expect(room(primary)).toBe(true);
    expect(prop(primary, DIAL_PROPS.size)).toBe('');
    syncDockDial(undefined); // and no primary at all is no error
  });

  it('writes nothing when nothing moved (#98’s discipline)', async () => {
    const { primary } = primaryRig({ ink: [[28, 68]] });
    syncDockDial(primary);
    const seen: MutationRecord[] = [];
    const mo = new MutationObserver((records) => seen.push(...records));
    mo.observe(primary, { attributes: true, subtree: true, childList: true });
    syncDockDial(primary);
    syncDockDial(primary);
    await Promise.resolve();
    mo.disconnect();
    expect(seen).toEqual([]);
  });

  it('the Standard Dock pass sizes the dial; Compact and teardown clear its props and class', () => {
    const r = rig({ stageHeight: 600, controls: TWO_ROWS });
    const { primary } = primaryRig({ ink: [[28, 68]] });
    const t = { ...r, primary };
    syncDockReserve(t, false);
    expect(room(primary)).toBe(true);
    expect(prop(primary, DIAL_PROPS.shift)).toBe('8px');
    syncDockReserve(t, true);
    expect(room(primary)).toBe(false);
    for (const name of Object.values(DIAL_PROPS)) expect(prop(primary, name), name).toBe('');
    syncDockReserve(t, false);
    expect(room(primary)).toBe(true);
    clearDockReserve(t);
    expect(room(primary)).toBe(false);
    for (const name of Object.values(DIAL_PROPS)) expect(prop(primary, name), name).toBe('');
  });
});
