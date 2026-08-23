// script-runner.test.ts — unit coverage for the shared script-runner core itself (G1-b,
// #94), the same convention wave-lookup.test.ts already carries for this package's other
// shared test-support module.
//
// Every story file that adopts `runBuildScript` only ever scripts real catalog tower ids,
// so none of them reach its own guard branch (an unknown towerId in the script — a fixture
// bug, never a legitimate placement attempt). Pinned here directly — cheap, no full-arc run
// needed — so the guard stays covered and a regression in it fails HERE, not as a silent
// never-arming wall inside a 4,000-tick story scene.

import { describe, it, expect } from 'vitest';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { runBuildScript } from './script-runner';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
const SEED = 0x5eed;

describe('runBuildScript guards', () => {
  it('throws up front on an unknown towerId in the script — a fixture bug, not a legitimate placement attempt', () => {
    expect(() =>
      runBuildScript(ruleset, SEED, [{ col: 2, row: 10, towerId: 'no-such-tower' }]),
    ).toThrow(/unknown towerId/);
  });
});
