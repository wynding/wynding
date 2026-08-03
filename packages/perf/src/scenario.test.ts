// scenario.test.ts — proves the two committed replays (PLAN step 17) are what
// `scenario.ts`'s builders produce right now, are internally consistent, and pass the
// real replay validator end to end.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseRulesetJson, SIM_VERSION, type SimInput } from '@wynding/sim';
import { currentRulesetHash, type Replay } from '@wynding/replay';
import { STRESS_RULESET_URL } from '@wynding/content/stress';
import { buildStressReplay, buildControlReplay, PLACEMENTS_PER_TICK } from './scenario';

/** Extracts the flat placement `index` (`tick * PLACEMENTS_PER_TICK + i` — the same
 *  indexing `layout.ts`'s `towerIdAt` uses) of every `placeTower` input in `replay`
 *  whose `towerId` is `towerId`, so callers can compare placements across two
 *  replays by INDEX rather than by tower id alone. */
function placementIndicesOf(replay: Replay, towerId: string): readonly number[] {
  const out: number[] = [];
  replay.tickInputs.forEach((inputs, tick) => {
    inputs.forEach((input, i) => {
      const placement = input as Extract<SimInput, { kind: 'placeTower' }>;
      if (placement.towerId === towerId) {
        out.push(tick * PLACEMENTS_PER_TICK + i);
      }
    });
  });
  return out;
}

const text = readFileSync(STRESS_RULESET_URL, 'utf8');
const bundle = parseRulesetJson(text);

// Read the committed files with `readFileSync` + `JSON.parse` rather than a TS `import
// … from './scenarios/*.json'` — the latter needs the generated files pre-listed in
// this project's `tsconfig.json`, which would make the composite `tsc -b` project fail
// to build the moment `gen:scenario` regenerates them with different content. Reading
// as plain text/JSON keeps this test's own compile independent of the generated
// artifact's shape, matching how `@wynding/content`'s registry loads bundle JSON.
const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const committedStressReplay = JSON.parse(
  readFileSync(join(scenariosDir, 'stress-40x40.replay.json'), 'utf8'),
) as Replay;
const committedControlReplay = JSON.parse(
  readFileSync(join(scenariosDir, 'control-40x40.replay.json'), 'utf8'),
) as Replay;

describe('identity guard: simVersion and rulesetHash', () => {
  it('buildStressReplay stamps SIM_VERSION and the bundle’s current digest', () => {
    const replay = buildStressReplay(bundle);
    expect(replay.simVersion).toBe(SIM_VERSION);
    expect(replay.rulesetHash).toBe(currentRulesetHash(bundle));
  });

  it('buildControlReplay stamps SIM_VERSION and the bundle’s current digest', () => {
    const replay = buildControlReplay(bundle);
    expect(replay.simVersion).toBe(SIM_VERSION);
    expect(replay.rulesetHash).toBe(currentRulesetHash(bundle));
  });
});

describe('the committed replay files are not stale', () => {
  // If a `simVersion` bump or a bundle edit isn't followed by re-running
  // `pnpm -C packages/perf run gen:scenario`, this is the test that turns that
  // forgotten step into a red CI run instead of a silently stale committed artifact.
  it('stress-40x40.replay.json on disk deep-equals buildStressReplay(bundle) right now', () => {
    expect(committedStressReplay).toEqual(buildStressReplay(bundle));
  });

  it('control-40x40.replay.json on disk deep-equals buildControlReplay(bundle) right now', () => {
    expect(committedControlReplay).toEqual(buildControlReplay(bundle));
  });
});

describe('tickInputs shape', () => {
  const replay = buildStressReplay(bundle);

  it('has 50 tick entries, 3 placeTower inputs each, 150 total', () => {
    expect(replay.tickInputs).toHaveLength(50);
    for (const inputs of replay.tickInputs) {
      expect(inputs).toHaveLength(3);
      for (const input of inputs) {
        expect(input.kind).toBe('placeTower');
      }
    }
    const total = replay.tickInputs.reduce((sum, inputs) => sum + inputs.length, 0);
    expect(total).toBe(150);
  });

  it('every anchor across the 150 placements is distinct', () => {
    const seen = new Set<string>();
    for (const inputs of replay.tickInputs) {
      for (const input of inputs) {
        const placement = input as Extract<SimInput, { kind: 'placeTower' }>;
        const key = `${placement.anchor.col},${placement.anchor.row}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(150);
  });

  it('every towerId is in the bundle’s catalog', () => {
    const catalogIds = new Set(bundle.towerCatalog.map((t) => t.id));
    for (const inputs of replay.tickInputs) {
      for (const input of inputs) {
        const placement = input as Extract<SimInput, { kind: 'placeTower' }>;
        expect(catalogIds.has(placement.towerId)).toBe(true);
      }
    }
  });
});

describe('buildControlReplay keeps stress-venom, at the same placements as the stress arm (packet P9 §2)', () => {
  // `stress.test.ts`'s `stress-venom-single` non-existence check is tautological
  // for this purpose — it fails only if a tower with that exact id is ever added,
  // never if `buildControlReplay`'s explicit `stress-venom` arm is simply deleted
  // (falling through to the `stress-single` `else`), which is the actual failure
  // `scenario.ts`'s twelve-line warning above exists to guard against. And it would
  // fail even after `gen:scenario` regenerates the committed replay files, since it
  // is derived from the BUILT replays here, not compared against committed JSON that
  // a regeneration step would silently update to match a broken mapper.
  const stressReplay = buildStressReplay(bundle);
  const controlReplay = buildControlReplay(bundle);

  it('places exactly 50 stress-venom towers', () => {
    expect(placementIndicesOf(controlReplay, 'stress-venom')).toHaveLength(50);
  });

  it('sits at the same placement indices as the stress arm’s stress-venom placements', () => {
    const stressIndices = placementIndicesOf(stressReplay, 'stress-venom');
    const controlIndices = placementIndicesOf(controlReplay, 'stress-venom');
    expect(controlIndices).toEqual(stressIndices);
  });
});

// The full `validate()` end-to-end re-simulation is NOT here. It lives in `run.ts` (the
// `perf` CI job), which asserts on every PR that the real replay path accepts the
// committed scenarios, as an ordinary escalating assertion. It sits there rather than
// here because `turbo run test` is part of `pnpm run verify` — the loop every contributor
// runs on every change — and under coverage this test cost ~7.5s locally and over 20s on
// `ubuntu-latest`, where it failed its ceiling. PLAN step 20's case for keeping sustained
// simulation out of `verify` applies to a test as much as to a script. The measured
// breakdown, and what it taught about measuring instrumented tests at all, is in
// `docs/design-notes/performance-spike.md`.
//
// What STAYS here are the cheap staleness guards, and they are the ones that actually
// catch a forgotten regeneration: `simVersion`, `rulesetHash`, and a deep-equal against
// the committed JSON.
