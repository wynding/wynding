// stress.ts — the `@wynding/content/stress` subpath export (M2-S4b, the ADR 0005
// stress scenario).
//
// A SEPARATE entry from the main `@wynding/content` registry (`./index.ts`) and from
// `./artifact.ts` — `STRESS_RULESET_URL` is the ONLY export here, and this module
// imports nothing else, so evaluating it never pulls the 40×40 stress bundle into
// any consumer's module graph that did not ask for it.
//
// The stress bundle is deliberately ABSENT from `registry.ts`'s `BUNDLED_TEXT` map:
// it is a synthetic perf ceiling (1,000,000 hp creeps, 1,000,000 starting lives —
// see `stress.test.ts`'s header for why), not shippable content. It must never
// reach the client build, and `wynding-core`'s content hash — the one every player
// actually plays against — must stay untouched by its presence in this package.
//
// A `new URL(..., import.meta.url)` (not a `?raw` import, which would bundler-embed
// the text into whatever imports this module) is what lets both the Node perf
// harness (`readFileSync`) and the browser perf build (`fetch`) load the exact same
// bytes through the one genuine `parseRulesetJson` path — no bespoke loader, no
// second source of truth for what "the stress bundle" means.

/** The bundled stress ruleset's id — matches `rulesetId` inside the JSON below. */
export const STRESS_RULESET_ID = 'stress-40x40';

/** The stress bundle's single board id — matches `boards[0].id` inside the JSON
 *  below. Equal in string value to `STRESS_RULESET_ID` (the bundle has exactly one
 *  board, named after its one ruleset) but distinct in MEANING — a ruleset id and a
 *  board id are different axes even when a bundle happens to have only one of each —
 *  so this is its own named export rather than callers reusing `STRESS_RULESET_ID`
 *  where they mean "board". */
export const STRESS_BOARD_ID = 'stress-40x40';

/** The on-disk URL of the stress bundle. Resolves beside THIS module in either
 *  tree: workspace consumers run the TS source (`src/stress.ts` → `src/rulesets/…`),
 *  while a dist-built deployment runs `dist/stress.js` → `dist/rulesets/…` — the
 *  package's `build` script already globs `src/rulesets/*.json` into
 *  `dist/rulesets/` (see `artifact.ts`'s precedent), so this needs no build change. */
export const STRESS_RULESET_URL = new URL('./rulesets/stress-40x40.json', import.meta.url);
