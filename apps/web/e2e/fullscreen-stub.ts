import type { Page } from '@playwright/test';

// fullscreen-stub.ts — a resolving spy over the Fullscreen API (PLAN.md Story 11 P4).
//
// REAL fullscreen is not CI-exercisable: headless Chromium either refuses the request
// outright or, when it honours it, resizes the viewport out from under every geometry
// assertion in the suite. So every touch-project spec that presses Start applies this init
// script — it keeps the gate's OBSERVABLE behaviour (a request is made, and it resolves)
// without the window actually changing size, and one dedicated test asserts the spy fires.
//
// The stub must be installed before navigation: `main.ts` reads `requestFullscreen` off the
// document element at Start time, so the replacement has to be in place from page load.

declare global {
  interface Window {
    /** How many times the app requested fullscreen since load. */
    __wyFullscreenCalls?: number;
  }
}

/** Replace `requestFullscreen` with a resolving spy, BEFORE navigation. */
export async function stubFullscreen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__wyFullscreenCalls = 0;
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      writable: true,
      value: function requestFullscreenStub(): Promise<void> {
        window.__wyFullscreenCalls = (window.__wyFullscreenCalls ?? 0) + 1;
        return Promise.resolve();
      },
    });
    // The gate re-checks `document.fullscreenElement` before every request; the stub never
    // actually enters fullscreen, so it must keep reporting null for the edge to be honest.
    Object.defineProperty(Document.prototype, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
  });
}

/** How many fullscreen requests the app has made since load. */
export async function fullscreenCallCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__wyFullscreenCalls ?? 0);
}
