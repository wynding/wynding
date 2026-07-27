// artifact.ts — the `@wynding/content/artifact` subpath export (M2-S1 Validation
// architecture).
//
// A SEPARATE entry from the main `@wynding/content` registry (`./index.ts`) so the
// server's cold-start disk-read path never drags the bundler-embedded raw TEXT (the
// registry's `?raw` import) into its module graph — `BUNDLED_ARTIFACT_URL` is the
// ONLY export here, and this module imports nothing else, so evaluating it never
// evaluates any bundled artifact content.

/** The on-disk URL of the shipped M1 artifact — the server reads this via
 *  `readFileSync` at cold start; `parseRulesetJson` (from `@wynding/sim`) then
 *  parses + validates the same bytes the client's registry carries bundled. */
export const BUNDLED_ARTIFACT_URL = new URL('./rulesets/wynding-core-m1.json', import.meta.url);
