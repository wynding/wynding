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
// Source-level completeness across all twenty call sites is `layout.test.ts`'s job; this file
// covers five MECHANISMS and structurally cannot reach the rest.
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

const widthOf = async (page: Page, sel: string): Promise<number> =>
  page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().width, sel);

const heightOf = async (page: Page, sel: string): Promise<number> =>
  page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().height, sel);

const pxProp = async (page: Page, sel: string, prop: string): Promise<number> =>
  page.evaluate(
    ([s, p]) => parseFloat(getComputedStyle(document.querySelector(s!)!).getPropertyValue(p!)),
    [sel, prop],
  );

test.describe('safe-area seam — additive tracks (Compact)', () => {
  test('a left inset grows the status column track by exactly that inset', async ({ page }) => {
    await gotoAt(page, PHONE);
    const before = await widthOf(page, '.wy-status');
    await inject(page, { left: '37px' });
    // `--wy-compact-col` is `min(4rem, 10vw) + inset`, and `.wy-status` spends the inset as
    // internal padding-left — so the track grows and the CONTENT width is unchanged, which is
    // the whole point of the term. Assert the track, not the padding.
    expect(await widthOf(page, '.wy-status')).toBeCloseTo(before + 37, 0);
  });

  test('a right inset grows the Rail track by exactly that inset', async ({ page }) => {
    await gotoAt(page, PHONE);
    const before = await widthOf(page, '.wy-rail');
    await inject(page, { right: '29px' });
    expect(await widthOf(page, '.wy-rail')).toBeCloseTo(before + 29, 0);
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

    // Big enough that the clamp binds rather than merely narrowing a bound nothing reaches.
    await inject(page, { top: '160px' });
    const after = await bound();
    expect(after).toBeCloseTo(before - 160, 0);

    // The rendered consequence, which is what a sign error actually costs: with the bound
    // tightened the element is clamped to it. A `+` instead of `-` would RAISE the bound and
    // leave the HUD content-sized, passing any assertion that only checked "it changed".
    expect(await heightOf(page, '.wy-hud')).toBeLessThanOrEqual(after + 1);
    expect(after).toBeLessThan(before);
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
    const controls = await page.evaluate(
      (min) =>
        [...document.querySelectorAll('.wy-dock .wy-btn')]
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { w: r.width, h: r.height, bottom: r.bottom, min };
          }),
      TARGET_MIN_PX,
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
