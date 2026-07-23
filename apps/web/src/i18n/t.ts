// t.ts — the single typed translation accessor (ADR 0004). Every user-facing string in
// the app comes through here; the `no-ui-literals` ESLint rule bans raw literals in
// DOM-text / aria / title sinks so nothing bypasses the catalog. Keys and per-key param
// types are generated from `en` (catalog.gen.ts); a call with the wrong key or missing/
// extra params is a compile error. The formatter substitutes ICU `{name}` placeholders;
// M1 uses only simple named substitution (no plural/select branches yet).

import { EN, type MessageKey, type MessageParams } from './catalog.gen';

/** Substitute `{name}` tokens in `message` from `params` (values stringified). Unknown
 *  placeholders are left intact so a mis-supplied param surfaces visibly rather than
 *  silently vanishing. */
export function format(message: string, params?: Record<string, string | number>): string {
  if (params === undefined) return message;
  // NB: this ICU `{name}` grammar mirrors scripts/i18n-gen.mjs `placeholders()`. The two
  // live on opposite sides of a runtime boundary — this is app-bundled browser code, that
  // is a Node dev-only build script — so a single shared source would couple the shipped
  // bundle to the build tooling. If the grammar ever changes, update BOTH (kept simple and
  // identical on purpose).
  return message.replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** True when key `K` takes no parameters (its param type has no own keys). */
type NoParams<K extends MessageKey> = keyof MessageParams[K] extends never ? true : false;

/**
 * Resolve a catalog key to its localized string. Param-less keys are called with just
 * the key; parameterized keys require their exact params object — both enforced at
 * compile time via the generated `MessageParams`.
 */
export function t<K extends MessageKey>(
  key: K,
  ...args: NoParams<K> extends true ? [] : [params: MessageParams[K]]
): string {
  const params = args[0] as Record<string, string | number> | undefined;
  return format(EN[key], params);
}
