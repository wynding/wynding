// balance-artifacts.ts — M3 story 1: the balance command's ruleset loader. Test/tooling
// support, NOT part of this package's public API — the `showcase-builds.ts` precedent.
//
// The command runs under `tsx`, outside Vite, so the registry's `?raw` import is
// unavailable; this reads a bundled artifact from disk and parses it through the same
// `parseRulesetJson` the registry uses — the server's loader path (`./artifact.ts`), the
// same bytes.

import { readFileSync } from 'node:fs';
import { parseRulesetJson } from '@wynding/sim';
import type { Ruleset } from '@wynding/types';
import { BUNDLED_ARTIFACT_URL } from './artifact';

// `artifact.ts` names the shipped bundle's file; its id is the registry's default
// (`registry.ts` itself can't be imported under `tsx` — its `?raw` import is Vite-only).
const ARTIFACTS: ReadonlyMap<string, URL> = new Map([['wynding-core', BUNDLED_ARTIFACT_URL]]);

/** The bundled ruleset `rulesetId`, read from disk and validated. */
export function loadArtifactRuleset(rulesetId: string): Ruleset {
  const url = ARTIFACTS.get(rulesetId);
  if (url === undefined) throw new Error(`balance: no on-disk artifact for '${rulesetId}'`);
  return parseRulesetJson(readFileSync(url, 'utf8'));
}
