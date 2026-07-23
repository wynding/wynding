import { describe, it, expect, beforeEach } from 'vitest';
import type { HudVM } from '@wynding/render';
import { createOverlay, type UiAction } from './overlay';
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
  const overlay = createOverlay(document, (a) => actions.push(a), settings, keymap);
  document.body.appendChild(overlay.root);
  const c = [...overlay.root.querySelectorAll<HTMLButtonElement>('.wy-controls .wy-btn')];
  return {
    actions,
    settings,
    keymap,
    overlay,
    pauseBtn: c[0]!,
    speedBtn: c[1]!,
    callBtn: c[2]!,
    sellBtn: c[3]!,
    settingsBtn: c[4]!,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('overlay — HUD readout', () => {
  it('renders lives/gold/score/stars and the pre-wave countdown, then the active label', () => {
    const { overlay } = setup();
    overlay.update({
      hud: hud(),
      paused: false,
      speed: 1,
      canSell: false,
      refund: 0,
      canCallWave: true,
    });
    const text = document.querySelector('.wy-hud')!.textContent!;
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
    const waveEl = document.querySelectorAll('.wy-hud span')[3]!;
    expect(waveEl.textContent).toBe('Wave in progress');

    // Terminal phase also has countdownSeconds null, but must NOT say "in progress".
    overlay.update({
      hud: hud({ countdownSeconds: null, phase: 'lost', won: false }),
      paused: false,
      speed: 1,
      canSell: false,
      refund: 0,
      canCallWave: false,
    });
    expect(waveEl.textContent).toBe('');
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
    const { overlay } = setup();
    const hud = overlay.root.querySelector('.wy-hud')!;
    expect(hud.getAttribute('role')).toBe('group');
    expect(hud.getAttribute('aria-live')).toBeNull(); // no ~20×/s announcement flood
    expect(hud.getAttribute('aria-label')).toBe('Game status');
  });

  it('showResults traps focus in the dialog and makes the game behind it inert', () => {
    const { overlay } = setup();
    overlay.showResults(hud({ won: true }));
    const controls = overlay.root.querySelector('.wy-controls')!;
    expect(controls.hasAttribute('inert')).toBe(true);
    expect(overlay.root.querySelector('.wy-hud')!.hasAttribute('inert')).toBe(true);
    const playAgain = overlay.root.querySelector<HTMLButtonElement>('.wy-results .wy-btn')!;
    expect(document.activeElement).toBe(playAgain); // focus moved into the dialog
    overlay.hideResults();
    expect(controls.hasAttribute('inert')).toBe(false); // restored on close
  });

  it('inerts an external board while modal and restores focus to it on close', () => {
    const actions: UiAction[] = [];
    const board = document.createElement('div');
    board.tabIndex = 0;
    document.body.appendChild(board);
    const overlay = createOverlay(
      document,
      (a) => actions.push(a),
      createSettings(),
      createKeymap(),
      {
        inertWhileModal: [board],
        restoreFocusOnClose: board,
      },
    );
    document.body.appendChild(overlay.root);

    overlay.showResults(hud({ won: false }));
    expect(board.hasAttribute('inert')).toBe(true); // sibling board inerted too
    overlay.hideResults();
    expect(board.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(board); // focus restored, not dropped to <body>
  });

  it('restores a rebind button accessible name when the capture is cancelled', () => {
    const { overlay, settingsBtn } = setup();
    settingsBtn.click(); // open
    const upBtn = overlay.root.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // arm → aria-label becomes the "Press a key…" prompt
    expect(upBtn.getAttribute('aria-label')).toContain('Press a key');
    settingsBtn.click(); // close → cancels capture and must restore the label
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

describe('overlay — accessibility settings panel', () => {
  it('toggles the settings panel and its aria-expanded', () => {
    const { settingsBtn, overlay } = setup();
    const panel = overlay.root.querySelector<HTMLElement>('.wy-settings')!;
    expect(panel.hidden).toBe(true);
    settingsBtn.click();
    expect(panel.hidden).toBe(false);
    expect(settingsBtn.getAttribute('aria-expanded')).toBe('true');
    settingsBtn.click();
    expect(panel.hidden).toBe(true);
  });

  it('changes the colour-vision mode and reduced-motion via the session settings store', () => {
    const { settings, overlay } = setup();
    const protan = overlay.root.querySelector<HTMLInputElement>('#wy-cb-protan')!;
    protan.checked = true;
    protan.dispatchEvent(new Event('change'));
    expect(settings.get().colourMode).toBe('protan');

    const motion = overlay.root.querySelector<HTMLInputElement>('.wy-toggle input')!;
    motion.checked = true;
    motion.dispatchEvent(new Event('change'));
    expect(settings.get().reducedMotion).toBe(true);
  });

  it('rebinds a control by capturing the next key press', () => {
    const { keymap, overlay } = setup();
    const firstRebind = overlay.root.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    firstRebind.click(); // enters listen mode for the first action ('up')
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(keymap.codeFor('up')).toBe('KeyW');
    expect(firstRebind.textContent).toBe('KeyW');
  });

  it('does not bind navigation/abort keys: Escape cancels the rebind, Tab is ignored', () => {
    const { keymap, overlay } = setup();
    const upBtn = overlay.root.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // arm rebind of 'up'
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // Escape aborted, no rebind
    expect(upBtn.getAttribute('aria-label')).toContain('Rebind'); // label restored

    upBtn.click(); // arm again
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // Tab not captured as a binding
  });

  it('starting a second rebind cancels the first (only one listener captures)', () => {
    const { keymap, overlay } = setup();
    const btns = [...overlay.root.querySelectorAll<HTMLButtonElement>('.wy-rebind-btn')];
    const upBtn = btns[0]!; // 'up'
    const downBtn = btns[1]!; // 'down'
    upBtn.click(); // listening for 'up'
    downBtn.click(); // cancels 'up', now listening for 'down'
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
    expect(keymap.codeFor('down')).toBe('KeyJ');
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // untouched — its capture was cancelled
  });

  it('shows Unbound when a rebind displaces another action off its key', () => {
    const { keymap, overlay } = setup();
    const btns = [...overlay.root.querySelectorAll<HTMLButtonElement>('.wy-rebind-btn')];
    const upBtn = btns[0]!; // 'up' (ArrowUp)
    const downBtn = btns[1]!; // 'down'
    downBtn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' })); // steal up's key
    expect(keymap.codeFor('up')).toBeNull();
    expect(upBtn.textContent).toBe('Unbound');
  });

  it('cancels an armed rebind when the settings panel is closed', () => {
    const { keymap, overlay, settingsBtn } = setup();
    settingsBtn.click(); // open panel
    overlay.root.querySelector<HTMLButtonElement>('.wy-rebind-btn')!.click(); // arm rebind of 'up'
    settingsBtn.click(); // close panel → must cancel the armed capture
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(keymap.codeFor('up')).toBe('ArrowUp'); // not hijacked
  });

  it('cancels a pending rebind capture on destroy (no leaked listener)', () => {
    const { keymap, overlay } = setup();
    const upBtn = overlay.root.querySelector<HTMLButtonElement>('.wy-rebind-btn')!;
    upBtn.click(); // listening
    overlay.destroy();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })); // must NOT rebind
    expect(keymap.codeFor('up')).toBe('ArrowUp');
  });
});

describe('overlay — results panel', () => {
  it('shows a win, offers verify + play-again, and hides again', () => {
    const { actions, overlay } = setup();
    const results = overlay.root.querySelector<HTMLElement>('.wy-results')!;
    expect(results.hidden).toBe(true);

    overlay.showResults(hud({ won: true, score: 120, stars: 3 }));
    expect(results.hidden).toBe(false);
    expect(results.querySelector('h2')!.textContent).toBe('You held the line!');
    expect(results.querySelector('p')!.textContent).toContain('Score 120');

    const resBtns = [...results.querySelectorAll<HTMLButtonElement>('.wy-btn')];
    const playAgain = resBtns[0]!;
    const verify = resBtns[1]!;
    verify.click();
    playAgain.click();
    expect(actions.map((a) => a.type)).toEqual(['verify', 'playAgain']);

    overlay.setVerifyMessage('checked');
    expect(overlay.root.querySelector('.wy-verify')!.textContent).toBe('checked');
    overlay.hideResults();
    expect(results.hidden).toBe(true);
  });

  it('shows a loss heading', () => {
    const { overlay } = setup();
    overlay.showResults(hud({ won: false }));
    expect(overlay.root.querySelector('.wy-results h2')!.textContent).toBe(
      'The creeps broke through.',
    );
    overlay.destroy();
    expect(document.querySelector('.wy-overlay')).toBeNull();
  });
});
