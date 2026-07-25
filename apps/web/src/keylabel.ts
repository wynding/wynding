// keylabel.ts — the one shared formatter from a stored `KeyboardEvent.code` to a display
// label (PLAN.md P2). ARIA's `aria-keyshortcuts` takes KEY NAMES, not physical codes, so a
// raw `codeFor()` value (e.g. `"Digit1"`, `"ArrowRight"`) is not a valid attribute value —
// every badge/settings display routes through here instead of showing the stored code
// verbatim. Pure and i18n-free (no `t()` here): the "unbound" case is represented as
// `null` so the caller supplies its own localized fallback text (`t('settings.unbound')`),
// keeping this module a plain, easily-unit-tested string mapper.

/** Map a stored `KeyboardEvent.code` to its display/aria-keyshortcuts label, or `null` for
 *  the unbound state (`code === null`). Handles the generic code families (`KeyA`-`KeyZ`,
 *  `Digit0`-`Digit9`, `Arrow*`, `Space`) plus a sensible identity fallback for anything else
 *  (`Enter`, `Escape`, `Tab`, `F1`, …) so a future rebindable action never renders `null`
 *  just because its code isn't one of the special-cased families. */
export function formatKeyLabel(code: string | null): string | null {
  if (code === null) return null;
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch !== null) return digitMatch[1] as string;
  const letterMatch = /^Key([A-Z])$/.exec(code);
  if (letterMatch !== null) return letterMatch[1] as string;
  if (code === 'Space') return 'Space';
  if (code.startsWith('Arrow')) return code;
  // Identity fallback: `Enter`, `Escape`, `Tab`, `F1`.. and anything else already reads as
  // a reasonable label verbatim.
  return code;
}
