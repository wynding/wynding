// layout.test.ts — the mechanical synchronization gate for the ONE published Compact
// trigger (Story 11's two-layouts contract §3). `ui.css` cannot import a TypeScript
// constant, so the query text is necessarily duplicated there; this test makes that
// duplication SAFE by asserting, against the real stylesheet, that (a) the query appears in
// exactly one block and (b) it is string-equal to `COMPACT_QUERY`. Editing either side
// alone fails CI.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  COMPACT_QUERY,
  LAYOUT_REGIONS,
  REGION_ATTR,
  EXEMPT_CONTAINER_SELECTOR,
  EXEMPT_CONTENT_SELECTOR,
  EXEMPT_FROM_DECLARATION,
  WALKED_CONTAINERS,
} from './layout';
import { PREVIEW_FLOAT_CAP_PX } from './preview-place';

// `new URL('./ui.css', import.meta.url)` would normally suffice, but under the jsdom test
// environment the global `URL` is jsdom's DOM implementation, not Node's — resolve via
// node:url/node:path instead (the same approach ui-contrast.test.ts uses).
const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.css'), 'utf8');

/** Every `@media <prelude> {` prelude in the stylesheet, comments stripped first so a
 *  commented-out block can neither satisfy nor break the count. */
function mediaPreludes(source: string): string[] {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = /@media\s+([^{]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(uncommented)) !== null) out.push((m[1] as string).trim());
  return out;
}

describe('layout — the one published Compact trigger (contract §3)', () => {
  it('ui.css declares the Compact trigger in exactly ONE media block', () => {
    // The complement block (`not all and …`) also contains the `max-height` substring —
    // exclude `not`-prefixed preludes so only positive triggers are counted.
    const matching = mediaPreludes(css).filter(
      (p) => p.includes('max-height') && !p.startsWith('not'),
    );
    expect(matching).toHaveLength(1);
  });

  it("that block's query is string-equal to COMPACT_QUERY", () => {
    const matching = mediaPreludes(css).filter(
      (p) => p.includes('max-height') && !p.startsWith('not'),
    );
    expect(matching[0]).toBe(COMPACT_QUERY);
  });

  it('the Standard-only re-budget block is the exact gap-free COMPLEMENT of COMPACT_QUERY', () => {
    // ui.css cannot negate a TypeScript constant, so the Standard-only fork at the banner
    // re-budget is written as the query's NEGATION (`not all and <trigger>`), which is
    // gap-free for fractional viewport heights — `(min-height: 501px)` would leave e.g.
    // 500.5px (page zoom) matching NEITHER fork. Assert the pair stays complementary —
    // otherwise moving the trigger would strand the re-budget on a stale query.
    const matching = mediaPreludes(css).filter((p) => p.startsWith('not'));
    expect(matching).toEqual([`not all and ${COMPACT_QUERY}`]);
  });

  it('COMPACT_QUERY is height-keyed only (decision 1: viewport height alone, never pointer)', () => {
    expect(COMPACT_QUERY).not.toMatch(/pointer|width|hover/);
  });

  it('the region registry names the P1 regions (+ the playtest-round preview) and the exempt structural container', () => {
    expect([...LAYOUT_REGIONS]).toEqual(['status', 'stage', 'dock', 'rail', 'banner', 'preview']);
    expect(REGION_ATTR).toBe('data-wy-region');
    expect(EXEMPT_CONTAINER_SELECTOR).toBe('.wy-main');
  });

  it('centralizes the probe walk/exemption vocabulary (contract §5, consumed by layout-probe)', () => {
    // `.wy-home` (not `.wy-wordmark`): the wordmark moved INSIDE the site home anchor, so the
    // anchor is what the `.wy-status` walk now sees as a direct child. `.wy-board` joined
    // when the Stage joined the walk (playtest round): the stage region's own content, as
    // `.wy-hud` is the status region's.
    expect(EXEMPT_CONTENT_SELECTOR).toBe('.wy-home, .wy-hud, .wy-board');
    expect(EXEMPT_FROM_DECLARATION).toBe('.wy-main, .wy-home, .wy-hud, .wy-board');
    expect([...WALKED_CONTAINERS]).toEqual(['.wy-shell', '.wy-main', '.wy-status', '.wy-stage']);
  });
});

// Every custom-property declaration of `prop`, comments stripped first, so a token declared
// in more than one block (e.g. `--wy-rail-w`'s base + Compact override) yields both values
// and the caller can pick the one it means to assert on.
function tokenDecls(source: string, prop: string): string[] {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = new RegExp(`${prop}\\s*:\\s*([^;]+);`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(uncommented)) !== null) out.push((m[1] as string).trim());
  return out;
}

/** The declaration block of the FIRST rule whose selector text matches `selector` exactly,
 *  comments stripped. Asserting on source text rather than computed style because jsdom
 *  performs no CSS layout at all and resolves neither `calc()` nor `env()`. */
function ruleBody(source: string, selector: string): string {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(
    `(^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  );
  const m = re.exec(uncommented);
  if (m === null) throw new Error(`no rule for selector ${selector}`);
  return (m[2] as string).replace(/\s+/g, ' ').trim();
}

// The home link's Standard box model and its visibility contract are pure CSS, so this is
// where they are pinned. The e2e specs measure the RESULT in a real browser; these
// assertions exist so a change to the mechanism fails here first, with a reason attached.
describe('layout — the home link box model and visibility contract', () => {
  it('reaches the 44px hit box by spending the row padding, not by growing the row', () => {
    const home = ruleBody(css, '.wy-home');
    // The border box is PINNED to 44px, not derived from a padding calculation: a browser's
    // real line box comes from the font's metrics, not `font-size × line-height`, so the
    // derived form lands a fraction of a pixel under the floor (Chrome: 43.97px).
    expect(home).toContain('min-height: 44px');
    expect(home, 'min-height must bound the BORDER box, or padding would push past it').toContain(
      'box-sizing: border-box',
    );
    // …and negative block margins let that box overlap the row's own padding instead of
    // adding to the flow. The cap is what keeps it inside `.wy-status`: the margins may never
    // exceed the row padding, or the 44px box would reach past the header into the board.
    expect(home).toContain('margin-block: -0.5rem');
    const status = ruleBody(css, '.wy-status');
    expect(
      status,
      'the negative margins are capped at THIS value — they must stay equal',
    ).toContain('padding: 0.5rem 1rem');
  });

  it('removes interactivity in the same rule that starts the fade — never a mid-fade ghost', () => {
    const live = ruleBody(css, '.wy-home[data-live]');
    expect(live).toContain('pointer-events: none');
    expect(live).toContain('opacity: 0');
    // `visibility` lands at the fade's END (a 0s transition, delayed) purely for AT/paint
    // cleanliness — the interactivity above is what actually gates activation, and it is
    // instant. Paired with the `inert` attribute `overlay.ts` sets in the same synchronous
    // write (asserted in overlay.test.ts).
    expect(live).toContain('visibility: hidden');
    expect(live).toMatch(/visibility 0s linear 180ms/);
  });

  it('drops the transition on BOTH reduced-motion branches', () => {
    // In-app: the settings toggle, reflected onto the Shell by main.ts.
    expect(ruleBody(css, '.wy-shell[data-wy-reduced-motion] .wy-home')).toContain(
      'transition: none',
    );
    // OS: the global `prefers-reduced-motion: reduce` block at the foot of the stylesheet
    // already kills every transition with `!important`, so the link needs no rule of its own
    // there — assert the block still exists and still does that, since this contract now
    // depends on it.
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const osBlock = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(
      uncommented,
    );
    expect(osBlock, 'the OS reduced-motion block must exist').not.toBeNull();
    expect((osBlock as RegExpExecArray)[1]).toContain('transition: none !important');
  });

  it('the hover affordance is scoped to the ANCHOR, so a hosted mark cannot paint one', () => {
    // #146 consumer 3 / ADR 0012. When hosted the mark ships as `span.wy-home` with no
    // destination, and hover paint on it is an advertisement of interactivity that no longer
    // exists — worst on the pointer-driven desktop host the ADR exists to keep correct.
    //
    // The gate is the ELEMENT TYPE rather than a `hosted` attribute on purpose: the paint
    // then cannot outlive the link, because it is keyed on the link. Asserted on source text
    // because jsdom applies no CSS at all — an unscoped selector would be invisible to every
    // other test in the suite.
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(ruleBody(uncommented, 'a.wy-home:hover')).toContain('background: var(--wy-surface)');
    expect(ruleBody(uncommented, 'a.wy-home:hover .wy-wordmark')).toContain(
      'text-decoration: underline',
    );
    // …and EVERY occurrence of the hover selector is anchor-scoped. Asserted positively —
    // enumerate what is actually there and check each prefix — because two successive
    // negative guards each shipped with a hole: the first enumerated positions and missed
    // the descendant form (`.wy-status .wy-home:hover`); the second used a lookbehind that
    // excluded any word character and so admitted `span.wy-home:hover`, which is precisely
    // the selector that would repaint hover on the hosted mark. A positive check cannot have
    // a third hole: anything not exactly `a`-prefixed fails, whatever shape it takes. Since
    // jsdom applies no CSS, this source-text guard is the only thing between a hosted desktop
    // host and a hover tint on a dead element.
    const hoverPrefixes = [...uncommented.matchAll(/(\S*)\.wy-home:hover/g)].map((m) => m[1] ?? '');
    expect(hoverPrefixes.length, 'the hover rules must still be present').toBeGreaterThanOrEqual(2);
    expect(
      hoverPrefixes.filter((p) => p !== 'a'),
      'every `.wy-home:hover` must be anchor-scoped — these are not',
    ).toEqual([]);
    // The focus ring is scoped the same way. A `span` cannot match `:focus-visible` anyway,
    // so this is consistency rather than a fix — but an unscoped rule would read as a claim
    // that the hosted mark is focusable.
    expect(ruleBody(uncommented, 'a.wy-home:focus-visible')).toContain('outline-offset: -3px');
  });

  it('Compact drops the Standard box model entirely — the playfield pays nothing', () => {
    // The Compact rules live inside the single `@media (max-height: 500px)` block, so scope
    // the search to it rather than matching the Standard `.wy-home` rule again.
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const compact = uncommented.slice(uncommented.indexOf(`@media ${COMPACT_QUERY}`));
    const home = ruleBody(compact, '.wy-home');
    // The 44px floor is INHERITED from the Standard rule (same `min-height`); what Compact
    // drops is the negative-margin trick, which only makes sense against a row's padding.
    // Here the anchor is an in-flow column item and simply takes its full 44px.
    expect(home).toContain('margin-block: 0');
    expect(home).not.toContain('min-height');
    // …and replaces it with the HORIZONTAL twin, which is load-bearing rather than cosmetic:
    // the column track is `min(4rem, 10vw)`, so on a narrow viewport it does not grow with
    // the root font while the column's own rem padding does — at 568px @ 200% zoom that took
    // the anchor to 40.8px, under the ADR 0003 floor. Reclaiming the padding pins it to the
    // full track width at every zoom level. The cap is the column's padding, same rule as
    // Standard's: exceed it and the anchor would escape the column.
    expect(home).toContain('margin-inline: -0.25rem');
    const compactStatus = ruleBody(compact, '.wy-status');
    expect(
      compactStatus,
      'the negative inline margins are capped at THIS padding — they must stay equal',
    ).toContain('padding: 0.25rem');
    // The text stays hidden exactly as before; the mark alone carries the branding.
    expect(ruleBody(compact, '.wy-wordmark')).toContain('display: none');
  });
});

// The wave preview's band grants (#101): three custom properties `main.ts` writes and
// `ui.css` reads. The DEFAULTS are what a pre-measurement pass (jsdom, a stage mid-resize)
// renders with, and one of them carries a number `preview-place.ts` mirrors — so, exactly
// like COMPACT_QUERY above, the duplication is made safe by asserting it rather than by
// trusting it.
describe('layout — the wave preview’s band grants (#101)', () => {
  const preview = ruleBody(css, '.wy-wave-preview');

  it('reads all three band properties, each with its pre-measurement default', () => {
    expect(preview).toContain('left: var(--wy-preview-left, 0.5rem)');
    expect(preview).toContain('right: var(--wy-preview-right, auto)');
    expect(preview).toContain('max-width: var(--wy-preview-max-w, min(256px, 45%))');
  });

  it('the stylesheet’s own width cap is the one preview-place.ts mirrors', () => {
    // `preview-place.ts` clamps a band wider than the cap back to it, so the card can never
    // be stretched past the box this stylesheet declares. A silent edit to either number
    // would let a wide band grow the card beyond its declared cap with nothing failing.
    expect(preview).toContain(`min(${PREVIEW_FLOAT_CAP_PX}px,`);
  });

  it('the reduced-weight companion form exists and is scoped to its own class', () => {
    // Candidate 5 (#101) applies ONLY while the card borrows the board's blocked border
    // ring; `main.ts` toggles the class. An unconditional edit into the base rule above
    // would paint it over the letterbox band too, where there is no board underneath.
    expect(ruleBody(css, '.wy-wave-preview--over-board')).toContain('border-style: dashed');
    expect(preview).not.toContain('border-style: dashed');
  });
});

describe('layout — the safe-area seam (#136)', () => {
  // A Compact region that spends a safe-area inset as INTERNAL padding while its grid track is
  // a fixed width starves the content by the inset (≈44–59px on a notched iPhone in
  // landscape). Pin that each such token grows its track by the matching inset so the content
  // keeps its intended min() width.
  //
  // Every inset read now goes through a `--wy-safe-*` token rather than `env()` directly,
  // because `env()` cannot be set from a test and a custom property can — `insets.spec.ts`
  // drives the rendered consequences through the same property Capacitor writes. These source
  // assertions are what scale to all twenty call sites; the rendered spec covers five
  // mechanisms and structurally cannot reach the rest.
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const AXES = ['top', 'right', 'bottom', 'left'] as const;

  it.each(AXES)('--wy-safe-%s chains to its OWN axis of env()', (axis) => {
    const decls = tokenDecls(css, `--wy-safe-${axis}`);
    expect(decls).toHaveLength(1);
    // `env()` is iOS's source and the source wherever Capacitor is absent. Dropping it would
    // leave the token silently zero on every non-Capacitor platform, which no rendered test
    // in CI can see — CI has no insets either way.
    expect(decls[0]).toContain(`env(safe-area-inset-${axis}`);
    // A transposed axis here would misroute EVERY consumer of this token at once.
    for (const other of AXES) {
      if (other !== axis) expect(decls[0]).not.toContain(`safe-area-inset-${other}`);
    }
  });

  it('env(safe-area-inset-*) appears ONLY inside the four token declarations', () => {
    // The completeness guard. A site left on bare `env()` still works today — CI resolves it
    // to zero exactly as the token does — so nothing else in the suite would notice, and the
    // seam would be silently incomplete.
    const withoutTokens = uncommented.replace(/--wy-safe-(?:top|right|bottom|left)\s*:[^;]+;/g, '');
    const strays = withoutTokens.match(/env\(safe-area-inset-\w+/g) ?? [];
    expect(strays, `these sites bypass the seam: ${strays.join(', ')}`).toEqual([]);

    // The OTHER way round the seam, and the more dangerous one: reading the Capacitor-owned
    // name directly. `padding-left: calc(1rem + var(--safe-area-inset-left))` trips no guard
    // above (no `env(`, no `--wy-safe-*` to axis-check) and would look correct in
    // `insets.spec.ts`, which injects exactly that property — then break everywhere Capacitor
    // is absent, because with no `env()` fallback the variable is unset, the substitution is
    // guaranteed-invalid, and the whole declaration dies at computed-value time. The seam
    // comment in ui.css names this property, so reaching for it is the easy mistake.
    const direct = withoutTokens.match(/var\(--safe-area-inset-\w+/g) ?? [];
    expect(direct, `use --wy-safe-*, not the raw Capacitor name: ${direct.join(', ')}`).toEqual([]);
  });

  it('every axis-named property reads its MATCHING axis token', () => {
    // Catches a transposition at a call site (e.g. `padding-left: … var(--wy-safe-right)`),
    // which no rendered assertion covers for the sites `insets.spec.ts` cannot reach.
    const re = /(?:scroll-)?(?:padding|margin|inset)-(top|right|bottom|left)\s*:([^;]+);/g;
    const wrong: string[] = [];
    let seen = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(uncommented)) !== null) {
      const [, axis, value] = m as unknown as [string, string, string];
      const token = /var\(--wy-safe-(top|right|bottom|left)\)/.exec(value);
      if (token === null) continue;
      seen += 1;
      if (token[1] !== axis) wrong.push(m[0].trim());
    }
    expect(wrong).toEqual([]);
    // The tripwire the sibling below already had and this one did not. Without it, a site
    // leaving the regex's reach — a logical longhand (`padding-inline-start`), a fold into the
    // `padding` shorthand, a dropped trailing `;` — takes its transposition cover with it and
    // `wrong` stays `[]`, passing while guarding nothing. `ui.css` already uses logical
    // longhands next door (`.wy-home { margin-block: … }`), so that refactor is ordinary.
    expect(seen, 'expected the fifteen axis-named sites that read an inset').toBe(15);
  });

  it('the three guards together account for every token read', () => {
    // 15 axis-named + 3 vertical bounds + 2 track tokens = the 20 call sites. Asserting the
    // partition means a NEW read cannot land in the gap between the guards: it either matches
    // one of them or fails this. Each guard's own count pins its share; this pins the whole.
    const reads = uncommented.match(/var\(--wy-safe-(?:top|right|bottom|left)\)/g) ?? [];
    expect(reads).toHaveLength(20);
  });

  it('vertical bounds read a VERTICAL axis token', () => {
    // The axis-named guard above matches `padding|margin|inset-<axis>` longhands, which three
    // of the twenty call sites are not: two `max-height` bounds and one `height`, all
    // subtracting `--wy-safe-top`. Two of those sit behind `:has()` selectors that are not
    // exercised at page load (`.wy-shell:has(.wy-banner:not([hidden]))` and
    // `.wy-hud:has(> .wy-wave-preview)`), so a top→left slip there would shrink the HUD by the
    // wrong inset with the entire suite green — the exact failure the guard exists to catch,
    // in the one place it could not see.
    const re = /(?:max-)?height\s*:([^;]+);/g;
    const wrong: string[] = [];
    let seen = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(uncommented)) !== null) {
      const token = /var\(--wy-safe-(top|right|bottom|left)\)/.exec(m[1] as string);
      if (token === null) continue;
      seen += 1;
      // TOP specifically, not "any vertical axis" (Codex P2 on c9b1cfa). All three of these
      // are `calc(NNdvh - 3.5rem - var(--wy-safe-top))` — a budget measured DOWN from the top
      // edge, so `top` is the only correct axis. Accepting `bottom` as well let a slip pass
      // this guard AND keep the 20-read partition intact, while the rendered spec probes only
      // the base `.wy-hud` rule and never the two `:has()`-gated ones — so those bounds would
      // react to the wrong physical inset with the whole suite green.
      if (token[1] !== 'top') wrong.push(m[0].trim());
    }
    expect(seen, 'expected the three vertical bounds that read an inset').toBe(3);
    expect(wrong).toEqual([]);
  });

  it('--wy-compact-col grows its track by the left inset (`.wy-status` pads left)', () => {
    const decls = tokenDecls(css, '--wy-compact-col');
    expect(decls).toHaveLength(1);
    expect(decls[0]).toContain('min(4rem, 10vw)');
    expect(decls[0]).toContain('var(--wy-safe-left)');
  });

  it('the Compact --wy-rail-w override grows its track by the right inset (`.wy-rail` pads right)', () => {
    // `--wy-rail-w` is declared twice — the Standard base clamp and this Compact override;
    // pick the override by its distinctive `min(9rem, 28vw)` core.
    const override = tokenDecls(css, '--wy-rail-w').find((d) => d.includes('min(9rem, 28vw)'));
    expect(override).toBeDefined();
    expect(override).toContain('var(--wy-safe-right)');
  });
});
