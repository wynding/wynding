// insets.spec.ts — the safe-area seam's rendered half (#136).
//
// `ui.css` computes real geometry from the safe-area insets, including two grid track widths
// and three subtractive height bounds. None of it had ever been exercised at a NONZERO inset:
// `env()` cannot be set from a test, so the suite could only pin the source text of two
// declarations. Every read now goes through a `--wy-safe-*` token whose first term is
// `--safe-area-inset-*` — the exact property Capacitor sets on `document.documentElement`
// (`SystemBars.java:265-268`) — so these tests drive the identical path a device does.
//
// WHY EACH TEST NAMES ITS VIEWPORT. Several inset reads are unconditional in source but
// OVERRIDDEN in one fork, and asserting one at the wrong viewport is silently vacuous:
// `.wy-dock`'s bottom padding is zeroed in Compact (ui.css `padding-bottom: 0`), `.wy-hud`'s
// `max-height` becomes `none` there, and `.wy-hud:has(> .wy-wave-preview)`'s height becomes
// `auto`. Each assertion below therefore sits at the layout where its mechanism is live.
// Source-level completeness across all twenty-two call sites is `layout.test.ts`'s job; this file
// covers six MECHANISMS (the sixth, #153, is the Compact Rail paying the top inset) and
// structurally cannot reach the rest. It also holds #172's Standard Rail walks, which share
// #153's walk and check that Standard's Rail needs no top inset of its own.
import { test, expect, type Page } from '@playwright/test';
import { TARGET_MIN_PX } from './targets';

const PHONE = { width: 658, height: 320 }; // Compact — Galaxy S9+ landscape
const STANDARD = { width: 1000, height: 720 }; // Standard, and unpinned at both zooms
// Standard by height, with the narrow Rail that pins an armed Panel (#172's viewport).
const TABLET = { width: 640, height: 560 };

type Axis = 'top' | 'right' | 'bottom' | 'left';
const AXES: readonly Axis[] = ['top', 'right', 'bottom', 'left'];

async function gotoAt(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
}

/** Set the inset property Capacitor sets, then let style and layout settle. */
async function inject(page: Page, values: Partial<Record<Axis, string>>): Promise<void> {
  await page.evaluate((v) => {
    for (const [axis, value] of Object.entries(v)) {
      document.documentElement.style.setProperty(`--safe-area-inset-${axis}`, value as string);
    }
  }, values);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** Border-box width of the first match, in CSS px. */
const widthOf = async (page: Page, sel: string): Promise<number> =>
  page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().width, sel);

/** CONTENT-box width — border box minus the element's own horizontal padding.
 *
 *  This is the half of the additive-track contract the track width cannot show. A track that
 *  grows by the inset while its element spends that inset as internal padding leaves the
 *  content width UNCHANGED; that invariant is the entire reason the `+ inset` term exists.
 *  Deleting the paired padding keeps every track assertion green while the content spills into
 *  the notch strip — demonstrated by mutation, which is why this helper exists.
 */
const contentWidthOf = async (page: Page, sel: string): Promise<number> =>
  page.evaluate((s) => {
    const el = document.querySelector(s)!;
    const cs = getComputedStyle(el);
    return (
      el.getBoundingClientRect().width -
      parseFloat(cs.paddingLeft) -
      parseFloat(cs.paddingRight) -
      parseFloat(cs.borderLeftWidth) -
      parseFloat(cs.borderRightWidth)
    );
  }, sel);

/** Resolved value of a computed length property, in CSS px. */
const pxProp = async (page: Page, sel: string, prop: string): Promise<number> =>
  page.evaluate(
    ([s, p]) => parseFloat(getComputedStyle(document.querySelector(s!)!).getPropertyValue(p!)),
    [sel, prop],
  );

test.describe('safe-area seam — additive tracks (Compact)', () => {
  test('a left inset grows the status column track by exactly that inset', async ({ page }) => {
    await gotoAt(page, PHONE);
    const before = await widthOf(page, '.wy-status');
    const contentBefore = await contentWidthOf(page, '.wy-status');
    await inject(page, { left: '37px' });
    // `--wy-compact-col` is `min(4rem, 10vw) + inset`, and `.wy-status` spends that inset as
    // internal padding-left. BOTH halves are asserted, because either alone is satisfiable
    // with the other deleted: the track must grow by the inset, AND the content width must not
    // move. Dropping the paired padding leaves the track assertion green while the Compact
    // Dock buttons render under the physical cutout — the exact regression the term prevents.
    expect(await widthOf(page, '.wy-status')).toBeCloseTo(before + 37, 0);
    expect(await contentWidthOf(page, '.wy-status')).toBeCloseTo(contentBefore, 0);
  });

  test('a right inset grows the Rail track by exactly that inset', async ({ page }) => {
    await gotoAt(page, PHONE);
    const before = await widthOf(page, '.wy-rail');
    const contentBefore = await contentWidthOf(page, '.wy-rail');
    await inject(page, { right: '29px' });
    expect(await widthOf(page, '.wy-rail')).toBeCloseTo(before + 29, 0);
    // Same pairing as the column above: the Card's `width: 100%` content box must not shrink.
    expect(await contentWidthOf(page, '.wy-rail')).toBeCloseTo(contentBefore, 0);
  });

  test('a bottom inset lands in the Compact status column padding', async ({ page }) => {
    // Compact's `.wy-status` owns the bottom inset here. `.wy-dock` does NOT — Compact zeroes
    // its padding — which is what made an earlier draft of this test vacuous.
    await gotoAt(page, PHONE);
    const before = await pxProp(page, '.wy-status', 'padding-bottom');
    await inject(page, { bottom: '21px' });
    expect(await pxProp(page, '.wy-status', 'padding-bottom')).toBeCloseTo(before + 21, 1);
  });
});

test.describe('safe-area seam — subtractive bound and the target floor (Standard)', () => {
  test('a top inset SHRINKS the HUD bound, and the sign is what is being asserted', async ({
    page,
  }) => {
    await gotoAt(page, STANDARD);
    const bound = (): Promise<number> => pxProp(page, '.wy-hud', 'max-height');
    const before = await bound();

    await inject(page, { top: '160px' });
    const after = await bound();
    expect(after).toBeCloseTo(before - 160, 0);
    expect(after).toBeLessThan(before);

    // NO rendered-clamp assertion here, deliberately. An earlier draft asserted the HUD's
    // rendered height fell to the tightened bound; that assertion was INERT and its comment
    // was false. At this viewport the HUD is content-sized at ~24.6px while the bound's own
    // `max(2.5rem, …)` floor keeps it at 40px or above, so the element cannot clamp at ANY
    // inset — the assertion passed identically under the sign-flip mutation it claimed to
    // catch. The sign IS caught, by `toBeCloseTo(before - 160)` above: flipping `-` to `+`
    // makes the bound 392px, not 72px. Asserting the bound is the honest claim; asserting a
    // clamp that never happens only looks stronger.
  });

  test('a bottom inset keeps the Dock inside the safe area without shrinking its targets', async ({
    page,
  }) => {
    await gotoAt(page, STANDARD);
    const INSET = 48;
    const paddingBefore = await pxProp(page, '.wy-dock', 'padding-bottom');
    await inject(page, { bottom: `${INSET}px` });
    expect(await pxProp(page, '.wy-dock', 'padding-bottom')).toBeCloseTo(paddingBefore + INSET, 1);

    // ADR 0003's floor survives the inset, and no control is left under the system bar the
    // inset stands for — the accessibility claim this whole seam exists to make assertable.
    // The 44px floor is applied Node-side, below. Nothing is passed into the page: an earlier
    // draft threaded TARGET_MIN_PX in and returned it on every control without ever reading
    // it there, which read as if this `.filter()` applied the floor. It filters on visibility
    // only.
    const controls = await page.evaluate(() =>
      [...document.querySelectorAll('.wy-dock .wy-btn')]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height, bottom: r.bottom };
        }),
    );
    expect(controls.length).toBeGreaterThan(0);
    const limit = STANDARD.height - INSET;
    for (const c of controls) {
      expect(c.h).toBeGreaterThanOrEqual(TARGET_MIN_PX);
      expect(c.w).toBeGreaterThanOrEqual(TARGET_MIN_PX);
      expect(c.bottom).toBeLessThanOrEqual(limit + 1);
    }
  });
});

/** The top inset every walk and #153 test injects: a phone's status bar. */
const TOP = 24;

/** The shipped catalog's Card count. Asserted, not just read, so a walk or reachability
 *  loop can never pass vacuously over a Rail that rendered fewer Cards. */
const CARD_COUNT = 9;

/** The focused element's box plus its RING band, read from that element's own computed
 *  style while it is focused — `outline-width + outline-offset`, i.e. what
 *  `.wy-card:focus-visible` actually paints — never from the tokens the reserve is built
 *  from. A literal ring change in that rule therefore moves this measurement even though
 *  it would leave the reserve behind, which is the drift this is here to catch. The band is
 *  0 when no ring is painted (outline-style none), which the callers reject. */
const focusedCard = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const railEl = document.querySelector('.wy-rail') as HTMLElement;
    const rail = railEl.getBoundingClientRect();
    return {
      isCard: el.classList.contains('wy-card'),
      index: [...document.querySelectorAll('.wy-card')].indexOf(el),
      top: b.top,
      bottom: b.bottom,
      ring:
        cs.outlineStyle === 'none' ? 0 : parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset),
      // The scrollport's CLIP edge: the Rail's padding box, which is where overflow is cut
      // off. 0 in Compact, whose Rail starts at y=0; below `.wy-status` in Standard (#172).
      railTop: rail.top + railEl.clientTop,
      railBottom: rail.bottom,
      railScrollTop: railEl.scrollTop,
      // The pinned Panel's top edge and its fade band, when a Panel is open and PINNED
      // (sticky); null otherwise. The band is read from the PAINTED pseudo-element, never
      // the token, and counts as an occluder only while it is actually painted: at maximum
      // scroll `wy-rail-has-more` is false and the band draws nothing (compact.spec.ts
      // reads it the same way).
      panel: (() => {
        const p = document.querySelector('.wy-panel') as HTMLElement;
        if (p.hidden || getComputedStyle(p).position !== 'sticky') return null;
        const band = getComputedStyle(p, '::before');
        const top = p.getBoundingClientRect().top;
        const painted = band.display !== 'none' && band.opacity !== '0';
        return { top, fadeTop: painted ? top - parseFloat(band.height) : top };
      })(),
      // The Rail's OWN fade band (`.wy-rail::after`) when no Panel is pinned and the band is
      // painted; null otherwise. Its bottom is the Rail's CONTENT-box bottom, not the
      // scrollport's, because the band is a flex item laid out inside the padding
      // (compact.spec.ts's fade test measures it the same way and records what reading
      // `rail.bottom` instead once hid).
      railFadeTop: (() => {
        const p = document.querySelector('.wy-panel') as HTMLElement;
        if (!p.hidden && getComputedStyle(p).position === 'sticky') return null;
        const band = getComputedStyle(railEl, '::after');
        if (band.display === 'none' || band.opacity === '0') return null;
        const contentBottom = rail.bottom - parseFloat(getComputedStyle(railEl).paddingBottom);
        return contentBottom - parseFloat(band.height);
      })(),
    };
  });

/** Let a focus-driven scroll come to rest: four consecutive unchanged animation frames
 *  (compact.spec.ts's `settleScroll` rationale). A reading taken mid-flight belongs to a
 *  world the Card never rests in. */
const settleRail = (page: Page) =>
  page.evaluate(async () => {
    const rail = document.querySelector('.wy-rail') as HTMLElement;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    let prev = Number.NaN;
    let stable = 0;
    for (let i = 0; i < 120 && stable < 4; i++) {
      await frame();
      stable = rail.scrollTop === prev ? stable + 1 : 0;
      prev = rail.scrollTop;
    }
  });

type Walk = {
  view: { width: number; height: number };
  armed: boolean;
  /** Armed only: whether this viewport PINS the Panel. Asserted either way, so a case can
   *  never quietly walk the other geometry. */
  pinned?: boolean;
  zoom: 100 | 200;
  inset: number;
  direction: 'Tab' | 'Shift+Tab';
};

/** THE WALK. Entered from the keyboard (the arming hotkey, or nothing) so `:focus-visible`
 *  is live from the first stop, then moved ONLY by real key traversal. Every focused Card
 *  AND its ring must clear both the top inset and the Rail's own top edge (the scrollport
 *  clips there), and its ring must clear the Rail's bottom.
 *
 *  THE BOTTOM OVERLAYS. With a PINNED Panel the Card must also clear the Panel: its ring's
 *  bottom at or above the Panel's top edge, and its body at or above the Panel's fade band
 *  while that band is painted. That is what makes the pinned focus reserve observable: at
 *  658x320, with the reserve deleted, a ring-top-only walk stayed green while Cards parked
 *  under the Panel (tops 211 / 196 against a Panel top of 144). With no pinned Panel the
 *  Card's body must clear the Rail's own painted fade band instead. Either way at least one
 *  stop must see its band painted, or the band assertion checked nothing.
 *
 *  THE TOP RESERVE, FROM BOTH SIDES (#172). Every Shift+Tab walk must also PARK a Card against
 *  its top bound at least once: over the stops where the Rail is SCROLLED (scrollTop > 0),
 *  the closest ring top sits within 2px of it (nearest-pixel rounding under the reserve's 1px
 *  allowance leaves 0.5-1.5px; measured 0.6-1.2px). That one bound does two jobs. It proves
 *  the Rail really scrolled a Card up to its top edge, so the lower bound above was exercised
 *  rather than vacuously met by a Rail that never overflowed (no scrolled stop at all fails
 *  it). And it rejects an OVERSIZED reserve, such as a top inset paid a second time by a Rail
 *  that sits below a row that already paid it: at 640x560 that parked every scrolled ring
 *  25px low unarmed and 10px low with the Panel pinned, which the lower bound alone accepts.
 *  The stops at scrollTop 0 are left out on purpose: there the first Card rests on the Rail's
 *  own 0.5rem padding, 3px below its bound at default text size whatever the reserve, which
 *  would hold this bound to a 1px margin instead of an 8-23px one. */
async function walkRail(
  page: Page,
  { view, armed, pinned = false, zoom, inset, direction }: Walk,
): Promise<void> {
  await gotoAt(page, view);
  // compact.spec.ts's text-zoom posture: the root font doubles, so every rem does.
  if (zoom === 200) await page.addStyleTag({ content: ':root{font-size:200%}' });
  await inject(page, { top: `${inset}px` });
  const cards = page.locator('.wy-card');
  const n = await cards.count();
  expect(n, 'the shipped catalog renders nine Cards').toBe(CARD_COUNT);
  if (armed) {
    // The arming HOTKEY, not a click: keyboard modality keeps `:focus-visible` live.
    await page.keyboard.press('Digit1');
    await expect(page.locator('.wy-card[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.wy-panel')).toBeVisible();
    // PINNED or not, as the case says: the focus reserve is keyed on this class, and a walk
    // over an unpinned Panel would assert nothing about it.
    const rail = page.locator('.wy-rail');
    if (pinned) await expect(rail).toHaveClass(/wy-rail-panel-pinned/);
    else await expect(rail).not.toHaveClass(/wy-rail-panel-pinned/);
  }
  await (direction === 'Tab' ? cards.first() : cards.last()).focus();
  const seen: number[] = [];
  // Steps where a fade band was actually painted: without at least one, the fade assertion
  // below checked nothing.
  let fadePainted = 0;
  // The closest a ring top came to its top bound at a SCROLLED stop (see THE TOP RESERVE,
  // FROM BOTH SIDES).
  let minTopGap = Number.POSITIVE_INFINITY;
  for (let step = 0; step < n; step++) {
    if (step > 0) await page.keyboard.press(direction);
    await settleRail(page);
    const f = await focusedCard(page);
    expect(f.isCard, `step ${step}: focus left the Cards`).toBe(true);
    seen.push(f.index);
    expect(f.ring, `Card ${f.index}: no focus ring painted`).toBeGreaterThan(0);
    expect(
      f.top - f.ring,
      `Card ${f.index} ring top ${(f.top - f.ring).toFixed(1)} sits under the ${inset}px inset or above the Rail's top edge (${f.railTop.toFixed(1)})`,
      // No sub-pixel tolerance: the reserve carries its own rounding allowance
      // (ui.css), and a 0.4px clip is exactly the zero-inset defect #153 also fixed.
    ).toBeGreaterThanOrEqual(Math.max(inset, f.railTop));
    if (f.railScrollTop > 0) {
      minTopGap = Math.min(minTopGap, f.top - f.ring - Math.max(inset, f.railTop));
    }
    expect(
      f.bottom + f.ring,
      `Card ${f.index} ring bottom ${(f.bottom + f.ring).toFixed(1)} is clipped by the Rail`,
    ).toBeLessThanOrEqual(f.railBottom + 0.5);
    if (!pinned) {
      expect(f.panel, 'no Panel may be pinned in this case').toBeNull();
      if (f.railFadeTop !== null) {
        // Half a pixel of tolerance, the most nearest-pixel `scrollTop` rounding can leave
        // (measured 0.19-0.34px): this reserve alone has no rounding allowance (ui.css,
        // `.wy-rail`'s `scroll-padding-bottom`, says why), so a parked Card may sit that far
        // into the band's transparent end.
        expect(
          f.bottom,
          `Card ${f.index} bottom ${f.bottom.toFixed(1)} sits under the Rail's painted fade band (top ${f.railFadeTop.toFixed(1)})`,
        ).toBeLessThanOrEqual(f.railFadeTop + 0.5);
        fadePainted++;
      }
      continue;
    }
    expect(f.panel, 'the armed Panel must be pinned').not.toBeNull();
    const panel = f.panel!;
    expect(
      f.bottom + f.ring,
      `Card ${f.index} ring bottom ${(f.bottom + f.ring).toFixed(1)} sits under the pinned Panel (top ${panel.top.toFixed(1)})`,
    ).toBeLessThanOrEqual(panel.top);
    expect(
      f.bottom,
      `Card ${f.index} bottom ${f.bottom.toFixed(1)} sits under the painted fade band (top ${panel.fadeTop.toFixed(1)})`,
    ).toBeLessThanOrEqual(panel.fadeTop);
    if (panel.fadeTop < panel.top) fadePainted++;
  }
  expect(new Set(seen).size, 'every Card must be reached').toBe(n);
  expect(
    fadePainted,
    'no fade band ever painted, so its assertion checked nothing',
  ).toBeGreaterThan(0);
  if (direction === 'Shift+Tab') {
    expect(
      minTopGap,
      `no scrolled Shift+Tab stop parked a Card against its top bound (closest ring top ${minTopGap.toFixed(1)}px below it): ` +
        'either the Rail never scrolled, so that bound checked nothing (Infinity), or the top ' +
        'reserve is oversized (an inset paid twice parked scrolled rings 10-25px low)',
    ).toBeLessThanOrEqual(2);
  }
}

test.describe('safe-area seam — the Compact Rail pays the top inset (#153)', () => {
  // The Compact Rail's track starts at y=0 (it shares row 1 with the status column), so the
  // top inset is the Rail's to pay. These tests assert CONTENT — where the Cards and their
  // focus rings land — never the padding track: a test of this shape once passed with its
  // mechanism deleted because it measured the box that held the fix instead of the thing the
  // fix was for.

  test('a top inset keeps the first Card clear of the system bar', async ({ page }) => {
    await gotoAt(page, PHONE);
    const firstCardTop = () =>
      page.evaluate(() => document.querySelector('.wy-card')!.getBoundingClientRect().top);
    await inject(page, { top: `${TOP}px` });
    expect(await firstCardTop()).toBeGreaterThanOrEqual(TOP);
  });

  test('the restated S12a commitment at rest: 4 of 9 Cards at zero inset, every Card scroll-reachable at a nonzero one', async ({
    page,
  }) => {
    await gotoAt(page, PHONE);
    const atRest = () =>
      page.evaluate(() => {
        const rail = document.querySelector('.wy-rail') as HTMLElement;
        const rr = rail.getBoundingClientRect();
        const cards = [...document.querySelectorAll('.wy-card')].map((c) =>
          c.getBoundingClientRect(),
        );
        return {
          total: cards.length,
          fullyVisible: cards.filter((b) => b.top >= rr.top - 0.5 && b.bottom <= rr.bottom + 0.5)
            .length,
        };
      });
    expect((await atRest()).fullyVisible, 'zero inset: the at-rest count is unchanged').toBe(4);

    await inject(page, { top: `${TOP}px` });
    const n = (await atRest()).total;
    expect(n, 'the shipped catalog renders nine Cards').toBe(CARD_COUNT);
    // Scroll-reachable: scrolling each Card into view shows it whole and clear of the bar.
    for (let i = 0; i < n; i++) {
      const card = page.locator('.wy-card').nth(i);
      await card.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
      const r = await card.evaluate((el) => {
        const b = el.getBoundingClientRect();
        const rail = document.querySelector('.wy-rail')!.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, railBottom: rail.bottom };
      });
      expect(
        r.top,
        `Card ${i} scrolled into view must clear the ${TOP}px bar`,
      ).toBeGreaterThanOrEqual(TOP - 0.5);
      expect(r.bottom, `Card ${i} must fit the Rail`).toBeLessThanOrEqual(r.railBottom + 0.5);
    }
  });

  // The WALKS (`walkRail`, above).
  //
  // THE OWNER'S FULL RULING ("inset + ring"), armed or not, at default text size: every
  // focused Card AND its ring clear the inset, in both directions. Armed, the Compact Panel
  // is pinned over the Rail's bottom, so the walk ALSO asserts the Card clears the Panel.
  // The reserve was once 60% of the Rail's PADDING box, over-covering the Panel by 24px at a
  // 24px inset and leaving a snapport shorter than a Card, so the ring could not fit armed.
  // It is now exactly what the Panel covers (ui.css `.wy-rail-panel-pinned`).
  //
  // With no tower armed the guarantee also holds at DOUBLED text zoom. Armed at doubled zoom
  // nothing is claimed: Cards are ~189px tall against ~121px of room above the Panel — the
  // pre-existing S12a geometry.
  const WALKS: { armed: boolean; zoom: 100 | 200; insets: readonly number[] }[] = [
    { armed: false, zoom: 100, insets: [0, TOP] },
    { armed: true, zoom: 100, insets: [0, TOP] },
    { armed: false, zoom: 200, insets: [TOP] },
  ];
  for (const { armed, zoom, insets } of WALKS) {
    for (const inset of insets) {
      for (const direction of ['Tab', 'Shift+Tab'] as const) {
        const state = armed ? 'armed' : 'unarmed';
        const extra = armed ? ' and the pinned Panel' : '';
        test(`${state}, ${zoom}% text, ${inset}px top inset, ${direction}: every focused Card AND its ring clear the inset${extra}`, async ({
          page,
        }) => {
          await walkRail(page, { view: PHONE, armed, pinned: armed, zoom, inset, direction });
        });
      }
    }
  }
});

test.describe('the Standard Rail parks a focused Card with its ring inside the scrollport (#172)', () => {
  // Standard had no `scroll-padding-top`, so a Card that Shift+Tab scrolled to landed flush
  // with the Rail's top edge and the scrollport clipped its ring's top leg: ring tops 4.6 to
  // 5.4px above that edge at 640x560, 1000x720 and 360x640, armed or not. The Rail now
  // reserves the ring band at its top in both layouts (ui.css `--wy-rail-ring-reserve`).
  //
  // Walked at the issue's 640x560 and at 360x640 (Standard by height, with the narrow Rail
  // that PINS an armed Panel), at 1000x720 (a wide Rail, whose armed Panel stays in flow) and
  // at 1440x900 (the two-column Rail, which overflows only at doubled text zoom).
  //
  // Standard's Rail pays NO top inset of its own: it sits below `.wy-status`, which already
  // does. Two checks hold that. The 24px walks bound each ring from below by the larger of
  // the inset and the Rail's top edge, and the 24px Shift+Tab walks also bound it from above
  // through the walk's parked-Card bound, which a reserve paying the inset again fails. The
  // at-rest test below catches the same inset leaking into the Rail's padding instead.
  //
  // Armed at doubled text zoom with the Panel pinned nothing is claimed, as in Compact: at
  // 640x560 Cards are 189-226px tall against ~160px of room above the Panel.
  const STANDARD_TALL = { width: 360, height: 640 }; // portrait phone, Standard by height
  const TWO_COLUMN = { width: 1440, height: 900 };
  const WALKS: {
    view: { width: number; height: number };
    armed: boolean;
    /** Whether the walk expects the Panel pinned: armed rows at a viewport that pins it
     *  (compact.spec.ts asserts 640x560 does); always false unarmed. */
    pinned: boolean;
    zoom: 100 | 200;
    insets: readonly number[];
  }[] = [
    { view: TABLET, armed: false, pinned: false, zoom: 100, insets: [0, TOP] },
    { view: TABLET, armed: true, pinned: true, zoom: 100, insets: [0, TOP] },
    { view: TABLET, armed: false, pinned: false, zoom: 200, insets: [0] },
    { view: STANDARD_TALL, armed: false, pinned: false, zoom: 100, insets: [0] },
    { view: STANDARD_TALL, armed: true, pinned: true, zoom: 100, insets: [0] },
    { view: STANDARD, armed: false, pinned: false, zoom: 100, insets: [0] },
    { view: STANDARD, armed: true, pinned: false, zoom: 100, insets: [0] },
    { view: STANDARD, armed: false, pinned: false, zoom: 200, insets: [0] },
    { view: TWO_COLUMN, armed: false, pinned: false, zoom: 200, insets: [0] },
  ];
  for (const { view, armed, pinned, zoom, insets } of WALKS) {
    for (const inset of insets) {
      for (const direction of ['Tab', 'Shift+Tab'] as const) {
        const state = armed ? (pinned ? 'armed, Panel pinned' : 'armed, Panel in flow') : 'unarmed';
        const extra = pinned ? ' and clear the pinned Panel' : '';
        test(`${view.width}x${view.height} ${state}, ${zoom}% text, ${inset}px top inset, ${direction}: every focused Card AND its ring stay inside the Rail's scrollport${extra}`, async ({
          page,
        }) => {
          await walkRail(page, { view, armed, pinned, zoom, inset, direction });
        });
      }
    }
  }

  test(`640x560: a ${TOP}px top inset leaves the Rail's Cards where they were at rest (the status row pays it)`, async ({
    page,
  }) => {
    await gotoAt(page, TABLET);
    const atRest = () =>
      page.evaluate(() => {
        const rail = document.querySelector('.wy-rail') as HTMLElement;
        const railTop = rail.getBoundingClientRect().top + rail.clientTop;
        const cardTop = document.querySelector('.wy-card')!.getBoundingClientRect().top;
        const statusPadTop = parseFloat(
          getComputedStyle(document.querySelector('.wy-status') as HTMLElement).paddingTop,
        );
        return { railTop, cardOffset: cardTop - railTop, statusPadTop };
      });
    const before = await atRest();
    await inject(page, { top: `${TOP}px` });
    const after = await atRest();
    // The premise first: an inset that never landed (a renamed property, a token chain that
    // stopped resolving) would leave the Card offset unchanged too, and prove nothing.
    expect(
      after.statusPadTop - before.statusPadTop,
      'the status row must pay the injected inset, or this test checks nothing',
    ).toBeCloseTo(TOP, 1);
    expect(after.railTop, 'the Rail sits below the row that paid the inset').toBeGreaterThanOrEqual(
      TOP,
    );
    expect(
      after.cardOffset,
      `the first Card sits ${after.cardOffset.toFixed(1)}px below the Rail's top edge at a ${TOP}px inset, ${before.cardOffset.toFixed(1)}px at none: the Rail paid the inset again`,
    ).toBeCloseTo(before.cardOffset, 1);
  });
});

test.describe('safe-area seam — a malformed inset degrades, it does not delete geometry', () => {
  // An unregistered custom property carrying an invalid value is invalid-at-computed-value-
  // time: the WHOLE consuming declaration is discarded, so padding falls to 0 and a
  // subtractive `max-height` becomes unbounded. `@property … syntax: '<length>';
  // initial-value: 0px` contains that to "inset ignored, base kept". Parameterised over all
  // four axes because a single-axis check leaves the other three registrations deletable with
  // the suite green.
  for (const axis of AXES) {
    test(`--wy-safe-${axis}: a malformed value keeps the base geometry`, async ({ page }) => {
      // Each axis is checked on a mechanism where it is actually observable. Bottom uses
      // `scroll-padding-bottom` on `.wy-rail` rather than an ordinary 4px padding, because a
      // poisoned longhand is not distinguishable from its own zero baseline.
      const probe: Record<Axis, { view: typeof PHONE; sel: string; prop: string }> = {
        top: { view: STANDARD, sel: '.wy-status', prop: 'padding-top' },
        right: { view: STANDARD, sel: '.wy-status', prop: 'padding-right' },
        bottom: { view: STANDARD, sel: '.wy-rail', prop: 'scroll-padding-bottom' },
        left: { view: STANDARD, sel: '.wy-status', prop: 'padding-left' },
      };
      const { view, sel, prop } = probe[axis];
      await gotoAt(page, view);
      const base = await pxProp(page, sel, prop);
      expect(base).toBeGreaterThan(0);

      await inject(page, { [axis]: 'banana' });
      // Unregistered, this reads 0 — the declaration is gone, not merely inset-free.
      expect(await pxProp(page, sel, prop)).toBeCloseTo(base, 1);
    });
  }
});
