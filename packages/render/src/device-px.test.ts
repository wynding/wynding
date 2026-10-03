// device-px.test.ts — the device pixels a box is drawn into (`snappedSpan`), which the board's
// canvas sizes its backing store to so it is shown pixel for pixel (`scene.ts`, #181).

import { describe, it, expect } from 'vitest';
import { snappedSpan } from './device-px';

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
