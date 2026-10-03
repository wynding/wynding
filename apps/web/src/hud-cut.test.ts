// hud-cut.test.ts — Compact's chips column rests on whole items (#181 QC round 2). jsdom lays
// nothing out, so every box is driven at the element seam; the rendered outcome (whole items at
// rest, the Dock and the chips unmoved, every chip reachable) is `compact.spec.ts`'s.
import { afterEach, describe, it, expect } from 'vitest';
import { chooseHudCut, clearHudCut, HUD_CUT_PROP, syncHudCut } from './hud-cut';

describe('chooseHudCut (#181 QC round 2)', () => {
  it('cuts at the bottom of the last item that fits whole', () => {
    expect(chooseHudCut(100, [20, 45, 70, 95, 120])).toBe(95);
    expect(chooseHudCut(94, [20, 45, 70, 95, 120])).toBe(70);
  });

  it('no cut where every item fits — nothing to hide — or none does — nothing whole to show', () => {
    expect(chooseHudCut(200, [20, 45, 70])).toBeNull();
    expect(chooseHudCut(70, [20, 45, 70])).toBeNull();
    expect(chooseHudCut(10, [20, 45])).toBeNull();
    expect(chooseHudCut(100, [])).toBeNull();
  });

  it('an item ending at the room’s edge is whole, to a hundredth of a px', () => {
    expect(chooseHudCut(95, [20, 95, 120])).toBe(95);
    expect(chooseHudCut(94.995, [20, 95, 120])).toBe(95);
    expect(chooseHudCut(94.98, [20, 95, 120])).toBe(20);
  });

  it('reads the bottoms in any order', () => {
    expect(chooseHudCut(100, [95, 120, 20, 70])).toBe(95);
  });
});

describe('syncHudCut (#181 QC round 2)', () => {
  afterEach(() => document.body.replaceChildren());

  const TOP = 40;
  const rect = (top: number, height: number): DOMRect =>
    ({ x: 0, y: top, left: 0, top, width: 60, height, right: 60, bottom: top + height }) as DOMRect;

  /** A Compact chips column whose border box starts at y = 40 and is `room` px tall — or less,
   *  where the cut bounds it, as the stylesheet makes it. Its chips end `bottoms` px into its
   *  content (below the padding box's top), each 20px tall; `strip` adds the wave strip's title
   *  and lines the same way. Its scroll position clamps to its range like a browser's. */
  function column(opts: {
    room: number;
    bottoms: number[];
    strip?: { title: number; lines: number[] };
    zeroBox?: number[];
    boxSizing?: 'content-box' | 'border-box';
    pad?: [number, number];
    border?: number;
    scrollTop?: number;
  }): HTMLElement {
    const hud = document.createElement('div');
    hud.className = 'wy-hud';
    const border = opts.border ?? 0;
    const [padTop, padBottom] = opts.pad ?? [0, 0];
    hud.style.boxSizing = opts.boxSizing ?? 'content-box';
    hud.style.border = `${border}px solid`;
    hud.style.paddingTop = `${padTop}px`;
    hud.style.paddingBottom = `${padBottom}px`;
    document.body.append(hud);
    const all = [...opts.bottoms, ...(opts.strip ? [opts.strip.title, ...opts.strip.lines] : [])];
    const contentEnd = Math.max(0, ...all) + padBottom;
    /** The padding box's visible height: the room, or the cut where it bounds it. */
    const visible = (): number => {
      const cut = parseFloat(hud.style.getPropertyValue(HUD_CUT_PROP));
      if (!Number.isFinite(cut)) return opts.room;
      const padBox =
        hud.style.boxSizing === 'border-box' ? cut - 2 * border : cut + padTop + padBottom;
      return Math.min(opts.room, padBox);
    };
    let scroll = opts.scrollTop ?? 0;
    const range = (): number => Math.max(0, contentEnd - visible());
    Object.defineProperty(hud, 'scrollTop', {
      configurable: true,
      get: () => (scroll = Math.min(scroll, range())),
      set: (v: number) => void (scroll = Math.max(0, Math.min(v, range()))),
    });
    hud.getBoundingClientRect = () => rect(TOP, opts.room > 0 ? visible() + 2 * border : 0);
    const item = (el: HTMLElement, bottom: number, height = 20): HTMLElement => {
      el.getBoundingClientRect = () => rect(TOP + border + bottom - height - hud.scrollTop, height);
      return el;
    };
    for (const [i, bottom] of opts.bottoms.entries()) {
      const chip = document.createElement('span');
      chip.className = 'wy-chip';
      hud.append(item(chip, bottom, opts.zeroBox?.includes(i) ? 0 : 20));
    }
    if (opts.strip) {
      const strip = document.createElement('div');
      strip.className = 'wy-wave-preview';
      const title = document.createElement('p');
      title.className = 'wy-wave-preview-title';
      const list = document.createElement('ul');
      list.className = 'wy-wave-preview-list';
      for (const bottom of opts.strip.lines) {
        const li = document.createElement('li');
        li.className = 'wy-preview-entry';
        list.append(item(li, bottom, 12));
      }
      strip.append(item(title, opts.strip.title, 14), list);
      hud.append(strip);
    }
    return hud;
  }

  const cut = (hud: HTMLElement): string => hud.style.getPropertyValue(HUD_CUT_PROP);

  it('stops the column at its last whole item', () => {
    const hud = column({ room: 100, bottoms: [20, 45, 70, 95, 120] });
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('95px');
  });

  it('measures the room with the last cut LIFTED, so the column can grow back into it', () => {
    const hud = column({ room: 100, bottoms: [20, 45, 70, 95, 120] });
    hud.style.setProperty(HUD_CUT_PROP, '45px'); // a cut from a shorter column
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('95px');
  });

  it('counts the wave strip’s title and each of its lines as items', () => {
    const hud = column({
      room: 130,
      bottoms: [20, 45, 70],
      strip: { title: 95, lines: [110, 125, 140] },
    });
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('125px');
  });

  it('skips an item with no box — a hidden chip', () => {
    const hud = column({ room: 100, bottoms: [20, 45, 70, 95, 120], zeroBox: [3] });
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('70px');
  });

  it('sizes the box `max-height` sizes: the content box, or the border box', () => {
    const content = column({ room: 100, bottoms: [24, 49, 74, 99, 124], pad: [4, 6] });
    syncHudCut(content, true);
    expect(cut(content)).toBe(`${99 - 4 - 6}px`);
    document.body.replaceChildren();
    const border = column({
      room: 100,
      bottoms: [20, 45, 70, 95, 120],
      boxSizing: 'border-box',
      border: 2,
    });
    syncHudCut(border, true);
    expect(cut(border)).toBe(`${95 + 2 * 2}px`);
  });

  it('rounds the cut UP to the layout unit, so the last whole item never loses a fraction', () => {
    const hud = column({ room: 100, bottoms: [20, 45.3, 70.61, 120] });
    syncHudCut(hud, true);
    const v = parseFloat(cut(hud));
    expect(v).toBeGreaterThanOrEqual(70.61);
    expect(v - 70.61).toBeLessThan(1 / 64);
    expect((v * 64) % 1).toBe(0);
  });

  it('no cut where everything fits — and a stale one is cleared', () => {
    const hud = column({ room: 200, bottoms: [20, 45, 70] });
    hud.style.setProperty(HUD_CUT_PROP, '45px');
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('');
  });

  it('puts the reader’s scroll position back: lifting the cut must not move the chips under them', () => {
    // 120px of content in a 95px cut: a 25px range, read to its end. Lifted, the 100px room
    // leaves only 20 — the position clamps — and the pass restores it under the new cut.
    const hud = column({ room: 100, bottoms: [20, 45, 70, 95, 120], scrollTop: 0 });
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('95px');
    hud.scrollTop = 25;
    expect(hud.scrollTop).toBe(25);
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('95px');
    expect(hud.scrollTop).toBe(25);
  });

  it('a column with no layout is no evidence: the cut it has stays', () => {
    const hud = column({ room: 0, bottoms: [20, 45] });
    hud.style.setProperty(HUD_CUT_PROP, '45px');
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('45px');
  });

  it('Standard owns none of it, and clearHudCut is the same clear, for teardown', () => {
    const hud = column({ room: 100, bottoms: [20, 45, 70, 95, 120] });
    syncHudCut(hud, true);
    expect(cut(hud)).toBe('95px');
    syncHudCut(hud, false);
    expect(cut(hud)).toBe('');
    syncHudCut(hud, true);
    clearHudCut(hud);
    expect(cut(hud)).toBe('');
  });
});
