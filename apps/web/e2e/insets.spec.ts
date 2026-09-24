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
// structurally cannot reach the rest.
import { test, expect, type Page } from '@playwright/test';
import { TARGET_MIN_PX } from './targets';

const PHONE = { width: 658, height: 320 }; // Compact — Galaxy S9+ landscape
const STANDARD = { width: 1000, height: 720 }; // Standard, and unpinned at both zooms

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

test.describe('safe-area seam — the Compact Rail pays the top inset (#153)', () => {
  // The Compact Rail's track starts at y=0 (it shares row 1 with the status column), so the
  // top inset is the Rail's to pay. These tests assert CONTENT — where the Cards and their
  // focus rings land — never the padding track: a test of this shape once passed with its
  // mechanism deleted because it measured the box that held the fix instead of the thing the
  // fix was for.
  const TOP = 24;

  /** Every Card's box, and its ring box (the border box grown by the ring's painted band:
   *  width + offset, read from the live `:focus-visible` style), relative to the Rail. */
  const RING_PX = async (page: Page): Promise<number> =>
    page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return (
        parseFloat(root.getPropertyValue('--wy-card-ring-w')) +
        parseFloat(root.getPropertyValue('--wy-card-ring-offset'))
      );
    });

  const focusedCard = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const b = el.getBoundingClientRect();
      const rail = document.querySelector('.wy-rail')!.getBoundingClientRect();
      return {
        isCard: el.classList.contains('wy-card'),
        index: [...document.querySelectorAll('.wy-card')].indexOf(el),
        top: b.top,
        bottom: b.bottom,
        railBottom: rail.bottom,
      };
    });

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

  for (const inset of [0, TOP]) {
    for (const direction of ['Tab', 'Shift+Tab'] as const) {
      test(`${inset}px top inset, ${direction}: every focused Card AND its ring clear the inset and the Rail's edges`, async ({
        page,
      }) => {
        await gotoAt(page, PHONE);
        await inject(page, { top: `${inset}px` });
        const ring = await RING_PX(page);
        expect(ring, 'the ring band must be a real, positive reserve').toBeGreaterThan(0);
        const cards = page.locator('.wy-card');
        const n = await cards.count();
        // Enter at the walk's starting end, then move ONLY by real key traversal.
        await (direction === 'Tab' ? cards.first() : cards.last()).focus();
        const seen: number[] = [];
        for (let step = 0; step < n; step++) {
          if (step > 0) await page.keyboard.press(direction);
          const f = await focusedCard(page);
          expect(f.isCard, `step ${step}: focus left the Cards`).toBe(true);
          seen.push(f.index);
          expect(
            f.top - ring,
            `Card ${f.index} ring top ${(f.top - ring).toFixed(1)} sits under the ${inset}px inset`,
            // No sub-pixel tolerance: the reserve carries its own rounding allowance (ui.css),
            // and a 0.4px clip is exactly the zero-inset defect this also fixes.
          ).toBeGreaterThanOrEqual(inset);
          expect(
            f.bottom + ring,
            `Card ${f.index} ring bottom ${(f.bottom + ring).toFixed(1)} is clipped by the Rail`,
          ).toBeLessThanOrEqual(f.railBottom + 0.5);
        }
        expect(new Set(seen).size, 'every Card must be reached').toBe(n);
      });
    }
  }
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
