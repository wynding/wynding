// registry.ts — the bundled ruleset registry (ADR 0007, M2-S1 Validation architecture).
//
// The main `@wynding/content` entry: the client-side loader half of the "two
// independent loaders" story (ADR 0007 §2). The registry carries the shipped
// artifact as BUNDLER-EMBEDDED RAW TEXT — `?raw` (Vite/vitest-native; typed for tsc
// via `./env.d.ts`'s ambient `declare module '*.json?raw'`, mirroring the web app's
// `*.css` precedent) — and feeds it through the SAME `parseRulesetJson` the server's
// disk-text cold-start path uses (`@wynding/content/artifact` + `readFileSync`), so
// the two loaders can never accept/reject different bundles on the same bytes.
//
// A future non-bundler Node consumer of the *registry* (rather than the artifact
// subpath) would need the disk path instead — that's exactly what
// `@wynding/content/artifact`'s `BUNDLED_ARTIFACT_URL` + `parseRulesetJson` provide.
//
// Validated on first access (not at module load, so a malformed bundle only ever
// surfaces from an explicit `getBundledRuleset()` call), then cached FROZEN — every
// caller shares the one immutable normalized `Ruleset`.

import type { Ruleset } from '@wynding/types';
import { parseRulesetJson, RulesetError } from '@wynding/sim';
import rawWyndingCoreM1 from './rulesets/wynding-core-m1.json?raw';

/** The ruleset id every match runs against unless a story specifies otherwise. */
export const DEFAULT_RULESET_ID = 'wynding-core-m1';

/** Bundled raw ruleset text, keyed by `rulesetId` — the registry's one source of
 *  truth for "which rulesets ship in this client build". */
const BUNDLED_TEXT: Readonly<Record<string, string>> = {
  [DEFAULT_RULESET_ID]: rawWyndingCoreM1,
};

/** Parsed + validated + frozen rulesets, cached by id on first access. */
const cache = new Map<string, Ruleset>();

/**
 * The bundled, validated `Ruleset` for `id` (default: {@link DEFAULT_RULESET_ID}).
 * Parses and validates via `@wynding/sim`'s `parseRulesetJson` on first access, then
 * caches the frozen normalized result — every subsequent call for the same `id`
 * returns the SAME frozen object. Throws `RulesetError` (from `@wynding/sim`) for an
 * unknown id or a bundle that fails structural validation.
 */
export function getBundledRuleset(id: string = DEFAULT_RULESET_ID): Ruleset {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const text = BUNDLED_TEXT[id];
  if (text === undefined) {
    // RulesetError for an unknown id too, so every registry failure surfaces
    // through the one error type sim callers expect.
    throw new RulesetError(`unknown bundled ruleset id '${id}'`);
  }
  const ruleset = parseRulesetJson(text);
  cache.set(id, ruleset);
  return ruleset;
}

/** Every bundled ruleset id, in registry order. */
export function bundledRulesetIds(): readonly string[] {
  return Object.keys(BUNDLED_TEXT);
}

/** The default board of a ruleset — the first entry of `boards` (the validator
 *  guarantees at least one). */
export function defaultBoardId(ruleset: Ruleset): string {
  return ruleset.boards[0]!.id;
}
