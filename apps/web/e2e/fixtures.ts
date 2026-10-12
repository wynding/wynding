import {
  test as base,
  chromium as playwrightChromium,
  firefox as playwrightFirefox,
  webkit as playwrightWebkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
} from '@playwright/test';

// fixtures.ts — the e2e suite's `test` (#196). Every spec imports `test` (and `expect`, and the
// rest of Playwright) from here, never from `@playwright/test` (ESLint forbids the value import).
//
// WHAT IT ADDS: every `console.error` and every uncaught page error (`weberror`) in any page of
// the test's context fails the test, unless the test declared it. A spec that expects one declares
// it with `test.use({ expectedErrors: { patterns: [/pattern/] } })` in a `describe`; a pattern
// that matches nothing fails the test too, so a declaration cannot outlive its cause. Warnings
// are not collected (Chromium's own "GPU stall due to ReadPixels" GL message is one, and the
// pixel-reading specs cause it).
//
// WHICH CONTEXTS: the test's own `context` (so every `page`), every context made through the
// `browser` fixture for the test's duration (`newContext`, and the one `newPage` makes), and every
// context of a browser a spec opens itself through this module's `chromium`, `firefox` or
// `webkit` (a spec that needs Chromium flags of its own, say). Nothing is opted into: ESLint
// forbids those three from `@playwright/test`, as it does `test`.
//
// The option is an object, not the bare array of patterns: Playwright reads any array whose
// second element is an object (a RegExp is one) as a `[value, options]` fixture tuple, so
// `test.use({ expectedErrors: [/a/, /b/] })` would hand the fixture a RegExp, not the list.
//
// The check judges only a test that otherwise passed. A test that already failed keeps its own
// failure, so the tripwire never hides the first cause; and a test skipped at runtime stays
// skipped (Playwright turns a teardown error into a failure even on a skipped test, and a skipped
// test never logs the errors its `describe` declared). `fixtures.spec.ts` pins both halves. A
// test that failed keeps what its pages logged, though, as a `page errors` attachment in its
// report: one of them may be why it failed.

export * from '@playwright/test';

interface Seen {
  readonly text: string;
  readonly url: string;
}

interface Collector {
  readonly seen: Seen[];
  readonly watched: Set<BrowserContext>;
}

/** The running test's collector. A worker runs one test at a time, so one slot is enough. */
let current: Collector | undefined;

function watch(collector: Collector, context: BrowserContext): void {
  if (collector.watched.has(context)) return;
  collector.watched.add(context);
  context.on('console', (message) => {
    if (message.type() !== 'error') return;
    collector.seen.push({ text: message.text(), url: message.page()?.url() ?? '(no page)' });
  });
  context.on('weberror', (webError) => {
    const error = webError.error();
    collector.seen.push({
      text: `uncaught ${error.name}: ${error.message}`,
      url: webError.page()?.url() ?? '(no page)',
    });
  });
}

/** Add a context to the running test's watch. A context made outside a test (in a `beforeAll`,
 *  say) has no test to fail, so making one is refused rather than left unwatched. */
function watchContext(context: BrowserContext): void {
  if (!current) {
    throw new Error(
      'a browser opened through ./fixtures made a context outside a running test, where no ' +
        'test would see its errors: make it inside the test',
    );
  }
  watch(current, context);
}

/** Hand every context `browser` makes (by `newContext`, or the one `newPage` makes) to
 *  `onContext`, until the returned function puts both methods back. */
function patchBrowser(browser: Browser, onContext: (context: BrowserContext) => void): () => void {
  const { newContext, newPage } = browser;
  browser.newContext = async (...args) => {
    const context = await newContext.apply(browser, args);
    onContext(context);
    return context;
  };
  browser.newPage = async (...args) => {
    const page = await newPage.apply(browser, args);
    onContext(page.context());
    return page;
  };
  return () => {
    browser.newContext = newContext;
    browser.newPage = newPage;
  };
}

/** Put every context `browser` makes, for as long as it is open, under the watch. Never restored:
 *  the browser is the spec's own and closes with it. */
function adoptBrowser(browser: Browser): Browser {
  patchBrowser(browser, watchContext);
  return browser;
}

const OPENS_A_BROWSER = new Set<PropertyKey>(['launch', 'connect', 'connectOverCDP']);

/** `type`, except that every browser it opens is adopted (and a persistent context is watched),
 *  so a spec that launches a browser of its own is covered without registering anything. */
function watchedType(type: BrowserType): BrowserType {
  return new Proxy(type, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const call = (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      if (OPENS_A_BROWSER.has(key)) {
        return async (...args: unknown[]) =>
          adoptBrowser(await (call(...args) as Promise<Browser>));
      }
      if (key === 'launchPersistentContext') {
        return async (...args: unknown[]) => {
          const context = await (call(...args) as Promise<BrowserContext>);
          watchContext(context);
          return context;
        };
      }
      return call;
    },
  });
}

/** Playwright's browser types, watched (these shadow the `export *` above). */
export const chromium = watchedType(playwrightChromium);
export const firefox = watchedType(playwrightFirefox);
export const webkit = watchedType(playwrightWebkit);

/** Whether `pattern` matches `text`, as if tested fresh. A `g` or `y` pattern keeps its
 *  `lastIndex` between `test` calls, so without the reset the same error could pass one scan and
 *  fail the next. */
function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

export interface ExpectedErrors {
  readonly patterns: readonly RegExp[];
}

/** The attachment that carries what a failed test's pages logged into its report. */
export const PAGE_ERRORS_ATTACHMENT = 'page errors';

export const test = base.extend<{ expectedErrors: ExpectedErrors; errorTripwire: void }>({
  expectedErrors: [{ patterns: [] }, { option: true }],
  errorTripwire: [
    async ({ context, browser, expectedErrors: { patterns } }, use, testInfo) => {
      const collector: Collector = { seen: [], watched: new Set() };
      current = collector;
      watch(collector, context);
      const restore = patchBrowser(browser, (made) => {
        watch(collector, made);
      });
      try {
        await use();
      } finally {
        restore();
        current = undefined;
      }
      if (testInfo.status !== 'passed') {
        // Not judged (see the header), but what the pages logged may be why it failed: keep it.
        if (collector.seen.length > 0) {
          await testInfo.attach(PAGE_ERRORS_ATTACHMENT, {
            body: collector.seen.map((error) => `${error.text}\n  on ${error.url}`).join('\n'),
            contentType: 'text/plain',
          });
        }
        return;
      }
      const undeclared = collector.seen.filter(
        (error) => !patterns.some((pattern) => matches(pattern, error.text)),
      );
      const unused = patterns.filter(
        (pattern) => !collector.seen.some((error) => matches(pattern, error.text)),
      );
      if (undeclared.length === 0 && unused.length === 0) return;
      const lines: string[] = [];
      if (undeclared.length > 0) {
        lines.push(
          `${String(undeclared.length)} console error(s) or uncaught page error(s) no expectedErrors pattern matches:`,
          ...undeclared.map((error) => `  - ${error.text}\n    on ${error.url}`),
        );
      }
      if (unused.length > 0) {
        lines.push(
          'expectedErrors pattern(s) that matched nothing (drop them, the error they allowed is gone):',
          ...unused.map((pattern) => `  - ${String(pattern)}`),
        );
      }
      throw new Error(lines.join('\n'));
    },
    { auto: true },
  ],
});
