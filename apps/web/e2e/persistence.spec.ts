import { test, expect } from '@playwright/test';

// persistence.spec.ts — #142's headline claim, measured where it actually lives.
//
// The unit tests prove the seam against injected fakes, and they have to: Vitest's jsdom
// has NO `localStorage` at all (probed — `document.defaultView.localStorage` is
// `undefined`), so the one environment in which "set it, reload, it is still set" can be
// observed is a real browser. That is the exact irritation #142 names, so it is asserted
// end to end rather than inferred from the parts.

const SETTINGS_KEY = 'wynding:settings';

test.describe('settings survive a reload (ADR 0008 seam, #142)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // A clean slate per test: this origin is shared with the landing site, and a leftover
    // envelope from another spec would make a pass mean nothing.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage))
        if (k.startsWith('wynding:')) localStorage.removeItem(k);
    });
  });

  test('colour mode and reduced motion both come back after a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.wy-board')).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.getByLabel('Protanopia').check();
    await page.getByLabel('Reduce motion').check();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.wy-shell')).toHaveAttribute('data-wy-reduced-motion', '');

    // The write is fire-and-forget, so wait for it rather than racing the reload.
    await expect
      .poll(async () => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY))
      .not.toBeNull();

    await page.reload();
    await expect(page.locator('.wy-board')).toBeVisible();

    // Reduced motion is observable on the Shell BEFORE any dialog is opened, which is the
    // half that proves hydration happened at boot rather than when settings was reopened.
    await expect(page.locator('.wy-shell')).toHaveAttribute('data-wy-reduced-motion', '');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Protanopia')).toBeChecked();
    await expect(page.getByLabel('Reduce motion')).toBeChecked();
    await expect(page.getByLabel('Default')).not.toBeChecked();
  });

  test('the stored payload is the ADR 0008 envelope, not a bare value', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Tritanopia').check();
    await expect
      .poll(async () => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY))
      .not.toBeNull();

    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), SETTINGS_KEY);
    expect(stored).toMatchObject({
      saveVersion: 1,
      revision: expect.any(Number),
      updatedAt: expect.any(Number),
      data: { colourMode: 'tritan' },
    });
    expect(typeof stored.deviceId).toBe('string');
    expect(stored.deviceId.length).toBeGreaterThan(0);
    // `revision` is the ordering primitive and it MOVES on every write.
    const first = stored.revision as number;
    await page.getByLabel('Deuteranopia').check();
    await expect
      .poll(async () =>
        page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).revision as number, SETTINGS_KEY),
      )
      .toBe(first + 1);
  });

  test('a corrupt stored payload is quarantined, not silently discarded', async ({ page }) => {
    await page.evaluate((k) => localStorage.setItem(k, '{not json'), SETTINGS_KEY);
    await page.reload();
    await expect(page.locator('.wy-board')).toBeVisible();
    // The app boots on defaults...
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Default')).toBeChecked();
    // ...and the unreadable original is still on the device (ADR 0008 §5).
    expect(await page.evaluate((k) => localStorage.getItem(`${k}.quarantine`), SETTINGS_KEY)).toBe(
      '{not json',
    );
  });
});
