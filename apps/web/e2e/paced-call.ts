import { expect, type Page } from '@playwright/test';

/** #97's cure: spec-controlled pacing for the undefended early-call marathon loops.
 *
 *  Those loops free-ran the sim (at 2× in the smoke/start-gate marathons) while each
 *  iteration did real wall-clock work — composition asserts, aria gates, the click
 *  itself — so on a lagged runner the gaps stretched, creeps leaked in them, and the run
 *  could LOSE with calls still outstanding. At terminal the primary control hides and the
 *  results dialog opens: #97's artifact-diagnosed failure shape (role query empty,
 *  preview title frozen, click blocked by the modal).
 *
 *  The cure is to hold the sim PAUSED for every observation and release it only in a
 *  window no runner stall can stretch:
 *
 *  1. The Call-wave press happens while PAUSED — a real Playwright click. The command
 *     buffers (`doCallWaveEarly` has no pause gate), surfacing only as `launchPending`
 *     until a tick consumes it, and the projection NEVER advances the preview for a
 *     merely-buffered call (`derivePreview` reads `waveCursor`, which only the real
 *     `step()` moves — packages/render/src/view-model.ts).
 *  2. One `page.evaluate` pulse resumes, waits for `data-sim-tick` to advance past its
 *     pre-release reading, and re-pauses — synchronously with the observation, in the
 *     page. This is the load-bearing choice, learned by local 3-worker stress runs:
 *     closing the window with any separate client-initiated action (an awaited title
 *     poll, even a blind Pause click) leaves a span that runner load inflates without
 *     bound, and both earlier shapes of this helper lost runs exactly there. In-page,
 *     the waiter and the sim share one event loop — a stall starves them together, the
 *     re-pause runs in the same task as the observation so no further RAF tick can
 *     interleave, and the engine's spiral-of-death clamp (5-tick accumulator cap,
 *     packages/engine/src/game-loop.ts) bounds what any single recovered frame can run.
 *     Sim exposure per call is therefore a few ticks REGARDLESS of runner load, and an
 *     undefended marathon structurally cannot lose mid-loop.
 *  3. Only then, re-paused and unhurried, the title check — repaint-latency deep, not
 *     sim-race deep, because a consumed call's advanced title is frozen state by now.
 *
 *  The pulse's in-page dispatch is pacing SCAFFOLDING, deliberately outside the
 *  user-input pipeline; pause/resume as real user interactions keep their coverage
 *  elsewhere (smoke exercises the buttons through Playwright directly, slow-press.spec
 *  pins press semantics). The tested surface here — the call press and every
 *  assertion — stays on the real pipeline.
 *
 *  Contract: the run must already be paused when this is called (pause once after
 *  Start, before the loop), and each call exits paused on a stable next-wave preview —
 *  after the final wave, the caller Resumes once to let the run stream to terminal.
 */
export async function callWavePaced(page: Page, expectedTitleAfter: string): Promise<void> {
  await page.getByRole('button', { name: 'Call wave' }).click();
  await page.evaluate(async () => {
    const board = document.querySelector('.wy-board');
    const tick = (): number => Number(board?.getAttribute('data-sim-tick') ?? NaN);
    // The pause toggle, by its localized text span (`.wy-btn-text` — the accessible
    // label; the sibling `.wy-btn-icon` glyph is aria-hidden presentation): 'Resume'
    // while paused, 'Pause' while running. Exact-match uniqueness is asserted so a
    // future second control with a colliding label fails loudly, not silently.
    const toggle = (label: string): void => {
      const hits = [...document.querySelectorAll<HTMLElement>('button > .wy-btn-text')].filter(
        (span) => span.textContent?.trim() === label,
      );
      if (hits.length !== 1) {
        throw new Error(`callWavePaced: ${hits.length} "${label}" buttons (expected exactly 1)`);
      }
      hits[0]!.closest('button')!.click();
    };
    const before = tick();
    if (!Number.isFinite(before)) throw new Error('callWavePaced: no data-sim-tick on .wy-board');
    const deadline = Date.now() + 5_000;
    toggle('Resume');
    for (;;) {
      const now = tick();
      if (Number.isFinite(now) && now > before) break;
      if (Date.now() > deadline) {
        // Freeze the evidence before failing — best-effort: in the one scenario that
        // reaches this deadline (RAF fully stalled, so the sim never ticked), the HUD
        // refresh that relabels the toggle to 'Pause' never ran either, and the timeout
        // diagnosis below must not be masked by the finder's uniqueness error.
        try {
          toggle('Pause');
        } catch {
          /* keep the timeout error */
        }
        throw new Error(`callWavePaced: no tick within 5s of resume (data-sim-tick=${before})`);
      }
      // Timer, not RAF: if RAF ever stalls, the sim stalls with it (advance() is
      // RAF-fed) — the timer keeps the deadline check alive instead of hanging.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    toggle('Pause');
  });
  await expect(page.locator('.wy-wave-preview .wy-wave-preview-title')).toHaveText(
    expectedTitleAfter,
  );
}

/** The preview title expected once wave `waveNumber` of `waveCount` has launched: the
 *  next wave's banner, or the explicit last-wave marker after the final call
 *  (`hud.preview.lastWave`). */
export function titleAfterCall(waveNumber: number, waveCount: number): string {
  return waveNumber < waveCount
    ? `Wave ${waveNumber + 1} of ${waveCount}`
    : 'Final wave launched — no more waves to call';
}
