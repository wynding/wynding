import { test, expect } from '@playwright/test';

// Player-started runs (PLAN.md P4/P6, decoupled further at M2-S2 P3 step 15): a fresh load
// is HELD at tick 0 — no wave has launched, and pre-start planning (build/sell) is fully
// available and presented as Pending. Space/speed must never un-hold; only Start does. The
// board carries plain test-hook attributes (`data-started`/`data-sim-tick`/
// `data-pending-adds`) so "held"/"frozen" are asserted directly instead of inferred from a
// short wait.
//
// M2-S2 changes what Start proves here: it no longer claims wave 1 (Start ≠ claiming), so
// the sim's own `phase` never flips on Start — it is `'running'` before, during, and after
// (only `won`/`lost` are distinct phases now). What DOES move on Start is the wave-1
// countdown, since `advance()` is gated on `started` — this spec asserts that COUNTDOWN
// MOVEMENT directly, rather than a phase flip that no longer exists.

test('holds at tick 0 until Start, commits a Pending pre-start build, and Play-again re-holds', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/');

  const board = page.locator('.wy-board');
  const waveChip = page.locator('.wy-chip[data-wy-chip="wave"]');
  // The chip's OWN accessible text lives in `.wy-chip-full` — the chip root's `textContent`
  // concatenates both the full and the aria-hidden glance forms (contract §4).
  const waveChipText = waveChip.locator('.wy-chip-full');
  await expect(board).toHaveAttribute('data-started', 'false');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await expect(board).toHaveAttribute('data-sim-phase', 'running');
  // The wave chip is countdown-only (M2-S2) and VISIBLE pre-start — the sim's real
  // countdownRemaining is meaningful before Start is ever pressed, not just after. Pin the
  // count first: `toBeHidden`/`toBeVisible` also pass on ZERO matches, so a chip that
  // vanished from the DOM would slip past it.
  await expect(waveChip).toHaveCount(1);
  await expect(waveChip).toBeVisible();
  await expect(waveChipText).toHaveText(/^Wave in \d+s$/);

  // Build pre-start via the keyboard cursor (arm the Card, move, Enter) — the build is
  // accepted into the tick buffer but not yet applied by a tick (Pending), reflected by
  // `data-pending-adds` incrementing while the run is still held.
  const card = page.getByRole('button', { name: /Basic Tower/ });
  await card.click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(board).toHaveAttribute('data-pending-adds', '1');
  // Still frozen — a Pending build queues, it does not step the sim.
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await expect(board).toHaveAttribute('data-started', 'false');

  // Space (pause) and a speed change do NOT un-hold — `advance()` is gated on `started`
  // independently of `paused`/speed (PLAN.md P4). Space toggles `paused` itself (which
  // works regardless of hold state — only ADVANCE checks `started`), so press it again to
  // leave `paused` false before Start, or the run would come out of `start()` already
  // paused and never actually step.
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await page.keyboard.press('KeyF'); // cycle speed to 2× — still held, no tick fires
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await expect(board).toHaveAttribute('data-started', 'false');

  // Start: ticks advance and the Pending tower commits (its buffer entry is gone —
  // `data-pending-adds` returns to 0) — but wave 1 does NOT launch (M2-S2's decouple): the
  // sim's phase stays `running` throughout (there is no flip to assert), so the observable
  // proof of "actually running now" is the wave-1 COUNTDOWN moving.
  const start = page.getByRole('button', { name: 'Start' });
  const initialCountdown = (await waveChipText.textContent())!;
  await start.click();
  await expect(board).toHaveAttribute('data-started', 'true');
  await expect(board).not.toHaveAttribute('data-sim-tick', '0');
  await expect(board).toHaveAttribute('data-sim-phase', 'running'); // never flips — only won/lost do
  await expect(board).toHaveAttribute('data-pending-adds', '0');
  await expect(waveChipText).not.toHaveText(initialCountdown); // the countdown itself moved

  // Early-call every wave via the SAME morphed primary control (now "Call wave") — keeps
  // this spec deterministic and fast rather than waiting out three full natural countdowns
  // (smoke.spec.ts exercises the identical flow end-to-end, with the preview + axe).
  const callWave = page.getByRole('button', { name: 'Call wave' });
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  // The bundle now carries six waves — M2-S6 appended index 4 (`resolute`+`fast`) and
  // M2-S7 appended index 5 (8 × `flying`) — so this early-calls all six, not four.
  for (let waveNumber = 1; waveNumber <= 6; waveNumber++) {
    // Gate each press on LAUNCH-specific state, not the free-running sim heartbeat:
    // a tick boundary can fall between a tick-read and the click, so a tick-poll
    // passes even when the press itself was swallowed or same-tick-deduped (local
    // QC round 2 + CodeRabbit — the loop would silently stop testing "call every
    // wave"). The preview title only advances when the PREVIOUS call actually
    // landed, and the aria gate proves this press is genuinely accepted-able.
    await expect(previewTitle).toHaveText(`Wave ${waveNumber} of 6`);
    await expect(callWave).toHaveAttribute('aria-disabled', 'false');
    await callWave.click();
  }
  await expect(previewTitle).toHaveText('Final wave launched — no more waves to call');

  // The run resolves — results dialog appears.
  const results = page.getByRole('dialog');
  await expect(results).toBeVisible({ timeout: 40_000 });

  // Play-again returns to the held state exactly as at first load.
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(board).toHaveAttribute('data-started', 'false');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await expect(waveChip).toHaveCount(1);
  await expect(waveChip).toBeVisible();
  await expect(waveChipText).toHaveText(/^Wave in \d+s$/);
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});
