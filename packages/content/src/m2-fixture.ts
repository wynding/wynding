// m2-fixture.ts — the FROZEN M2 bundle (M3 story 4): `field-01` and M2's ten waves, kept
// as a test fixture once the crossing board became the shipped default. Test/tooling
// support, NOT part of this package's public API — the `showcase-builds.ts` precedent:
// nothing in `index.ts` re-exports it and no `exports` subpath reaches it, so the client
// build never carries it, and the JSON sits outside `rulesets/`, so no build step copies
// it next to the shipped artifacts either.
//
// The JSON is byte for byte the `wynding-core.json` shipped just before the crossing board
// replaced it — M2's content in `formatVersion` 3 (`format3-parity.test.ts` proves it plays
// as `p1-m2`'s format-2 file did), `rulesetId` and all — so M2's mechanism tests, `m2-golden`
// and every hash pinned against it keep their meaning unchanged: its `rulesetHash` is the
// one pinned before the move (`parity.test.ts`'s `M2_RULESET_HASH`). It must never be
// edited — a change to the game goes in `rulesets/wynding-core.json`. M2 stays playable from
// the `p1-m2` tag.
//
// Parsed through the same `parseRulesetJson` the registry uses, then cached frozen — the
// registry's own posture (`registry.ts`). This is the Vite-side loader (tests, the e2e
// harness); the balance command, which runs under `tsx`, reads the same file from disk
// (`balance-artifacts.ts`) under the same key (`m2-fixture-key.ts`).

import type { Ruleset } from '@wynding/types';
import { parseRulesetJson } from '@wynding/sim';
import rawM2Core from './fixtures/m2-wynding-core.json?raw';
import { getBundledRuleset } from './registry';
import { M2_FIXTURE_KEY } from './m2-fixture-key';

export { M2_BOARD_ID, M2_FIXTURE_KEY } from './m2-fixture-key';

let cached: Ruleset | undefined;

/** The frozen M2 bundle, validated on first access and cached frozen. */
export function getM2Fixture(): Ruleset {
  cached ??= parseRulesetJson(rawM2Core);
  return cached;
}

/** A bundle by the key a reference set names it by: the frozen M2 bundle under its own key,
 *  any other through the registry. What tests hand the balance report, as the command line
 *  hands it `loadArtifactRuleset`. */
export function loadRulesetOrM2Fixture(key: string): Ruleset {
  return key === M2_FIXTURE_KEY ? getM2Fixture() : getBundledRuleset(key);
}
