// layout.ts — the ONE published layout trigger token and the declared-region registry
// (PLAN.md Story 11, the two-layouts contract §3/§5).
//
// Wynding ships exactly TWO layouts out of one DOM and one stylesheet fork:
//
//   Standard — viewports taller than the Compact trigger. Status bar across the top, the
//              Dock floating over the Stage's bottom-left.
//   Compact  — short viewports (phones in landscape, and any window under the trigger).
//              The status header becomes a full-height left COLUMN holding the status
//              chips above its own in-column Dock; the board takes the rest.
//
// `COMPACT_QUERY` is the single source of truth for the trigger. `ui.css` repeats the
// query text in exactly ONE documented block, and `layout.test.ts` mechanically asserts
// both facts (one occurrence, string-equal to this constant) so the stylesheet and the
// TypeScript view of the layout can never silently drift apart.

/** The Compact trigger (contract §3). Viewport HEIGHT alone — a narrow-but-tall window is
 *  still Standard; a short-but-wide one (a phone in landscape) is Compact. */
export const COMPACT_QUERY = '(max-height: 500px)';

/** The attribute every declared layout region carries (contract §5). */
export const REGION_ATTR = 'data-wy-region';

/** Every declared layout region. `compact.spec.ts` asserts (a) every visible direct layout
 *  child of `.wy-shell`/`.wy-main` carries one of these — so a future element cannot ship
 *  undeclared — and (b) the per-region geometric relation to the projected playable grid. */
export const LAYOUT_REGIONS = ['status', 'stage', 'dock', 'rail'] as const;

export type LayoutRegion = (typeof LAYOUT_REGIONS)[number];

/** Structural containers exempt from carrying a region attribute (contract §5): they hold
 *  regions rather than being one. The undeclared-child rule instead requires every visible
 *  child of an exempt container to be declared itself. */
export const EXEMPT_CONTAINER_SELECTOR = '.wy-main';
