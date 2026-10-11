// fire-rate.test.ts — no tower flashes more than three times in any one second (ADR 0003's
// photosensitivity bound, WCAG 2.3.1), held against every shipped tower at every game speed
// (visual pass T3, #181).
//
// A tower that fires shows the shot once — its head's muzzle flash, or its ring pulse
// (`packages/render/src/tower-fire.ts`) — when the shot's tracer is first seen: from its
// launch tick to just under `FIRE_FEEDBACK_TICKS` after it. A tower fires at most once per
// `cadenceTicks`, so four of its flashes take no less than three cadences less
// `FIRE_FEEDBACK_TICKS` of game time (`shortestFourFlashMs`; the first seen as late as a shot
// still shows, the fourth the moment it launches), and render time runs as many times faster
// than the wall clock as the game's speed. The bound holds while that is at least a second
// for every tower at every speed: no second then holds four flashes of one tower. The
// cadences and the speeds are READ here — from the bundled rulesets and from the real
// controller's speed toggle — so a faster tower, or a faster game speed, fails this test
// instead of quietly strobing.

import { describe, it, expect } from 'vitest';
import { bundledRulesetIds, getBundledRuleset } from '@wynding/content';
import {
  FIRE_FEEDBACK_TICKS,
  MAX_FLASHES_PER_SECOND,
  flashesPerSecond,
  shortestFourFlashMs,
} from '@wynding/render';
import { createController } from './controller';

/** Every speed the game runs at: the controller's speed toggle, cycled until it repeats. */
function gameSpeeds(): number[] {
  const c = createController(1);
  const speeds: number[] = [];
  while (!speeds.includes(c.speed())) {
    speeds.push(c.speed());
    c.cycleSpeed();
  }
  return speeds;
}

/** Every shipped tower that fires on a cadence — a burst tower fires once, and a support
 *  tower never does. */
function cadencedTowers(): { readonly id: string; readonly cadenceTicks: number }[] {
  return bundledRulesetIds().flatMap((rulesetId) =>
    getBundledRuleset(rulesetId).towerCatalog.flatMap((t) =>
      t.attack?.cadenceTicks === undefined
        ? []
        : [{ id: `${rulesetId}/${t.id}`, cadenceTicks: t.attack.cadenceTicks }],
    ),
  );
}

describe('fire feedback flash rate (ADR 0003, WCAG 2.3.1)', () => {
  it('reads the game’s speeds off the controller: 1× and 2× today', () => {
    expect(gameSpeeds()).toEqual([1, 2]);
  });

  it('no shipped tower fits four flashes into one second, at any game speed', () => {
    const towers = cadencedTowers();
    expect(towers.length).toBeGreaterThan(0);
    for (const speed of gameSpeeds()) {
      for (const t of towers) {
        expect(
          shortestFourFlashMs(t.cadenceTicks, speed),
          `${t.id} at ${speed}×`,
        ).toBeGreaterThanOrEqual(1000);
      }
    }
  });

  it('the closest is the one docs/accessibility-checklist.md cites: antiair at 2×, four flashes in no less than 1025 ms', () => {
    const fastest = Math.max(...gameSpeeds());
    const windows = cadencedTowers().map((t) => ({
      id: t.id,
      ms: shortestFourFlashMs(t.cadenceTicks, fastest),
      perSecond: flashesPerSecond(t.cadenceTicks, fastest),
    }));
    const closest = windows.reduce((a, b) => (b.ms < a.ms ? b : a));
    expect(closest.id).toBe('wynding-core/antiair'); // every 15 ticks
    expect(closest.ms).toBe(1025);
    // ... 2⅔ flashes a second on average, under the three the bound allows.
    expect(closest.perSecond).toBeCloseTo(8 / 3, 9);
    expect(closest.perSecond).toBeLessThan(MAX_FLASHES_PER_SECOND);
  });

  it('each shot’s flash is over before the tower’s next shot, so no two run together', () => {
    for (const t of cadencedTowers()) {
      expect(FIRE_FEEDBACK_TICKS, t.id).toBeLessThan(t.cadenceTicks);
    }
  });
});
