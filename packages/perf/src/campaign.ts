// campaign.ts — the CAMPAIGN scene (M3 story 8; m3.md, "What tuned means", B).
//
// The shipped game's own load, where the stress and catalog scenes are synthetic ceilings:
// the strongest reference build — the serpentine, `packages/content`'s `M3_SERPENTINE` —
// playing the shipped thirty-wave arc on the crossing board, measured over the DENSEST
// STRETCH of its run. RECORDED, NEVER GATED: ADR 0005's stress scene and its gate are
// unchanged, nothing reads these numbers as a budget, and the real-device pass (#141) has
// the final word.
//
// The stretch is the sample window the browser spec times (`campaign.perf.spec.ts`, 10 s of
// frames at the sim's 20 Hz, so `CAMPAIGN_SAMPLE_TICKS`): of every window that ends at least
// `CAMPAIGN_SLACK_TICKS` before the run does, the one with the most creeps alive, summed
// tick by tick (`densestStretch`). The slack keeps the run going through the spec's
// input-latency clicks after the window, so the phase it reads at the end is still `running`.
//
// This module holds the rule and the oracle values the browser echoes at the window's first
// tick; it imports no reference build. `campaign.test.ts` plays the serpentine in Node,
// re-derives the window by this rule and pins every value below, and the browser entry
// (`apps/web/perf/main-perf-campaign.ts`) plays the same build through the real controller to
// that tick. Both reach the build the way the repo's other test support does, by relative
// path: the content package exports no subpath for its reference builds.

/** The sample window, in ticks: the browser spec's 10 s at 20 Hz. */
export const CAMPAIGN_SAMPLE_TICKS = 200;

/** Ticks the run must still have to go after the window — 30 s, room for the spec's
 *  input-latency clicks — so a window at the very end of the run is never chosen. */
export const CAMPAIGN_SLACK_TICKS = 600;

/** The first tick of the densest window over `liveCreeps` (creeps alive at each tick, from
 *  tick 0): of every `window`-tick span that ends at least `slack` ticks before the series
 *  does, the one with the largest sum, the earliest on a tie. `null` if none fits. */
export function densestStretch(
  liveCreeps: readonly number[],
  window: number = CAMPAIGN_SAMPLE_TICKS,
  slack: number = CAMPAIGN_SLACK_TICKS,
): number | null {
  const lastStart = liveCreeps.length - slack - window;
  if (window < 1 || lastStart < 0) return null;
  let sum = 0;
  for (let t = 0; t < window; t++) sum += liveCreeps[t]!;
  let best = 0;
  let bestSum = sum;
  for (let start = 1; start <= lastStart; start++) {
    sum += liveCreeps[start + window - 1]! - liveCreeps[start - 1]!;
    if (sum > bestSum) {
      best = start;
      bestSum = sum;
    }
  }
  return best;
}

/** The window's first tick on the shipped bundle — re-derived by `campaign.test.ts`. */
export const CAMPAIGN_SAMPLE_START_TICK = 15_475;

/** The board at `CAMPAIGN_SAMPLE_START_TICK`, measured in Node and echoed by the browser
 *  before it times a frame: every tower of the serpentine standing, the bounty it holds and
 *  the creeps alive. All three exact, so the browser's run is the Node run to the tick. */
export const CAMPAIGN_AT_START = {
  towers: 83,
  bounty: 213,
  liveCreeps: 16,
} as const;
