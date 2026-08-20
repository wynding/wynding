import { test, expect } from '@playwright/test';

// The Host build actually carries its declaration (#135, ADR 0013).
//
// Why this spec exists at all: `src/build-config.test.ts` pins the mode → artifact mapping,
// but NOTHING in the unit suite can reach the declaration `boot()` actually reads. `define`
// replaces `import.meta.env.WYNDING_HOSTED` at transform time, so under Vitest it is already
// a compiled-in literal — there is no seam to stub and no way to exercise the other arm. So
// if Vite defines one key and `env.d.ts` declares another, every unit test stays green and
// the shipped Host build is unhosted: the silently-wrong app ADR 0013 exists to prevent.
// The built artifact is the only place that fact is observable, which is what this spec is.
//
// Why it is SEMANTIC and not a grep. Inspecting the bundle for a baked `true` cannot work:
// `define` inlines the value at the use site and minification then constant-folds the
// branch and eliminates the dead arm, so there is no stable string to look for — the
// tell-tale is precisely what the optimiser removes. What survives is the BEHAVIOUR, so
// that is what is asserted: the #146 consumer that is visible with no interaction at all.
//
// The wordmark is that consumer (`shell.ts`): on the open web it is the home anchor, the
// one site affordance; hosted, it is a `span`, because a Host has no site to navigate to.
// Both directions are asserted — the Host build's `span` would be worth little without the
// open-web `a` as its inverted control, since "no anchor found" is also what a blank page
// looks like. Each test therefore asserts a POSITIVE count first: the app booted, and then
// which element it chose.
// 4175, not 4174: `playwright.perf.config.ts` reserves 4174 (see playwright.config.ts).
const HOST_BUILD = 'http://localhost:4175/';
const WEB_BUILD = 'http://localhost:4173/';

test('the Host build declares itself: the wordmark is not an anchor', async ({ page }) => {
  await page.goto(HOST_BUILD);
  // Exactly one wordmark, so a failure to boot cannot pass as "not an anchor".
  await expect(page.locator('.wy-home')).toHaveCount(1);
  await expect(page.locator('span.wy-home')).toHaveCount(1);
  await expect(page.locator('a.wy-home')).toHaveCount(0);
});

test('the open-web build does not declare itself: the wordmark is the home anchor', async ({
  page,
}) => {
  await page.goto(WEB_BUILD);
  await expect(page.locator('.wy-home')).toHaveCount(1);
  await expect(page.locator('a.wy-home')).toHaveCount(1);
  await expect(page.locator('span.wy-home')).toHaveCount(0);
  // Root-absolute, so it stays correct under the deploy's `--base=/play/` rewrite. Asserted
  // here because it is the half of the control that proves this really is the live site
  // affordance rather than an anchor that merely survived.
  await expect(page.locator('a.wy-home')).toHaveAttribute('href', '/');
});
