import { test, expect, type Locator, type Page } from './fixtures';
import { openResults, toggleOf } from './results-harness';

// verify.spec.ts — in-app Verify runs off the main thread (M3 story 2), in a real browser.
//
// Verify re-simulates the whole finished run. On the main thread that froze the page for the
// whole of it, seconds on a low-end phone at M3's run length, so it moved into a dedicated
// module worker (`src/verifier.ts`, `src/verify-worker.ts`). The unit suites prove the exchange
// and the dialog's states against a stand-in; what only a browser can prove is that the BUILT
// app spawns a real worker from a chunk Vite emitted, that the worker loads and answers, that
// the page keeps drawing frames while it works, and that a worker that cannot load ends the
// verification instead of leaving "Verifying" up for good.
//
// The frame-gap check verifies the harness's synthetic 30-wave run (`?run=long`), the length M3
// moved Verify off the main thread for, once in the worker and once on the main thread, and
// compares the two; the failure paths use its M2 win (`?run=win`), which opens sooner. The
// dialog opens on the finished run either way.

const VERIFYING = 'Verifying this run…';
const VERIFIED = 'Verified: replay re-simulated to the same outcome.';
const COULD_NOT_START = 'Verification failed: the verifier could not start';

/** How many times shorter than a main-thread Verify's longest frame gap the worker's must be. The
 *  check is RELATIVE because both arms run in one test, on one machine, back to back: a loaded CI
 *  runner (SwiftShader, parallel workers) slows both, and only the ratio says whether the worker
 *  kept the page drawing. Measured on an M-series Mac with two Playwright workers (eight runs
 *  each, M3 story 2): worker 15–30 ms, main thread 425–624 ms, a ratio of 14 or more. The
 *  worker's gap includes the main thread's own share — building the replay and copying it into
 *  the worker — which is why the bar is 4, not the measured ratio. */
const MIN_GAP_RATIO = 4;

/** The least the main-thread arm must stall the page for, so a run too short to stall it (the M2
 *  win's main-thread stall was 88 ms) cannot make the ratio vacuous. Under half the fastest
 *  measured; a slower machine only widens the stall. */
const CONTROL_MIN_GAP_MS = 200;

/** The worker chunk the build emits for `verify-worker.ts`. */
const WORKER_CHUNK = /\/assets\/verify-worker-[\w-]+\.js$/;

/** What the status region showed, in order, and when every frame ran, the press landed and
 *  the answer was written — recorded in the page, so nothing depends on polling timing. */
interface VerifyTrace {
  texts: string[];
  frames: number[];
  pressedAt: number;
  answeredAt: number;
}

/** Start recording a {@link VerifyTrace} on the open results dialog. */
async function traceVerify(page: Page): Promise<void> {
  await page.evaluate((verifying) => {
    const trace: VerifyTrace = { texts: [], frames: [], pressedAt: NaN, answeredAt: NaN };
    (window as unknown as { wyVerifyTrace: VerifyTrace }).wyVerifyTrace = trace;
    const region = document.querySelector('.wy-results .wy-verify')!;
    const frame = (): void => {
      trace.frames.push(performance.now());
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Capture phase on the window: timed before the app's own handler runs, which is where a
    // main-thread re-simulation would do all of its work.
    window.addEventListener('click', () => (trace.pressedAt = performance.now()), {
      capture: true,
    });
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text === '' || text === trace.texts.at(-1)) return;
      trace.texts.push(text);
      if (text !== verifying) trace.answeredAt = performance.now();
    }).observe(region, { childList: true, characterData: true, subtree: true });
  }, VERIFYING);
}

/** Press Verify, wait for the answer and two frames past it, and read the trace back. */
async function pressVerify(page: Page, dialog: Locator): Promise<VerifyTrace> {
  await dialog.getByRole('button', { name: 'Verify this run' }).click();
  await expect(dialog.getByRole('status')).toHaveText(VERIFIED);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => (window as unknown as { wyVerifyTrace: VerifyTrace }).wyVerifyTrace);
}

/** The longest stretch without a frame from the last frame before the press to the first after
 *  the answer: the whole time the page was verifying, including any task that ran it. */
function longestFrameGap({ frames, pressedAt, answeredAt }: VerifyTrace): number {
  let from = 0;
  while (from + 1 < frames.length && frames[from + 1]! <= pressedAt) from++;
  let gap = 0;
  for (let i = from + 1; i < frames.length; i++) {
    gap = Math.max(gap, frames[i]! - frames[i - 1]!);
    if (frames[i]! >= answeredAt) return gap;
  }
  throw new Error('no frame ran after the answer');
}

test('Verify runs in a worker: it says so at once, the page keeps drawing, and the answer lands', async ({
  page,
}) => {
  // The worker arm: the shipped verifier.
  let dialog = await openResults(page, 'long');
  await toggleOf(dialog).click();
  await traceVerify(page);
  const spawned = page.waitForEvent('worker');
  const tracing = pressVerify(page, dialog);
  const worker = await spawned;
  // A chunk of its own, emitted by the build — not inlined, not served from source.
  expect(new URL(worker.url()).pathname).toMatch(WORKER_CHUNK);
  const closed = worker.waitForEvent('close');
  const inWorker = await tracing;
  expect(inWorker.texts).toEqual([VERIFYING, VERIFIED]);
  // And the worker is gone once it answered: one per verification.
  await closed;

  // The main-thread arm, on the same run and the same machine, straight after: `&verifyOnMain=1`
  // swaps the harness's verifier for the in-process one.
  let workers = 0;
  page.on('worker', () => workers++);
  dialog = await openResults(page, 'long', 100, '&verifyOnMain=1');
  await toggleOf(dialog).click();
  await traceVerify(page);
  const onMain = await pressVerify(page, dialog);
  expect(onMain.texts).toEqual([VERIFYING, VERIFIED]);
  expect(workers, 'the main-thread arm verified in the page, not a worker').toBe(0);

  const workerGap = longestFrameGap(inWorker);
  const mainGap = longestFrameGap(onMain);
  test
    .info()
    .annotations.push(
      { type: 'longest frame gap, worker (ms)', description: workerGap.toFixed(1) },
      { type: 'longest frame gap, main thread (ms)', description: mainGap.toFixed(1) },
    );
  expect(mainGap, 'a main-thread Verify of this run stalls the page (ms)').toBeGreaterThanOrEqual(
    CONTROL_MIN_GAP_MS,
  );
  expect(
    workerGap,
    `the worker's longest frame gap, against a quarter of the main thread's ${mainGap.toFixed(1)} ms`,
  ).toBeLessThan(mainGap / MIN_GAP_RATIO);
});

// The two ways a worker can fail to start, end to end. Both read "could not start", because
// that is what happened in both: the region tells the player whether a verification could run,
// not which browser event said it could not. The unit suite (`verifier.test.ts`) tells the
// paths apart — an `error` before `ready`, the ready window passing, a crash after `ready` —
// and the console carries the cause for each, which each test declares (and so requires).
test.describe('a worker that cannot load', () => {
  test.use({
    expectedErrors: {
      patterns: [/^Wynding: Verify could not run\. VerifyError: the verify worker failed/],
    },
  });

  test('ends the verification and says why', async ({ page }) => {
    await page.route(WORKER_CHUNK, (route) => route.abort());
    const dialog = await openResults(page, 'win');
    await toggleOf(dialog).click();
    await dialog.getByRole('button', { name: 'Verify this run' }).click();
    await expect(dialog.getByRole('status')).toHaveText(COULD_NOT_START);
  });
});

test.describe('a worker whose load stalls', () => {
  test.use({
    expectedErrors: {
      patterns: [
        /^Wynding: Verify could not run\. VerifyError: the verify worker did not start in time/,
      ],
    },
  });

  test('firing nothing, still ends the verification', async ({ page }) => {
    // No error event ever comes: only the ready handshake's window ends it. The page's clock is
    // Playwright's, so that window passes in a moment.
    await page.clock.install();
    let requested = false;
    await page.route(WORKER_CHUNK, () => void (requested = true)); // held: never answered
    const dialog = await openResults(page, 'win');
    await toggleOf(dialog).click();
    await dialog.getByRole('button', { name: 'Verify this run' }).click();
    await expect(dialog.getByRole('status')).toHaveText(VERIFYING);
    await expect.poll(() => requested, 'the worker chunk was asked for').toBe(true);
    await page.clock.fastForward('00:16'); // past VERIFY_READY_TIMEOUT_MS (15 s)
    await expect(dialog.getByRole('status')).toHaveText(COULD_NOT_START);
  });
});
