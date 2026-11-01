import { test, expect } from './fixtures';
import { openResults, toggleOf } from './results-harness';

// verify.spec.ts — in-app Verify runs off the main thread (M3 story 2), in a real browser.
//
// Verify re-simulates the whole finished run. On the main thread that froze the page for the
// whole of it, seconds on a low-end phone at M3's run length, so it moved into a dedicated
// module worker (`src/verifier.ts`, `src/verify-worker.ts`). The unit suites prove the exchange
// and the dialog's states against a stand-in; what only a browser can prove is that the BUILT
// app spawns a real worker from a chunk Vite emitted, that the worker loads and answers, and
// that the page keeps drawing frames while it works.
//
// It runs on the results harness's won run (`?run=win`, ten waves and forty towers: the longest
// re-simulation the e2e builds have), which the dialog opens on.

/** What the status region showed, in order, and how many frames the page drew between the
 *  first text and the last — recorded in the page, so nothing depends on polling timing. */
interface StatusLog {
  texts: string[];
  framesBetween: number;
}

test('Verify runs in a worker: it says so at once, the page keeps drawing, and the answer lands', async ({
  page,
}) => {
  const dialog = await openResults(page, 'win');
  await toggleOf(dialog).click();
  await page.evaluate(() => {
    const log: StatusLog = { texts: [], framesBetween: 0 };
    (window as unknown as { wyVerifyLog: StatusLog }).wyVerifyLog = log;
    const region = document.querySelector('.wy-results .wy-verify')!;
    let counting = false;
    const tick = (): void => {
      if (counting) log.framesBetween++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text === '' || text === log.texts.at(-1)) return;
      log.texts.push(text);
      counting = text === 'Verifying this run…';
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });

  const spawned = page.waitForEvent('worker');
  await dialog.getByRole('button', { name: 'Verify this run' }).click();
  const worker = await spawned;
  // A chunk of its own, emitted by the build — not inlined, not served from source.
  expect(new URL(worker.url()).pathname).toMatch(/^\/assets\/verify-worker-[\w-]+\.js$/);
  const closed = worker.waitForEvent('close');

  await expect(dialog.getByRole('status')).toHaveText(
    'Verified: replay re-simulated to the same outcome.',
  );
  const log = await page.evaluate(
    () => (window as unknown as { wyVerifyLog: StatusLog }).wyVerifyLog,
  );
  expect(log.texts).toEqual([
    'Verifying this run…',
    'Verified: replay re-simulated to the same outcome.',
  ]);
  // A main-thread re-simulation would have drawn nothing between the two: the press would
  // have written its answer before the browser could paint "Verifying".
  expect(log.framesBetween, 'frames drawn while the worker verified').toBeGreaterThan(0);
  // And the worker is gone once it answered: one per verification.
  await closed;
});
