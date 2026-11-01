// balance-cli.ts — M3 story 1: `pnpm --filter @wynding/content run balance` prints the
// balance report (`balance-report.ts`) for every registered reference set. Opt-in: it is
// not part of `verify`.
//
// It runs under `tsx`, outside Vite, so the registry's `?raw` import is unavailable; it
// reads the bundled artifact from disk and parses it through the same `parseRulesetJson`
// the registry uses — the server's loader path (`./artifact.ts`), the same bytes.

import { readFileSync } from 'node:fs';
import { parseRulesetJson } from '@wynding/sim';
import { BUNDLED_ARTIFACT_URL } from './artifact';
import { balanceReport } from './balance-report';
import { REFERENCE_SETS } from './reference-builds';

// `artifact.ts` names the shipped bundle's file; its id is the registry's default
// (`registry.ts` itself can't be imported here — its `?raw` import is Vite-only).
const ARTIFACTS: ReadonlyMap<string, URL> = new Map([['wynding-core', BUNDLED_ARTIFACT_URL]]);

console.log(
  balanceReport(REFERENCE_SETS, (rulesetId) => {
    const url = ARTIFACTS.get(rulesetId);
    if (url === undefined) throw new Error(`balance: no on-disk artifact for '${rulesetId}'`);
    return parseRulesetJson(readFileSync(url, 'utf8'));
  }),
);
