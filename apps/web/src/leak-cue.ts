// leak-cue.ts — when the lives chip shows that a creep got through (visual pass C1, #181): it
// shakes, or under Reduce motion turns red, for `LEAK_CUE_MS` after a leak. Pure and DOM-free:
// `main.ts` feeds it each frame's leaks (`Controller.drainFeedback`) and sets the chip's
// `data-wy-leak` from what it answers; `ui.css` draws the shake and the tint.
//
// PHOTOSENSITIVITY (ADR 0003, WCAG 2.3.1: no more than three flashes in any second). The tint
// is a change of colour on and off — a flash — and a run of leaks would otherwise blink it as
// fast as they came. A cue begins at most once every `LEAK_CUE_GAP_MS`, however many leaks
// arrive between: one that lands while a cue shows, or before the gap has run, starts nothing
// new. So cues begin a second or more apart, far inside the bound — and the HUD's lives count,
// its accessible source, still changes with every leak.

/** How long the chip shows a leak, ms: the frame's leak moment, its exit pulsing twice. */
export const LEAK_CUE_MS = 600;
/** The least time between the starts of two cues, ms. */
export const LEAK_CUE_GAP_MS = 1000;

export interface LeakCue {
  /** Take in a frame at `nowMs` that drained `leaks` leaks; answer whether the cue shows now. */
  update(nowMs: number, leaks: number): boolean;
  /** Forget the last cue — a new run starts with none showing. */
  reset(): void;
}

export function createLeakCue(): LeakCue {
  let startedAt: number | null = null;
  return {
    update(nowMs, leaks) {
      if (leaks > 0 && (startedAt === null || nowMs - startedAt >= LEAK_CUE_GAP_MS)) {
        startedAt = nowMs;
      }
      return startedAt !== null && nowMs - startedAt < LEAK_CUE_MS && nowMs >= startedAt;
    },
    reset() {
      startedAt = null;
    },
  };
}
