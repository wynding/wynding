// dock-ring.test.ts — whether the countdown ring and its hint fit beside the Standard Dock
// (#181 H1). `ringFit` is the decision; `syncDockRing` is its DOM glue, driven here with stubbed
// boxes because jsdom lays nothing out. The real-browser half — the Dock never wraps or grows a
// row at any viewport the dock specs sweep — is `e2e/dock-overlap.spec.ts`'s.

import { describe, it, expect } from 'vitest';
import {
  RING_EDGE_GAP_PX,
  RING_NO_HINT_CLASS,
  RING_OFF_CLASS,
  ringFit,
  syncDockRing,
} from './dock-ring';

describe('dock-ring — ringFit (the decision)', () => {
  const STAGE = 800;
  const LIMIT = STAGE - RING_EDGE_GAP_PX;

  it('keeps both while the hint ends short of the Rail by the gap', () => {
    expect(ringFit({ ringRight: 300, hintRight: LIMIT, stageRight: STAGE })).toEqual({
      ring: true,
      hint: true,
    });
  });

  it('drops the hint FIRST: a hint past the limit goes, the ring stays', () => {
    expect(ringFit({ ringRight: 300, hintRight: LIMIT + 0.5, stageRight: STAGE })).toEqual({
      ring: true,
      hint: false,
    });
  });

  it('drops the ring only when even the ring would reach the Rail — and never keeps a hint for no ring', () => {
    expect(ringFit({ ringRight: LIMIT + 1, hintRight: 100, stageRight: STAGE })).toEqual({
      ring: false,
      hint: false,
    });
    expect(ringFit({ ringRight: LIMIT, hintRight: LIMIT + 50, stageRight: STAGE })).toEqual({
      ring: true,
      hint: false,
    });
  });

  it('keeps the Dock’s own float offset between the ink and the Rail', () => {
    expect(RING_EDGE_GAP_PX).toBe(8);
  });
});

describe('dock-ring — syncDockRing (the DOM glue)', () => {
  /** A ring slot whose three boxes report the given right edges, plus a stage. */
  function fixture(opts: {
    readonly ringRight: number;
    readonly hintRight: number;
    readonly stageRight: number;
    readonly stageWidth?: number;
    readonly rendered?: boolean;
  }) {
    const root = document.createElement('div');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const hint = document.createElement('span');
    root.append(svg, hint);
    const stage = document.createElement('div');
    document.body.append(root, stage);
    const rect = (right: number, width = 40): DOMRect =>
      ({
        right,
        width,
        left: right - width,
        top: 0,
        bottom: 40,
        height: 40,
        x: right - width,
        y: 0,
      }) as DOMRect;
    svg.getBoundingClientRect = () => rect(opts.ringRight);
    hint.getBoundingClientRect = () => rect(opts.hintRight);
    stage.getBoundingClientRect = () => rect(opts.stageRight, opts.stageWidth ?? opts.stageRight);
    // jsdom reports no client rects for anything; a rendered slot has one.
    root.getClientRects = () =>
      (opts.rendered === false ? [] : [rect(0, 0)]) as unknown as DOMRectList;
    return { targets: { root, ring: { svg }, hint }, stage, root };
  }
  const has = (el: Element, cls: string): boolean => el.classList.contains(cls);

  it('marks the hint off when only the hint overflows, and both when the ring does', () => {
    const narrow = fixture({ ringRight: 300, hintRight: 900, stageRight: 800 });
    syncDockRing(narrow.targets, narrow.stage);
    expect(has(narrow.root, RING_NO_HINT_CLASS)).toBe(true);
    expect(has(narrow.root, RING_OFF_CLASS)).toBe(false);

    const crowded = fixture({ ringRight: 795, hintRight: 900, stageRight: 800 });
    syncDockRing(crowded.targets, crowded.stage);
    expect(has(crowded.root, RING_OFF_CLASS)).toBe(true);
    expect(has(crowded.root, RING_NO_HINT_CLASS)).toBe(true);
  });

  it('lifts a stale verdict once room returns — the hidden boxes are still measured', () => {
    const f = fixture({ ringRight: 300, hintRight: 600, stageRight: 800 });
    f.root.classList.add(RING_OFF_CLASS, RING_NO_HINT_CLASS);
    syncDockRing(f.targets, f.stage);
    expect(has(f.root, RING_OFF_CLASS)).toBe(false);
    expect(has(f.root, RING_NO_HINT_CLASS)).toBe(false);
  });

  it('clears every verdict when the ring is not rendered at all (hidden, Compact, the Dock’s scroll form)', () => {
    const hidden = fixture({ ringRight: 900, hintRight: 900, stageRight: 800 });
    hidden.root.hidden = true;
    hidden.root.classList.add(RING_OFF_CLASS, RING_NO_HINT_CLASS);
    syncDockRing(hidden.targets, hidden.stage);
    expect(hidden.root.className).toBe('');

    const unrendered = fixture({
      ringRight: 900,
      hintRight: 900,
      stageRight: 800,
      rendered: false,
    });
    unrendered.root.classList.add(RING_OFF_CLASS);
    syncDockRing(unrendered.targets, unrendered.stage);
    expect(unrendered.root.className).toBe('');
  });

  it('a stage with no layout box is no evidence: nothing changes', () => {
    const f = fixture({ ringRight: 300, hintRight: 900, stageRight: 0, stageWidth: 0 });
    f.root.classList.add(RING_OFF_CLASS);
    syncDockRing(f.targets, f.stage);
    expect(has(f.root, RING_OFF_CLASS)).toBe(true);
    expect(has(f.root, RING_NO_HINT_CLASS)).toBe(false);
  });
});
