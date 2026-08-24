import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { validate } from '@wynding/replay';
import { parseRulesetJson } from '@wynding/sim';
import { BUNDLED_ARTIFACT_URL } from '@wynding/content/artifact';

// playtrace.spec.ts — #133's headline claim, end to end: an export taken from the real
// results dialog, in a real browser, is a payload the REPLAY VALIDATOR accepts.
//
// The unit suite proves the payload shape and the round-trip against a controller run;
// what only a browser can prove is the half in between — that the dialog's secondary
// action, the clipboard, and JSON serialization deliver that payload intact to something
// outside the page. The validator here is the real one, imported into the spec and run in
// Node against the same bundled ruleset the page played.
//
// The ruleset comes through `@wynding/content/artifact` + `parseRulesetJson`, NOT through
// the registry's `getBundledRuleset`. That is the subpath's whole reason for existing
// (see its header): the registry embeds its artifact with a Vite-only `?raw` import, and
// Playwright's Node loader rejects it. This is the documented non-bundler path, and it
// parses the same bytes through the same validator, so the two loaders cannot disagree.

/** The shipped ruleset, read from disk the way any non-bundler consumer reads it. */
const bundledRuleset = parseRulesetJson(readFileSync(BUNDLED_ARTIFACT_URL, 'utf8'));

/** One playtrace run, as it comes back off the clipboard. */
interface ExportedRun {
  runId: string;
  seed: number;
  boardId: string;
  rulesetHash: string;
  simVersion: number;
  ticksCompleted: number;
  stateHash: string;
  tickInputs: Parameters<typeof validate>[0]['tickInputs'];
  pendingInputs: unknown[];
  pendingInputsTruncated: boolean;
  viewport: string;
  capturedAt: number;
}

/** The allowlist, restated at the far end of the wire. A field that reaches a clipboard
 *  is a field that reaches an issue tracker, so the ban is asserted here too and not only
 *  where the payload is built. */
const ALLOWED_FIELDS = [
  'boardId',
  'capturedAt',
  'pendingInputs',
  'pendingInputsTruncated',
  'rulesetHash',
  'runId',
  'seed',
  'simVersion',
  'stateHash',
  'tickInputs',
  'ticksCompleted',
  'viewport',
];

/** Drive an undefended run to its results dialog — `home.spec.ts`'s exact accelerator,
 *  reused rather than re-derived. Start claims wave 1 itself (#70), so the spec settles on
 *  the wave-2 preview and a call-ready control before early-calling wave 2; without that
 *  second call, wave 2's own countdown alone costs far longer than any sane wait. */
async function playToResults(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Start' }).click();
  const callWave = page.getByRole('button', { name: 'Call wave' });
  await expect(page.locator('.wy-wave-preview .wy-wave-preview-title')).toHaveText('Wave 2 of 10');
  await expect(callWave).toHaveAttribute('aria-disabled', 'false');
  await callWave.click();
  await expect(page.locator('.wy-results')).toBeVisible({ timeout: 60_000 });
}

test.describe('playtrace export (#133, ADR 0011)', () => {
  test.setTimeout(150_000);

  test('the results dialog exports a payload the replay validator accepts', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.locator('.wy-board')).toBeVisible();
    await playToResults(page);

    await page.getByRole('button', { name: 'Copy run data' }).click();
    // The announcement is the app's own proof the write resolved — reading the clipboard
    // before it lands is the flake this avoids.
    await expect(page.locator('.wy-results .wy-verify')).toHaveText(
      'Run data copied to the clipboard.',
    );

    const text = await page.evaluate(() => navigator.clipboard.readText());
    const payload = JSON.parse(text) as { playtraceVersion: number; runs: ExportedRun[] };
    expect(payload.playtraceVersion).toBe(1);
    expect(payload.runs).toHaveLength(1);

    const run = payload.runs[0]!;
    expect(Object.keys(run).sort()).toEqual(ALLOWED_FIELDS);
    expect(run.viewport).toBe('standard');
    expect(run.ticksCompleted).toBe(run.tickInputs.length);

    // THE ROUND TRIP. The exported envelope goes straight into the real validator.
    const result = validate(
      {
        seed: run.seed,
        boardId: run.boardId,
        rulesetHash: run.rulesetHash,
        simVersion: run.simVersion,
        tickInputs: run.tickInputs,
      },
      bundledRuleset,
    );
    expect(result.reason ?? '', 'the exported replay was rejected').toBe('');
    expect(result.ok).toBe(true);
  });

  test('the exported payload carries no settings, no keybindings and no device id', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.locator('.wy-board')).toBeVisible();
    // Set both accessibility settings first, so their absence below is a real exclusion
    // rather than a payload built before anything could have leaked into it.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Protanopia').check();
    await page.getByLabel('Reduce motion').check();
    await page.getByRole('button', { name: 'Close' }).click();

    await playToResults(page);
    await page.getByRole('button', { name: 'Copy run data' }).click();
    await expect(page.locator('.wy-results .wy-verify')).toHaveText(
      'Run data copied to the clipboard.',
    );

    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).not.toContain('protan');
    expect(text).not.toContain('reducedMotion');
    expect(text).not.toContain('colourMode');
    expect(text).not.toContain('deviceId');
    // And nothing left the device: the export is local, so no request was made.
    const stored = await page.evaluate(() => localStorage.getItem('wynding:playtrace'));
    expect(stored, 'local export must not write an opt-out or anything else').toBeNull();
  });
});
