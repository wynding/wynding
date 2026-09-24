// dock-reserve.test.ts — the Standard Dock footprint pass (#152). jsdom lays nothing out, so
// every box is driven at the element seam; the rendered outcome (no buildable cell under the
// Dock, the 12px floor, keyboard reach inside the bounded scrollport) is `dock-overlap.spec.ts`'s.
import { describe, it, expect } from 'vitest';
import {
  clearDockReserve,
  DOCK_PROPS,
  DOCK_SCROLL_CLASS,
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
  readonly buttons: HTMLElement[];
  /** The Dock's top edge as a function of what the pass has written so far — so a test can
   *  prove the reserve is read AFTER the bound's inputs land. */
  dockTop: () => number;
  scroll: { height: number; client: number };
}

function rig(opts: { stageTop?: number; stageHeight: number; buttonHeights: number[] }): Rig {
  const shell = document.createElement('div');
  const stage = document.createElement('div');
  const dock = document.createElement('div');
  const buttons = opts.buttonHeights.map((h) => {
    const b = document.createElement('button');
    b.getBoundingClientRect = () => rect(0, h);
    dock.append(b);
    return b;
  });
  shell.append(stage, dock);
  document.body.append(shell);
  const r: Rig = {
    shell,
    stage,
    dock,
    buttons,
    dockTop: () => 0,
    scroll: { height: 44, client: 44 },
  };
  const stageTop = opts.stageTop ?? 0;
  stage.getBoundingClientRect = () => rect(stageTop, opts.stageHeight);
  dock.getBoundingClientRect = () => rect(r.dockTop(), 44);
  Object.defineProperty(dock, 'scrollHeight', { get: () => r.scroll.height });
  Object.defineProperty(dock, 'clientHeight', { get: () => r.scroll.client });
  return r;
}

const prop = (el: HTMLElement, name: string): string => el.style.getPropertyValue(name);

describe('syncDockReserve (#152)', () => {
  it('reserves everything from the Dock top edge to the Stage bottom, rounded UP', () => {
    const r = rig({ stageTop: 44, stageHeight: 676, buttonHeights: [44, 44] });
    r.dockTop = () => 667.6; // the Dock's top edge in page coordinates
    syncDockReserve(r, false);
    // 720 − 667.6 = 52.4 → 53: a sub-pixel under-reserve is a sliver of cell under the Dock.
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('53px');
    expect(prop(r.shell, DOCK_PROPS.stageHeight)).toBe('676px');
  });

  it('writes the bound inputs BEFORE reading the Dock, so the reserve describes the bounded box', () => {
    const r = rig({ stageHeight: 364, buttonHeights: [49] });
    // A Dock whose top edge depends on whether the Stage height has landed yet — the
    // browser's behaviour, where writing `--wy-stage-h` re-bounds the Dock.
    r.dockTop = () => (prop(r.shell, DOCK_PROPS.stageHeight) === '' ? 202 : 288);
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('76px');
  });

  it('floors the bound at the tallest VISIBLE control plus the Dock block padding', () => {
    const r = rig({ stageHeight: 400, buttonHeights: [44, 73, 49] });
    r.buttons[1]!.hidden = true; // a hidden control (Pause pre-start) takes no row
    r.dock.style.paddingTop = '2px';
    r.dock.style.paddingBottom = '21.5px';
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.minHeight)).toBe(`${Math.ceil(49 + 2 + 21.5)}px`);
  });

  it('a Dock with no controls still gets a (zero) floor rather than a stale one', () => {
    const r = rig({ stageHeight: 400, buttonHeights: [] });
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.minHeight)).toBe('0px');
  });

  it('never writes a negative reserve', () => {
    const r = rig({ stageHeight: 100, buttonHeights: [44] });
    r.dockTop = () => 500; // a Dock below the Stage's bottom edge (a transient mid-resize)
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('0px');
  });

  it('sets the scroll form exactly while the content exceeds the bound, with 1px slack', () => {
    const r = rig({ stageHeight: 364, buttonHeights: [49] });
    r.scroll = { height: 114, client: 60 };
    syncDockReserve(r, false);
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);

    r.scroll = { height: 61, client: 60 }; // fractional rounding, not overflow
    syncDockReserve(r, false);
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(false);
  });

  it('moves nothing without a laid-out Stage — no evidence is not a zero reserve', () => {
    const r = rig({ stageHeight: 0, buttonHeights: [44] });
    r.shell.style.setProperty(DOCK_PROPS.reserve, '52px');
    r.dock.classList.add(DOCK_SCROLL_CLASS);
    syncDockReserve(r, false);
    expect(prop(r.shell, DOCK_PROPS.reserve)).toBe('52px');
    expect(prop(r.shell, DOCK_PROPS.stageHeight)).toBe('');
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);
  });

  it('Compact owns none of it: every property and the scroll class are cleared', () => {
    const r = rig({ stageHeight: 400, buttonHeights: [44] });
    r.scroll = { height: 200, client: 60 };
    syncDockReserve(r, false);
    for (const p of Object.values(DOCK_PROPS)) expect(prop(r.shell, p)).not.toBe('');
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(true);

    syncDockReserve(r, true);
    for (const p of Object.values(DOCK_PROPS)) expect(prop(r.shell, p)).toBe('');
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(false);
  });

  it('clearDockReserve is the same clear, for teardown', () => {
    const r = rig({ stageHeight: 400, buttonHeights: [44] });
    r.scroll = { height: 200, client: 60 };
    syncDockReserve(r, false);
    clearDockReserve(r);
    for (const p of Object.values(DOCK_PROPS)) expect(prop(r.shell, p)).toBe('');
    expect(r.dock.classList.contains(DOCK_SCROLL_CLASS)).toBe(false);
  });

  it('reads padding as zero when the Dock has no window to compute styles in', () => {
    const doc = document.implementation.createHTMLDocument('detached');
    const shell = doc.createElement('div');
    const stage = doc.createElement('div');
    const dock = doc.createElement('div');
    const btn = doc.createElement('button');
    btn.getBoundingClientRect = () => rect(0, 44);
    dock.append(btn);
    stage.getBoundingClientRect = () => rect(0, 400);
    dock.getBoundingClientRect = () => rect(348, 44);
    syncDockReserve({ shell, stage, dock }, false);
    expect(shell.style.getPropertyValue(DOCK_PROPS.minHeight)).toBe('44px');
    expect(shell.style.getPropertyValue(DOCK_PROPS.reserve)).toBe('52px');
  });
});
