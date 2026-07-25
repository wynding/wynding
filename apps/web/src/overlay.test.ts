import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HudVM } from '@wynding/render';
import { compileRuleset } from '@wynding/sim';
import { m1Ruleset, M1_BOARD_ID } from '@wynding/content';
import { createOverlay, type UiAction } from './overlay';
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

const ruleset = compileRuleset(m1Ruleset, M1_BOARD_ID);

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
    phase: 'pre-wave',
    lives: 10,
    bounty: 80,
    countdownSeconds: 25,
    score: 0,
    stars: 0,
    won: false,
    ...over,
  };
}

/** A neutral (unarmed, unselected) `UiState`, for tests that don't exercise the
 *  armed/selection state machine. */
function uiState(over: Partial<UiState> = {}): UiState {
  return { started: true, armed: null, selection: null, lastOutcome: null, outcomeSeq: 0, ...over };
}

/** A minimal fake of the `Controller` slice `createOverlay` reads for the settings
 *  auto-pause (mirrors `rotate.test.ts`'s fake) — a mutable `started`/`paused` pair plus a
 *  `pause` spy, avoiding the need to stand up a real Controller. */
function fakeController(started = true): {
  uiState: () => { started: boolean };
  isPaused: () => boolean;
  pause: ReturnType<typeof vi.fn>;
  setPaused(v: boolean): void;
} {
  let paused = false;
  const pause = vi.fn(() => {
    paused = true;
  });
  return {
    uiState: () => ({ started }),
    isPaused: () => paused,
    pause,
    setPaused(v: boolean): void {
      paused = v;
    },
  };
}

interface SetupOptions {
  readonly install?: InstallHandle;
}

function setup(
  controller = fakeController(),
  abortGesture: () => void = () => {},
  options: SetupOptions = {},
) {
  const actions: UiAction[] = [];
  const settings = createSettings();
  const keymap = createKeymap();
  const shell = createShell(document);
  document.body.appendChild(shell.root);
  const install = options.install ?? defaultInstall();
  const overlay = createOverlay(
    document,
    (a) => actions.push(a),
    controller,
    settings,
    keymap,
    shell,
    ruleset,
    abortGesture,
    install,
  );
  document.body.append(overlay.resultsEl, overlay.settingsEl, overlay.instructionsEl);
  return {
    actions,
    controller,
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
    card: shell.card,
    panel: shell.panel,
    live: shell.live,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('overlay — HUD readout', () => {
  it('renders lives/gold/score/stars and the pre-wave countdown, then the active label', () => {
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

    overlay.update({
      hud: hud({ countdownSeconds: null, phase: 'active' }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.hud.wave.full.textContent).toBe('Wave in progress');
    expect(shell.hud.wave.glance.textContent).toBe('▶');
    expect(shell.hud.wave.root.hidden).toBe(false);

    // Terminal phase also has countdownSeconds null, but must NOT say "in progress" — the
    // wave slot hides entirely (the outcome is the results dialog), with its full-form node
    // retained and empty.
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

describe('overlay — player-started runs (PLAN.md P4)', () => {
  it('pre-start: Pause is hidden, the primary Dock button reads Start, and the wave slot is hidden (four visible chips)', () => {
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
    // Story 11 P1's wave-slot states: pre-start the slot is HIDDEN with its full-form node
    // retained and empty — the sim's countdown never ticks down while held, and the Dock's
    // "Start" button already carries the prompt. Four of the five chip slots are visible.
    expect(shell.hud.wave.full.textContent).toBe('');
    expect(shell.hud.wave.root.hidden).toBe(true);
    const visible = [...shell.hudBox.children].filter((el) => !(el as HTMLElement).hidden);
    expect(visible).toHaveLength(4);
  });

  it('once started: Pause is visible, the primary Dock button hides for the rest of the run', () => {
    const { overlay, pauseBtn, primaryBtn } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ started: true }),
      refund: 0,
    });
    expect(pauseBtn.hidden).toBe(false);
    expect(primaryBtn.hidden).toBe(true);
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

    const closeBtn = panel.root.querySelector<HTMLButtonElement>('.wy-btn')!;
    closeBtn.click();
    expect(actions.map((a) => a.type)).toEqual(['closePanel']);
  });

  it('the Panel shows a selected tower with Sell (live refund) and a permanent Max-level Upgrade', () => {
    const { overlay, panel, actions } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ selection: { col: 1, row: 1, id: 7 } }),
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
    const selection = { col: 1, row: 1, id: 7 };
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

  it('closing the Panel from a DESELECT while a Panel control has focus re-homes focus to the board', () => {
    const { overlay, shell, panel } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ selection: { col: 1, row: 1, id: 7 } }),
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
    expect(render({ kind: 'armed' })).toBe('Basic Tower armed. Place it on the board.');
    expect(render({ kind: 'disarmed' })).toBe('Placement cancelled.');
    expect(render({ kind: 'placed' })).toBe('Basic Tower placed.');
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
      ui: uiState({ lastOutcome: { kind: 'placed' as const } }),
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

  it('fails closed (throws) for an unknown tower kind rather than inventing stats', () => {
    const { overlay } = setup();
    // M1's `ArmedTower` union is the single literal 'basic' — a future kind reaching the
    // Panel without being taught its stats is a programmer error. Force that path with an
    // unsafe cast (the only way to construct an invalid `ArmedTower` at the type level).
    expect(() =>
      overlay.update({
        hud: hud(),
        paused: false,
        speed: 1,
        ui: uiState({ armed: 'turret' as unknown as UiState['armed'] }),
        refund: 0,
      }),
    ).toThrow(/unknown tower kind/);
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
    const s = setup(fakeController(), options.abortGesture ?? (() => {}), { install });
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

  it('re-homes banner focus to the board (not the hidden Start button) on the Start edge', () => {
    // On the Start edge `update()` hides `primaryBtn` BEFORE `renderInstall` re-homes banner
    // focus, so re-homing to Start would `focus()` a hidden element and strand focus on
    // `document.body`. The fallback must be a guaranteed-focusable target — the board.
    const s = installSetup();
    s.target.dispatch(fakePromptEvent().event);
    s.render(false);
    s.shell.banner.action.focus();
    expect(document.activeElement).toBe(s.shell.banner.action);

    s.render(true); // Start: the banner hides AND primaryBtn hides in the same update()
    expect(bannerVisible(s.shell)).toBe(false);
    expect(s.shell.dock.primary.hidden).toBe(true);
    expect(document.activeElement).toBe(s.shell.board);
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
    const { shell, settingsBtn } = setup(fakeController(), abort);
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
    const shell = createShell(document);
    document.body.appendChild(shell.root);
    const c = createController(1);
    c.start(); // PLAN.md P4: advance() no-ops while held
    const input = attachInput(document, shell.board, [shell.card.root], c, createKeymap(), {
      getRect: () => RECT,
      isModalOpen: () => shell.root.hasAttribute('inert'),
    });
    const overlay = createOverlay(
      document,
      () => {},
      c,
      createSettings(),
      createKeymap(),
      shell,
      ruleset,
      () => input.abort(),
      defaultInstall(),
    );
    document.body.append(overlay.resultsEl, overlay.settingsEl, overlay.instructionsEl);

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
    const shell = createShell(document);
    document.body.appendChild(shell.root);
    const c = createController(1);
    c.start();
    const input = attachInput(document, shell.board, [shell.card.root], c, createKeymap(), {
      getRect: () => RECT,
      isModalOpen: () => shell.root.hasAttribute('inert'),
    });
    const overlay = createOverlay(
      document,
      () => {},
      c,
      createSettings(),
      createKeymap(),
      shell,
      ruleset,
      () => input.abort(),
      defaultInstall(),
    );
    document.body.append(overlay.resultsEl, overlay.settingsEl, overlay.instructionsEl);

    shell.card.root.dispatchEvent(ptr('pointerdown', 10, 10, 1));
    shell.card.root.dispatchEvent(ptr('pointermove', 35, 105, 1)); // crosses the drag threshold → arms
    expect(c.uiState().armed).toBe('basic');

    shell.dock.settings.click(); // open settings → abort → Card-drag disarms
    expect(c.uiState().armed).toBeNull();

    shell.card.root.dispatchEvent(ptr('pointerup', 35, 105, 1)); // the delayed release
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

  it('auto-pauses an active, unpaused run when settings opens', () => {
    const { overlay, controller, settingsBtn } = setup(fakeController(true));
    expect(controller.pause).not.toHaveBeenCalled();
    openClose(overlay, settingsBtn);
    expect(controller.pause).toHaveBeenCalledTimes(1);
  });

  it('stays paused on close — the player resumes deliberately from the Dock', () => {
    const { overlay, controller, settingsBtn } = setup(fakeController(true));
    const closeBtn = openClose(overlay, settingsBtn);
    expect(controller.isPaused()).toBe(true);
    closeBtn.click();
    expect(overlay.settingsEl.hidden).toBe(true);
    expect(controller.isPaused()).toBe(true); // no auto-resume — closing settings never resumes
  });

  it('does not auto-pause pre-start (nothing to pause); Start still works after close', () => {
    const { actions, overlay, controller, settingsBtn, primaryBtn } = setup(fakeController(false));
    const closeBtn = openClose(overlay, settingsBtn);
    expect(controller.pause).not.toHaveBeenCalled();
    closeBtn.click();
    // The Dock's Start action is unaffected by the settings open/close round-trip.
    primaryBtn.click();
    expect(actions.map((a) => a.type)).toContain('start');
  });

  it('is idempotent when already paused — pauses once, and close does not resume', () => {
    const controller = fakeController(true);
    controller.setPaused(true); // already paused (e.g. rotate auto-paused first)
    const { overlay, settingsBtn } = setup(controller);
    const closeBtn = openClose(overlay, settingsBtn);
    expect(controller.pause).not.toHaveBeenCalled(); // guard sees isPaused() — no double-pause
    expect(controller.isPaused()).toBe(true);
    closeBtn.click();
    expect(controller.isPaused()).toBe(true);
  });

  it('opening settings during a rotate-paused run leaves the pause state uncorrupted', () => {
    // Rotate auto-paused first (started + paused). Settings opening on top must not pause
    // again, and closing must not resume — a single, stable pause across both modals.
    const controller = fakeController(true);
    controller.setPaused(true);
    const { overlay, settingsBtn } = setup(controller);
    const closeBtn = openClose(overlay, settingsBtn);
    closeBtn.click();
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.isPaused()).toBe(true);
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
