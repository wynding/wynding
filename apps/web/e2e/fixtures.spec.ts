import { test, chromium } from './fixtures';

// The error tripwire in `fixtures.ts` checks itself (#196). The first three describes declare an
// error and log it, so a tripwire that stopped seeing errors would leave the pattern unused and
// fail them. The next three are expected failures: a tripwire that let an undeclared error (in
// the test's own page, or in a browser the test launched itself) or an unused pattern through
// would make them pass, which fails the run. The last pins that a test skipped at runtime under
// a `describe` that declares errors stays skipped.

const LOGGED = 'tripwire self-check: console';
const THROWN = 'tripwire self-check: uncaught';

test.describe('the error tripwire (#196)', () => {
  test.describe('a declared console error', () => {
    test.use({ expectedErrors: { patterns: [new RegExp(`^${LOGGED}$`)] } });
    test('is seen and allowed', async ({ page }) => {
      await page.goto('about:blank');
      await page.evaluate((text) => console.error(text), LOGGED);
    });
  });

  test.describe('a declared uncaught page error', () => {
    test.use({ expectedErrors: { patterns: [new RegExp(`^uncaught Error: ${THROWN}$`)] } });
    test('is seen and allowed', async ({ page }) => {
      await page.goto('about:blank');
      const thrown = page.waitForEvent('pageerror');
      await page.evaluate((text) => {
        setTimeout(() => {
          throw new Error(text);
        }, 0);
      }, THROWN);
      await thrown;
    });
  });

  test.describe('a declared pattern with the g flag', () => {
    // A `g` pattern keeps its `lastIndex` between matches: unreset, the second error (or the
    // unused scan after the first) would start past the match and miss it.
    test.use({ expectedErrors: { patterns: [/tripwire self-check: global/g] } });
    test('matches every error it declares, in both scans', async ({ page }) => {
      await page.goto('about:blank');
      await page.evaluate(() => {
        console.error('tripwire self-check: global');
        console.error('tripwire self-check: global');
      });
    });
  });

  test('fails a test on a console error it did not declare', async ({ page }) => {
    test.fail(true, 'the tripwire must fail this test');
    await page.goto('about:blank');
    await page.evaluate(() => console.error('tripwire self-check: undeclared'));
  });

  test('fails a test on a console error in a browser it launched itself', async () => {
    test.fail(true, 'the tripwire must fail this test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      const logged = page.waitForEvent('console');
      await page.evaluate(() => console.error('tripwire self-check: launched'));
      await logged;
    } finally {
      await browser.close();
    }
  });

  test.describe('a declared error that never comes', () => {
    test.use({ expectedErrors: { patterns: [/^tripwire self-check: never logged$/] } });
    test('fails the test', async ({ page }) => {
      test.fail(true, 'the tripwire must fail this test');
      await page.goto('about:blank');
    });

    test('leaves a test skipped at runtime skipped', () => {
      test.skip(true, 'pins fixtures.ts: the check judges only a test that otherwise passed');
    });
  });
});
