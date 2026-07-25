import { test, expect } from '@playwright/test';

// Player-started runs (PLAN.md P4/P6): a fresh load is HELD at tick 0 — no countdown, no
// wave, and pre-start planning (build/sell) is fully available and presented as Pending.
// Space/speed must never un-hold; only Start does. The board carries plain test-hook
// attributes (`data-run-started`/`data-sim-tick`/`data-pending-adds`, PLAN.md P4) so
// "held"/"frozen" are asserted directly instead of inferred from a short wait.

test('holds at tick 0 until Start, commits a Pending pre-start build, and Play-again re-holds', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/');

  const board = page.locator('.wy-board');
  await expect(board).toHaveAttribute('data-run-started', 'false');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  // Story 11's wave-slot states: pre-start the wave chip is hidden entirely (the held sim's
  // countdown figure is meaningless), leaving four visible chips — the Dock's "Start" button
  // is the affordance that says a run has not begun.
  await expect(page.locator('.wy-chip[data-wy-chip="wave"]')).toBeHidden();

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
  await expect(board).toHaveAttribute('data-run-started', 'false');

  // Space (pause) and a speed change do NOT un-hold — `advance()` is gated on `started`
  // independently of `paused`/speed (PLAN.md P4). Space toggles `paused` itself (which
  // works regardless of hold state — only ADVANCE checks `started`), so press it again to
  // leave `paused` false before Start, or the run would come out of `start()` already
  // paused and never actually step.
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await page.keyboard.press('KeyF');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await expect(board).toHaveAttribute('data-run-started', 'false');

  // Start: ticks advance, wave 1 arrives (the sim's own `pre-wave` phase moves on), and
  // the Pending tower commits (its buffer entry is gone — `data-pending-adds` returns to
  // 0 rather than growing further).
  const start = page.getByRole('button', { name: 'Start' });
  await start.click();
  await expect(board).toHaveAttribute('data-run-started', 'true');
  await expect(board).not.toHaveAttribute('data-sim-tick', '0');
  await expect(board).not.toHaveAttribute('data-sim-phase', 'pre-wave');
  await expect(board).toHaveAttribute('data-pending-adds', '0');

  // The run resolves (speed was already cycled to 2× above) — results dialog appears.
  const results = page.getByRole('dialog');
  await expect(results).toBeVisible({ timeout: 40_000 });

  // Play-again returns to the held state exactly as at first load.
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(board).toHaveAttribute('data-run-started', 'false');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await expect(page.locator('.wy-chip[data-wy-chip="wave"]')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});
