// leak-cue.test.ts — when the lives chip shows a creep got through (#181 C1): for the cue's
// span after a leak, never begun again inside the gap, so it can never blink more than three
// times in a second (ADR 0003, WCAG 2.3.1) however fast creeps leak; and forgotten with the run.

import { describe, it, expect } from 'vitest';
import { createLeakCue, LEAK_CUE_GAP_MS, LEAK_CUE_MS } from './leak-cue';

describe('createLeakCue — the lives chip’s leak cue', () => {
  it('shows from the frame a leak arrives for the cue’s span, then stops', () => {
    const cue = createLeakCue();
    expect(cue.update(0, 0)).toBe(false);
    expect(cue.update(100, 1)).toBe(true);
    expect(cue.update(100 + LEAK_CUE_MS - 1, 0)).toBe(true);
    expect(cue.update(100 + LEAK_CUE_MS, 0)).toBe(false);
  });

  it('a leak while the cue shows, or before its gap has run, begins nothing new', () => {
    const cue = createLeakCue();
    cue.update(0, 1);
    expect(cue.update(300, 2)).toBe(true); // still the first cue
    expect(cue.update(LEAK_CUE_MS, 0)).toBe(false); // which ends on time
    expect(cue.update(LEAK_CUE_GAP_MS - 1, 1)).toBe(false); // inside the gap: nothing
    expect(cue.update(LEAK_CUE_GAP_MS, 1)).toBe(true); // a second on: a new one
  });

  it('never begins more than three cues in any second, though a creep leaks every frame', () => {
    expect(LEAK_CUE_GAP_MS).toBeGreaterThanOrEqual(1000 / 3);
    expect(LEAK_CUE_GAP_MS).toBeGreaterThan(LEAK_CUE_MS); // the cue is off between two
    const cue = createLeakCue();
    const starts: number[] = [];
    let shown = false;
    for (let i = 0; i <= 600; i++) {
      const now = (i * 1000) / 60;
      const on = cue.update(now, 1);
      if (on && !shown) starts.push(now);
      shown = on;
    }
    expect(starts.length).toBeGreaterThan(5); // it does show, as often as it may
    for (let i = 3; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 3]!).toBeGreaterThanOrEqual(1000);
    }
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(LEAK_CUE_GAP_MS);
    }
  });

  it('reset forgets the cue: a new run’s first leak shows at once', () => {
    const cue = createLeakCue();
    cue.update(5000, 1);
    cue.reset();
    expect(cue.update(5100, 0)).toBe(false);
    expect(cue.update(5200, 1)).toBe(true);
  });

  it('shows nothing for a clock that runs backwards past the cue’s start', () => {
    const cue = createLeakCue();
    cue.update(1000, 1);
    expect(cue.update(900, 0)).toBe(false);
  });
});
