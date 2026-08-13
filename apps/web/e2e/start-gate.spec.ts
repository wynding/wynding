import { test, expect } from '@playwright/test';
import { callWavePaced, titleAfterCall } from './paced-call';

// Player-started runs (PLAN.md P4/P6, decoupled further at M2-S2 P3 step 15): a fresh load
// is HELD at tick 0 — no wave has launched, and pre-start planning (build/sell) is fully
// available and presented as Pending. Space/speed must never un-hold; only Start does. The
// board carries plain test-hook attributes (`data-started`/`data-sim-tick`/
// `data-pending-adds`) so "held"/"frozen" are asserted directly instead of inferred from a
// short wait.
//
// #70 changes what Start proves here again: it now CLAIMS wave 1 as well as un-holding the
// run — pressing Start both flips `started` (gating `advance()`) AND buffers a
// `callWaveEarly` for wave 1, consumed on the very next tick. The sim's own `phase` still
// never flips on Start (only `won`/`lost` are distinct phases), so the observable proof of
// the claim is the wave preview flipping to "Wave 2 of 10" once that buffered call lands —
// this spec asserts that LAUNCH directly, alongside the wave-1 countdown movement
// `advance()`'s `started` gate still produces.

test('holds at tick 0 until Start, commits a Pending pre-start build, and Play-again re-holds', async ({
  page,
}) => {
  // Above the sum of this test's own declared worst-case budgets — nine paced calls
  // (#70: wave 1 now launches on Start itself, not through this loop) carrying a 5s
  // in-page deadline each (paced-call.ts) plus the 60s results wait — so a pathological
  // run dies at the stage that owns it, with that stage's named diagnostic, never as an
  // anonymous whole-test timeout mid-budget (CodeRabbit #117). The budget itself is
  // unchanged — #117 pinned it for the marathon's worst case and one fewer paced call
  // only widens the margin.
  test.setTimeout(150_000);
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
  // `data-pending-adds` returns to 0) — and wave 1 DOES launch (#70's claim-first
  // composition): the sim's phase stays `running` throughout (there is no flip to
  // assert), so the observable proof of "actually running now" is the wave-1 COUNTDOWN
  // moving, and the observable proof of the CLAIM is the preview flipping to wave 2.
  const start = page.getByRole('button', { name: 'Start' });
  const callWave = page.getByRole('button', { name: 'Call wave' });
  const previewTitle = page.locator('.wy-wave-preview .wy-wave-preview-title');
  const initialCountdown = (await waveChipText.textContent())!;
  await start.click();
  await expect(board).toHaveAttribute('data-started', 'true');
  await expect(board).not.toHaveAttribute('data-sim-tick', '0');
  await expect(board).toHaveAttribute('data-sim-phase', 'running'); // never flips — only won/lost do
  await expect(board).toHaveAttribute('data-pending-adds', '0');
  await expect(waveChipText).not.toHaveText(initialCountdown); // the countdown itself moved
  // Settle on wave 1's launch (buffered by the press, consumed on the next tick) before
  // any further activation — a same-tick Pause below would race that consumption, not
  // dedupe against it (Pause and Call wave are distinct controls), but this pins the
  // claim itself as a named assertion rather than an incidental side effect of the loop.
  // The settle window itself runs UNPAUSED — the claim can only be consumed by a real
  // tick, so it cannot be waited for under pause. Bounded, not unbounded: two awaited
  // assertions at 1x against ~450 ticks before this undefended run's first leak, so the
  // #97 lag class has orders of magnitude of headroom here even though this is, strictly,
  // a window the old same-tick Start->Pause did not have.
  await expect(previewTitle).toHaveText('Wave 2 of 10');
  await expect(callWave).toHaveAttribute('aria-disabled', 'false');

  // #97: enter the marathon loop PAUSED. An undefended run free-running at 2× while the
  // loop below does its per-wave assertion work loses around wave 8–9 on a lagged runner
  // (creeps leak in the stretched gaps), and at terminal the primary control hides — the
  // recurring CI failure this spec wore. Every assert below now runs against a frozen
  // sim; `callWavePaced` opens the only windows in which it advances.
  await page.getByRole('button', { name: 'Pause' }).click();

  // Early-call every REMAINING wave via the SAME morphed primary control (now
  // "Call wave") — wave 1 already launched on Start above, so this calls 2 through 10,
  // keeping the spec deterministic and fast rather than waiting out nine full natural
  // countdowns (smoke.spec.ts exercises the identical flow end-to-end, with the preview
  // + axe). The bundle carries ten waves — M2-S6 appended index 4 (`resolute`+`fast`),
  // M2-S7 appended index 5 (8 × `flying`), M2-S10 appended indices 6 and 7
  // (`armored-flyer` and the boss wave), and M2-S11 inserted two further rows (a second
  // `normal`+`swarm` wave and the arc's four-entry densest tick) — so this early-calls
  // nine, not three.
  for (let waveNumber = 2; waveNumber <= 10; waveNumber++) {
    // Gate each press on LAUNCH-specific state, not the free-running sim heartbeat:
    // a tick boundary can fall between a tick-read and the click, so a tick-poll
    // passes even when the press itself was swallowed or same-tick-deduped (local
    // QC round 2 + CodeRabbit — the loop would silently stop testing "call every
    // wave"). The preview title only advances when the PREVIOUS call actually
    // landed, and the aria gate proves this press is genuinely accepted-able.
    await expect(previewTitle).toHaveText(`Wave ${waveNumber} of 10`);
    await expect(callWave).toHaveAttribute('aria-disabled', 'false');
    await callWavePaced(page, titleAfterCall(waveNumber, 10));
  }
  await expect(previewTitle).toHaveText('Final wave launched — no more waves to call');

  // The loop exits paused (callWavePaced's contract) — release the run so the horde can
  // stream through and resolve. The window is wider than the free-running spec's old 40s:
  // pacing froze traversal between calls, so resolution now covers essentially the whole
  // undefended march, not just its tail.
  await page.getByRole('button', { name: 'Resume' }).click();
  const results = page.getByRole('dialog');
  await expect(results).toBeVisible({ timeout: 60_000 });

  // Play-again returns to the held state exactly as at first load.
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(board).toHaveAttribute('data-started', 'false');
  await expect(board).toHaveAttribute('data-sim-tick', '0');
  await expect(waveChip).toHaveCount(1);
  await expect(waveChip).toBeVisible();
  await expect(waveChipText).toHaveText(/^Wave in \d+s$/);
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});
