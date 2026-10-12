import { test as base, type Browser, type BrowserContext } from '@playwright/test';

// fixtures.ts — the e2e suite's `test` (#196). Every spec imports `test` (and `expect`, and the
// rest of Playwright) from here, never from `@playwright/test` (ESLint forbids the value import).
//
// WHAT IT ADDS: every `console.error` and every uncaught page error (`weberror`) in any page of
// the test's context fails the test, unless the test declared it. A spec that expects one declares
// it with `test.use({ expectedErrors: { patterns: [/pattern/] } })` in a `describe`; a pattern that matches
// nothing fails the test too, so a declaration cannot outlive its cause. Warnings are not
// collected (Chromium's own "GPU stall due to ReadPixels" GL message is one, and the
// pixel-reading specs cause it).
//
// WHICH CONTEXTS: the test's own `context` (so every `page`), every context made through the
// `browser` fixture for the test's duration (`newContext`, and the one `newPage` makes), and any
// context a spec adds by hand with `watchContext` (the specs that call `chromium.launch()` for a
// browser of their own).
//
// The option is an object, not the bare array of patterns: Playwright reads any array whose
// second element is an object (a RegExp is one) as a `[value, options]` fixture tuple, so
// `test.use({ expectedErrors: [/a/, /b/] })` would hand the fixture a RegExp, not the list.
//
// The check judges only a test that otherwise passed. A test that already failed keeps its own
// failure, so the tripwire never hides the first cause; and a test skipped at runtime stays
// skipped (Playwright turns a teardown error into a failure even on a skipped test, and a skipped
// test never logs the errors its `describe` declared). `fixtures.spec.ts` pins both halves.

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

/** Add a context the test made itself (say, in a browser from `chromium.launch()`) to the
 *  running test's watch. Call it before the context's first page does anything. */
export function watchContext(context: BrowserContext): void {
  if (!current) throw new Error('watchContext was called outside a running test');
  watch(current, context);
}

/** Watch every context `browser` makes until the returned function restores it. */
function watchBrowser(collector: Collector, browser: Browser): () => void {
  const { newContext, newPage } = browser;
  browser.newContext = async (...args) => {
    const context = await newContext.apply(browser, args);
    watch(collector, context);
    return context;
  };
  browser.newPage = async (...args) => {
    const page = await newPage.apply(browser, args);
    watch(collector, page.context());
    return page;
  };
  return () => {
    browser.newContext = newContext;
    browser.newPage = newPage;
  };
}

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

export const test = base.extend<{ expectedErrors: ExpectedErrors; errorTripwire: void }>({
  expectedErrors: [{ patterns: [] }, { option: true }],
  errorTripwire: [
    async ({ context, browser, expectedErrors: { patterns } }, use, testInfo) => {
      const collector: Collector = { seen: [], watched: new Set() };
      current = collector;
      watch(collector, context);
      const restore = watchBrowser(collector, browser);
      try {
        await use();
      } finally {
        restore();
        current = undefined;
      }
      if (testInfo.status !== 'passed') return;
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
