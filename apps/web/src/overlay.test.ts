import { describe, it, expect, beforeEach } from 'vitest';
import type { HudVM } from '@wynding/render';
import { compileRuleset } from '@wynding/sim';
import { m1Ruleset, M1_BOARD_ID } from '@wynding/content';
import { createOverlay, type UiAction } from './overlay';
import { createShell } from './shell';
import { createSettings } from './settings';
import { createKeymap } from './keymap';
import type { UiState } from './controller';

const ruleset = compileRuleset(m1Ruleset, M1_BOARD_ID);

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

function setup() {
  const actions: UiAction[] = [];
  const settings = createSettings();
  const keymap = createKeymap();
  const shell = createShell(document);
  document.body.appendChild(shell.root);
  const overlay = createOverlay(document, (a) => actions.push(a), settings, keymap, shell, ruleset);
  document.body.append(overlay.resultsEl, overlay.settingsEl);
  return {
    actions,
    settings,
    keymap,
    shell,
    overlay,
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
    const text = shell.hud.lives.parentElement!.textContent!;
    expect(text).toContain('Lives: 10');
    expect(text).toContain('Bounty: 80');
    expect(text).toContain('Wave in 25s');

    overlay.update({
      hud: hud({ countdownSeconds: null, phase: 'active' }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.hud.wave.textContent).toBe('Wave in progress');

    // Terminal phase also has countdownSeconds null, but must NOT say "in progress".
    overlay.update({
      hud: hud({ countdownSeconds: null, phase: 'lost', won: false }),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(shell.hud.wave.textContent).toBe('');
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
    expect(pauseBtn.textContent).toBe('Resume');
    expect(pauseBtn.getAttribute('aria-pressed')).toBe('true');
    expect(speedBtn.textContent).toBe('Speed: 2x');

    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState(),
      refund: 0,
    });
    expect(pauseBtn.textContent).toBe('Pause');
  });
});

describe('overlay — player-started runs (PLAN.md P4)', () => {
  it('pre-start: Pause is hidden, the primary Dock button reads Start, and the wave slot prompts to begin', () => {
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
    expect(primaryBtn.textContent).toBe('Start');
    expect(shell.hud.wave.textContent).toBe('Press Start to begin');
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
    expect(render({ kind: 'armed' })).toBe(
      'Basic Tower armed. Click or tap the board to place it.',
    );
    expect(render({ kind: 'disarmed' })).toBe('Placement cancelled.');
    expect(render({ kind: 'placed' })).toBe('Basic Tower placed.');
    expect(render({ kind: 'rejected', reason: 'bounty' })).toBe('Not enough Bounty.');
    expect(render({ kind: 'rejected', reason: 'occupied' })).toBe('That cell is already occupied.');
    expect(render({ kind: 'rejected', reason: 'other' })).toBe("Can't build there.");
    expect(render({ kind: 'sold', refund: 12 })).toBe('Tower sold. Refunded 12 Bounty.');
  });

  it('the live region is NOT re-written when the outcome message is unchanged (no stale re-announcement every tick)', () => {
    const { overlay, live } = setup();
    // Spy on the `textContent` SETTER (own-property override shadows the inherited
    // Node.prototype accessor for this one element) so the assertion is about whether the
    // write happened at all, not just about the value it would have written.
    let writeCount = 0;
    const native = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
    Object.defineProperty(live, 'textContent', {
      configurable: true,
      get(): string | null {
        return native.get!.call(live) as string | null;
      },
      set(v: string | null) {
        writeCount++;
        native.set!.call(live, v);
      },
    });
    const frame = {
      hud: hud(),
      paused: false,
      speed: 1,
      ui: uiState({ lastOutcome: { kind: 'placed' as const } }),
      refund: 0,
    };
    overlay.update(frame); // first render: establishes the message, one write
    expect(writeCount).toBe(1);
    writeCount = 0;
    overlay.update(frame); // the HUD's every-tick update, SAME lastOutcome — no re-write
    expect(writeCount).toBe(0);
  });

  it('the SAME outcome recorded twice in a row (e.g. rejecting the same occupied cell twice) is announced BOTH times — a new outcomeSeq forces a real textContent mutation even though the message text is identical (Fix A)', () => {
    const { overlay, live } = setup();
    let writeCount = 0;
    const native = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
    Object.defineProperty(live, 'textContent', {
      configurable: true,
      get(): string | null {
        return native.get!.call(live) as string | null;
      },
      set(v: string | null) {
        writeCount++;
        native.set!.call(live, v);
      },
    });
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
    expect(writeCount).toBe(1);
    const firstText = live.textContent;
    expect(firstText).toBe('That cell is already occupied.');

    overlay.update(frameFor(2)); // SAME message, but a NEW recorded outcome (seq bumped)
    expect(writeCount).toBe(2); // a real DOM mutation happened...
    expect(live.textContent).not.toBe(firstText); // ...distinguishable from the first write...
    expect(live.textContent!.trim()).toBe('That cell is already occupied.'); // ...but still reads the same to a human
  });

  it('arming via the Card emits armTower', () => {
    const { actions, card } = setup();
    card.root.click();
    expect(actions).toEqual([{ type: 'armTower', tower: 'basic' }]);
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

describe('overlay — accessibility semantics', () => {
  it('the HUD is a labelled group, NOT a chatty live region', () => {
    const { shell } = setup();
    const hudGroup = shell.hud.lives.parentElement!;
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
