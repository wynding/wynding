import { describe, it, expect, beforeEach } from 'vitest';
import type { HudVM } from '@wynding/render';
import { createOverlay, type UiAction } from './overlay';
import { createShell } from './shell';
import { createSettings } from './settings';
import { createKeymap } from './keymap';

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

function setup() {
  const actions: UiAction[] = [];
  const settings = createSettings();
  const keymap = createKeymap();
  const shell = createShell(document);
  document.body.appendChild(shell.root);
  const overlay = createOverlay(document, (a) => actions.push(a), settings, keymap, shell);
  document.body.append(overlay.resultsEl, overlay.settingsEl);
  return {
    actions,
    settings,
    keymap,
    shell,
    overlay,
    pauseBtn: shell.dock.pause,
    speedBtn: shell.dock.speed,
    callBtn: shell.dock.callWave,
    sellBtn: shell.dock.sell,
    settingsBtn: shell.dock.settings,
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
      canSell: false,
      refund: 0,
      canCallWave: true,
    });
    const text = shell.hud.lives.parentElement!.textContent!;
    expect(text).toContain('Lives: 10');
    expect(text).toContain('Bounty: 80');
    expect(text).toContain('Wave in 25s');

    overlay.update({
      hud: hud({ countdownSeconds: null, phase: 'active' }),
      paused: false,
      speed: 1,
      canSell: false,
      refund: 0,
      canCallWave: false,
    });
    expect(shell.hud.wave.textContent).toBe('Wave in progress');

    // Terminal phase also has countdownSeconds null, but must NOT say "in progress".
    overlay.update({
      hud: hud({ countdownSeconds: null, phase: 'lost', won: false }),
      paused: false,
      speed: 1,
      canSell: false,
      refund: 0,
      canCallWave: false,
    });
    expect(shell.hud.wave.textContent).toBe('');
  });

  it('reflects pause/speed/sell/call state on the controls', () => {
    const { overlay, pauseBtn, speedBtn, sellBtn, callBtn } = setup();
    overlay.update({
      hud: hud(),
      paused: true,
      speed: 2,
      canSell: true,
      refund: 40,
      canCallWave: false,
    });
    expect(pauseBtn.textContent).toBe('Resume');
    expect(pauseBtn.getAttribute('aria-pressed')).toBe('true');
    expect(speedBtn.textContent).toBe('Speed: 2x');
    expect(sellBtn.disabled).toBe(false);
    expect(sellBtn.textContent).toBe('Sell tower (refund 40)');
    expect(callBtn.disabled).toBe(true);

    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      canSell: false,
      refund: 0,
      canCallWave: true,
    });
    expect(pauseBtn.textContent).toBe('Pause');
    expect(sellBtn.disabled).toBe(true);
    expect(callBtn.disabled).toBe(false);
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
    const { actions, pauseBtn, speedBtn, callBtn, sellBtn } = setup();
    pauseBtn.click();
    speedBtn.click();
    callBtn.click();
    sellBtn.click();
    expect(actions.map((a) => a.type)).toEqual(['togglePause', 'cycleSpeed', 'callWave', 'sell']);
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
    expect(firstRebind.textContent).toBe('KeyW');
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
