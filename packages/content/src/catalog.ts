// catalog.ts — the `@wynding/content/catalog` subpath export (M2-S11 P7, the
// catalog-scale perf scene).
//
// Structurally identical to `./stress.ts`, and for the same reasons: a SEPARATE entry
// from the main `@wynding/content` registry (`./index.ts`), exporting nothing but the
// three constants below and importing nothing at all, so evaluating this module never
// pulls the 40×40 catalog bundle into a consumer's module graph that did not ask for
// it.
//
// The catalog bundle is deliberately ABSENT from `registry.ts`'s `BUNDLED_TEXT` map,
// exactly like the stress bundle: it is a synthetic perf ceiling (1,000,000-hp creeps,
// 1,000,000 starting lives, a starting bounty pinned to the exact cost of a 150-tower
// maze), not shippable content, and `wynding-core`'s content hash must stay untouched
// by its presence in this package.
//
// What makes it a DIFFERENT scene from the stress bundle rather than a variant of it:
// its tower catalog is the NINE REAL `wynding-core` towers, verbatim — same ids, same
// costs, same attack blocks, same effect bundles — so the browser frame-time spike it
// measures is the cost of the shipped catalog at 150-tower scale, not the cost of
// three synthetic stand-ins. Its board geometry, entrance/exit and anchor set are the
// stress scene's, reused unchanged, so the as-built maze route is pre-committed at 329
// cells rather than "measured at authoring".
//
// A `new URL(..., import.meta.url)` (not a `?raw` import) for the same reason
// `stress.ts` gives: both the Node perf harness (`readFileSync`) and the browser perf
// build (`fetch`) load the exact same bytes through the one genuine `parseRulesetJson`
// path.

/** The bundled catalog ruleset's id — matches `rulesetId` inside the JSON. */
export const CATALOG_RULESET_ID = 'catalog-40x40';

/** The catalog bundle's single board id — matches `boards[0].id` inside the JSON.
 *  Equal in string value to `CATALOG_RULESET_ID` but distinct in MEANING (see
 *  `stress.ts`'s `STRESS_BOARD_ID` for the full argument), so it is its own named
 *  export rather than callers reusing the ruleset id where they mean "board". */
export const CATALOG_BOARD_ID = 'catalog-40x40';

/** The on-disk URL of the catalog bundle. Resolves beside THIS module in either tree
 *  (`src/catalog.ts` → `src/rulesets/…`, `dist/catalog.js` → `dist/rulesets/…`); the
 *  package's `build` script already globs `src/rulesets/*.json` into `dist/rulesets/`,
 *  so this needs no build change. */
export const CATALOG_RULESET_URL = new URL('./rulesets/catalog-40x40.json', import.meta.url);
