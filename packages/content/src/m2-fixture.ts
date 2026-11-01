// m2-fixture.ts — the FROZEN M2 bundle (M3 story 4): `field-01` and M2's ten waves, kept
// as a test fixture once the crossing board became the shipped default. Test/tooling
// support, NOT part of this package's public API — the `showcase-builds.ts` precedent:
// nothing in `index.ts` re-exports it and no `exports` subpath reaches it, so the client
// build never carries it, and the JSON sits outside `rulesets/`, so no build step copies
// it next to the shipped artifacts either.
//
// The JSON is byte-for-byte the `wynding-core.json` that `p1-m2` shipped, `rulesetId` and
// all, so M2's mechanism tests, `m2-golden` and every hash pinned against it keep their
// meaning unchanged: its `rulesetHash` is M2's (`m2-fixture.test.ts` pins it). It must
// never be edited — a change to the game goes in `rulesets/wynding-core.json`. M2 stays
// playable from the `p1-m2` tag.
//
// Parsed through the same `parseRulesetJson` the registry uses, then cached frozen — the
// registry's own posture (`registry.ts`).

import type { Ruleset } from '@wynding/types';
import { parseRulesetJson } from '@wynding/sim';
import rawM2Core from './fixtures/m2-wynding-core.json?raw';

/** The frozen M2 bundle's one board — M1's and M2's board. */
export const M2_BOARD_ID = 'field-01';

let cached: Ruleset | undefined;

/** The frozen M2 bundle, validated on first access and cached frozen. */
export function getM2Fixture(): Ruleset {
  cached ??= parseRulesetJson(rawM2Core);
  return cached;
}
