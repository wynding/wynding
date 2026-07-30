// scenario.test.ts — proves the two committed replays (PLAN step 17) are what
// `scenario.ts`'s builders produce right now, are internally consistent, and pass the
// real replay validator end to end.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseRulesetJson, SIM_VERSION, type SimInput } from '@wynding/sim';
import { currentRulesetHash, validate, type Replay } from '@wynding/replay';
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

describe('the stress replay validates end to end through the real replay path', () => {
  // Deliberately the one expensive test in this package: it re-simulates the whole
  // ~4,000-tick stress run (via `validate`, the SAME re-simulation path the server
  // runs against an untrusted client submission) — several seconds of wall time
  // (hence the raised per-test timeout below). It earns that cost because it is the
  // only test in this package that proves the committed replay is not merely
  // well-shaped JSON but a scenario the real sim accepts and completes — anchors that
  // don't overlap, bounty that doesn't run out, inputs the validator's per-tick cap
  // and structural checks don't reject. Nothing else in this package or `content`'s
  // stress tests exercises that path.
  it('validate(stressReplay, bundle) returns ok: true', () => {
    const replay = buildStressReplay(bundle);
    const result = validate(replay, bundle);
    expect(result.ok).toBe(true);
  }, 20_000);
});
