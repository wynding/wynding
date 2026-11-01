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
// The frame-gap checks run on the harness's synthetic 30-wave run (`?run=long`), the length M3
// moved Verify off the main thread for; the failure paths on its M2 win (`?run=win`), which
// opens sooner. The dialog opens on the finished run either way.

const VERIFYING = 'Verifying this run…';
const VERIFIED = 'Verified: replay re-simulated to the same outcome.';
const COULD_NOT_START = 'Verification failed: the verifier could not start';

/** The longest the page may go without a frame while Verify works: a few frames at 60 Hz. A
 *  main-thread re-simulation of the 30-wave run blocks for several times this in one go, as
 *  the control test below shows; the M2 win's is too short to tell the two apart. */
const MAX_FRAME_GAP_MS = 100;

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
  const dialog = await openResults(page, 'long');
  await toggleOf(dialog).click();
  await traceVerify(page);

  const spawned = page.waitForEvent('worker');
  const trace = pressVerify(page, dialog);
  const worker = await spawned;
  // A chunk of its own, emitted by the build — not inlined, not served from source.
  expect(new URL(worker.url()).pathname).toMatch(WORKER_CHUNK);
  const closed = worker.waitForEvent('close');

  const answered = await trace;
  expect(answered.texts).toEqual([VERIFYING, VERIFIED]);
  expect(
    longestFrameGap(answered),
    'the longest the page went without a frame while the worker verified (ms)',
  ).toBeLessThan(MAX_FRAME_GAP_MS);
  // And the worker is gone once it answered: one per verification.
  await closed;
});

test('control: the same Verify on the main thread stalls the page past that bound', async ({
  page,
}) => {
  // Without this, the bound above could pass on a run too short for a main-thread Verify to
  // fail it. `&verifyOnMain=1` swaps the harness's verifier for the in-process one.
  const dialog = await openResults(page, 'long', 100, '&verifyOnMain=1');
  await toggleOf(dialog).click();
  await traceVerify(page);
  let workers = 0;
  page.on('worker', () => workers++);

  const trace = await pressVerify(page, dialog);
  expect(trace.texts).toEqual([VERIFYING, VERIFIED]);
  expect(workers, 'verified in the page, not a worker').toBe(0);
  expect(
    longestFrameGap(trace),
    'the longest the page went without a frame while it verified on its own thread (ms)',
  ).toBeGreaterThanOrEqual(MAX_FRAME_GAP_MS);
});

test('a worker that cannot load ends the verification and says why', async ({ page }) => {
  await page.route(WORKER_CHUNK, (route) => route.abort());
  const dialog = await openResults(page, 'win');
  await toggleOf(dialog).click();
  await dialog.getByRole('button', { name: 'Verify this run' }).click();
  await expect(dialog.getByRole('status')).toHaveText(COULD_NOT_START);
});

test('a worker whose load stalls, firing nothing, still ends the verification', async ({
  page,
}) => {
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
