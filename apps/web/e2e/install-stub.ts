import type { Page } from '@playwright/test';

// install-stub.ts — deterministic preconditions for the install-path e2e (PLAN.md Story 11
// P3). No test here relies on the browser's real install heuristics: Chromium only fires
// `beforeinstallprompt` after its own engagement rules are satisfied, which is neither
// reproducible nor fast in CI, and Safari never fires it at all.
//
// TIMING IS THE WHOLE POINT of splitting these two helpers. The init script may only
// INSTALL the factory/stubs — it runs before any page script, so an event dispatched there
// would fire before the app has mounted its own listener and simply be lost. The dispatch
// itself has to happen from `page.evaluate()` AFTER `page.goto()` and mount.

declare global {
  interface Window {
    /** Installed by `installPromptFactory` — builds a spec-shaped `beforeinstallprompt`. */
    __wyMakePrompt?: (outcome: 'accepted' | 'dismissed') => Event;
    /** Set by the factory when the app calls `prompt()` on the synthetic event. */
    __wyPromptCalls?: number;
  }
}

/** Make the page look like iOS Safari, BEFORE navigation (the app reads these at boot). */
export async function stubIosPlatform(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  });
}

/** Install the synthetic-event factory, BEFORE navigation. Dispatches nothing. */
export async function installPromptFactory(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__wyPromptCalls = 0;
    window.__wyMakePrompt = (outcome: 'accepted' | 'dismissed'): Event => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: () => {
          window.__wyPromptCalls = (window.__wyPromptCalls ?? 0) + 1;
          return Promise.resolve();
        },
        userChoice: Promise.resolve({ outcome }),
      });
      return event;
    };
  });
}

/** Dispatch the captured-prompt signal — call only AFTER `page.goto()` and app mount, so
 *  the app's own listener exists to receive it. */
export async function firePrompt(
  page: Page,
  outcome: 'accepted' | 'dismissed' = 'accepted',
): Promise<void> {
  await page.evaluate((o) => {
    const make = window.__wyMakePrompt;
    if (make === undefined) throw new Error('installPromptFactory() was not applied before goto');
    window.dispatchEvent(make(o));
  }, outcome);
}

/** How many times the app called `prompt()` on the synthetic event (single-use proof). */
export async function promptCallCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__wyPromptCalls ?? 0);
}
