// fire-rate.test.ts — no tower flashes more than three times a second (ADR 0003's
// photosensitivity bound, WCAG 2.3.1), held against every shipped tower at the game's fastest
// speed (visual pass T3, #181).
//
// A tower that fires shows the shot once — its head's muzzle flash, or its ring pulse
// (`packages/render/src/tower-fire.ts`) — so it flashes exactly as often as it fires: at most
// once per `cadenceTicks`, and render time runs as many times faster than the wall clock as
// the game's speed. The worst case is therefore the shortest cadence in any shipped ruleset at
// the fastest speed the game offers. Both are READ here — the cadences from the bundled
// rulesets, the speeds from the real controller's speed toggle — so a faster tower, or a
// faster game speed, fails this test instead of quietly strobing. (The game's own fixed tick
// rate comes from the sim.)

import { describe, it, expect } from 'vitest';
import { bundledRulesetIds, getBundledRuleset } from '@wynding/content';
import { FIRE_FEEDBACK_TICKS, MAX_FLASHES_PER_SECOND, flashesPerSecond } from '@wynding/render';
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

  it('no shipped tower flashes more than three times a second, even at the fastest speed', () => {
    const fastest = Math.max(...gameSpeeds());
    const towers = cadencedTowers();
    expect(towers.length).toBeGreaterThan(0);
    for (const t of towers) {
      expect(flashesPerSecond(t.cadenceTicks, fastest), t.id).toBeLessThanOrEqual(
        MAX_FLASHES_PER_SECOND,
      );
    }
  });

  it('the worst case is the one docs/accessibility-checklist.md cites: antiair, 2⅔ a second at 2×', () => {
    const fastest = Math.max(...gameSpeeds());
    const rates = cadencedTowers().map((t) => ({
      id: t.id,
      perSecond: flashesPerSecond(t.cadenceTicks, fastest),
    }));
    const worst = rates.reduce((a, b) => (b.perSecond > a.perSecond ? b : a));
    expect(worst.id).toBe('wynding-core/antiair'); // every 15 ticks
    expect(worst.perSecond).toBeCloseTo(8 / 3, 9);
  });

  it('each shot’s flash is over before the tower’s next shot, so no two run together', () => {
    for (const t of cadencedTowers()) {
      expect(FIRE_FEEDBACK_TICKS, t.id).toBeLessThan(t.cadenceTicks);
    }
  });
});
