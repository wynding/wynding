import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { assertRenderedContrast } from './contrast';

// One end-to-end smoke over the M1 slice, carrying the ADR 0003 axe-core audit. It
// exercises the real DOM UI (HUD + controls + settings) and the run lifecycle, then
// asserts zero accessibility violations. The Phaser canvas is out of axe's scope (ADR
// 0003 §3 — covered by the accessibility checklist + unit tests), so we audit the DOM.

test('renders the app shell (status/board/dock/rail), and settings with no axe violations', async ({
  page,
}) => {
  await page.goto('/');

  // Pinned topology (PLAN.md P1): wordmark + HUD in the status bar, board + Dock in the
  // Stage, and the Rail — which carries the single M1 tower Card (asserted below).
  await expect(page.locator('.wy-wordmark')).toHaveText('Wynding');
  await expect(page.locator('.wy-status')).toContainText('Lives:');
  await expect(page.locator('.wy-board')).toBeVisible();
  await expect(page.locator('.wy-rail')).toBeVisible();
  // The Rail's Card (PLAN.md P2) — the single M1 `basic` tower, unarmed at load.
  await expect(page.locator('.wy-card')).toBeVisible();
  await expect(page.locator('.wy-card')).toHaveAttribute('aria-pressed', 'false');
  // Pre-start (PLAN.md P4): Pause is hidden (nothing to pause yet), and the Dock's
  // primary button reads "Start".
  await expect(page.getByRole('button', { name: 'Pause' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();

  // Open the accessibility settings (now a bounded, labelled modal dialog — sibling of
  // the Shell, which goes inert while it's open) and switch colour-vision mode + reduced
  // motion.
  await page.getByRole('button', { name: 'Accessibility settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Accessibility' });
  await expect(settingsDialog).toBeVisible();
  await expect(page.locator('.wy-shell')).toHaveAttribute('inert', '');
  await page.getByLabel('Deuteranopia').check();
  await page.getByLabel('Reduce motion').check();

  // axe audit of the live DOM UI (settings dialog open).
  const results = await new AxeBuilder({ page }).include('#app').analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  // Rendered-contrast spot checks (actual computed colours, not tokens): body text and a
  // control button, each against its own background.
  await assertRenderedContrast(page, 'body', 4.5);
  await assertRenderedContrast(page, '.wy-btn', 4.5);

  // Close via the dialog's own Close button (Escape is covered separately below) —
  // un-inerts the Shell and restores focus to the opener.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(settingsDialog).toBeHidden();
  await expect(page.locator('.wy-shell')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Accessibility settings' })).toBeFocused();
});

test('the settings dialog closes on Escape (the modal owner consumes it first)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Accessibility settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Accessibility' });
  await expect(settingsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsDialog).toBeHidden();
  await expect(page.locator('.wy-shell')).not.toHaveAttribute('inert', '');
});

test('arms the Card, places a tower via the keyboard cursor, sells it via the Panel — with live-region announcements and no axe violations while armed and while the Panel is open', async ({
  page,
}) => {
  await page.goto('/');

  const card = page.getByRole('button', { name: /Basic Tower/ });
  const board = page.locator('.wy-board');
  const live = page.locator('.wy-sr-only[role="status"][aria-live="polite"]');
  const panel = page.locator('.wy-panel');

  await expect(panel).toBeHidden();
  await card.click(); // armed (PLAN.md P2 table, row 1)
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(board).toBeFocused(); // Focus rules: arming moves focus to the board
  await expect(live).toContainText('armed');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Basic Tower');
  await expect(panel).toContainText('Cost:');

  // axe audit while ARMED (Panel showing type info).
  const armedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(armedAudit.violations, JSON.stringify(armedAudit.violations, null, 2)).toEqual([]);

  // Place via the keyboard cursor (arrow-cursor + Enter must keep working while armed,
  // per the Focus rules) at (3,3) — a well-known buildable cell used throughout the unit
  // suite, away from the entrance/exit lane.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(card).toHaveAttribute('aria-pressed', 'false'); // placement disarms
  await expect(live).toContainText('placed');
  await expect(panel).toBeVisible(); // now showing the just-placed tower's selection

  // axe audit with the Panel open in its SELECTION state (Sell + the Max-level Upgrade).
  const panelAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(panelAudit.violations, JSON.stringify(panelAudit.violations, null, 2)).toEqual([]);

  // No global Sell button (PLAN.md P2 removes it) — Sell lives in the Panel.
  await expect(page.getByRole('button', { name: /^Sell tower/ })).toHaveCount(0);
  const sellBtn = panel.getByRole('button', { name: /^Sell/ });
  await expect(sellBtn).toBeVisible();
  const upgradeBtn = panel.getByRole('button', { name: 'Max level' });
  await expect(upgradeBtn).toHaveAttribute('aria-disabled', 'true');

  await sellBtn.click();
  await expect(panel).toBeHidden(); // Sell closes the Panel immediately
  await expect(live).toContainText('sold');
  await expect(board).toBeFocused(); // Sell → focus returns to the board
});

test('supports player-started runs, pause / speed controls, and reaches a result', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/');

  // Pre-start (PLAN.md P4): no countdown, just the localized prompt; Pause hidden.
  await expect(page.locator('.wy-status')).toContainText('Press Start to begin');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeHidden();

  // Start launches the run (M1: exactly one wave, launched immediately — Start IS the
  // early call). The primary Dock button then hides for the rest of the run.
  const start = page.getByRole('button', { name: 'Start' });
  await start.click();
  await expect(start).toBeHidden();

  const pause = page.getByRole('button', { name: 'Pause' });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();

  // Run at 2× so the no-tower loss resolves well within the timeout regardless of CI
  // runner speed (a full M1 wave at 1× can approach ~25 s of wall-clock).
  await page.getByRole('button', { name: /^Speed:/ }).click();

  // The run resolves; the results dialog appears with a Play-again + Verify affordance.
  const results = page.getByRole('dialog');
  await expect(results).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: 'Verify this run' })).toBeVisible();

  // axe audit of the results-dialog state — the settings-panel state is covered by the
  // other test; this closes the gap where the dialog was never scanned.
  const dialogResults = await new AxeBuilder({ page }).include('#app').analyze();
  expect(dialogResults.violations, JSON.stringify(dialogResults.violations, null, 2)).toEqual([]);

  // Modal semantics: `.wy-shell` (status bar + board + Dock + Rail — the ONLY node the
  // modal owner ever toggles `inert` on) carries `inert` while the dialog is open, and Tab
  // never escapes into it. `body` is the transit state (identical to native `showModal()`,
  // which also hands focus to browser chrome between tabbables rather than wrapping
  // directly) — so it's an allowed member of the "outside the dialog" set per press, but
  // the count + re-entry assertions below prove focus keeps cycling back into the dialog
  // rather than escaping permanently.
  await expect(page.locator('.wy-shell')).toHaveAttribute('inert', '');

  const dialogTabbableCount = await results
    .locator('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    .count();
  let inDialogCount = 0;
  let lastOnBody = false;
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    const inDialog = await page.evaluate(() => {
      const el = document.activeElement;
      const dialog = document.querySelector('[role="dialog"]');
      return dialog !== null && el !== null && dialog.contains(el);
    });
    const onBody = await page.evaluate(() => document.activeElement === document.body);
    expect(
      inDialog || onBody,
      `Tab press ${i + 1} landed outside the dialog and outside body`,
    ).toBe(true);
    if (inDialog) inDialogCount++;
    lastOnBody = onBody;
  }
  expect(
    inDialogCount,
    `only ${inDialogCount}/10 Tab presses landed in the dialog`,
  ).toBeGreaterThanOrEqual(6);
  if (lastOnBody) {
    // Focus transited to body on the final press — confirm it re-enters the dialog rather
    // than escaping permanently.
    await page.keyboard.press('Tab');
    const backInDialog = await page.evaluate(() => {
      const el = document.activeElement;
      const dialog = document.querySelector('[role="dialog"]');
      return dialog !== null && el !== null && dialog.contains(el);
    });
    expect(backInDialog, 'focus did not re-enter the dialog after transiting body').toBe(true);
  }
  expect(dialogTabbableCount).toBeGreaterThan(0);

  // Rendered-contrast spot check inside the dialog: the primary Play-again button. The
  // Dock's Start button shares `.wy-primary` (deduplicated — one primary class), so the
  // selector is scoped to `.wy-results` to sample Play-again specifically, never the Dock.
  await assertRenderedContrast(page, '.wy-results .wy-primary', 4.5);

  // Dev-verify re-simulates the recorded replay and confirms it matches.
  await page.getByRole('button', { name: 'Verify this run' }).click();
  await expect(page.locator('.wy-verify')).toContainText('Verified');

  // Focus-restore: Play again clears inert and returns focus to the board.
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(page.locator('.wy-shell')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.wy-board')).toBeFocused();

  // Play-again returns to the pre-start state (PLAN.md P4): held again, Start required
  // again.
  await expect(page.locator('.wy-status')).toContainText('Press Start to begin');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('arms the Card via the keyboard hotkey and places with arrows + Enter — a full keyboard-only path', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByRole('button', { name: /Basic Tower/ });
  const board = page.locator('.wy-board');

  // `Digit1` (armTower1's default binding) arms from document scope — "any state" per the
  // PLAN.md P2 table — with no mouse/Card click involved at all.
  await page.keyboard.press('Digit1');
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(board).toBeFocused();

  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(card).toHaveAttribute('aria-pressed', 'false'); // placement disarms
  const panel = page.locator('.wy-panel');
  await expect(panel.getByRole('button', { name: /^Sell/ })).toBeVisible();
});

test('settings: focusing the last rebind control then closing via Escape restores focus to the opener', async ({
  page,
}) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Accessibility settings' });
  await opener.click();
  const settingsDialog = page.getByRole('dialog', { name: 'Accessibility' });
  await expect(settingsDialog).toBeVisible();

  // The last rebind row (armTower1, GAME_ACTIONS' last entry) — reachable and visible
  // within the dialog's own scrollport before it closes.
  const lastRebind = page.getByRole('button', { name: 'Rebind Arm basic tower' });
  await lastRebind.focus();
  await expect(lastRebind).toBeFocused();
  await expect(lastRebind).toBeInViewport();

  await page.keyboard.press('Escape');
  await expect(settingsDialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('the aria-disabled Upgrade control is keyboard-reachable (Tab) despite being inert to activation', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByRole('button', { name: /Basic Tower/ });
  await card.click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter'); // placed + selected

  const panel = page.locator('.wy-panel');
  const upgradeBtn = panel.getByRole('button', { name: 'Max level' });
  await expect(upgradeBtn).toHaveAttribute('aria-disabled', 'true');

  const sellBtn = panel.getByRole('button', { name: /^Sell/ });
  await sellBtn.focus();
  await page.keyboard.press('Tab');
  await expect(upgradeBtn).toBeFocused(); // reachable — a native `disabled` button couldn't be
});

test('rendered contrast: Card, Panel, and Dock controls meet the DOM text bar', async ({
  page,
}) => {
  await page.goto('/');
  await assertRenderedContrast(page, '.wy-card', 4.5);
  await assertRenderedContrast(page, '.wy-dock .wy-btn', 4.5);

  await page.getByRole('button', { name: /Basic Tower/ }).click();
  await assertRenderedContrast(page, '.wy-panel', 4.5);
});

test('200% text zoom at the smallest supported landscape viewport (658×320): chrome regions scroll internally instead of clipping', async ({
  page,
}) => {
  // Pinned to the Galaxy S9+ landscape profile's viewport (`chromium-touch`'s device) — the
  // smallest supported landscape size (ADR 0003's text-resize commitment).
  await page.setViewportSize({ width: 658, height: 320 });
  await page.goto('/');
  expect(page.viewportSize()).toEqual({ width: 658, height: 320 });

  await page.addStyleTag({ content: ':root { font-size: 200% }' });

  // Reading back the authored `overflow-y` value cannot fail (it is what ui.css declares) —
  // assert the internal scrolling actually ENGAGES instead: each region's scrollHeight must
  // exceed its visible clientHeight (i.e. its content overflows and it scrolls), rather than
  // clipping. `overflowsInternally` is the observable proof the region is scrollable AND has
  // overflowing content.
  const overflowsInternally = (selector: string): Promise<boolean> =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => el.scrollHeight > el.clientHeight);

  // The status bar (Lives/Bounty/Score/Stars + wordmark at 200%) overflows its bounded row
  // — `.wy-shell`'s first row is `minmax(0, auto)` with `.wy-status` capped at a dvh-based
  // max-height (ui.css), so it scrolls internally rather than growing unbounded and
  // squeezing the board.
  expect(await overflowsInternally('.wy-status'), '.wy-status should scroll internally').toBe(true);

  // The board keeps a defensible minimum height because the bounded status row can eat at
  // most ~40dvh (128px of this 320px-tall viewport), leaving the board's `1fr` row ≥ ~192px.
  // 150 is a floor with margin below that ~192 — and above what an UNBOUNDED status row would
  // leave: remove the `.wy-status` max-height and the 200%-zoom status bar grows tall enough
  // to squeeze the board well under 150, so this assertion bites exactly on the M4 bound.
  const boardHeight = await page.locator('.wy-board').evaluate((el) => el.clientHeight);
  expect(
    boardHeight,
    `.wy-board height ${boardHeight}px below the 150px floor`,
  ).toBeGreaterThanOrEqual(150);

  // Rail: arm the Card so the Panel opens with its Close button as the Rail's last
  // control at 200% zoom — the Rail's content now overflows, so it must scroll internally
  // AND focusing that Close button must scroll it into `.wy-rail`'s own scrollport rather
  // than leaving it clipped off-screen.
  await page.getByRole('button', { name: /Basic Tower/ }).click();
  expect(await overflowsInternally('.wy-rail'), '.wy-rail should scroll internally').toBe(true);
  const panelClose = page.locator('.wy-panel').getByRole('button', { name: 'Close panel' });
  await panelClose.scrollIntoViewIfNeeded();
  await panelClose.focus();
  await expect(panelClose).toBeFocused();
  await expect(panelClose).toBeInViewport();

  // Settings: the dialog overflows at 200% and scrolls internally; the same reachability
  // proof for its own scrollport follows.
  await page.getByRole('button', { name: 'Accessibility settings' }).click();
  expect(await overflowsInternally('.wy-settings'), '.wy-settings should scroll internally').toBe(
    true,
  );
  const lastRebind = page.getByRole('button', { name: 'Rebind Arm basic tower' });
  await lastRebind.scrollIntoViewIfNeeded();
  await lastRebind.focus();
  await expect(lastRebind).toBeFocused();
  await expect(lastRebind).toBeInViewport();
  await page.keyboard.press('Escape');

  // Status bar holds no focusable controls — scroll its last content element (the Stars
  // HUD span) into view and assert visibility instead of focus/reachability.
  const stars = page.locator('.wy-hud > span').last();
  await stars.scrollIntoViewIfNeeded();
  await expect(stars).toBeInViewport();
});
