// balance-cli.ts — M3 story 1: `pnpm --filter @wynding/content run balance` prints the
// balance report (`balance-report.ts`) for every registered reference set, reading each
// bundle from disk (`balance-artifacts.ts`). Opt-in: it is not part of `verify`. It exits
// nonzero when the report can't be trusted — nothing registered, or a build whose plan
// didn't finish or whose run never ended.

import { loadArtifactRuleset } from './balance-artifacts';
import { balanceReport } from './balance-report';
import { REFERENCE_SETS } from './reference-builds';

const { text, failures } = balanceReport(REFERENCE_SETS, loadArtifactRuleset);
console.log(text);
if (failures.length > 0) {
  console.error(['balance: the report cannot be trusted:', ...failures].join('\n  '));
  process.exitCode = 1;
}
