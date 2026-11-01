// m2-fixture-key.ts — what names the FROZEN M2 bundle (`m2-fixture.ts`), in a module that
// loads nothing. Test/tooling support, NOT part of this package's public API.
//
// Its own module because two loaders need the names and only one of them runs under Vite:
// `m2-fixture.ts` reads the JSON through a `?raw` import, which `tsx` (the balance command,
// `balance-cli.ts`) cannot resolve, and `balance-artifacts.ts` reads it from disk. A reference
// set names its bundle by `M2_FIXTURE_KEY`, so the balance command reaches this module and
// never the `?raw` one.

/** The key a reference set names the frozen M2 bundle by (`ReferenceSet.rulesetId`). Not the
 *  bundle's own `rulesetId`, which is the shipped `wynding-core` it was frozen from: a key of
 *  its own is what lets a loader tell it from the shipped bundle of that id. */
export const M2_FIXTURE_KEY = 'm2-fixture';

/** The frozen M2 bundle's one board — M1's and M2's board. */
export const M2_BOARD_ID = 'field-01';
