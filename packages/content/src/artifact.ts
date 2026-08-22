// artifact.ts — the `@wynding/content/artifact` subpath export (M2-S1 Validation
// architecture).
//
// A SEPARATE entry from the main `@wynding/content` registry (`./index.ts`) so the
// server's cold-start disk-read path never drags the bundler-embedded raw TEXT (the
// registry's `?raw` import) into its module graph — `BUNDLED_ARTIFACT_URL` is the
// ONLY export here, and this module imports nothing else, so evaluating it never
// evaluates any bundled artifact content.

/** The on-disk URL of the shipped artifact — the server reads this via
 *  `readFileSync` at cold start; `parseRulesetJson` (from `@wynding/sim`) then
 *  parses + validates the same bytes the client's registry carries bundled.
 *
 *  `import.meta.url` resolves beside whatever module this expression ENDS UP IN,
 *  and there are exactly two such modules. Workspace consumers (vitest, tsx,
 *  Vite) run the TS source, so it is `src/artifact.ts` → `src/rulesets/…`. The
 *  deployed server runs neither this file nor a compiled copy of it: esbuild
 *  inlines the expression into `apps/server/dist/handler.mjs` (#109), where it
 *  resolves beside the BUNDLE — `apps/server/dist/rulesets/…`, staged there by
 *  that package's build from this package's `dist/rulesets/` (`cp` after `tsc
 *  -b`; tsc emits no assets, and without that copy a deployed server ENOENTs at
 *  cold start — Codex PR #66 P1).
 *
 *  What does NOT happen is `dist/artifact.js` → `dist/rulesets/…`: this package's
 *  `exports` map points every subpath at `./src/*.ts`, so nothing ever loads the
 *  compiled copy of this module. `check:artifact-parity` keeps the claim honest
 *  the only way that works — by executing the built artifact under plain `node`. */
export const BUNDLED_ARTIFACT_URL = new URL('./rulesets/wynding-core.json', import.meta.url);
