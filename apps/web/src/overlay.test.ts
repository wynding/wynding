import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HudVM } from '@wynding/render';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import { createOverlay, type UiAction } from './overlay';
import type { ModalOverlay } from './modal';
import { createShell, dockButtonParts } from './shell';
import { createSettings } from './settings';
import { createKeymap, GAME_ACTIONS } from './keymap';
import { createController, type UiState } from './controller';
import { attachInput } from './input';
import { createInstall, type InstallHandle, type StorageAdapter } from './install';
import {
  COARSE,
  STANDALONE,
  defaultInstall,
  fakeMatchMedia,
  fakePromptEvent,
  fakeStorage,
  fakeTarget,
} from './install-fakes';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
const CARD_DESCRIPTORS = ruleset.towers.map((t) => ({ towerId: t.id }));

// A fixed 280×240 board rect → 28×24 cells at 10 px each (mirrors input.test.ts) so the
// settings-open integration tests below can place/hold a real gesture under jsdom (whose
// own rects are zero-size). A client point (x,y) maps to cell (⌊x/10⌋, ⌊y/10⌋).
const RECT = { left: 0, top: 0, width: 280, height: 240 };

function ptr(type: string, clientX: number, clientY: number, pointerId = 1): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX, clientY, pointerType: 'touch', button: 0, pointerId });
  return e;
}

function hud(over: Partial<HudVM> = {}): HudVM {
  return {
    phase: 'running',
    lives: 10,
    bounty: 80,
    countdownSeconds: 25,
    score: 0,
    stars: 0,
    won: false,
    waveCount: 3,
    waveCursor: 0,
    launchPending: false,
    callable: true,
    // Defaults to `null` (no preview surface) so the many pre-existing HUD-readout tests
    // that never touch the wave preview aren't affected by it — the dedicated "wave
    // preview" describe block below overrides this explicitly.
    preview: null,
    ...over,
  };
}

/** A neutral (unarmed, unselected) `UiState`, for tests that don't exercise the
 *  armed/selection state machine. */
function uiState(over: Partial<UiState> = {}): UiState {
  return {
    started: true,
    armed: null,
    selection: null,
    lastOutcome: null,
    outcomeSeq: 0,
    callWaveReady: true,
    ...over,
  };
}

/** A spy for the app-level pause seam the settings dialog asks on open. The
 *  started/already-paused guard moved into `main.ts`'s `ensurePaused` — one guard shared by
 *  every pause caller, and one synchronous home-link refresh — so the cases this file used to
 *  assert against a Controller fake (pre-start is a no-op, already-paused is a no-op, closing
 *  never resumes the controller) live in `main.test.ts`'s "the app-level pause seam" block
 *  against the REAL controller. What `overlay.ts` still owns, and what is asserted below, is
 *  WHEN it asks. */
const fakeEnsurePaused = (): ReturnType<typeof vi.fn> => vi.fn();

interface SetupOptions {
  readonly install?: InstallHandle;
}

function setup(
  ensurePaused: ReturnType<typeof vi.fn> = fakeEnsurePaused(),
  abortGesture: () => void = () => {},
  options: SetupOptions = {},
) {
  const actions: UiAction[] = [];
  const settings = createSettings();
  const keymap = createKeymap();
  const shell = createShell(document, CARD_DESCRIPTORS);
  document.body.appendChild(shell.root);
  const install = options.install ?? defaultInstall();
  const overlay = createOverlay(
    document,
    (a) => actions.push(a),
    ensurePaused,
    settings,
    keymap,
    shell,
    ruleset,
    abortGesture,
    install,
  );
  document.body.append(
    overlay.resultsEl,
    overlay.settingsEl,
    overlay.instructionsEl,
    overlay.leaveEl,
  );
  return {
    actions,
    ensurePaused,
    settings,
    keymap,
    shell,
    overlay,
    install,
    abortGesture,
    pauseBtn: shell.dock.pause,
    speedBtn: shell.dock.speed,
    primaryBtn: shell.dock.primary,
    settingsBtn: shell.dock.settings,
    card: shell.cards[0]!,
    panel: shell.panel,
    live: shell.live,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('overlay — HUD readout', () => {
  it('renders lives/gold/score/stars and the wave countdown; hides the wave chip once every wave has launched or the run is terminal (M2-S2: countdown-only, no "in progress" fallback)', () => {
    const { overlay, shell } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    const text = shell.hudBox.textContent!;
    expect(text).toContain('Lives: 10');
    expect(text).toContain('Bounty: 80');
    expect(text).toContain('Wave in 25s');
    // Dual-form chips (Story 11 contract §4): the aria-hidden glance form carries the icon
    // + value; the full ICU message stays the accessible text, never sentence-split.
    expect(shell.hud.lives.full.textContent).toBe('Lives: 10');
    expect(shell.hud.lives.glance.textContent).toBe('♥ 10');
    expect(shell.hud.bounty.glance.textContent).toBe('◈ 80');
    expect(shell.hud.wave.glance.textContent).toBe('25s');

    // Once every wave has launched, `countdownSeconds` is null — the chip hides entirely
    // (its own preview surface carries the last-wave marker instead — see the dedicated
    // "wave preview" describe block).
    overlay.update({
      hud: hud({ countdownSeconds: null, waveCursor: 3, callable: false }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.hud.wave.full.textContent).toBe('');
    expect(shell.hud.wave.root.hidden).toBe(true);
    expect(shell.hud.wave.root.isConnected).toBe(true);

    // Terminal phase also has countdownSeconds null — the wave slot hides entirely (the
    // outcome is the results dialog), with its full-form node retained and empty.
    overlay.update({
      hud: hud({ countdownSeconds: null, phase: 'lost', won: false }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.hud.wave.full.textContent).toBe('');
    expect(shell.hud.wave.root.hidden).toBe(true);
    expect(shell.hud.wave.root.isConnected).toBe(true);
  });

  it('reflects pause/speed state on the controls', () => {
    const { overlay, pauseBtn, speedBtn } = setup();
    overlay.update({
      hud: hud(),
      paused: true,
      speed: 2,
      ui: uiState(),
      refund: 0,
    });
    // The Dock markup contract (Story 11 P1) splits every button into an aria-hidden icon
    // span + the localized text span; the icon swaps in the SAME update as the text.
    expect(dockButtonParts(pauseBtn).text.textContent).toBe('Resume');
    expect(dockButtonParts(pauseBtn).icon.textContent).toBe('⏵');
    expect(pauseBtn.getAttribute('aria-pressed')).toBe('true');
    expect(dockButtonParts(speedBtn).text.textContent).toBe('Speed: 2x');
    expect(dockButtonParts(speedBtn).icon.textContent).toBe('2×');

    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(dockButtonParts(pauseBtn).text.textContent).toBe('Pause');
    expect(dockButtonParts(pauseBtn).icon.textContent).toBe('⏸');
    expect(dockButtonParts(speedBtn).icon.textContent).toBe('1×');
  });

  it('the Settings button carries its glyph and its localized accessible text', () => {
    const { settingsBtn } = setup();
    expect(dockButtonParts(settingsBtn).icon.textContent).toBe('⚙');
    expect(dockButtonParts(settingsBtn).text.textContent).toBe('Settings');
  });
});

describe('overlay — the wave preview surface (M2-S2, PLAN.md P3 steps 16-17/19)', () => {
  it('renders the title + one accessible-text row per entry: "{count} × {name} — {domain}, armor {n}, {immunities}", with explicit none-states', () => {
    const { overlay, shell } = setup();
    overlay.update({
      hud: hud({
        preview: {
          kind: 'upcoming',
          waveNumber: 2,
          waveCount: 3,
          entries: [{ creepId: 'normal', count: 10, domain: 'ground', armor: 0, immunities: [] }],
        },
      }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.preview.root.hidden).toBe(false);
    expect(shell.preview.title.textContent).toBe('Wave 2 of 3');
    const items = [...shell.preview.list.querySelectorAll('li')];
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe('10 × Creep — ground, armor 0, no immunities');
  });

  it('an unchanged preview never rebuilds its rows — node identity survives repeated updates (the SR-stability memo)', () => {
    // The memo guard is an a11y contract (a screen-reader virtual cursor or
    // braille display parked on a row must not have its node torn down every
    // tick) and, post-locale-sentinel, it is drift-prone by construction: its
    // three conjuncts must reproduce what the render writes byte-for-byte.
    // Local QC round 3: disabling the guard left all web tests green — this
    // test is the pin (it fails under a disabled or drifted guard).
    const { overlay, shell } = setup();
    const view = {
      hud: hud({
        preview: {
          kind: 'upcoming' as const,
          waveNumber: 2,
          waveCount: 3,
          entries: [{ creepId: 'normal', count: 10, domain: 'ground', armor: 0, immunities: [] }],
        },
      }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    };
    overlay.update(view);
    const firstRow = shell.preview.list.firstElementChild;
    expect(firstRow).not.toBeNull();
    for (let i = 0; i < 20; i++) overlay.update(view);
    expect(shell.preview.list.firstElementChild).toBe(firstRow); // same NODE, not equal text
  });

  it('shows the last-wave marker (no entry list) once every wave has launched', () => {
    const { overlay, shell } = setup();
    overlay.update({
      hud: hud({ preview: { kind: 'lastWave' } }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.preview.root.hidden).toBe(false);
    expect(shell.preview.title.textContent).toBe('Final wave launched — no more waves to call');
    expect(shell.preview.list.children).toHaveLength(0);
  });

  it('hides once terminal (preview null) — the results dialog takes over', () => {
    const { overlay, shell } = setup();
    overlay.update({
      hud: hud({ preview: null }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.preview.root.hidden).toBe(true);
  });

  it('falls back to the localized generic name for a valid-but-unmapped catalog id — NEVER a raw id (Round 2 finding #9 / ADR 0004) — and warns in dev mode', () => {
    const { overlay, shell } = setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    overlay.update({
      hud: hud({
        preview: {
          kind: 'upcoming',
          waveNumber: 1,
          waveCount: 1,
          // A creepId sv6's catalog CAN carry (it's schema-valid) but this build's overlay
          // hasn't been taught a localized name for — the exact "future content, current
          // client" gap the fallback exists for.
          entries: [
            { creepId: 'future-kind', count: 4, domain: 'ground', armor: 2, immunities: [] },
          ],
        },
      }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    const text = shell.preview.list.querySelector('li')!.textContent;
    expect(text).toBe('4 × Unknown creep (future-kind) — ground, armor 2, no immunities');
    // The dev-only warn is asserted conditionally — Vitest defaults DEV to true, but a
    // production-mode run must not fail on a behaviour (the warn) that build mode elides.
    if (import.meta.env.DEV) expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // QC r3 (the `CREEP_NAME` mirror of the tower-side Codex #73 fix): an id colliding
  // with an inherited `Object.prototype` key must take the localized fallback — a plain
  // object map would render an object-derived string into accessible preview text AND
  // suppress `warnUnmappedCreeps`' mapping-gap diagnostic (the `=== undefined` check
  // sees the inherited member) — the double silent failure the null prototype prevents.
  it('a creep id colliding with an Object.prototype key falls back too — and still fires the dev mapping-gap warn', () => {
    const { overlay, shell } = setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    overlay.update({
      hud: hud({
        preview: {
          kind: 'upcoming',
          waveNumber: 1,
          waveCount: 1,
          entries: [
            { creepId: 'constructor', count: 4, domain: 'ground', armor: 2, immunities: [] },
          ],
        },
      }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    const text = shell.preview.list.querySelector('li')!.textContent;
    expect(text).toBe('4 × Unknown creep (constructor) — ground, armor 2, no immunities');
    expect(text).not.toContain('[object');
    if (import.meta.env.DEV) {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("creep id 'constructor'"));
    }
    warnSpy.mockRestore();
  });

  it('rebuilds the entry list on every render (no stale rows left behind from a shorter previous wave)', () => {
    const { overlay, shell } = setup();
    const two = {
      kind: 'upcoming' as const,
      waveNumber: 1,
      waveCount: 2,
      entries: [
        { creepId: 'normal', count: 1, domain: 'ground' as const, armor: 0, immunities: [] },
        { creepId: 'normal', count: 2, domain: 'ground' as const, armor: 0, immunities: [] },
      ],
    };
    overlay.update({
      hud: hud({ preview: two }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.preview.list.children).toHaveLength(2);

    overlay.update({
      hud: hud({
        preview: { kind: 'upcoming', waveNumber: 2, waveCount: 2, entries: [two.entries[0]!] },
      }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.preview.list.children).toHaveLength(1);
  });
});

describe('overlay — player-started runs (PLAN.md P4)', () => {
  it('pre-start: Pause is hidden, the primary Dock button reads Start, and the wave countdown is ALREADY visible (M2-S2: Start decoupled — countdownRemaining is meaningful before Start)', () => {
    const { overlay, pauseBtn, primaryBtn, shell } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: false }),
      refund: 0,
    });
    expect(pauseBtn.hidden).toBe(true);
    expect(primaryBtn.hidden).toBe(false);
    // Start keeps its VISIBLE text label in both layouts (contract §2) — no icon form.
    expect(dockButtonParts(primaryBtn).text.textContent).toBe('Start');
    expect(dockButtonParts(primaryBtn).icon.textContent).toBe('');
    // The wave chip is countdown-only (M2-S2) and now visible PRE-START too — `hud()`'s
    // countdown default (25) is a real, meaningful figure before Start is ever pressed.
    expect(shell.hud.wave.full.textContent).toBe('Wave in 25s');
    expect(shell.hud.wave.root.hidden).toBe(false);
    const visible = [...shell.hudBox.children].filter((el) => !(el as HTMLElement).hidden);
    expect(visible).toHaveLength(5); // lives, bounty, score, wave, stars (preview is separate)
  });

  it('once started: Pause is visible, and the primary Dock button MORPHS to Call wave rather than hiding (M2-S2, PLAN.md P3 step 17)', () => {
    const { overlay, pauseBtn, primaryBtn } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: true }),
      refund: 0,
    });
    expect(pauseBtn.hidden).toBe(false);
    expect(primaryBtn.hidden).toBe(false);
    expect(dockButtonParts(primaryBtn).text.textContent).toBe('Call wave');
    expect(primaryBtn.getAttribute('aria-disabled')).toBe('false'); // callable: true by default
  });

  it('clicking the primary Dock button emits start', () => {
    const { actions, primaryBtn } = setup();
    primaryBtn.click();
    expect(actions).toEqual([{ type: 'start' }]);
  });

  it('the live region announces the pre-start pending cap distinctly from a generic rejection', () => {
    const { overlay, live } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ lastOutcome: { kind: 'rejected', reason: 'pendingCap' } }),
      refund: 0,
    });
    expect(live.textContent).toBe('Too many pending actions.');
  });
});

describe('overlay — the morphing primary control’s aria-disabled states (M2-S2, PLAN.md P3 step 17, Round 2 finding #4)', () => {
  it('is aria-disabled (never native disabled) and shows the pending-launch label while a call is queued', () => {
    const { overlay, primaryBtn } = setup();
    overlay.update({
      hud: hud({ launchPending: true, callable: false }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: false }),
      refund: 0,
    });
    expect(dockButtonParts(primaryBtn).text.textContent).toBe('Launching…');
    expect(primaryBtn.getAttribute('aria-disabled')).toBe('true');
    expect(primaryBtn.hasAttribute('disabled')).toBe(false); // native disabled would drop it from the tab order
  });

  it('is aria-disabled with the Call-wave label (not pending) once every wave has launched — visible-disabled, never hidden', () => {
    const { overlay, primaryBtn } = setup();
    overlay.update({
      hud: hud({ waveCursor: 3, callable: false, preview: { kind: 'lastWave' } }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: false }),
      refund: 0,
    });
    expect(primaryBtn.hidden).toBe(false);
    expect(dockButtonParts(primaryBtn).text.textContent).toBe('Call wave');
    expect(primaryBtn.getAttribute('aria-disabled')).toBe('true');
  });

  it('Start is never aria-disabled pre-start, even with a full buffer (callWaveReady false)', () => {
    const { overlay, primaryBtn } = setup();
    overlay.update({
      hud: hud({ callable: true }),
      paused: false,
      speed: 1,
      ui: uiState({ started: false, callWaveReady: false }),
      refund: 0,
    });
    expect(dockButtonParts(primaryBtn).text.textContent).toBe('Start');
    expect(primaryBtn.getAttribute('aria-disabled')).toBe('false');
  });

  it('is aria-disabled when the buffer is momentarily full (UiState.callWaveReady), even though HudVM.callable is true', () => {
    const { overlay, primaryBtn } = setup();
    overlay.update({
      hud: hud({ callable: true }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: false }),
      refund: 0,
    });
    expect(primaryBtn.getAttribute('aria-disabled')).toBe('true');
  });

  it('hides only at TERMINAL, regardless of callable/launchPending', () => {
    const { overlay, primaryBtn } = setup();
    overlay.update({
      hud: hud({ phase: 'won', won: true, callable: false, preview: null }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: false }),
      refund: 0,
    });
    expect(primaryBtn.hidden).toBe(true);
  });

  it('activation is suppressed while aria-disabled — a click on the pending-launch button emits nothing', () => {
    const { overlay, actions, primaryBtn } = setup();
    overlay.update({
      hud: hud({ launchPending: true, callable: false }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: false }),
      refund: 0,
    });
    primaryBtn.click();
    expect(actions).toEqual([]);
  });

  // Round 2 finding #4: dynamically disabling the FOCUSED primary control must not strand
  // focus — a paused early call disables the just-clicked button, and native `disabled`
  // would drop focus to the document. `aria-disabled` keeps it in the tab order.
  it('retains focus across the callable→pending transition (a click that lands the control disabled)', () => {
    const { overlay, primaryBtn } = setup();
    overlay.update({
      hud: hud({ callable: true }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: true }),
      refund: 0,
    });
    primaryBtn.focus();
    expect(document.activeElement).toBe(primaryBtn);
    overlay.update({
      hud: hud({ launchPending: true, callable: false }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: false }),
      refund: 0,
    });
    expect(primaryBtn.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(primaryBtn); // never stranded on document.body
  });

  it('retains focus across the callable→after-final-launch transition', () => {
    const { overlay, primaryBtn } = setup();
    overlay.update({
      hud: hud({ callable: true }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: true }),
      refund: 0,
    });
    primaryBtn.focus();
    overlay.update({
      hud: hud({ waveCursor: 3, callable: false, preview: { kind: 'lastWave' } }),
      paused: false,
      speed: 1,
      ui: uiState({ started: true, callWaveReady: false }),
      refund: 0,
    });
    expect(primaryBtn.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(primaryBtn);
  });
});

describe('overlay — the Start→Call-wave morph announcement (M2-S2, Round 1 finding #8: Start moves focus to the board and the HUD is not live, so without this the morph is undiscoverable to AT users)', () => {
  it('announces exactly once on a genuine started false→true edge, through the existing polite live region', () => {
    const { overlay, live } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: false }),
      refund: 0,
    });
    // Not yet announced — still held. (The very first `update()` call also runs the
    // unrelated outcome-announcement path with a null outcome, which — per its own
    // same-value collision guard — may write a lone space rather than '': `.trim()`
    // normalizes that quirk away here, since it's not what this test is about.)
    expect(live.textContent!.trim()).toBe('');
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: true }),
      refund: 0,
    });
    expect(live.textContent).toBe(
      'Run started. The primary button now calls the current wave early.',
    );
    // A further tick with `started` still true must NOT re-announce (no per-tick spam).
    const setSpy = vi.spyOn(live, 'textContent', 'set');
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: true }),
      refund: 0,
    });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('re-arms after Play-again — a second run’s Start is announced too', () => {
    const { overlay, live } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: false }),
      refund: 0,
    });
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: true }),
      refund: 0,
    });
    expect(live.textContent).toContain('Run started');
    // Play-again: back to held.
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: false }),
      refund: 0,
    });
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: true }),
      refund: 0,
    });
    expect(live.textContent).toContain('Run started');
  });
});

describe('overlay — Card/Panel/live region (PLAN.md P2)', () => {
  it('the Card shows the localized name/cost and a live hotkey badge, mirrored via aria-pressed', () => {
    const { overlay, card } = setup();
    expect(card.name.textContent).toBe('Basic Tower');
    expect(card.cost.textContent).toBe('Cost: 5');
    expect(card.hotkey.textContent).toBe('1'); // Digit1 default
    expect(card.root.getAttribute('aria-keyshortcuts')).toBe('1');

    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'basic' }),
      refund: 0,
    });
    expect(card.root.getAttribute('aria-pressed')).toBe('true');
  });

  it('the second of three Cards (M2-S3) shows the slow tower and carries the Digit2 hotkey badge', () => {
    const { shell } = setup();
    expect(shell.cards).toHaveLength(3);
    const slowCard = shell.cards[1]!;
    expect(slowCard.towerId).toBe('slow');
    expect(slowCard.name.textContent).toBe('Slow Tower');
    expect(slowCard.cost.textContent).toBe('Cost: 8');
    expect(slowCard.hotkey.textContent).toBe('2'); // Digit2 default
    expect(slowCard.root.getAttribute('aria-keyshortcuts')).toBe('2');
  });

  // M2-S4a: the third catalog tower (`splash`) gets the third hotkey slot.
  it('a third Card (M2-S4a) shows the splash tower and carries the Digit3 hotkey badge', () => {
    const { shell } = setup();
    const splashCard = shell.cards[2]!;
    expect(splashCard.towerId).toBe('splash');
    expect(splashCard.name.textContent).toBe('Splash Tower');
    expect(splashCard.cost.textContent).toBe('Cost: 12');
    expect(splashCard.hotkey.textContent).toBe('3'); // Digit3 default
    expect(splashCard.root.getAttribute('aria-keyshortcuts')).toBe('3');
  });

  it('a card at catalog index ≥ 3 gets NO hotkey badge/aria-keyshortcuts at all (Codex R2-2, widened M2-S4a)', () => {
    // Four-tower descriptor list — index 3 has no ARM_HOTKEY_ACTIONS slot.
    const fourTowerRuleset = ruleset;
    const shell = createShell(document, [
      { towerId: 'basic' },
      { towerId: 'slow' },
      { towerId: 'splash' },
      { towerId: 'basic' }, // a synthetic fourth slot — id doesn't matter, only the index does
    ]);
    document.body.appendChild(shell.root);
    const overlay = createOverlay(
      document,
      () => {},
      () => {},
      createSettings(),
      createKeymap(),
      shell,
      fourTowerRuleset,
      () => {},
      defaultInstall(),
    );
    document.body.append(
      overlay.resultsEl,
      overlay.settingsEl,
      overlay.instructionsEl,
      overlay.leaveEl,
    );
    const fourthCard = shell.cards[3]!;
    expect(fourthCard.hotkey.textContent).toBe('');
    expect(fourthCard.root.hasAttribute('aria-keyshortcuts')).toBe(false);
    overlay.destroy();
  });

  it('a legal one-tower bundle filters armTower2 from the rebind list, and its document hotkey no-ops (Codex R3-1)', () => {
    const oneCardShell = createShell(document, [{ towerId: 'basic' }]);
    document.body.appendChild(oneCardShell.root);
    const actions: UiAction[] = [];
    const overlay = createOverlay(
      document,
      (a) => actions.push(a),
      () => {},
      createSettings(),
      createKeymap(),
      oneCardShell,
      ruleset,
      () => {},
      defaultInstall(),
    );
    document.body.append(
      overlay.resultsEl,
      overlay.settingsEl,
      overlay.instructionsEl,
      overlay.leaveEl,
    );
    // No phantom rebindable action for a slot that doesn't exist.
    const rebindNames = [...overlay.settingsEl.querySelectorAll('.wy-rebind li span')].map(
      (el) => el.textContent,
    );
    expect(rebindNames).not.toContain('Arm tower 2');
    // The document hotkey no-ops too — cards[1] doesn't exist.
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
    expect(actions).toEqual([]);
    overlay.destroy();
  });

  it('the board aria-label names the actual bound keys and refreshes on rebind', () => {
    const { keymap, overlay, shell, settingsBtn } = setup();
    // Initially derived from the default keymap (arrows / Enter / X), not hardcoded.
    const initial = shell.board.getAttribute('aria-label')!;
    expect(initial).toContain('ArrowUp / ArrowDown / ArrowLeft / ArrowRight');
    expect(initial).toContain('press Enter');
    expect(initial).toContain('Press X to sell');

    // Rebind 'sell' (KeyX → KeyQ) via the settings dialog: the board aria must reflect it.
    settingsBtn.click();
    const rebindBtns = overlay.settingsEl.querySelectorAll<HTMLButtonElement>('.wy-rebind-btn');
    const sellBtn = rebindBtns[GAME_ACTIONS.indexOf('sell')]!;
    sellBtn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
    expect(keymap.codeFor('sell')).toBe('KeyQ');
    expect(shell.board.getAttribute('aria-label')).toContain('Press Q to sell');
  });

  it('the hotkey badge re-renders after a rebind that displaces armTower1', () => {
    const { keymap, overlay, card, settingsBtn } = setup();
    settingsBtn.click();
    // armTower1 is the LAST rebind row (GAME_ACTIONS order): steal its key (Digit1) by
    // rebinding an earlier action onto it.
    const upBtn = overlay.settingsEl.querySelectorAll<HTMLButtonElement>('.wy-rebind-btn')[0]!;
    upBtn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
    expect(keymap.codeFor('armTower1')).toBeNull();
    expect(card.hotkey.textContent).toBe('Unbound');
    expect(card.root.hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('the Panel shows armed type info (cost/damage/range/fire-rate/targets) and closes on Close (disarm)', () => {
    const { overlay, panel, actions } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'basic' }),
      refund: 0,
    });
    expect(panel.root.hidden).toBe(false);
    const text = panel.root.textContent!;
    expect(text).toContain('Basic Tower');
    expect(text).toContain('Cost: 5');
    expect(text).toContain('Damage: 10');
    expect(text).toContain('Range: 4.0 tiles'); // rangeFp 1024 / FP_ONE 256
    expect(text).toContain('Fire rate: 0.7/s'); // (1000/50) / 30 cadenceTicks
    expect(text).toContain('Targets: Ground');
    // `basic` has no `aoe` effect — no blast-radius row at all (not even a "0").
    expect(text).not.toContain('Blast radius');

    const closeBtn = panel.root.querySelector<HTMLButtonElement>('.wy-btn')!;
    closeBtn.click();
    expect(actions.map((a) => a.type)).toEqual(['closePanel']);
  });

  // M2-S4a: `splash`'s damage is carried by its `aoe` effect (kind 'aoe', not 'direct')
  // — the Panel's damage sum must include it, or an AoE tower would read "Damage: 0"
  // despite dealing real damage. The blast radius is exposed as its own text row
  // (never ring-only — the ghost-preview a11y obligation, PLAN.md step 14/15).
  it("the Panel shows the SPLASH tower's AoE damage and blast-radius stat row", () => {
    const { overlay, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'splash' }),
      refund: 0,
    });
    expect(panel.root.hidden).toBe(false);
    const text = panel.root.textContent!;
    expect(text).toContain('Splash Tower');
    expect(text).toContain('Cost: 12');
    expect(text).toContain('Damage: 8'); // the aoe effect's amount, not 0
    expect(text).toContain('Range: 4.0 tiles');
    expect(text).toContain('Fire rate: 0.3/s'); // (1000/50) / 60 cadenceTicks
    expect(text).toContain('Blast radius: 1.5 tiles'); // radiusFp 384 / FP_ONE 256
  });

  // QC round 1: the wrong-stats regression guard PLAN step 21 named (G18's bug — a
  // towerStats that hardcoded basic's numbers, or read towers[0] instead of
  // towerById[towerId], would render basic's stats on a slow tower and pass every other
  // test in the suite, since they all exercise 'basic').
  it("the Panel shows the SLOW tower's own stats when slow is armed — never basic's", () => {
    const { overlay, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'slow' }),
      refund: 0,
    });
    expect(panel.root.hidden).toBe(false);
    const text = panel.root.textContent!;
    expect(text).toContain('Slow Tower');
    expect(text).toContain('Cost: 8');
    expect(text).toContain('Damage: 2'); // Σ direct amounts of the slow bundle — not basic's 10
    expect(text).not.toContain('Damage: 10');
    expect(text).toContain('Range: 4.0 tiles');
    expect(text).toContain('Fire rate: 0.7/s'); // cadence 30, same as basic
  });

  // QC round 2: the SELECTED branch funnels through the same towerStats(id) seam, but a
  // wrong-id regression there (e.g. reading the armed id, or towers[0]) would have passed
  // the armed-only variant above — pin the selection path on the slow tower too.
  it("the Panel shows a SELECTED slow tower's own stats — never basic's", () => {
    const { overlay, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ selection: { col: 1, row: 1, id: 7, towerId: 'slow' } }),
      refund: 6,
    });
    expect(panel.root.hidden).toBe(false);
    const text = panel.root.textContent!;
    expect(text).toContain('Slow Tower');
    expect(text).toContain('Cost: 8');
    expect(text).toContain('Damage: 2');
    expect(text).not.toContain('Damage: 10');
  });

  it('the Panel shows a selected tower with Sell (live refund) and a permanent Max-level Upgrade', () => {
    const { overlay, panel, actions } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ selection: { col: 1, row: 1, id: 7, towerId: 'basic' } }),
      refund: 3,
    });
    expect(panel.root.hidden).toBe(false);
    const buttons = [...panel.root.querySelectorAll<HTMLButtonElement>('.wy-btn')];
    const sellBtn = buttons.find((b) => b.textContent?.startsWith('Sell'))!;
    expect(sellBtn.textContent).toBe('Sell (refund 3)');
    const upgradeBtn = buttons.find((b) => b.textContent === 'Max level')!;
    expect(upgradeBtn.getAttribute('aria-disabled')).toBe('true');
    expect(upgradeBtn.hasAttribute('aria-describedby')).toBe(true);
    upgradeBtn.click(); // activation suppressed — no action emitted
    expect(actions).toEqual([]);

    sellBtn.click();
    expect(actions.map((a) => a.type)).toEqual(['sellSelected']);
  });

  it('a refund change on the SAME selection updates the Sell label in place, preserving the button element (no re-creation)', () => {
    const { overlay, panel } = setup();
    const selection = { col: 1, row: 1, id: 7, towerId: 'basic' };
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ selection }),
      refund: 3,
    });
    const findSell = (): HTMLButtonElement =>
      [...panel.root.querySelectorAll<HTMLButtonElement>('.wy-btn')].find((b) =>
        b.textContent?.startsWith('Sell'),
      )!;
    const sellBtn1 = findSell();
    expect(sellBtn1.textContent).toBe('Sell (refund 3)');

    // Same selection identity, refund shifts (the pending queue changed) — the label must
    // refresh WITHOUT recreating the button, which would drop focus.
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ selection }),
      refund: 8,
    });
    const sellBtn2 = findSell();
    expect(sellBtn2.textContent).toBe('Sell (refund 8)');
    expect(sellBtn2).toBe(sellBtn1); // patched in place — same element, not re-created
  });

  it('the Panel closes (hidden) when neither armed nor a selection is present', () => {
    const { overlay, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(panel.root.hidden).toBe(true);
  });

  // FINDING 1: Panel teardown is the ONE focus-re-homing seam (renderPanel). When focus is
  // inside the Panel as it closes, it must land on a deliberate control — never on
  // document.body, which would kill every board-scoped shortcut.
  it('closing the Panel from a DISARM while a Panel control has focus re-homes focus to the Card', () => {
    const { overlay, card, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'basic' }),
      refund: 0,
    });
    const panelBtn = panel.root.querySelector<HTMLButtonElement>('.wy-btn')!;
    panelBtn.focus();
    expect(panel.root.contains(document.activeElement)).toBe(true);
    // Disarm → the Panel closes; focus was inside it, so it re-homes to the Card.
    overlay.update({ hud: hud(), paused: false, speed: 1, ui: uiState(), refund: 0 });
    expect(document.activeElement).toBe(card.root);
    expect(document.activeElement).not.toBe(document.body);
  });

  // QC round 1: G17 requires the re-home to resolve WHICH card — a hardcoded
  // cards[0].root.focus() would pass the basic-card test above.
  it('a disarm-close from the SLOW card re-homes focus to the SLOW card, not the first card', () => {
    const { overlay, shell, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'slow' }),
      refund: 0,
    });
    const panelBtn = panel.root.querySelector<HTMLButtonElement>('.wy-btn')!;
    panelBtn.focus();
    expect(panel.root.contains(document.activeElement)).toBe(true);
    overlay.update({ hud: hud(), paused: false, speed: 1, ui: uiState(), refund: 0 });
    expect(document.activeElement).toBe(shell.cards[1]!.root);
    expect(document.activeElement).not.toBe(shell.cards[0]!.root);
  });

  it('closing the Panel from a DESELECT while a Panel control has focus re-homes focus to the board', () => {
    const { overlay, shell, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ selection: { col: 1, row: 1, id: 7, towerId: 'basic' } }),
      refund: 3,
    });
    const panelBtn = panel.root.querySelector<HTMLButtonElement>('.wy-btn')!;
    panelBtn.focus();
    expect(panel.root.contains(document.activeElement)).toBe(true);
    // Deselect → the Panel closes; focus was inside it, so it re-homes to the board.
    overlay.update({ hud: hud(), paused: false, speed: 1, ui: uiState(), refund: 0 });
    expect(document.activeElement).toBe(shell.board);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('closing the Panel never STEALS focus that is already outside the Panel (no focus steal)', () => {
    const { overlay, shell, settingsBtn } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'basic' }),
      refund: 0,
    });
    // Focus sits OUTSIDE the Panel (on the board and, as a stronger no-steal proof, on a Dock
    // button that is neither re-home target) — a Panel close must leave it exactly there.
    shell.board.focus();
    overlay.update({ hud: hud(), paused: false, speed: 1, ui: uiState(), refund: 0 });
    expect(document.activeElement).toBe(shell.board); // untouched, not stolen to the Card

    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ armed: 'basic' }),
      refund: 0,
    });
    settingsBtn.focus(); // a control that is neither the Card nor the board
    overlay.update({ hud: hud(), paused: false, speed: 1, ui: uiState(), refund: 0 });
    expect(document.activeElement).toBe(settingsBtn); // not re-homed to the Card
  });

  it('the live region announces armed/disarmed/placed/rejected/sold, restrained + localized', () => {
    const { overlay, live } = setup();
    let seq = 0;
    const render = (lastOutcome: UiState['lastOutcome']): string => {
      // Each call models a genuinely NEW recorded outcome (armed → disarmed → placed →
      // …) — bump `outcomeSeq` like the controller does, so the live-region write actually
      // fires (Fix A keys the write on seq identity, not on message-text equality).
      overlay.update({
        hud: hud(),
        paused: false,
        speed: 1,
        ui: uiState({ lastOutcome, outcomeSeq: ++seq }),
        refund: 0,
      });
      return live.textContent!;
    };
    expect(render({ kind: 'armed', towerId: 'basic' })).toBe(
      'Basic Tower armed. Place it on the board.',
    );
    // QC round 1: the announcements must name the ACTUAL armed tower — a hardcoded
    // t('tower.basic.name') in outcomeMessage would pass the basic-only assertions above.
    expect(render({ kind: 'armed', towerId: 'slow' })).toBe(
      'Slow Tower armed. Place it on the board.',
    );
    expect(render({ kind: 'placed', towerId: 'slow' })).toBe('Slow Tower placed.');
    expect(render({ kind: 'disarmed', towerId: 'basic' })).toBe('Placement cancelled.');
    expect(render({ kind: 'placed', towerId: 'basic' })).toBe('Basic Tower placed.');
    expect(render({ kind: 'rejected', reason: 'bounty' })).toBe('Not enough Bounty.');
    expect(render({ kind: 'rejected', reason: 'occupied' })).toBe('That cell is already occupied.');
    expect(render({ kind: 'rejected', reason: 'other' })).toBe("Can't build there.");
    expect(render({ kind: 'sold', refund: 12 })).toBe('Tower sold. Refunded 12 Bounty.');
  });

  it('the live region is NOT re-written when the outcome message is unchanged (no stale re-announcement every tick)', () => {
    const { overlay, live } = setup();
    // Spy on the `textContent` SETTER so the assertion is about whether the write happened at
    // all, not just about the value it would have written. The spy calls through to the real
    // setter by default, so the element still updates.
    const setSpy = vi.spyOn(live, 'textContent', 'set');
    const frame = {
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ lastOutcome: { kind: 'placed' as const, towerId: 'basic' } }),
      refund: 0,
    };
    overlay.update(frame); // first render: establishes the message, one write
    expect(setSpy).toHaveBeenCalledTimes(1);
    setSpy.mockClear();
    overlay.update(frame); // the HUD's every-tick update, SAME lastOutcome — no re-write
    expect(setSpy).not.toHaveBeenCalled();
  });

  // Announcements are keyed on outcomeSeq (outcome identity), not message-text equality:
  // rejecting the same occupied cell twice is two distinct outcomes, and the second must
  // reach assistive tech via a real textContent mutation even though the text reads the same.
  it('re-announces an identical outcome when outcomeSeq changes', () => {
    const { overlay, live } = setup();
    const setSpy = vi.spyOn(live, 'textContent', 'set'); // calls through to the real setter
    const frameFor = (outcomeSeq: number) => ({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({
        lastOutcome: { kind: 'rejected' as const, reason: 'occupied' as const },
        outcomeSeq,
      }),
      refund: 0,
    });
    overlay.update(frameFor(1)); // first rejection
    expect(setSpy).toHaveBeenCalledTimes(1);
    const firstText = live.textContent;
    expect(firstText).toBe('That cell is already occupied.');

    overlay.update(frameFor(2)); // SAME message, but a NEW recorded outcome (seq bumped)
    expect(setSpy).toHaveBeenCalledTimes(2); // a real DOM mutation happened...
    expect(live.textContent).not.toBe(firstText); // ...distinguishable from the first write...
    expect(live.textContent!.trim()).toBe('That cell is already occupied.'); // ...but still reads the same to a human
  });

  it('arming via the Card emits armTower', () => {
    const { actions, card } = setup();
    card.root.click();
    expect(actions).toEqual([{ type: 'armTower', tower: 'basic' }]);
  });

  it('a global arm hotkey rebound onto Enter arms AND consumes the key, so a focused button is not also activated', () => {
    const { actions, keymap, settingsBtn } = setup();
    keymap.rebind('armTower1', 'Enter'); // the player rebinds arm onto Enter
    settingsBtn.focus(); // focus sits on a native button (e.g. the settings opener)
    const evt = new KeyboardEvent('keydown', { code: 'Enter', bubbles: true, cancelable: true });
    settingsBtn.dispatchEvent(evt);
    expect(actions).toContainEqual({ type: 'armTower', tower: 'basic' }); // armed
    expect(evt.defaultPrevented).toBe(true); // ...and the key is consumed, so the button isn't also clicked
  });

  // M2-S3 (Codex R1-5): `ArmedTower` is now an OPEN catalog-id string — any schema-valid
  // direct+slow tower compiles at sv7, so a legitimate modded bundle can arm an id this
  // build's `TOWER_NAME` map doesn't recognize. A crash here would break on that
  // legitimate bundle, so the Panel renders the localized fallback name + zeroed stats
  // (never fabricated numbers) instead of throwing — the exact `CREEP_NAME` strategy.
  it('renders the localized unknown-tower fallback name (never throws) for an id this build does not recognize', () => {
    const { overlay, panel } = setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      overlay.update({
        hud: hud(),
        paused: false,
        speed: 1,
        ui: uiState({ armed: 'turret' }),
        refund: 0,
      }),
    ).not.toThrow();
    expect(panel.root.textContent).toContain('Unknown tower (turret)');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("catalog id 'turret'"));
    warnSpy.mockRestore();
  });

  // Codex #73: `'constructor'` is a schema-legal catalog id that collides with an
  // inherited `Object.prototype` key. A plain-object `TOWER_NAME` would resolve it to
  // the inherited `Object` constructor and render an object-derived string; the
  // null-prototype map must miss and take the same localized fallback as any unknown id.
  it('an id colliding with an Object.prototype key falls back too, never an inherited member', () => {
    const { overlay, panel } = setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      overlay.update({
        hud: hud(),
        paused: false,
        speed: 1,
        ui: uiState({ armed: 'constructor' }),
        refund: 0,
      }),
    ).not.toThrow();
    expect(panel.root.textContent).toContain('Unknown tower (constructor)');
    expect(panel.root.textContent).not.toContain('[object');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("catalog id 'constructor'"));
    warnSpy.mockRestore();
  });
});

describe('overlay — install banner, settings row, iOS instructions (PLAN.md Story 11 P3)', () => {
  /** Build an overlay wired to a controllable install handle. */
  function installSetup(
    options: {
      readonly matching?: readonly string[];
      readonly platform?: string;
      readonly maxTouchPoints?: number;
      readonly storage?: StorageAdapter;
      readonly abortGesture?: () => void;
    } = {},
  ) {
    const mm = fakeMatchMedia(options.matching ?? [COARSE]);
    const target = fakeTarget();
    const install = createInstall({
      storage: options.storage ?? fakeStorage(),
      matchMedia: mm.fn,
      target: target.target,
      navigator: {
        platform: options.platform ?? 'Linux x86_64',
        maxTouchPoints: options.maxTouchPoints ?? 0,
      },
    });
    const s = setup(fakeEnsurePaused(), options.abortGesture ?? (() => {}), { install });
    // The overlay re-renders on `update()`; wire the install handle's own change signal the
    // way main.ts does, so a captured prompt refreshes immediately. Re-render with the LAST
    // rendered `started`, not a hardcoded pre-start — otherwise any emit after Start (a
    // pointer/display-mode change) would silently rewind the harness to pre-start.
    let lastStarted = false;
    install.onChange(() => render(lastStarted));
    function render(started: boolean): void {
      lastStarted = started;
      s.overlay.update({
        hud: hud(),
        paused: false,
        speed: 1,
        ui: uiState({ started }),
        refund: 0,
      });
    }
    return { ...s, install, mm, target, render };
  }

  const bannerVisible = (shell: ReturnType<typeof createShell>): boolean =>
    !shell.banner.root.hidden;

  it('promptable + coarse pointer: the banner offers Install; `other` offers nothing at all', () => {
    const promptable = installSetup();
    promptable.render(false);
    expect(bannerVisible(promptable.shell)).toBe(false); // `other` — no signal, no banner
    promptable.target.dispatch(fakePromptEvent().event);
    expect(bannerVisible(promptable.shell)).toBe(true);
    expect(promptable.shell.banner.action.textContent).toBe('Install');
    expect(promptable.shell.banner.text.textContent).toBe(
      'Wynding plays best as an app — full screen, no browser bars.',
    );
    promptable.overlay.destroy();
  });

  it('iOS + coarse pointer: the banner offers instructions, with no prompt event involved', () => {
    const ios = installSetup({ platform: 'iPhone', maxTouchPoints: 5 });
    ios.render(false);
    expect(bannerVisible(ios.shell)).toBe(true);
    expect(ios.shell.banner.action.textContent).toBe('Show me how');
    ios.overlay.destroy();
  });

  it('a promptable DESKTOP session gets the settings row only — never the banner', () => {
    const desktop = installSetup({ matching: [] }); // fine pointer
    desktop.target.dispatch(fakePromptEvent().event);
    desktop.render(false);
    expect(bannerVisible(desktop.shell)).toBe(false);
    const action =
      desktop.overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-install-action')!;
    expect(action.hidden).toBe(false);
    expect(action.textContent).toBe('Install');
    desktop.overlay.destroy();
  });

  it('`other`: no banner, and the settings row EXPLAINS instead of offering a dead button', () => {
    const other = installSetup();
    other.render(false);
    const dialog = other.overlay.settingsEl;
    expect(bannerVisible(other.shell)).toBe(false);
    expect(dialog.querySelector<HTMLButtonElement>('.wy-install-action')!.hidden).toBe(true);
    const explain = dialog.querySelector<HTMLElement>('.wy-install-explain')!;
    expect(explain.hidden).toBe(false);
    expect(explain.textContent).toContain('Add to Home Screen');
    other.overlay.destroy();
  });

  it('standalone (already installed) suppresses BOTH surfaces', () => {
    const app = installSetup({
      matching: [COARSE, STANDALONE],
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    app.render(false);
    expect(bannerVisible(app.shell)).toBe(false);
    expect(app.overlay.settingsEl.querySelector<HTMLElement>('.wy-install-row')!.hidden).toBe(true);
    app.overlay.destroy();
  });

  it('the banner is pre-start only, is dismissible once, and never resurrects after the first Start', () => {
    const storage = fakeStorage();
    const s = installSetup({ storage });
    s.target.dispatch(fakePromptEvent().event);
    s.render(false);
    expect(bannerVisible(s.shell)).toBe(true);

    // Started → hidden.
    s.render(true);
    expect(bannerVisible(s.shell)).toBe(false);

    // Play-again returns to pre-start; the session latch keeps the banner gone.
    s.install.endBannerForSession();
    s.render(false);
    expect(bannerVisible(s.shell)).toBe(false);
    s.overlay.destroy();

    // A fresh overlay over the SAME storage — a destroy()/recreate inside one session — sees
    // the dismissal only once it has actually been made.
    const again = installSetup({ storage });
    again.target.dispatch(fakePromptEvent().event);
    again.render(false);
    expect(bannerVisible(again.shell)).toBe(true);
    again.shell.banner.dismiss.click();
    expect(bannerVisible(again.shell)).toBe(false);
    again.overlay.destroy();

    const third = installSetup({ storage });
    third.target.dispatch(fakePromptEvent().event);
    third.render(false);
    expect(bannerVisible(third.shell), 'dismissal must survive a recreate').toBe(false);
    third.overlay.destroy();
  });

  it('a beforeinstallprompt arriving MID-GESTURE aborts it — the banner row moves the stage', () => {
    const abortGesture = vi.fn();
    const s = installSetup({ abortGesture });
    s.render(false);
    abortGesture.mockClear();

    s.target.dispatch(fakePromptEvent().event); // banner appears → geometry changes
    expect(bannerVisible(s.shell)).toBe(true);
    expect(
      abortGesture,
      'a banner visibility change must cancel an in-flight gesture',
    ).toHaveBeenCalled();

    // A re-render with NO visibility change must not keep aborting gestures.
    abortGesture.mockClear();
    s.render(false);
    expect(abortGesture).not.toHaveBeenCalled();
    s.overlay.destroy();
  });

  it('the prompt is single-use through the UI: a second activation cannot re-call it', async () => {
    const s = installSetup();
    const { event, prompt } = fakePromptEvent('accepted');
    s.target.dispatch(event);
    s.render(false);

    s.shell.banner.action.click();
    // Settle the `prompt()` chain robustly, not by a pinned microtask count.
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

    s.shell.banner.action.click(); // no fresh event has arrived
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledOnce();
    // Accepted → installed → every affordance gone.
    s.render(false);
    expect(bannerVisible(s.shell)).toBe(false);
    expect(s.overlay.settingsEl.querySelector<HTMLElement>('.wy-install-row')!.hidden).toBe(true);
    s.overlay.destroy();
  });

  it('appinstalled removes the install UI even though the tab is not standalone', () => {
    const s = installSetup();
    s.target.dispatch(fakePromptEvent().event);
    s.render(false);
    expect(bannerVisible(s.shell)).toBe(true);

    s.target.dispatch(new Event('appinstalled'));
    s.render(false);
    expect(s.install.state().standalone).toBe(false);
    expect(bannerVisible(s.shell)).toBe(false);
    expect(s.overlay.settingsEl.querySelector<HTMLElement>('.wy-install-row')!.hidden).toBe(true);
    s.overlay.destroy();
  });

  it('dismissing the banner while focus is inside it re-homes focus to Start (never document.body)', () => {
    const s = installSetup();
    s.target.dispatch(fakePromptEvent().event);
    s.render(false);
    s.shell.banner.dismiss.focus();
    expect(document.activeElement).toBe(s.shell.banner.dismiss);

    s.shell.banner.dismiss.click();
    expect(bannerVisible(s.shell)).toBe(false);
    expect(document.activeElement).toBe(s.shell.dock.primary);
    s.overlay.destroy();
  });

  it('re-homes banner focus to the (still-visible) primary control on the Start edge — it morphs rather than hiding (M2-S2)', () => {
    // The primary control stays visible through Start now (M2-S2's morph, PLAN.md P3 step
    // 17 — it hides only once terminal), so it's a guaranteed-focusable fallback itself; the
    // board is only the fallback for the terminal case (see the dedicated test below).
    const s = installSetup();
    s.target.dispatch(fakePromptEvent().event);
    s.render(false);
    s.shell.banner.action.focus();
    expect(document.activeElement).toBe(s.shell.banner.action);

    s.render(true); // Start: the banner hides; primaryBtn stays visible, morphed
    expect(bannerVisible(s.shell)).toBe(false);
    expect(s.shell.dock.primary.hidden).toBe(false);
    expect(document.activeElement).toBe(s.shell.dock.primary);
    s.overlay.destroy();
  });

  it('an accepted install re-homes focus out of the settings row to the dialog close button', async () => {
    const s = installSetup({ matching: [] });
    const { event } = fakePromptEvent('accepted');
    s.target.dispatch(event);
    s.render(false);

    const action = s.overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-install-action')!;
    action.focus();
    expect(document.activeElement).toBe(action);
    action.click();
    // The accepted `prompt()` chain settles then emits, re-rendering the row — wait for that
    // robustly (loop-until-settled) instead of a pinned count of microtask drains.
    await vi.waitFor(() =>
      expect(s.overlay.settingsEl.querySelector<HTMLElement>('.wy-install-row')!.hidden).toBe(true),
    );
    expect(document.activeElement).toBe(
      s.overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-settings-close'),
    );
    s.overlay.destroy();
  });

  it('appinstalled while the banner holds focus re-homes to Start', () => {
    const s = installSetup();
    s.target.dispatch(fakePromptEvent().event);
    s.render(false);
    s.shell.banner.action.focus();
    s.target.dispatch(new Event('appinstalled'));
    expect(bannerVisible(s.shell)).toBe(false);
    expect(document.activeElement).toBe(s.shell.dock.primary);
    s.overlay.destroy();
  });

  it('iOS: the banner action opens the instructions dialog, which Escape dismisses via the new metadata', () => {
    const s = installSetup({ platform: 'iPhone', maxTouchPoints: 5 });
    s.render(false);
    expect(s.overlay.instructionsEl.hidden).toBe(true);

    s.shell.banner.action.click();
    expect(s.overlay.instructionsEl.hidden).toBe(false);
    expect(s.overlay.instructionsEl.getAttribute('aria-label')).toBe(
      'Add Wynding to your Home Screen',
    );
    expect(s.overlay.instructionsEl.textContent).toContain('Add to Home Screen');
    expect(s.shell.root.hasAttribute('inert')).toBe(true);
    // Focus lands on the dialog's own close target.
    expect(document.activeElement).toBe(
      s.overlay.instructionsEl.querySelector('.wy-instructions-close'),
    );

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(s.overlay.instructionsEl.hidden).toBe(true);
    expect(s.shell.root.hasAttribute('inert')).toBe(false);
    s.overlay.destroy();
  });

  it('iOS: opening instructions FROM settings closes settings first, and focus returns to the opener', () => {
    const s = installSetup({ platform: 'iPhone', maxTouchPoints: 5 });
    s.render(false);
    s.shell.dock.settings.focus();
    s.shell.dock.settings.click();
    expect(s.overlay.settingsEl.hidden).toBe(false);

    const action = s.overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-install-action')!;
    expect(action.textContent).toBe('Show me how');
    action.click();

    // The two never sit on the stack together — settings closes, instructions opens.
    expect(s.overlay.settingsEl.hidden).toBe(true);
    expect(s.overlay.instructionsEl.hidden).toBe(false);

    s.overlay.instructionsEl.querySelector<HTMLButtonElement>('.wy-instructions-close')!.click();
    expect(s.overlay.instructionsEl.hidden).toBe(true);
    // Focus return per the modal owner's stack rules: back to the settings opener.
    expect(document.activeElement).toBe(s.shell.dock.settings);
    s.overlay.destroy();
  });

  it('destroy() leaks no install nodes (the instructions dialog is torn down with the rest)', () => {
    const s = installSetup();
    expect(document.body.contains(s.overlay.instructionsEl)).toBe(true);
    s.overlay.destroy();
    expect(document.body.contains(s.overlay.instructionsEl)).toBe(false);
    expect(document.body.contains(s.overlay.settingsEl)).toBe(false);
    expect(document.body.contains(s.overlay.resultsEl)).toBe(false);
  });
});

describe('overlay — accessibility semantics', () => {
  it('the HUD is a labelled group, NOT a chatty live region', () => {
    const { shell } = setup();
    const hudGroup = shell.hudBox;
    expect(hudGroup.getAttribute('role')).toBe('group');
    expect(hudGroup.getAttribute('aria-live')).toBeNull(); // no ~20×/s announcement flood
    expect(hudGroup.getAttribute('aria-label')).toBe('Game status');
  });

  it('showResults traps focus in the dialog and makes the Shell inert', () => {
    const { overlay, shell } = setup();
    overlay.showResults(hud({ won: true }));
    expect(shell.root.hasAttribute('inert')).toBe(true);
    const playAgain = overlay.resultsEl.querySelector<HTMLButtonElement>('.wy-btn')!;
    expect(document.activeElement).toBe(playAgain); // focus moved into the dialog
    overlay.hideResults();
    expect(shell.root.hasAttribute('inert')).toBe(false); // restored on close
  });

  it('restores focus to the pre-modal element when the results dialog closes', () => {
    const { overlay, settingsBtn } = setup();
    settingsBtn.focus();
    overlay.showResults(hud({ won: false }));
    overlay.hideResults();
    expect(document.activeElement).toBe(settingsBtn);
  });

  it('restores a rebind button accessible name when the capture is cancelled', () => {
    const { overlay, settingsBtn } = setup();
    settingsBtn.click(); // open
    const upBtn = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // arm → aria-label becomes the "Press a key…" prompt
    expect(upBtn.getAttribute('aria-label')).toContain('Press a key');
    const closeBtn = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-settings-close')!;
    closeBtn.click(); // close → cancels capture and must restore the label
    expect(upBtn.getAttribute('aria-label')).toContain('Rebind');
  });
});

describe('overlay — control intents', () => {
  it('emits the right UiAction for each control button', () => {
    const { actions, pauseBtn, speedBtn, primaryBtn } = setup();
    pauseBtn.click();
    speedBtn.click();
    primaryBtn.click();
    expect(actions.map((a) => a.type)).toEqual(['togglePause', 'cycleSpeed', 'start']);
  });
});

describe('overlay — settings dialog (modal)', () => {
  it('opens as a labelled dialog, inerts the Shell, and closes via the Close button', () => {
    const { overlay, shell, settingsBtn } = setup();
    expect(overlay.settingsEl.hidden).toBe(true);
    settingsBtn.click();
    expect(overlay.settingsEl.hidden).toBe(false);
    expect(overlay.settingsEl.getAttribute('role')).toBe('dialog');
    expect(shell.root.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(overlay.settingsEl);

    const closeBtn = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-settings-close')!;
    closeBtn.click();
    expect(overlay.settingsEl.hidden).toBe(true);
    expect(shell.root.hasAttribute('inert')).toBe(false);
  });

  it('aborts an in-flight placement gesture BEFORE inerting the Shell (rotate-open parity)', () => {
    // The abort must run FIRST in the open lifecycle (mirroring rotate.ts's evaluate()):
    // abort → modal.open → auto-pause. Assert the ordering by sampling the Shell's inert
    // state at abort time — it must still be non-inert, i.e. the abort precedes modal.open.
    let inertAtAbort: boolean | null = null;
    let shellRef: { root: HTMLElement } | null = null;
    const abort = vi.fn(() => {
      inertAtAbort = shellRef?.root.hasAttribute('inert') ?? null;
    });
    const { shell, settingsBtn } = setup(fakeEnsurePaused(), abort);
    shellRef = shell;
    settingsBtn.click();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(inertAtAbort).toBe(false); // Shell not yet inert when abort ran → abort before open
    expect(shell.root.hasAttribute('inert')).toBe(true); // and the modal did open afterwards
  });

  it('a held board placement gesture places nothing when settings opens then releases', () => {
    // Full wiring: real controller + real input + real overlay share ONE shell, so the Dock
    // click routes through the overlay's abortGesture into the input manager, exactly as
    // main.ts wires it. Reproduces the P2 finding: a pointer captured on the board before
    // the modal opens still delivers its pointerup to the release path.
    const shell = createShell(document, CARD_DESCRIPTORS);
    document.body.appendChild(shell.root);
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const input = attachInput(
      document,
      shell.board,
      [{ el: shell.cards[0]!.root, towerId: 'basic' }],
      c,
      createKeymap(),
      {
        getRect: () => RECT,
        isModalOpen: () => shell.root.hasAttribute('inert'),
      },
    );
    const overlay = createOverlay(
      document,
      () => {},
      () => c.pause(),
      createSettings(),
      createKeymap(),
      shell,
      ruleset,
      () => input.abort(),
      defaultInstall(),
    );
    document.body.append(
      overlay.resultsEl,
      overlay.settingsEl,
      overlay.instructionsEl,
      overlay.leaveEl,
    );

    c.armTower('basic');
    shell.board.dispatchEvent(ptr('pointerdown', 35, 105, 1)); // held, anchor (3,8)
    expect(c.frame().ghost).not.toBeNull();

    shell.dock.settings.click(); // open settings → abort the gesture, inert the Shell
    expect(shell.root.hasAttribute('inert')).toBe(true);
    expect(c.frame().ghost).toBeNull(); // board-origin abort cleared the ghost…
    expect(c.uiState().armed).toBe('basic'); // …but stays armed (P3 board-flow cancellation)

    shell.board.dispatchEvent(ptr('pointerup', 35, 105, 1)); // the delayed release
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // nothing queued behind the dialog

    input.destroy();
    overlay.destroy();
  });

  it('a held Card drag disarms and places nothing when settings opens then releases', () => {
    const shell = createShell(document, CARD_DESCRIPTORS);
    document.body.appendChild(shell.root);
    const c = createController(1);
    c.start();
    const input = attachInput(
      document,
      shell.board,
      [{ el: shell.cards[0]!.root, towerId: 'basic' }],
      c,
      createKeymap(),
      {
        getRect: () => RECT,
        isModalOpen: () => shell.root.hasAttribute('inert'),
      },
    );
    const overlay = createOverlay(
      document,
      () => {},
      () => c.pause(),
      createSettings(),
      createKeymap(),
      shell,
      ruleset,
      () => input.abort(),
      defaultInstall(),
    );
    document.body.append(
      overlay.resultsEl,
      overlay.settingsEl,
      overlay.instructionsEl,
      overlay.leaveEl,
    );

    shell.cards[0]!.root.dispatchEvent(ptr('pointerdown', 10, 10, 1));
    shell.cards[0]!.root.dispatchEvent(ptr('pointermove', 35, 105, 1)); // crosses the drag threshold → arms
    expect(c.uiState().armed).toBe('basic');

    shell.dock.settings.click(); // open settings → abort → Card-drag disarms
    expect(c.uiState().armed).toBeNull();

    shell.cards[0]!.root.dispatchEvent(ptr('pointerup', 35, 105, 1)); // the delayed release
    c.advance(50);
    expect(c.frame().curVm.towers).toHaveLength(0); // nothing placed

    input.destroy();
    overlay.destroy();
  });

  it('closes on Escape (the modal owner consumes it before any game-level handling)', () => {
    const { overlay, settingsBtn } = setup();
    settingsBtn.click();
    expect(overlay.settingsEl.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(overlay.settingsEl.hidden).toBe(true);
  });

  it('an armed rebind capture wins over Escape-closes-settings ("existing capture wins")', () => {
    const { overlay, keymap, settingsBtn } = setup();
    settingsBtn.click();
    const upBtn = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // arm rebind of 'up'
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    // The rebind capture consumed Escape (aborting the rebind); the dialog stays open.
    expect(overlay.settingsEl.hidden).toBe(false);
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // rebind aborted, not committed
  });

  it('changes the colour-vision mode and reduced-motion via the session settings store', () => {
    const { settings, overlay, settingsBtn } = setup();
    settingsBtn.click();
    const protan = overlay.settingsEl.querySelector<HTMLInputElement>('#wy-cb-protan')!;
    protan.checked = true;
    protan.dispatchEvent(new Event('change'));
    expect(settings.get().colourMode).toBe('protan');

    const motion = overlay.settingsEl.querySelector<HTMLInputElement>('.wy-toggle input')!;
    motion.checked = true;
    motion.dispatchEvent(new Event('change'));
    expect(settings.get().reducedMotion).toBe(true);
  });

  it('rebinds a control by capturing the next key press', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click();
    const firstRebind = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    firstRebind.click(); // enters listen mode for the first action ('up')
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(keymap.codeFor('up')).toBe('KeyW');
    // Displayed via the shared key-label formatter (PLAN.md P2), not the raw stored code —
    // `KeyW` (the code) renders as `W` (the label).
    expect(firstRebind.textContent).toBe('W');
  });

  it('a successful bind stops propagation — the same keydown does not also fire the board action (#43)', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click();
    const upBtn = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // arm rebind of 'up'

    // A real board element elsewhere in the document, with its own bubble-phase keydown
    // listener standing in for `input.ts`'s board action handler — the real event
    // topology (capture on `document` fires first; propagation must not continue to it).
    const board = document.createElement('div');
    document.body.appendChild(board);
    let boardActionFired = false;
    board.addEventListener('keydown', () => {
      boardActionFired = true;
    });

    const evt = new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true, cancelable: true });
    board.dispatchEvent(evt);

    expect(keymap.codeFor('up')).toBe('KeyQ'); // the bind happened
    expect(boardActionFired).toBe(false); // but the board's own action did not execute
  });

  it('does not bind navigation/abort keys: Tab is ignored', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click();
    const upBtn = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // arm rebind of 'up'
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // Tab not captured as a binding
  });

  it('starting a second rebind cancels the first (only one listener captures)', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click();
    const btns = [...overlay.settingsEl.querySelectorAll<HTMLButtonElement>('.wy-rebind-btn')];
    const upBtn = btns[0]!; // 'up'
    const downBtn = btns[1]!; // 'down'
    upBtn.click(); // listening for 'up'
    downBtn.click(); // cancels 'up', now listening for 'down'
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
    expect(keymap.codeFor('down')).toBe('KeyJ');
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // untouched — its capture was cancelled
  });

  it('shows Unbound when a rebind displaces another action off its key', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click();
    const btns = [...overlay.settingsEl.querySelectorAll<HTMLButtonElement>('.wy-rebind-btn')];
    const upBtn = btns[0]!; // 'up' (ArrowUp)
    const downBtn = btns[1]!; // 'down'
    downBtn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' })); // steal up's key
    expect(keymap.codeFor('up')).toBeNull();
    expect(upBtn.textContent).toBe('Unbound');
  });

  it('cancels an armed rebind when the settings dialog is closed', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click(); // open
    overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-rebind-btn')!.click(); // arm rebind of 'up'
    overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-settings-close')!.click(); // close → must cancel the armed capture
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // not hijacked
  });

  it('cancels a pending rebind capture on destroy (no leaked listener)', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click();
    const upBtn = overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // listening
    overlay.destroy();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })); // must NOT rebind
    expect(keymap.codeFor('up')).toBe('ArrowUp');
  });
});

describe('overlay — settings auto-pause (modal family, mirrors rotate)', () => {
  function openClose(overlay: ReturnType<typeof setup>['overlay'], settingsBtn: HTMLButtonElement) {
    settingsBtn.click();
    return overlay.settingsEl.querySelector<HTMLButtonElement>('.wy-settings-close')!;
  }

  it('asks the app-level pause seam when settings OPENS', () => {
    const { overlay, ensurePaused, settingsBtn } = setup();
    expect(ensurePaused).not.toHaveBeenCalled();
    openClose(overlay, settingsBtn);
    expect(ensurePaused).toHaveBeenCalledTimes(1);
  });

  it("asks unconditionally — the started/already-paused guard is the seam's, not the dialog's", () => {
    // Deliberately NOT re-implementing the guard here against a fake (that would only test
    // the fake). The dialog's job is to ask on open, every time; whether asking actually
    // pauses is `ensurePaused`'s, covered in main.test.ts against the real controller.
    const { overlay, ensurePaused, settingsBtn } = setup();
    const closeBtn = openClose(overlay, settingsBtn);
    closeBtn.click();
    settingsBtn.click();
    expect(ensurePaused).toHaveBeenCalledTimes(2);
  });

  it('never asks on CLOSE — the player resumes deliberately from the Dock', () => {
    const { overlay, ensurePaused, settingsBtn } = setup();
    const closeBtn = openClose(overlay, settingsBtn);
    expect(ensurePaused).toHaveBeenCalledTimes(1);
    closeBtn.click();
    expect(overlay.settingsEl.hidden).toBe(true);
    // No further pause-state request of ANY kind on the way out: the overlay's whole
    // controller surface is a single `ensurePaused` callback, so there is no `resume` for it
    // to call even by mistake — the never-auto-resume property is structural here.
    expect(ensurePaused).toHaveBeenCalledTimes(1);
  });

  it('Start still works after a settings open/close round-trip', () => {
    const { actions, overlay, settingsBtn, primaryBtn } = setup();
    const closeBtn = openClose(overlay, settingsBtn);
    closeBtn.click();
    primaryBtn.click();
    expect(actions.map((a) => a.type)).toContain('start');
  });
});

describe('overlay — home link visibility driver', () => {
  /** Drive one `update()` and read back the two attributes the driver writes together. */
  function drive(
    s: ReturnType<typeof setup>,
    over: { started?: boolean; paused?: boolean; phase?: HudVM['phase'] } = {},
  ): { live: boolean; inert: boolean } {
    s.overlay.update({
      hud: hud({ phase: over.phase ?? 'running' }),
      paused: over.paused ?? false,
      speed: 1,
      ui: uiState({ started: over.started ?? false }),
      refund: 0,
    });
    return {
      live: s.shell.home.hasAttribute('data-live'),
      inert: s.shell.home.hasAttribute('inert'),
    };
  }

  const VISIBLE = { live: false, inert: false };
  const HIDDEN = { live: true, inert: true };

  it('sets data-live AND inert together for every started, unpaused, unresolved phase', () => {
    const s = setup();
    // Including the started wave-1 COUNTDOWN — the sim has no "held" concept and reports
    // `running` either way, which is why the rule keys on `ui.started`, not the phase.
    expect(drive(s, { started: true, phase: 'running' })).toEqual(HIDDEN);
  });

  it('clears both while HELD pre-start, while PAUSED, and once TERMINAL', () => {
    const s = setup();
    expect(drive(s, { started: false, phase: 'running' })).toEqual(VISIBLE);
    expect(drive(s, { started: true, phase: 'running', paused: true })).toEqual(VISIBLE);
    expect(drive(s, { started: true, phase: 'won' })).toEqual(VISIBLE);
    expect(drive(s, { started: true, phase: 'lost' })).toEqual(VISIBLE);
  });

  it('a terminal phase wins even when the run is somehow reported unpaused', () => {
    // The resolution branch is a phase test, not a pause test: a resolved run must show the
    // link regardless of the paused flag, so the player can always find their way back out.
    const s = setup();
    expect(drive(s, { started: true, phase: 'won', paused: false })).toEqual(VISIBLE);
  });

  it('flips back and forth cleanly — the attributes are never left stale on either side', () => {
    const s = setup();
    expect(drive(s, { started: true, phase: 'running' })).toEqual(HIDDEN);
    expect(drive(s, { started: true, phase: 'running', paused: true })).toEqual(VISIBLE);
    expect(drive(s, { started: true, phase: 'running' })).toEqual(HIDDEN);
  });
});

describe('overlay — the leave-run confirm dialog (presentation only)', () => {
  it('is a hidden modal dialog sibling until showLeave opens it', () => {
    const s = setup();
    expect(s.overlay.leaveEl.hidden).toBe(true);
    expect(s.overlay.leaveEl.getAttribute('role')).toBe('dialog');
    expect(s.overlay.leaveEl.getAttribute('aria-modal')).toBe('true');
    expect(s.overlay.leaveEl.getAttribute('aria-label')).toBe('Leave this run?');
    // A sibling of the Shell, never inside it — the Shell is the one node the owner inerts.
    expect(s.shell.root.contains(s.overlay.leaveEl)).toBe(false);
  });

  it('opens with focus on Stay (the safe action) and inerts the Shell', () => {
    const s = setup();
    s.overlay.showLeave(() => {});
    expect(s.overlay.leaveEl.hidden).toBe(false);
    expect(document.activeElement).toBe(s.overlay.leaveEl.querySelector('.wy-leave-stay'));
    expect(s.shell.root.hasAttribute('inert')).toBe(true);
    // Its body says what is at stake — the dialog exists to make the cost explicit.
    expect(s.overlay.leaveEl.textContent).toContain('discards this run');
  });

  it('ANNOUNCES the consequence — the body is the dialog’s accessible description', () => {
    // Without `aria-describedby` the dialog is named but not described, and `show()` puts
    // focus straight on Stay — so a screen reader says "Leave this run?, dialog. Stay, button."
    // and the player never hears that leaving discards the run. axe does not flag a missing
    // description, so nothing else in the suite catches this.
    const s = setup();
    const describedBy = s.overlay.leaveEl.getAttribute('aria-describedby');
    expect(describedBy, 'the leave dialog has no accessible description').not.toBeNull();
    const desc = s.overlay.leaveEl.querySelector(`#${describedBy}`);
    expect(desc, 'aria-describedby points at no element inside the dialog').not.toBeNull();
    expect(desc!.textContent).toContain('discards this run');
  });

  it('SURVIVES being deposed by the rotate prompt and re-shown — Confirm still works', () => {
    // The modal owner calls `hide()` on DEPOSITION, not just on close, and leaves the deposed
    // entry on the stack to be re-shown later. Clearing the confirm handler in `hide()` (the
    // obvious-looking place) therefore produced a genuinely dead button on a real phone path:
    // pause → tap home → rotate to portrait → rotate back. `showLeave` cannot repair it,
    // because `modal.open` is idempotent by identity and the entry never left the stack.
    const s = setup();
    const onConfirm = vi.fn();
    s.overlay.showLeave(onConfirm);
    expect(s.overlay.leaveEl.hidden).toBe(false);

    // Rotate (rank 1) outranks this dialog's `settings` (rank 2) → deposed, not closed.
    const rotate: ModalOverlay = { show: vi.fn(), hide: vi.fn() };
    s.overlay.modal.open(rotate, { priority: 'rotate' });
    expect(s.overlay.leaveEl.hidden).toBe(true);

    // Back to landscape: the owner re-activates the stacked dialog.
    s.overlay.modal.close(rotate);
    expect(s.overlay.leaveEl.hidden).toBe(false);

    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-confirm')!.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // The REAL registration `showLeave` performs, not a hand-written copy of it. `modal.test.ts`
  // pins the owner's mechanics given a registration; these two pin the registration itself, so
  // changing the priority or dropping `dismissOnEscape` cannot pass unnoticed.
  it('registers BELOW results — a resolving run keeps the results dialog on top', () => {
    const s = setup();
    s.overlay.showLeave(() => {});
    expect(s.overlay.leaveEl.hidden).toBe(false);

    s.overlay.showResults(
      hud({
        phase: 'won',
        lives: 3,
        bounty: 0,
        countdownSeconds: null,
        score: 10,
        stars: 2,
        won: true,
      }),
    );
    expect(s.overlay.resultsEl.hidden).toBe(false);
    expect(s.overlay.leaveEl.hidden).toBe(true); // deposed by the higher-priority dialog
  });

  it('Escape dismisses it, and dismissing MEANS stay — no confirm handler runs', () => {
    const s = setup();
    const onConfirm = vi.fn();
    s.overlay.showLeave(onConfirm);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    expect(s.overlay.leaveEl.hidden).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(s.shell.root.hasAttribute('inert')).toBe(false);
  });

  it('a Confirm click while the dialog is not showing never fires — the real staleness guard', () => {
    // What actually makes a stale confirmation impossible, on EVERY close route (Stay,
    // Escape, deposition) without a hook on each: leaving a run is destructive, so it only
    // ever fires from a dialog the player can see.
    const s = setup();
    const onConfirm = vi.fn();
    s.overlay.showLeave(onConfirm);
    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-stay')!.click();
    expect(s.overlay.leaveEl.hidden).toBe(true);

    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-confirm')!.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a double Confirm activation navigates ONCE', () => {
    const s = setup();
    const onConfirm = vi.fn();
    s.overlay.showLeave(onConfirm);
    const confirmBtn = s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-confirm')!;
    confirmBtn.click();
    confirmBtn.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight placement gesture on open, like every other modal in the family', () => {
    const abort = vi.fn();
    const s = setup(fakeEnsurePaused(), abort);
    s.overlay.showLeave(() => {});
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('Stay closes without calling the confirm handler', () => {
    const s = setup();
    const onConfirm = vi.fn();
    s.overlay.showLeave(onConfirm);
    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-stay')!.click();
    expect(s.overlay.leaveEl.hidden).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(s.shell.root.hasAttribute('inert')).toBe(false);
  });

  it('Confirm closes and calls the handler exactly once', () => {
    const s = setup();
    const onConfirm = vi.fn();
    s.overlay.showLeave(onConfirm);
    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-confirm')!.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(s.overlay.leaveEl.hidden).toBe(true);
  });

  it('a STALE handler can never fire against a later open', () => {
    // Guarded by the showing check (see above), NOT by clearing on `hide()` — clearing there
    // is what broke the rotate-deposition path. A dialog opened, dismissed, and re-opened with
    // a different handler runs only the newest one, and a Confirm after a Stay runs none.
    const s = setup();
    const first = vi.fn();
    const second = vi.fn();
    s.overlay.showLeave(first);
    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-stay')!.click();
    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-confirm')!.click();
    expect(first).not.toHaveBeenCalled();

    s.overlay.showLeave(second);
    s.overlay.leaveEl.querySelector<HTMLButtonElement>('.wy-leave-confirm')!.click();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('destroy() removes it — no orphan dialog left behind for a recreate to stack on', () => {
    const s = setup();
    expect(document.body.contains(s.overlay.leaveEl)).toBe(true);
    s.overlay.destroy();
    expect(document.body.contains(s.overlay.leaveEl)).toBe(false);
  });
});

describe('overlay — results dialog', () => {
  it('shows a win, offers verify + play-again, and hides again', () => {
    const { actions, overlay } = setup();
    expect(overlay.resultsEl.hidden).toBe(true);

    overlay.showResults(hud({ won: true, score: 120, stars: 3 }));
    expect(overlay.resultsEl.hidden).toBe(false);
    expect(overlay.resultsEl.querySelector('h2')!.textContent).toBe('You held the line!');
    expect(overlay.resultsEl.querySelector('p')!.textContent).toContain('Score 120');

    const resBtns = [...overlay.resultsEl.querySelectorAll<HTMLButtonElement>('.wy-btn')];
    const playAgain = resBtns[0]!;
    const verify = resBtns[1]!;
    verify.click();
    playAgain.click();
    expect(actions.map((a) => a.type)).toEqual(['verify', 'playAgain']);

    overlay.setVerifyMessage('checked');
    expect(overlay.resultsEl.querySelector('.wy-verify')!.textContent).toBe('checked');
    overlay.hideResults();
    expect(overlay.resultsEl.hidden).toBe(true);
  });

  it('shows a loss heading', () => {
    const { overlay } = setup();
    overlay.showResults(hud({ won: false }));
    expect(overlay.resultsEl.querySelector('h2')!.textContent).toBe('The creeps broke through.');
    overlay.destroy();
    expect(document.body.contains(overlay.resultsEl)).toBe(false);
  });
});

describe('overlay — modal priority (results > settings)', () => {
  it('opening results while settings is open hides settings and shows/focuses results', () => {
    const { overlay, settingsBtn } = setup();
    settingsBtn.click();
    expect(overlay.settingsEl.hidden).toBe(false);

    overlay.showResults(hud({ won: true }));
    expect(overlay.settingsEl.hidden).toBe(true); // hidden while a higher-priority modal is up
    expect(overlay.resultsEl.hidden).toBe(false);
    const playAgain = overlay.resultsEl.querySelector<HTMLButtonElement>('.wy-btn')!;
    expect(document.activeElement).toBe(playAgain);
  });
});
