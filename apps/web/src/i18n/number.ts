// number.ts — locale-aware number formatting for the i18n layer (PLAN.md P2). `t()`'s
// substitution (format.ts's `{name}` replace) is a raw string swap with no numeric
// facility, but the Panel's derived stats (range in tiles, fire rate in shots/sec) are
// non-integer and must format per-locale (e.g. a comma decimal separator in many European
// locales) rather than via `toFixed`, which is locale-blind.

// M1 ships exactly one locale; swap this for the active runtime locale once i18n grows
// past English (tracked alongside the rest of the catalog's single-locale scope).
const LOCALE = 'en';

const oneDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Format `n` to one decimal digit using the active locale. */
export function formatNumber(n: number): string {
  return oneDecimal.format(n);
}
