// balance-cli.ts — M3 story 1: `pnpm --filter @wynding/content run balance` prints the
// balance report (`balance-report.ts`) for every registered reference set, reading each
// bundle from disk (`balance-artifacts.ts`). Opt-in: it is not part of `verify`. It exits
// nonzero when the report can't be trusted — every failure `balance-report.ts` names: nothing
// registered, a set with no builds, a build whose plan didn't finish or whose run never
// ended, a juggling or centre-only build that isn't one of the set's, a juggling build that
// never juggles or goes over the replay's command budgets, or a capacity drawing the sim
// won't take as drawn or that doesn't draw the strongest build.

import { loadArtifactRuleset } from './balance-artifacts';
import { balanceReport } from './balance-report';
import { REFERENCE_SETS } from './reference-builds';

const { text, failures } = balanceReport(REFERENCE_SETS, loadArtifactRuleset);
console.log(text);
if (failures.length > 0) {
  console.error(['balance: the report cannot be trusted:', ...failures].join('\n  '));
  process.exitCode = 1;
}
