import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createProjection } from '@wynding/render';
import { assertRenderedContrast } from './contrast';
import { callWavePaced, titleAfterCall } from './paced-call';
import {
  assertDeclaredRegions,
  assertRegionRelations,
  GRID,
  projectedGrid,
  regionRect,
} from './layout-probe';
import { firePrompt, installPromptFactory, promptCallCount, stubIosPlatform } from './install-stub';
import { fullscreenCallCount, stubFullscreen } from './fullscreen-stub';

/** The smallest supported landscape viewport (the Galaxy S9+ landscape profile) — Compact
 *  after Story 11, and the size every pinned board-floor gate is derived against. */
const VIEWPORT_658 = { width: 658, height: 320 };

/** A representative small PORTRAIT phone viewport — tall enough to render Standard (the
 *  Compact trigger is `max-height: 500px`), so it gates the horizontal status header. */
const VIEWPORT_360 = { width: 360, height: 640 };

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
  // The Rail's Cards (PLAN.md P2, M2-S3/M2-S4a/M2-S6: one per catalog tower) — unarmed at load.
  await expect(page.locator('.wy-card')).toHaveCount(9); // M2-S10 appends `frost-splash`
  for (const c of await page.locator('.wy-card').all()) {
    await expect(c).toBeVisible();
    await expect(c).toHaveAttribute('aria-pressed', 'false');
  }
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
  await expect(instructions).toContainText('Add to Home Screen');
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

// #98/#115: the exact "can't sell mid-run" report — a player arms a Card while a tower is
// already on the board, then clicks that tower meaning to inspect/sell it, and the OLD
// behavior read it as an occupied-cell placement attempt and rejected it, leaving Sell
// unreachable without first disarming by hand. #115's ruling: a direct press on an
// EXISTING tower's footprint always reads as inspect intent, armed or not — the Card
// disarms, the tower selects, and Sell is immediately available. Exercised MID-RUN (sim
// actually stepping, not the static pre-start board), since that's the report's own
// context.
test('#115/#98: mid-run, arming a Card then clicking your OWN tower disarms and selects it — Sell stays reachable, never blocked by an armed Card', async ({
  page,
}) => {
  await page.goto('/');
  const board = page.locator('.wy-board');
  const card = page.getByRole('button', { name: /Basic Tower/ });
  const panel = page.locator('.wy-panel');

  // Place a tower pre-start via the keyboard cursor at (3,3) — smoke.spec's well-known
  // buildable cell, the same arrow walk used throughout this file.
  await card.click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: /^Sell/ })).toBeVisible();
  await page.keyboard.press('Escape'); // deselect — a clean slate before Start
  await expect(panel).toBeHidden();

  // Start the run and let the sim actually step — the report was specifically MID-RUN
  // (creeps live, HUD refreshing), not the static pre-start board.
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(board).toHaveAttribute('data-started', 'true');
  await expect
    .poll(async () => Number(await board.getAttribute('data-sim-tick')))
    .toBeGreaterThan(5);

  // Arm the Card (a genuine "about to build" state) and click the tower already on the
  // board, via a real mouse click at its projected cell — the pointer-intent path, the
  // one #98 actually reported.
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');

  const box = (await board.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const projection = createProjection({
    cols: GRID.cols,
    rows: GRID.rows,
    cssWidth: box.width,
    cssHeight: box.height,
    dpr: 1,
  });
  const cell = projection.cellToPixel(3, 3);
  await page.mouse.click(
    box.x + cell.x + projection.cellPx / 2,
    box.y + cell.y + projection.cellPx / 2,
  );

  await expect(card).toHaveAttribute('aria-pressed', 'false'); // #115: disarmed, never rejected
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Sell/ })).toBeVisible(); // Sell reachable mid-run
});

test('the second Card (M2-S3): arms Slow Tower by click AND by Digit2, places it, and the 3-card Rail is axe-clean', async ({
  page,
}) => {
  await page.goto('/');
  const slowCard = page.getByRole('button', { name: /Slow Tower/ });
  const board = page.locator('.wy-board');
  const panel = page.locator('.wy-panel');

  // Click-arm.
  await expect(panel).toBeHidden();
  await slowCard.click();
  await expect(slowCard).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('Slow Tower');
  await expect(board).toBeFocused();

  // axe with the 3-card Rail, one card armed.
  const armedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(armedAudit.violations, JSON.stringify(armedAudit.violations, null, 2)).toEqual([]);

  await slowCard.click(); // disarm — back to a clean slate for the hotkey path
  await expect(slowCard).toHaveAttribute('aria-pressed', 'false');

  // Digit2 (armTower2's default binding) arms from document scope, exactly like Digit1
  // arms the basic Card.
  await page.keyboard.press('Digit2');
  await expect(slowCard).toHaveAttribute('aria-pressed', 'true');
  await expect(board).toBeFocused();

  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(slowCard).toHaveAttribute('aria-pressed', 'false'); // placement disarms
  await expect(panel).toContainText('Slow Tower'); // now selected

  // axe with the just-placed slow tower selected (Sell + Upgrade row).
  const selectedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(selectedAudit.violations, JSON.stringify(selectedAudit.violations, null, 2)).toEqual([]);
});

// M2-S4a step 15: the blast ring + radius preview are DECORATIVE canvas-only cues (outcomes
// stay carried by HP pips, per the Tracer/Blast glossary entries), so axe cannot see them at
// all — the a11y obligation here is text (the Panel's `panel.blastRadius` row) plus reduced-
// motion compliance, never ring-only. The ring's own geometry/reduced-motion damping is NOT
// unit-tested anywhere (QC round-1 #8 — a prior version of this comment wrongly pointed to
// `tower-paint.test.ts`/`creep-paint.test.ts`, which cover only id→shape maps; no test in
// `packages/render` imports `scene.ts` at all — it stays coverage-excluded by long-standing
// convention, per `docs/accessibility-checklist.md`'s own honest closing line). This e2e
// proves the DOM-visible half: the Card/Panel/hotkey surface stays fully functional and
// axe-clean for valid placement, invalid (border-blocked) placement, AND under reduced motion.
test('the third Card (M2-S4a): arms Splash Tower by click AND by Digit3, labels its blast radius as TEXT, and stays axe-clean for valid + invalid placement', async ({
  page,
}) => {
  await page.goto('/');
  // Anchored at the start: M2-S10's `frost-splash` Card is named "Frost Splash Tower",
  // which an unanchored /Splash Tower/ would also match (strict-mode violation).
  const splashCard = page.getByRole('button', { name: /^Splash Tower/ });
  const board = page.locator('.wy-board');
  const panel = page.locator('.wy-panel');

  // Click-arm.
  await expect(panel).toBeHidden();
  await splashCard.click();
  await expect(splashCard).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('Splash Tower');
  // The blast radius is labelled as TEXT, alongside the range stat every tower already
  // shows — never ring-only (PLAN.md step 14/15's a11y obligation).
  await expect(panel).toContainText('Blast radius:');
  await expect(panel).toContainText('Range:');
  await expect(board).toBeFocused();

  // axe with the 3-card Rail, the third Card armed.
  const armedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(armedAudit.violations, JSON.stringify(armedAudit.violations, null, 2)).toEqual([]);

  await splashCard.click(); // disarm — back to a clean slate for the hotkey path
  await expect(splashCard).toHaveAttribute('aria-pressed', 'false');

  // Digit3 (armTower3's default binding) arms from document scope, exactly like Digit1/
  // Digit2 arm the first two Cards.
  await page.keyboard.press('Digit3');
  await expect(splashCard).toHaveAttribute('aria-pressed', 'true');
  await expect(board).toBeFocused();

  // VALID placement, via the keyboard cursor.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(splashCard).toHaveAttribute('aria-pressed', 'false'); // placement disarms
  await expect(panel).toContainText('Splash Tower'); // now selected
  await expect(panel).toContainText('Blast radius:');

  const selectedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(selectedAudit.violations, JSON.stringify(selectedAudit.violations, null, 2)).toEqual([]);

  // #115 ruling: keyboard CONFIRM (Enter) on an EXISTING TOWER's cell disarms-and-selects,
  // exactly like a click — no rejection. The cursor still sits on the just-placed anchor
  // (placement leaves it there — the pre-#115 version of this flow leaned on that same
  // invariant for its occupied rejection), so re-arm and confirm IN PLACE: no walk, no
  // geometry assumption.
  await page.keyboard.press('Digit3');
  await page.keyboard.press('Enter');
  await expect(splashCard).toHaveAttribute('aria-pressed', 'false'); // #115: inspect, not reject
  await expect(panel).toContainText('Splash Tower'); // selects the same tower

  const inspectAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(inspectAudit.violations, JSON.stringify(inspectAudit.violations, null, 2)).toEqual([]);

  // Rejection coverage stays, on an honest NON-tower blocker: clamp-walk the cursor into
  // the blocked border corner — 30 presses each way over-walk both board dimensions, so
  // the landing cell is (0,0) no matter where the cursor sat (a fixed step count toward a
  // named row proved false against the real cursor geometry: the first cut of this
  // retarget landed on buildable ground and PLACED). Border cells are blocked terrain and
  // can never hold a tower, so Enter here is a genuine rejection: invalid ghost, still
  // armed (#115 keeps every non-tower rejection).
  await page.keyboard.press('Digit3'); // re-arm (the inspect above disarmed)
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(splashCard).toHaveAttribute('aria-pressed', 'true'); // rejected — still armed

  const invalidAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(invalidAudit.violations, JSON.stringify(invalidAudit.violations, null, 2)).toEqual([]);
});

test('the Splash Tower ghost + blast-radius preview stay functional and axe-clean under reduced motion (M2-S4a step 15)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Reduce motion').check();
  await page.getByRole('button', { name: 'Close' }).click();

  // Anchored (see the third-Card test above): unanchored /Splash Tower/ also matches
  // M2-S10's "Frost Splash Tower" Card.
  const splashCard = page.getByRole('button', { name: /^Splash Tower/ });
  await splashCard.click();
  await expect(splashCard).toHaveAttribute('aria-pressed', 'true');

  // Aim the board so the ghost (with its damped, shape-distinct blast-radius ring) is
  // drawn on the canvas — decorative, out of axe's scope (ADR 0003 §3); this proves the
  // DOM-visible flow doesn't regress with the setting on. The ring's own reduced-motion
  // damping has NO unit-test coverage (QC round-1 #8 — `scene.ts` stays coverage-excluded
  // by long-standing convention, not meaningfully testable under jsdom); this e2e pass is
  // the only place the setting is exercised end-to-end, and it verifies DOM/axe stability
  // only, never the ring's own pixels.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');

  const audit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(audit.violations, JSON.stringify(audit.violations, null, 2)).toEqual([]);
});

// M2-S5a step 31/33: `venom` adds a `dot` effect (armor-bypassing damage-over-time) and a
// footprint mark distinct from `basic`/`slow`/`splash`. The DoT telegraph (three pips +
// drift, on a poisoned creep) and the footprint's droplet mark are canvas-only cues that
// are AXE-INVISIBLE, which is not the same as decorative: `docs/accessibility-checklist.md`
// records that the decorative-by-analogy reading was reviewed and REJECTED (PLAN.md step 32
// corrected it) — HP pips show damage already taken, a DoT record is damage already
// SCHEDULED, so the shape cue carries information no other canvas surface does. It is
// ESSENTIAL to draw, and merely not essential for axe, because the underlying
// scheduled-damage FACT is also readable as the Panel's `panel.dot` text row below, so
// axe cannot see the canvas cues at all — same posture the blast ring/crosshair preview
// already established (M2-S4a). This e2e proves the DOM-visible half: the Card/Panel/
// hotkey surface stays fully functional and axe-clean for valid + invalid placement.
test('the fourth Card (M2-S5a): arms Venom Tower by click AND by Digit4, labels its DoT stat as TEXT, and stays axe-clean for valid + invalid placement', async ({
  page,
}) => {
  await page.goto('/');
  const venomCard = page.getByRole('button', { name: /Venom Tower/ });
  const board = page.locator('.wy-board');
  const panel = page.locator('.wy-panel');

  // Click-arm.
  await expect(panel).toBeHidden();
  await venomCard.click();
  await expect(venomCard).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('Venom Tower');
  // The DoT is labelled as TEXT, alongside the range stat every tower already shows —
  // never telegraph-only (PLAN.md step 31/32's a11y obligation): magnitude, cadence, and
  // duration all read out (`panel.dot`, mirrored exactly from `overlay.test.ts`).
  await expect(panel).toContainText('Poison: 4 damage every 0.5s for 3.0s');
  await expect(panel).toContainText('Range:');
  await expect(board).toBeFocused();

  // axe with the 4-card Rail, the fourth Card armed.
  const armedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(armedAudit.violations, JSON.stringify(armedAudit.violations, null, 2)).toEqual([]);

  await venomCard.click(); // disarm — back to a clean slate for the hotkey path
  await expect(venomCard).toHaveAttribute('aria-pressed', 'false');

  // Digit4 (armTower4's default binding) arms from document scope, exactly like
  // Digit1/2/3 arm the first three Cards.
  await page.keyboard.press('Digit4');
  await expect(venomCard).toHaveAttribute('aria-pressed', 'true');
  await expect(board).toBeFocused();

  // VALID placement, via the keyboard cursor.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(venomCard).toHaveAttribute('aria-pressed', 'false'); // placement disarms
  await expect(panel).toContainText('Venom Tower'); // now selected
  await expect(panel).toContainText('Poison: 4 damage every 0.5s for 3.0s');

  const selectedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(selectedAudit.violations, JSON.stringify(selectedAudit.violations, null, 2)).toEqual([]);

  // #115 ruling: keyboard CONFIRM (Enter) on an EXISTING TOWER's cell disarms-and-selects,
  // exactly like a click — no rejection. The cursor still sits on the just-placed anchor
  // (placement leaves it there), so re-arm and confirm IN PLACE — no walk, no geometry
  // assumption (see the Splash flow's comment for why a fixed walk proved false).
  await page.keyboard.press('Digit4');
  await page.keyboard.press('Enter');
  await expect(venomCard).toHaveAttribute('aria-pressed', 'false'); // #115: inspect, not reject
  await expect(panel).toContainText('Venom Tower'); // selects the same tower

  const inspectAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(inspectAudit.violations, JSON.stringify(inspectAudit.violations, null, 2)).toEqual([]);

  // Rejection coverage stays, on an honest NON-tower blocker: clamp into the blocked
  // border corner (0,0) — deterministic regardless of where the cursor sat; border cells
  // can never hold a tower.
  await page.keyboard.press('Digit4'); // re-arm (the inspect above disarmed)
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(venomCard).toHaveAttribute('aria-pressed', 'true'); // rejected — still armed

  const invalidAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(invalidAudit.violations, JSON.stringify(invalidAudit.violations, null, 2)).toEqual([]);
});

test('the seventh Card (M2-S8): arms Beacon by click AND by Digit7, OMITS the four attack stat rows entirely, states its Support row as TEXT, and stays axe-clean', async ({
  page,
}) => {
  // Every prior tower shipped its own spec here; the beacon needs one more than most,
  // because its Panel is the first in this app's history to OMIT rows rather than add
  // them — the story's headline a11y claim — and an omitted-region shape is exactly what
  // can satisfy a jsdom `textContent` assertion while producing an empty or mis-labelled
  // node in a real accessibility tree. `overlay.test.ts` covers the strings; only this
  // covers them in a real browser, through axe.
  await page.goto('/');
  const beaconCard = page.getByRole('button', { name: /Beacon/ });
  const board = page.locator('.wy-board');
  const panel = page.locator('.wy-panel');

  // Click-arm.
  await expect(panel).toBeHidden();
  await beaconCard.click();
  await expect(beaconCard).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('Beacon');
  await expect(panel).toContainText('Cost: 15');
  // The aura's magnitude is TEXT, and it is the ONLY non-canvas carrier of what this
  // tower does — the shell and the recipient mark are both canvas-only.
  await expect(panel).toContainText('Support: +50.0% damage to towers sharing a full edge');
  // ... and the four attack rows are ABSENT, not zeroed. Asserted on the LABELS: a beacon
  // rendered as "Damage: 0 / Range: 0.0 tiles / Fire rate: 20.0/s / Targets: Ground" would
  // be four false statements about a tower with none of those properties, and would still
  // satisfy a "contains Support" check.
  await expect(panel).not.toContainText('Damage');
  await expect(panel).not.toContainText('Range');
  await expect(panel).not.toContainText('Fire rate');
  await expect(panel).not.toContainText('Targets');
  await expect(board).toBeFocused();

  // axe with the 7-card Rail, the seventh Card armed — the omitted-row Panel is the new
  // DOM shape being audited here.
  const armedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(armedAudit.violations, JSON.stringify(armedAudit.violations, null, 2)).toEqual([]);

  await beaconCard.click(); // disarm — clean slate for the hotkey path
  await expect(beaconCard).toHaveAttribute('aria-pressed', 'false');

  // Digit7 (armTower7's default binding) arms from document scope, exactly like Digit1-6
  // arm the first six Cards. No keymap change was needed — nine slots already existed.
  await page.keyboard.press('Digit7');
  await expect(beaconCard).toHaveAttribute('aria-pressed', 'true');
  await expect(board).toBeFocused();

  // VALID placement via the keyboard cursor — the same route the fourth-Card spec walks.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(beaconCard).toHaveAttribute('aria-pressed', 'false'); // placement disarms
  await expect(panel).toContainText('Beacon'); // now selected
  await expect(panel).toContainText('Support: +50.0% damage to towers sharing a full edge');
  // A SELECTED beacon still omits the four rows — the selection path builds its stats
  // through the same `towerStats` call, and this is the path a player reaches by clicking
  // a tower they already own.
  await expect(panel).not.toContainText('Fire rate');

  const selectedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(selectedAudit.violations, JSON.stringify(selectedAudit.violations, null, 2)).toEqual([]);

  // #115 ruling: keyboard CONFIRM (Enter) on an EXISTING TOWER's cell disarms-and-selects,
  // exactly like a click — no rejection. The cursor still sits on the just-placed anchor
  // (placement leaves it there), so re-arm and confirm IN PLACE — no walk, no geometry
  // assumption (see the Splash flow's comment for why a fixed walk proved false).
  await page.keyboard.press('Digit7');
  await page.keyboard.press('Enter');
  await expect(beaconCard).toHaveAttribute('aria-pressed', 'false'); // #115: inspect, not reject
  await expect(panel).toContainText('Beacon'); // selects the same tower

  const inspectAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(inspectAudit.violations, JSON.stringify(inspectAudit.violations, null, 2)).toEqual([]);

  // Rejection coverage stays, on an honest NON-tower blocker: clamp into the blocked
  // border corner (0,0) — deterministic regardless of where the cursor sat; border cells
  // can never hold a tower.
  await page.keyboard.press('Digit7'); // re-arm (the inspect above disarmed)
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(beaconCard).toHaveAttribute('aria-pressed', 'true'); // rejected — still armed

  const invalidAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(invalidAudit.violations, JSON.stringify(invalidAudit.violations, null, 2)).toEqual([]);
});

test('the Venom Tower ghost stays functional and axe-clean under reduced motion, and a live run with an Armored Creep on the board (its hexagon silhouette + wave-4 preview text) is axe-clean (M2-S5a steps 31/32/36)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Reduce motion').check();
  await page.getByRole('button', { name: 'Close' }).click();

  const venomCard = page.getByRole('button', { name: /Venom Tower/ });
  await venomCard.click();
  await expect(venomCard).toHaveAttribute('aria-pressed', 'true');

  // Aim the board so the ghost is drawn on the canvas — decorative, out of axe's scope
  // (ADR 0003 §3); this proves the DOM-visible flow doesn't regress with the setting on.
  // The DoT telegraph's own reduced-motion damping is unit-tested at source
  // (`creep-paint.test.ts`), not here — `scene.ts` stays coverage-excluded by
  // long-standing convention (not meaningfully testable under jsdom).
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter'); // place it — commits the venom tower to the board

  const armedAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(armedAudit.violations, JSON.stringify(armedAudit.violations, null, 2)).toEqual([]);

  // Start unholds the run — the Dock's primary control morphs from "Start" to
  // "Call wave" (M2-S2's decouple), which is what makes early-calling waves 1..4 below
  // possible.
  await page.getByRole('button', { name: 'Start' }).click();

  // Early-call through to wave 4 (M2-S5a's `armored` creep — a hexagon silhouette on
  // canvas, out of axe's scope, but its wave-preview composition IS a DOM/AT surface:
  // `armor 6`, never `armor 0`, now that a wave actually carries a nonzero-armor creep
  // — PLAN.md step 36's "preview's now-nonzero armor text").
  const callWave = page.getByRole('button', { name: 'Call wave' });
  const preview = page.locator('.wy-wave-preview');
  for (let waveNumber = 1; waveNumber <= 3; waveNumber++) await callWave.click();
  // M2-S11: the bundle now carries ten waves — the armored wave is wave 4 of 10, not
  // wave 4 of 4.
  await expect(preview.locator('.wy-wave-preview-title')).toHaveText('Wave 4 of 10');
  await expect(preview.locator('li')).toHaveText([
    '6 × Armored Creep — ground, armor 6, leak cost 1, no immunities',
  ]);

  const previewAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(previewAudit.violations, JSON.stringify(previewAudit.violations, null, 2)).toEqual([]);

  // Call wave 4 and let the (reduced-motion, axe-invisible) poisoned telegraph + hexagon
  // silhouette actually render for a moment on canvas — proving the live-run DOM stays
  // axe-clean with an armored, poisoned creep on the board, not merely the wave preview.
  await callWave.click();
  await page.waitForTimeout(1000);

  const liveAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(liveAudit.violations, JSON.stringify(liveAudit.violations, null, 2)).toEqual([]);
});

test('supports player-started runs, pause / speed controls, early-calls all ten waves with the preview checked before each, and reaches a result', async ({
  page,
}) => {
  // Above the sum of this test's own declared worst-case budgets — ten paced calls
  // carrying a 5s in-page deadline each (paced-call.ts) plus the 60s results wait — so
  // a pathological run dies at the stage that owns it, with that stage's named
  // diagnostic, never as an anonymous whole-test timeout mid-budget (CodeRabbit #117).
  test.setTimeout(150_000);
  await page.goto('/');

  // Pre-start (PLAN.md P4 + Story 11's wave-slot states, decoupled further at M2-S2): the
  // wave chip is countdown-only and now VISIBLE pre-start too (the sim's real
  // `countdownRemaining` is meaningful before Start — five visible chips; Pause hidden.
  const waveChip = page.locator('.wy-chip[data-wy-chip="wave"]');
  await expect(waveChip).toBeVisible();
  await expect(page.locator('.wy-hud > .wy-chip:not([hidden])')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeHidden();

  // The wave preview is its OWN visible surface (never chip-hosted) and already shows wave
  // 1's composition pre-start — the shipped bundle's single creep kind.
  const preview = page.locator('.wy-wave-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('.wy-wave-preview-title')).toHaveText('Wave 1 of 10');
  await expect(preview.locator('li')).toHaveText([
    '10 × Creep — ground, armor 0, leak cost 1, no immunities',
  ]);

  // axe audit with the wave preview visible (PLAN.md P3 step 19) — the preview is a real
  // DOM surface (never chip-hosted), so it's in scope for the standard audit like every
  // other HUD content.
  const previewAudit = await new AxeBuilder({ page }).include('#app').analyze();
  expect(previewAudit.violations, JSON.stringify(previewAudit.violations, null, 2)).toEqual([]);

  // Start no longer claims wave 1 (M2-S2's decouple) — it unholds the run, and the primary
  // Dock control MORPHS to "Call wave" rather than hiding.
  const primary = page.locator('.wy-dock .wy-primary');
  const start = page.getByRole('button', { name: 'Start' });
  await start.click();
  // The SAME element stays visible and re-labels — it does not hide (M2-S2's morph).
  await expect(primary).toHaveCount(1);
  await expect(primary).toBeVisible();
  const callWave = page.getByRole('button', { name: 'Call wave' });
  await expect(callWave).toBeVisible();

  const pause = page.getByRole('button', { name: 'Pause' });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();

  // Run at 2× so the undefended loss resolves well within the timeout regardless of
  // CI runner speed.
  await page.getByRole('button', { name: /^Speed:/ }).click();

  // #97: enter the marathon loop PAUSED. Free-running at 2× while each iteration below
  // does composition asserts stretched the inter-call gaps on lagged runners until the
  // run LOST around wave 8–9 with calls still outstanding (the recurring a11y-job red).
  // Every per-wave assert now runs against a frozen sim; `callWavePaced` opens the only
  // windows in which it advances.
  await page.getByRole('button', { name: 'Pause' }).click();

  // Early-call every wave via the morphed primary control, checking the preview shows the
  // CORRECT upcoming wave before each call (PLAN.md P3 step 19) — per-wave, since wave 2
  // is M2-S4a's DISTINCT swarm-creep composition and wave 3 is M2-S3's DISTINCT
  // fast-creep composition (only wave 1 stays the single normal-creep kind).
  // M2-S6 P5 appended a `resolute`+`fast` multi-entry wave — the FIRST multi-entry wave
  // this spec exercises, so its composition is an array of two `<li>` texts (authored
  // order: `resolute` then `fast`), not a single string like every wave before it. M2-S7
  // P6 appended an AIR wave, so its row reads `air`, not `ground`. M2-S10 appended an
  // `armored-flyer` wave and the boss wave, closing out the (then eight-wave) bundle with
  // a `boss` entry ahead of a final `creep` swarm. M2-S11 (P1) inserts two further waves —
  // a second `normal`+`swarm` wave ahead of the air waves, and the arc's densest tick, a
  // FOUR-entry wave (`swarm`+`fast`+`armored`+`flying`) — taking the bundle to ten waves
  // and reordering `flying` ahead of `resolute`+`fast`.
  const EXPECTED_COMPOSITION: Record<number, string[]> = {
    1: ['10 × Creep — ground, armor 0, leak cost 1, no immunities'],
    2: ['16 × Swarm Creep — ground, armor 0, leak cost 1, no immunities'],
    3: ['8 × Fast Creep — ground, armor 0, leak cost 1, no immunities'],
    4: ['6 × Armored Creep — ground, armor 6, leak cost 1, no immunities'],
    5: [
      '12 × Creep — ground, armor 0, leak cost 1, no immunities',
      '6 × Swarm Creep — ground, armor 0, leak cost 1, no immunities',
    ],
    6: ['8 × Flying Creep — air, armor 0, leak cost 1, no immunities'],
    7: [
      '6 × Resolute Creep — ground, armor 0, leak cost 1, slow',
      '6 × Fast Creep — ground, armor 0, leak cost 1, no immunities',
    ],
    8: ['6 × Armored Flyer — air, armor 5, leak cost 1, no immunities'],
    9: [
      '10 × Swarm Creep — ground, armor 0, leak cost 1, no immunities',
      '6 × Fast Creep — ground, armor 0, leak cost 1, no immunities',
      '4 × Armored Creep — ground, armor 6, leak cost 1, no immunities',
      '4 × Flying Creep — air, armor 0, leak cost 1, no immunities',
    ],
    10: [
      '1 × Boss — ground, armor 8, leak cost 3, stun',
      '8 × Creep — ground, armor 0, leak cost 1, no immunities',
    ],
  };
  for (let waveNumber = 1; waveNumber <= 10; waveNumber++) {
    await expect(preview.locator('.wy-wave-preview-title')).toHaveText(`Wave ${waveNumber} of 10`);
    await expect(preview.locator('li')).toHaveText(EXPECTED_COMPOSITION[waveNumber]!);
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  // Every wave has launched: the preview's explicit last-wave marker, and the control is
  // visible-disabled (never hidden — it hides only at terminal).
  await expect(preview.locator('.wy-wave-preview-title')).toHaveText(
    'Final wave launched — no more waves to call',
  );
  await expect(preview.locator('li')).toHaveCount(0);
  await expect(callWave).toBeVisible();
  await expect(callWave).toHaveAttribute('aria-disabled', 'true');

  // The loop exits paused (callWavePaced's contract) — release the run so it can stream
  // to its terminal. Wider window than the free-running spec's old 40s: pacing froze
  // traversal between calls, so resolution now covers essentially the whole undefended
  // march, not just its tail.
  await page.getByRole('button', { name: 'Resume' }).click();

  // The run resolves; the results dialog appears with a Play-again + Verify affordance.
  const results = page.getByRole('dialog');
  await expect(results).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Verify this run' })).toBeVisible();

  // axe audit of the results-dialog state — the settings-panel state is covered by the
  // other test; this closes the gap where the dialog was never scanned. The wave preview
  // is gone once terminal (its own axe coverage is the pre-terminal audit below).
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
  // again — including the wave preview going back to wave 1 of 10 (M2-S11).
  await expect(waveChip).toBeVisible();
  await expect(preview.locator('.wy-wave-preview-title')).toHaveText('Wave 1 of 10');
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
  // The run did start — the primary control morphs to "Call wave" rather than hiding.
  await expect(page.getByRole('button', { name: 'Call wave' })).toBeVisible();
  // The stub's sentinel must actually be installed — otherwise `fullscreenCallCount` returns
  // its `?? 0` fallback and a broken/unapplied stub would satisfy the `toBe(0)` below
  // vacuously, hiding a real regression where fullscreen WAS requested.
  expect(await page.evaluate(() => typeof window.__wyFullscreenCalls)).toBe('number');
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

  // The last rebind row (armTower3, GAME_ACTIONS' last entry as of M2-S4a — the
  // last-entry pin moved from armTower1 at M2-S3, then armTower2 to armTower3 here) —
  // reachable and visible within the dialog's own scrollport before it closes.
  const lastRebind = page.getByRole('button', { name: 'Rebind Arm tower 3' });
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
  const lastRebind = page.getByRole('button', { name: 'Rebind Arm tower 2' });
  await lastRebind.scrollIntoViewIfNeeded();
  await lastRebind.focus();
  await expect(lastRebind).toBeFocused();
  await expect(lastRebind).toBeInViewport();
  await page.keyboard.press('Escape');
});

test('200% text zoom on the Standard layout (360×640): the status row stays inside its 40dvh bound and the board keeps a playable floor', async ({
  page,
}) => {
  // The Compact gate above pins the short-landscape case; this is its Standard twin — the
  // layout where the status row is a horizontal header, so the wordmark, the wrapped row
  // gap and the row's padding sit OUTSIDE `.wy-hud`'s cap and have to be inside the same
  // 40dvh budget (ADR 0003). Without that, the row grows unbounded at 200% and squeezes
  // the board even though the chips scrollport itself is capped.
  await page.setViewportSize(VIEWPORT_360);
  await page.goto('/');
  expect(await page.evaluate(() => matchMedia('(max-height: 500px)').matches)).toBe(false);

  await page.addStyleTag({ content: ':root { font-size: 200% }' });

  // The bound is on the ROW, not just the scrollport: measure `.wy-status`'s own box.
  // 1px of tolerance for sub-pixel layout rounding.
  const statusHeight = await page
    .locator('.wy-status')
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(
    statusHeight,
    `.wy-status ${statusHeight}px exceeds the 40dvh bound (${VIEWPORT_360.height * 0.4}px)`,
  ).toBeLessThanOrEqual(VIEWPORT_360.height * 0.4 + 1);

  // ...and the content that no longer fits scrolls inside the chips list rather than
  // clipping (the ADR 0003 doctrine — same proof as the Compact gate).
  expect(
    await page.locator('.wy-hud').evaluate((el) => el.scrollHeight > el.clientHeight),
    '.wy-hud should scroll internally',
  ).toBe(true);
  const lastChip = page.locator('.wy-hud > .wy-chip:not([hidden])').last();
  await lastChip.scrollIntoViewIfNeeded();
  await expect(lastChip).toBeInViewport();

  // What the bound buys: the Stage keeps the VERTICAL space the status row would otherwise
  // eat.
  const stage = await regionRect(page, 'stage');
  expect(stage, 'the stage region must be present').not.toBeNull();
  const stageHeight = (stage as { height: number }).height;
  expect(
    stageHeight / VIEWPORT_360.height,
    `stage height ${stageHeight}px below the 50% floor`,
  ).toBeGreaterThanOrEqual(0.5);

  // ...and the vw-capped Rail keeps the HORIZONTAL space: at 360px wide the rail resolves
  // to ~101px (28vw, not 9rem = 288px), so the stage keeps ~259px and the 28×24 grid still
  // projects a playable cellPx. Both floors sit just under that and bite the moment the
  // rail's vw cap is dropped.
  const stageWidth = (stage as { width: number }).width;
  expect(stageWidth, `stage width ${stageWidth}px below the 240px floor`).toBeGreaterThanOrEqual(
    240,
  );
  const zoomedGrid = await projectedGrid(page);
  expect(
    zoomedGrid.cellPx,
    `cellPx ${zoomedGrid.cellPx} below the 8px floor`,
  ).toBeGreaterThanOrEqual(8);
  // The relation table still holds, with ONE zoom-specific allowance: the floating Dock's
  // controls are text-sized, so at 200% the cluster wraps into a band far taller than the
  // 64px it occupies at 100%. It stays a bottom-left overlay — it may not cover more of the
  // grid than the same 40dvh budget the status row is held to.
  await assertRegionRelations(page, 'standard', VIEWPORT_360.height * 0.4);
});
