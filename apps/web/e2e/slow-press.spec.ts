import { test, expect } from '@playwright/test';
import { GRID, projectedGrid } from './layout-probe';

// #98's WebKit regression: mid-run, `overlay.update()` reassigns the Pause/Speed/Sell
// labels on every ~20 Hz HUD refresh even when the strings are unchanged, and a same-value
// `textContent` write still replaces the label's Text node. WebKit, unlike Chromium, does
// not synthesize `click` when a press straddles such a replacement under the pointer, so a
// ~170ms+ held press on any of the three dies silently while the game runs. P1 (`overlay.ts`)
// cures this by change-gating every per-refresh label write; this spec pins the browser-level
// symptom the fix is FOR.
//
// The press mechanism is `locator.click({ delay: 220 })` — a real held down → 220ms → up,
// through Playwright's input pipeline, WITH its actionability/hit-target checks (a covered,
// clipped, or unstable target fails loudly instead of silently missing). Playwright's default
// INSTANTANEOUS `.click()` structurally cannot catch this class — that is how ~40 green e2e
// runs coexisted with a bug the owner hit every session (#98). Detection is by OUTCOME
// assertion, not by the click call itself: pre-fix, the input sequence completes but no
// `click` event fires, so the assertions below go red; post-fix there is nothing to straddle,
// so the pass is deterministic (no arbitrary sleeps beyond the one deliberate tick-freeze
// window and Playwright's own polling).
//
// Runs under BOTH the default `chromium` project (the control arm — Chromium synthesizes
// `click` across mutations, so it passes even pre-fix) and the narrowly-scoped `webkit`
// project added in `playwright.config.ts` (the actual regression arm).

test('mid-run 220 ms press on Pause pauses', async ({ page }) => {
  await page.goto('/');
  const board = page.locator('.wy-board');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(board).toHaveAttribute('data-started', 'true');
  await expect
    .poll(async () => Number(await board.getAttribute('data-sim-tick')))
    .toBeGreaterThan(5);

  // Precondition: visible before the delayed press (`controls.pause` = "Pause").
  const pauseBtn = page.getByRole('button', { name: 'Pause' });
  await expect(pauseBtn).toBeVisible();
  await pauseBtn.click({ delay: 220 });

  // Outcome, not the click call: the button's own aria-pressed flips, and its label reads
  // the Resume string (`controls.resume` = "Resume") — queried fresh, since the accessible
  // name the button now exposes IS the assertion.
  const resumeBtn = page.getByRole('button', { name: 'Resume' });
  await expect(resumeBtn).toBeVisible();
  await expect(resumeBtn).toHaveAttribute('aria-pressed', 'true');

  // ...and the sim actually froze: two `data-sim-tick` reads 300ms apart must agree. This is
  // the deliberate exception to "no arbitrary sleeps" — proving a NON-event (no more ticks)
  // has no other observable.
  const frozenTick = await board.getAttribute('data-sim-tick');
  await page.waitForTimeout(300);
  await expect(board).toHaveAttribute('data-sim-tick', frozenTick!);
});

test('mid-run 220 ms press on Speed changes speed', async ({ page }) => {
  await page.goto('/');
  const board = page.locator('.wy-board');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(board).toHaveAttribute('data-started', 'true');
  await expect
    .poll(async () => Number(await board.getAttribute('data-sim-tick')))
    .toBeGreaterThan(5);

  // Precondition: visible before the delayed press. `controls.speed` = "Speed: {factor}x",
  // starting at the default 1x.
  const speedBtn = page.getByRole('button', { name: 'Speed: 1x' });
  await expect(speedBtn).toBeVisible();
  await speedBtn.click({ delay: 220 });

  // The ACCESSIBLE NAME, not the aria-hidden icon glyph (`2×`, `.wy-btn-icon`) — the button's
  // visible/localized text span (`.wy-btn-text`) is what the icon span is excluded from the
  // accessible-name computation FOR. Asserted by role/name query against the factor-2 form.
  await expect(page.getByRole('button', { name: 'Speed: 2x' })).toBeVisible();
});

test('mid-run 220 ms press on Sell sells', async ({ page }) => {
  await page.goto('/');
  const board = page.locator('.wy-board');
  const panel = page.locator('.wy-panel');

  // The target point, computed ONCE from the projected playable grid as the CENTER of a
  // named cell — a 75%/50% fraction of the board lands exactly ON a grid line (a boundary,
  // not an anchor, per the #98 investigation), where a cell center is deterministic. Cell
  // (21,17): the 2×2 footprint is clear of the border AND far enough below the row-11 creep
  // path to be OUT of the basic tower's range — Start itself launches wave 1 immediately
  // (#70), so it is this placement's range, not run timing, that keeps that launch from
  // being able to pay bounty and corrupt the exact sell-refund delta asserted below. The
  // `data-pending-adds` assertion is the in-test proof of buildability either way.
  const grid = await projectedGrid(page);
  const x = grid.x + (21.5 / GRID.cols) * grid.width;
  const y = grid.y + (17.5 / GRID.rows) * grid.height;

  // Pre-start: arm the Basic Tower Card, then place via a raw board click at the computed
  // point — board input is pointer-driven and untouched by #98 (the defect is in the Dock/
  // Panel LABEL writes), so this is the ordinary placement path.
  await expect(panel).toBeHidden();
  const card = page.getByRole('button', { name: /Basic Tower/ });
  await expect(card).toBeVisible();
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');

  await page.mouse.click(x, y);
  await expect(board).toHaveAttribute('data-pending-adds', '1');

  // Placement auto-selects the just-placed (now-pending) tower, opening the Panel — Escape
  // closes it so the mid-run reselection below is a REAL selection, not a carried-over one.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(board).toHaveAttribute('data-started', 'true');
  // The pending build committed — its buffer entry is gone.
  await expect(board).toHaveAttribute('data-pending-adds', '0');
  await expect
    .poll(async () => Number(await board.getAttribute('data-sim-tick')))
    .toBeGreaterThan(5);

  // Board-click the SAME retained point to select the now-committed tower — board input was
  // never affected by #98, so this re-selection is the reliable setup step, not part of what
  // this test is pinning.
  await page.mouse.click(x, y);
  const sellBtn = panel.getByRole('button', { name: /^Sell/ });
  await expect(sellBtn).toBeVisible();

  // Parse the refund from the Sell button's own label, anchored to `panel.sell`'s exact
  // shape ("Sell (refund {refund})") — never a loose substring match.
  const sellText = (await sellBtn.textContent()) ?? '';
  const sellMatch = sellText.match(/^Sell \(refund (\d+)\)$/);
  expect(
    sellMatch,
    `Sell button text "${sellText}" did not match the expected shape`,
  ).not.toBeNull();
  const refund = Number(sellMatch![1]);

  // Read the bounty from the anchored FULL form (`hud.bounty` = "Bounty: {count}") — never
  // the chip root, which concatenates the full and aria-hidden glance text.
  const bountyFull = page.locator('.wy-chip[data-wy-chip="bounty"] .wy-chip-full');
  const readBounty = async (): Promise<number | null> => {
    const text = (await bountyFull.textContent()) ?? '';
    const match = text.match(/^Bounty: (\d+)$/);
    return match ? Number(match[1]) : null;
  };
  const bountyBefore = await readBounty();
  expect(bountyBefore, `bounty chip text did not match the expected shape`).not.toBeNull();

  // Zero-income witness (#121): the exact bounty-delta assertion below only proves "refund,
  // no run income" if run income really is zero — until now that rested on the placement
  // comment's geometric argument (out of tower range) alone, unasserted. While a run is
  // active, `deriveScore`'s RUNNING phase (packages/sim/src/index.ts, ADR 0006) is
  // Σ kill-bounties + Σ early-call credit — both terms, not kill bounties alone — separate
  // from the `survivalMul` term, which only applies once the match resolves. Kill income is
  // zero by the placement geometry above; early-call credit is zero for a DIFFERENT, harder
  // reason worth pinning explicitly: `paysEarlyCall = k > 0` (sv15, #70) pays nothing for
  // wave index 0, and Start's own launch of wave 1 is the only launch this flow ever
  // triggers — no `callWaveEarly` on wave 2+ occurs before the sell. So "Score: 0" here is
  // the direct, enforced form of "neither income term has paid anything yet." If a future
  // change to range/lane geometry OR to the wave-1-is-free rule ever let this flow earn
  // either term, the failure now points at income (this assertion), not at bogus refund
  // arithmetic three lines down.
  await expect(page.locator('.wy-chip[data-wy-chip="score"] .wy-chip-full')).toHaveText('Score: 0');

  await sellBtn.click({ delay: 220 });

  // Outcome: the Panel hides (Sell closes it immediately, per the existing Panel contract),
  // and the SAME anchored bounty reading rises by exactly the parsed refund.
  await expect(panel).toBeHidden();
  await expect.poll(readBounty).toBe(bountyBefore! + refund);
});
