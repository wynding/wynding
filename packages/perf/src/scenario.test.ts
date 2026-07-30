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
import { buildStressReplay, buildControlReplay } from './scenario';

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

// The full `validate()` end-to-end re-simulation used to live here. It MOVED to
// `run.ts` (the `perf` CI job) rather than being deleted — see that file's startup
// check. Two reasons, both measured rather than assumed:
//
//   1. COST IN THE WRONG PLACE. It re-simulates the whole ~4,000-tick stress run: ~8s
//      locally, and **21.2s on `ubuntu-latest`**, which failed a 20s ceiling on S4b's
//      first CI run. `turbo run test` is part of `pnpm run verify`, the loop every
//      contributor runs on every change, and PLAN step 20's whole argument for keeping
//      sustained simulation out of `verify` applies to a test just as much as to a
//      script.
//   2. IT WAS STARVING A NEIGHBOUR. Adding this package gave `turbo run test` a
//      CPU-heavy task to schedule alongside `apps/web`'s suite; on a 2-core runner
//      `apps/web`'s 64-pending-command controller test — previously green and near its
//      5s default — began timing out at 5.9s. The contention was ours; so is the fix.
//
// The cheap staleness guards STAY here, and they are the ones that actually catch a
// forgotten regeneration: `simVersion`, `rulesetHash`, and a deep-equal against the
// committed JSON. What moved is only the expensive proof that the real replay path
// ACCEPTS the scenario — which the `perf` job now asserts before it measures anything,
// on every PR.
