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
// TypeScript view of the layout can never silently drift apart. The one Standard-ONLY block
// (`@media not all and (max-height: …)`, the banner re-budget) is the hand-written
// gap-free complement (negation) of this query; `layout.test.ts` gates that pair too, so
// the two can never overlap or leave a fractional-height gap.

/** The Compact trigger (contract §3). Viewport HEIGHT alone — a narrow-but-tall window is
 *  still Standard; a short-but-wide one (a phone in landscape) is Compact. */
export const COMPACT_QUERY = '(max-height: 500px)';

/** The attribute every declared layout region carries (contract §5). */
export const REGION_ATTR = 'data-wy-region';

/** Every declared layout region. `compact.spec.ts` asserts (a) every visible direct layout
 *  child of `.wy-shell`/`.wy-main` carries one of these — so a future element cannot ship
 *  undeclared — and (b) the per-region geometric relation to the projected playable grid.
 *  `banner` is the install suggestion's reserved row (Story 11 P3); it is declared here
 *  unconditionally even though the element is usually `hidden`, because the registry
 *  describes the layout's VOCABULARY, not what happens to be on screen. `preview` is the
 *  wave-preview surface (playtest round): floating over the Stage on Standard — the
 *  second Stage overlay after the Dock, budgeted by the same relations gate — and in-flow
 *  inside `.wy-hud` on Compact or under heavy text zoom, where `regionRect` still finds
 *  it but the relations rule demands grid-disjointness instead of a budget. */
export const LAYOUT_REGIONS = ['status', 'stage', 'dock', 'rail', 'banner', 'preview'] as const;

export type LayoutRegion = (typeof LAYOUT_REGIONS)[number];

/** Structural containers exempt from carrying a region attribute (contract §5): they hold
 *  regions rather than being one. The undeclared-child rule instead requires every visible
 *  child of an exempt container to be declared itself. */
export const EXEMPT_CONTAINER_SELECTOR = '.wy-main';

/** Content painted INSIDE a region — the home link and the HUD chips (status), and the
 *  board mount (stage) — rather than regions the Shell places. They sit under walked
 *  containers yet are not layout regions, so the undeclared-child gate exempts them
 *  explicitly.
 *
 *  `.wy-home` replaced `.wy-wordmark` here when the wordmark was UPGRADED into the site home
 *  anchor: the wordmark span is now a child of that anchor, not a direct child of
 *  `.wy-status`, so it is no longer reached by the walk at all — only its new parent is.
 *  `.wy-board` joined when `.wy-stage` joined the walk (playtest round): the board is the
 *  stage region's own content, exactly as `.wy-hud` is the status region's. */
export const EXEMPT_CONTENT_SELECTOR = '.wy-home, .wy-hud, .wy-board';

/** The FULL exemption from contract §5's undeclared-child gate: the structural container plus
 *  the status content above. Nothing else may ship undeclared. `layout-probe.ts`'s
 *  `assertDeclaredRegions` consumes this, so the exemption vocabulary lives in ONE place. */
export const EXEMPT_FROM_DECLARATION = `${EXEMPT_CONTAINER_SELECTOR}, ${EXEMPT_CONTENT_SELECTOR}`;

/** The containers whose VISIBLE children must each declare a region (contract §5). `.wy-status`
 *  is walked alongside `.wy-shell`/`.wy-main`: Story 11's topology amendment reparented the
 *  Dock into it, so `.wy-dock` — and anything a future packet adds beside it — is a Shell
 *  layout child in all but nesting, and would otherwise escape the gate entirely.
 *  `.wy-stage` joined at the playtest round for the same reason: the floating wave preview
 *  made the Stage a host of overlay surfaces, and an undeclared overlay is exactly how the
 *  preview's 200%-zoom growth escaped every budget until it covered the whole grid. */
export const WALKED_CONTAINERS = [
  '.wy-shell',
  EXEMPT_CONTAINER_SELECTOR,
  '.wy-status',
  '.wy-stage',
] as const;
