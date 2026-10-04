// device-px.test.ts — the device pixels a box is drawn into (`snappedSpan`), which the board's
// canvas sizes its backing store to so it is shown pixel for pixel (`scene.ts`, #181).

import { describe, it, expect } from 'vitest';
import {
  backingStoreSize,
  devicePixelReport,
  observesDevicePixels,
  snappedSpan,
  type DevicePixelReport,
} from './device-px';

describe('snappedSpan — the device pixels a box is drawn into', () => {
  it('counts from the pixel nearest the box’s start to the one nearest its end — not its rounded size', () => {
    // The board at 525×320: x = 52.5, w = 328.5, so pixels 53 to 381 — 328 of them,
    // where a store sized round(328.5) = 329 was scaled into 328 and smeared.
    expect(snappedSpan(52.5, 328.5, 1)).toBe(328);
    // One pixel narrower, the board keeps its width and sits at x = 52: pixels 52 to 381.
    expect(snappedSpan(52, 328.5, 1)).toBe(329);
    // At dpr 1.25 the 525×320 board covers 66 to 476: 410, where round(410.625) is 411.
    expect(snappedSpan(52.5, 328.5, 1.25)).toBe(410);
  });

  it('rounds a half up, either side of zero, as layout does', () => {
    // One edge on a half each time, so the way the half goes decides the count — with both
    // on halves, rounding them either way moves both edges together and keeps it.
    expect(snappedSpan(0.5, 10.25, 1)).toBe(10); // 0.5 → 1 (not 0), 10.75 → 11
    expect(snappedSpan(0.25, 9.25, 1)).toBe(10); // 0.25 → 0, 9.5 → 10 (not 9)
    expect(snappedSpan(-1.5, 3.25, 1)).toBe(3); // −1.5 → −1 (not −2), 1.75 → 2
    expect(snappedSpan(-3.25, 1.75, 1)).toBe(2); // −3.25 → −3, −1.5 → −1 (not −2)
  });

  it('puts an edge read back with floating-point dust onto layout’s 1/64 grid before rounding', () => {
    // At dpr 0.9 a box from device px 30.5 to 40 reads back as CSS px 30.5 / 0.9 and
    // 9.5 / 0.9 — and 30.5 / 0.9 × 0.9 is 30.499999999999996, which rounds down. Layout
    // rounds its exact 30.5 up: pixels 31 to 40, so 9, not 10.
    expect((30.5 / 0.9) * 0.9).toBeLessThan(30.5);
    expect(snappedSpan(30.5 / 0.9, 9.5 / 0.9, 0.9)).toBe(9);
  });
});

describe('backingStoreSize — as many pixels as the device pixels the box is drawn into', () => {
  // The board at 525×320: worked out from where it sits, 328 device pixels wide.
  const box = { left: 52.5, top: 0, width: 328.5, height: 200 };
  const report = (over: Partial<DevicePixelReport> = {}): DevicePixelReport => ({
    width: 329,
    height: 201,
    cssWidth: 328.5,
    cssHeight: 200,
    dpr: 1,
    ...over,
  });

  it('takes the browser’s own count when it has given one for the box as it is now', () => {
    // A count unlike the arithmetic's, so the answer shows whose it is.
    expect(backingStoreSize(box, 1, 1, report())).toEqual({ width: 329, height: 201 });
    // A reading of the same layout with floating-point dust in it is still that layout.
    expect(backingStoreSize(box, 1, 1, report({ cssWidth: 328.5 + 1e-9 }))).toEqual({
      width: 329,
      height: 201,
    });
  });

  it('works it out from where the box sits otherwise', () => {
    const worked = { width: 328, height: 200 };
    expect(backingStoreSize(box, 1, 1, null), 'no observer (WebKit)').toEqual(worked);
    // A report for the box before it was resized — by a layout unit, the least a change can be.
    for (const stale of [
      { cssWidth: 328.5 - 1 / 64 },
      { cssHeight: 200 + 1 / 64 },
      { cssWidth: 300, cssHeight: 180 },
    ]) {
      expect(backingStoreSize(box, 1, 1, report(stale)), JSON.stringify(stale)).toEqual(worked);
    }
    // A report taken at another dpr (the window moved to another screen; a new one follows).
    expect(backingStoreSize(box, 1, 1, report({ dpr: 2 })), 'stale dpr').toEqual(worked);
    // Past the clamp the store is drawn at 2 on a 3× screen: deliberately fewer pixels than
    // the box, whatever the browser counts.
    expect(backingStoreSize(box, 2, 3, report({ dpr: 3, width: 986, height: 600 }))).toEqual({
      width: 657, // pixels 105 to 762
      height: 400,
    });
  });

  it('is never under one pixel', () => {
    const empty = { left: 10.5, top: 3, width: 0, height: 0 };
    expect(backingStoreSize(empty, 1, 1, null)).toEqual({ width: 1, height: 1 });
    const answer = { width: 0, height: 0, cssWidth: 0, cssHeight: 0, dpr: 1 };
    expect(backingStoreSize(empty, 1, 1, answer)).toEqual({ width: 1, height: 1 });
  });
});

describe('devicePixelReport and observesDevicePixels — the browser’s own count, where it has one', () => {
  const size = (inlineSize: number, blockSize: number): ResizeObserverSize => ({
    inlineSize,
    blockSize,
  });

  it('reads the device pixels and the CSS box from an entry, inline as width', () => {
    const entry = {
      devicePixelContentBoxSize: [size(329, 201)],
      contentBoxSize: [size(328.5, 200)],
    } as unknown as ResizeObserverEntry;
    expect(devicePixelReport(entry, 1.25)).toEqual({
      width: 329,
      height: 201,
      cssWidth: 328.5,
      cssHeight: 200,
      dpr: 1.25,
    });
  });

  it('has none where the browser gives none', () => {
    const webkit = { contentBoxSize: [size(328.5, 200)] } as unknown as ResizeObserverEntry;
    expect(devicePixelReport(webkit, 1)).toBeNull();
    const empty = {
      devicePixelContentBoxSize: [],
      contentBoxSize: [],
    } as unknown as ResizeObserverEntry;
    expect(devicePixelReport(empty, 1)).toBeNull();
  });

  it('knows a window that can watch the device-pixel box from one that cannot', () => {
    class WithIt {
      get devicePixelContentBoxSize(): readonly ResizeObserverSize[] {
        return [];
      }
    }
    class Without {}
    expect(observesDevicePixels({ ResizeObserverEntry: WithIt })).toBe(true);
    expect(observesDevicePixels({ ResizeObserverEntry: Without }), 'WebKit').toBe(false);
    expect(observesDevicePixels({}), 'no ResizeObserver').toBe(false);
    expect(observesDevicePixels(null), 'no window').toBe(false);
  });
});
