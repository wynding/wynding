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
// `run.ts` (the `perf` CI job) rather than being deleted, because of WHERE the cost
// lands. The measured breakdown, since an earlier version of this note misattributed
// the cause:
//
//   - `validate(stressReplay, bundle)` re-simulates 3,969 ticks. Under `tsx`, which is
//     how `pnpm run perf` runs it, that costs **~0.65s** (warm median 642ms over 32,
//     667ms cold). Inside vitest the SAME call costs **~1.15s** — vitest's module runner
//     makes the simulation itself ~1.8x slower. That is a harness difference, not
//     startup: vitest reports transform/collect/prepare (~0.3s) OUTSIDE the per-test
//     duration.
//   - The TEST that held it cost **~1.15s** under vitest bare and **~7.5s under v8
//     coverage instrumentation**, which `verify` turns on (`vitest run --coverage`).
//     Like for like inside vitest, instrumentation costs **~6.5x**.
//     So the earlier "~8s locally" figure was ACCURATE — within ~6% of what `verify`
//     actually paid. Where it misled was the cause it implied. The re-simulation IS
//     essentially the whole of that 7.5s — but only because it is instrumented;
//     uninstrumented, the same work is ~0.65s, about a tenth. That is precisely why the
//     cheaper fix nobody considered — excluding this path from coverage — would have
//     worked: the sim is exactly where the instrumented time goes.
//     Getting this right took three QC rounds, and both wrong turns were the same
//     mistake: one round "corrected" the 8s to "wrong by ~20x" by dividing an
//     instrumented TEST by a bare FUNCTION CALL, and the next repeated the cross-harness
//     slip by charging vitest's 1.8x to startup. Measure both halves in one harness.
//   - On `ubuntu-latest` that same test took **21.2s and 28.1s** on two runs of the
//     same commit (run 30588677622, attempts 3 and 5), against a 20s ceiling — 2.8x and
//     3.7x this machine's coverage-on cost, and a 33% spread between two observations of
//     one commit. THAT is the argument: `turbo run test` is part of `pnpm run verify`,
//     the loop every contributor runs on every change, and PLAN step 20's case for
//     keeping sustained simulation out of `verify` applies to a test as much as to a
//     script.
//
// An earlier version of this note also blamed the move for a NEIGHBOURING failure —
// `apps/web`'s 64-pending-command controller test, "previously green and near its 5s
// default", timing out once this package joined `turbo run test`, and called the
// contention "ours". A later round then over-corrected, calling that "not supportable".
// Neither is right, and the honest record is: it was never measured either way.
//   - What IS established: that test (`apps/web/src/controller.test.ts`) timed out at
//     vitest's 5s default on CI run 30589511344, and it passed on the two runs after
//     the 21.2s test moved out of `turbo run test`.
//   - What is also established: its SIBLING in the same O(n²)/n=64 family already
//     carried an explicit `{ timeout: 20_000 }`, added in an earlier story (`98e6a3d`,
//     squashed into `2edd61f`) after it timed out on CI at the 5s default — before
//     `packages/perf` existed. The family was already CI-marginal.
//   - What was NEVER measured: `verify` on a CI runner with and without this package in
//     the graph. Both stories fit the evidence. Note that this package's own suite still
//     costs ~12s wall under coverage, nearly all of it import-and-instrument, so it does
//     add real concurrent load to a 2-core runner regardless.
// The failing test now carries the same explicit budget its sibling does — a budget, not
// a diagnosis.
//
// The cheap staleness guards STAY here, and they are the ones that actually catch a
// forgotten regeneration: `simVersion`, `rulesetHash`, and a deep-equal against the
// committed JSON. What moved is only the expensive proof that the real replay path
// ACCEPTS the scenario — which the `perf` job now asserts on every PR, as an ordinary
// escalating assertion.
