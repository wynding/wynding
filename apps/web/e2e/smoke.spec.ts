import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { assertRenderedContrast } from './contrast';
import { assertDeclaredRegions, assertRegionRelations, projectedGrid } from './layout-probe';
import { firePrompt, installPromptFactory, promptCallCount, stubIosPlatform } from './install-stub';
import { fullscreenCallCount, stubFullscreen } from './fullscreen-stub';

/** The smallest supported landscape viewport (the Galaxy S9+ landscape profile) — Compact
 *  after Story 11, and the size every pinned board-floor gate is derived against. */
const VIEWPORT_658 = { width: 658, height: 320 };

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
  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
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
  await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();
});

test('the SERVED page links a manifest that actually launches the game (PLAN.md P2)', async ({
  page,
  request,
}) => {
  await page.goto('/');

  // Resolve the link the browser itself would follow — not the source path — so a base-path
  // rewrite (production builds with `--base=/play/`) is exercised rather than assumed.
  const href = await page
    .locator('link[rel="manifest"]')
    .evaluate((el) => (el as HTMLLinkElement).href);
  const response = await request.get(href);
  expect(response.status(), `${href} was not served`).toBe(200);
  const manifest = JSON.parse(await response.text());

  // Relative members resolve against the MANIFEST URL, so an installed app opens the
  // deployed base path rather than the origin root.
  expect(manifest.start_url).toBe('.');
  expect(manifest.scope).toBe('.');
  expect(manifest.display).toBe('standalone');
  expect(manifest.name).toBe('Wynding');

  // ...and every icon it declares is actually SERVED (a committed-but-unpublished icon is a
  // silently uninstallable app on Chromium, which requires a fetchable ≥192px icon).
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    const iconUrl = new URL(icon.src, href).toString();
    const iconResponse = await request.get(iconUrl);
    expect(iconResponse.status(), `${iconUrl} was not served`).toBe(200);
    expect(iconResponse.headers()['content-type']).toContain('image/png');
  }
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);

  // The iOS home-screen icon is linked from the document (iOS ignores the manifest's icons).
  const appleHref = await page
    .locator('link[rel="apple-touch-icon"]')
    .evaluate((el) => (el as HTMLLinkElement).href);
  expect((await request.get(appleHref)).status(), `${appleHref} was not served`).toBe(200);
});

test('a promptable DESKTOP session gets the settings-row Install action and NO banner, and the prompt is single-use', async ({
  page,
}) => {
  // The init script only installs the factory; the dispatch happens after mount (an
  // init-script dispatch would fire before the app's listener exists and be lost).
  await installPromptFactory(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();

  // Desktop = fine pointer. `beforeinstallprompt` is a Chromium signal, not "Android": the
  // banner is phone-oriented, so this session gets the settings row only.
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
  await firePrompt(page, 'accepted');
  await expect(page.locator('.wy-banner')).toBeHidden();

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // The renamed dialog keeps an "Accessibility" heading for the a11y controls (decision 5).
  await expect(dialog.getByRole('heading', { name: 'Accessibility' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Install as app' })).toBeVisible();

  // Axe with the renamed Settings dialog + install row visible.
  const settingsAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(settingsAudit.violations, JSON.stringify(settingsAudit.violations, null, 2)).toEqual([]);

  const install = dialog.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeVisible();
  await install.click();
  await expect.poll(() => promptCallCount(page)).toBe(1);

  // Accepted → installed for this session → every install affordance goes away, and the
  // held event was consumed so nothing can re-fire it.
  await expect(page.locator('.wy-install-row')).toBeHidden();
  expect(await promptCallCount(page)).toBe(1);
});

test('an `other` browser is told where to look instead of being offered a dead button', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'Install as app' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Install', exact: true })).toBeHidden();
  await expect(page.locator('.wy-install-explain')).toContainText('Add to Home Screen');
});

test('iOS: the settings row opens the Add-to-Home-Screen dialog, which Escape dismisses', async ({
  page,
}) => {
  await stubIosPlatform(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsDialog.getByRole('button', { name: 'Show me how' }).click();

  // Settings closes FIRST, then instructions opens — they never share the stack.
  await expect(settingsDialog).toBeHidden();
  const instructions = page.getByRole('dialog', { name: 'Add Wynding to your Home Screen' });
  await expect(instructions).toBeVisible();
  await expect(instructions).toContainText('tap the Share button');
  await expect(page.locator('.wy-shell')).toHaveAttribute('inert', '');

  // Axe with the instructions dialog open.
  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);

  // Escape dismisses it via the new per-overlay modal metadata, and focus returns to the
  // settings opener per the modal owner's stack rules.
  await page.keyboard.press('Escape');
  await expect(instructions).toBeHidden();
  await expect(page.locator('.wy-shell')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();
});

test('the settings dialog closes on Escape (the modal owner consumes it first)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
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

  // Pre-start (PLAN.md P4 + Story 11's wave-slot states): no countdown — the wave chip is
  // hidden entirely until a run begins (the sim's countdown never ticks down while held),
  // leaving four visible chips; Pause hidden.
  await expect(page.locator('.wy-chip[data-wy-chip="wave"]')).toBeHidden();
  await expect(page.locator('.wy-hud > .wy-chip:not([hidden])')).toHaveCount(4);
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
  // again — including the wave chip going back to hidden.
  await expect(page.locator('.wy-chip[data-wy-chip="wave"]')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('a fine-pointer session never requests fullscreen on Start (the gate is capability-based)', async ({
  page,
}) => {
  await stubFullscreen(page);
  await page.goto('/');
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeHidden(); // the run did start
  expect(await fullscreenCallCount(page)).toBe(0);
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
  const opener = page.getByRole('button', { name: 'Settings' });
  await opener.click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
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

test('200% text zoom at the smallest supported landscape viewport (658×320): the Compact layout scrolls internally instead of clipping, and the board keeps its pinned floor', async ({
  page,
}) => {
  // Pinned to the Galaxy S9+ landscape profile's viewport (`chromium-touch`'s device) — the
  // smallest supported landscape size (ADR 0003's text-resize commitment). At 320px tall
  // this renders the COMPACT layout (Story 11): a status column, not a top row.
  await page.setViewportSize(VIEWPORT_658);
  await page.goto('/');
  expect(page.viewportSize()).toEqual(VIEWPORT_658);
  expect(await page.evaluate(() => matchMedia('(max-height: 500px)').matches)).toBe(true);

  // Banner-absent board floor at 100% zoom, BEFORE the zoom is applied (P1's pinned gates;
  // P3 adds a separate, lower gate for the banner-present pre-start state).
  const base = await projectedGrid(page);
  expect(base.cellPx, `cellPx ${base.cellPx} below the 12px floor`).toBeGreaterThanOrEqual(12);
  expect(base.height / VIEWPORT_658.height).toBeGreaterThanOrEqual(0.85);

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

  // The CHIPS LIST is the scrollport now that the Dock shares the status header (Story 11's
  // contract §1): at 200% the four chips overflow the `flex: 1` column it gets, so it must
  // scroll internally rather than push the Dock (or the board) out of the layout.
  expect(await overflowsInternally('.wy-hud'), '.wy-hud should scroll internally').toBe(true);

  // ...and it is keyboard-operable, not pointer-only: focus the scrollport itself, press an
  // arrow key, and assert ITS OWN scrollTop moved (a page-level scroll or an ancestor
  // scrolling instead would leave this at 0), with the last chip then reachable.
  const hud = page.locator('.wy-hud');
  await hud.focus();
  await expect(hud).toBeFocused();
  expect(await hud.evaluate((el) => el.scrollTop)).toBe(0);
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => hud.evaluate((el) => el.scrollTop), {
      message: 'the chips scrollport should scroll on an arrow key',
    })
    .toBeGreaterThan(0);
  const lastChip = page.locator('.wy-hud > .wy-chip:not([hidden])').last();
  await lastChip.scrollIntoViewIfNeeded();
  await expect(lastChip).toBeInViewport();

  // The vw-capped column and rail (contract §2) keep the board playable at 200%: the column
  // resolves to ~66px (10vw, not 4rem = 128px) and the rail to ~184px (28vw, not 9rem =
  // 288px), leaving a ~408px-wide stage — so the 28×24 grid lands at cellPx 13 → 364×312.
  // The floors below sit just under those, and bite the moment a cap is dropped.
  const zoomed = await projectedGrid(page);
  expect(zoomed.cellPx, `cellPx ${zoomed.cellPx} below the 12px floor`).toBeGreaterThanOrEqual(12);
  expect(zoomed.width, `grid width ${zoomed.width}px below the 336px floor`).toBeGreaterThanOrEqual(
    336,
  );
  expect(
    zoomed.height,
    `grid height ${zoomed.height}px below the 288px floor`,
  ).toBeGreaterThanOrEqual(288);

  // Every Dock control stays reachable at 200% inside the bounded column, and the region
  // relation table still holds (banner row absent in P1).
  for (const name of ['Speed: 1x', 'Settings', 'Start']) {
    const btn = page.getByRole('button', { name });
    await btn.scrollIntoViewIfNeeded();
    await btn.focus();
    await expect(btn).toBeFocused();
    await expect(btn).toBeInViewport();
  }
  await assertDeclaredRegions(page);
  await assertRegionRelations(page, 'compact');

  // Rail: arm the Card so the Panel opens with its Close button as the Rail's last
  // control at 200% zoom — the Rail's content now overflows, so it must scroll internally
  // AND focusing that Close button must scroll it into `.wy-rail`'s own scrollport rather
  // than leaving it clipped off-screen.
  await page.getByRole('button', { name: /Basic Tower/ }).click();
  // The Panel renders on the next animation frame after arming — wait for it before
  // measuring rail overflow, or the assertion races the render under parallel load.
  await expect(page.locator('.wy-panel')).toBeVisible();
  expect(await overflowsInternally('.wy-rail'), '.wy-rail should scroll internally').toBe(true);
  const panelClose = page.locator('.wy-panel').getByRole('button', { name: 'Close panel' });
  await panelClose.scrollIntoViewIfNeeded();
  await panelClose.focus();
  await expect(panelClose).toBeFocused();
  await expect(panelClose).toBeInViewport();

  // Settings: the dialog overflows at 200% and scrolls internally; the same reachability
  // proof for its own scrollport follows.
  await page.getByRole('button', { name: 'Settings' }).click();
  expect(await overflowsInternally('.wy-settings'), '.wy-settings should scroll internally').toBe(
    true,
  );
  const lastRebind = page.getByRole('button', { name: 'Rebind Arm basic tower' });
  await lastRebind.scrollIntoViewIfNeeded();
  await lastRebind.focus();
  await expect(lastRebind).toBeFocused();
  await expect(lastRebind).toBeInViewport();
  await page.keyboard.press('Escape');
});
