// overlay.ts — the DOM HUD + controls + accessibility settings + results panel (ADR
// 0003 §3: the HUD/controls are a DOM overlay, NOT canvas text, so axe audits real
// semantic elements, text resizes to 200% and reflows, and focus/keyboard are native).
// Every user-facing string comes through `t()` (the no-ui-literals rule forbids raw
// literals in text sinks). Buttons are real <button>s sized ≥ 44×44 CSS px via ui.css.
// Colour is always paired with text/shape — never the sole signal.

import { COLOUR_MODES, type HudVM, type ColourMode } from '@wynding/render';
import { t } from './i18n/t';
import type { SettingsStore } from './settings';
import { GAME_ACTIONS, type GameAction, type Keymap } from './keymap';

/** A player intent emitted by the overlay for the app to route to the controller. */
export type UiAction =
  | { readonly type: 'togglePause' }
  | { readonly type: 'cycleSpeed' }
  | { readonly type: 'callWave' }
  | { readonly type: 'sell' }
  | { readonly type: 'playAgain' }
  | { readonly type: 'verify' };

/** Live HUD numbers + control availability for one refresh. */
export interface HudView {
  readonly hud: HudVM;
  readonly paused: boolean;
  readonly speed: number;
  readonly canSell: boolean;
  readonly refund: number;
  readonly canCallWave: boolean;
}

export interface Overlay {
  readonly root: HTMLElement;
  update(view: HudView): void;
  showResults(hud: HudVM): void;
  hideResults(): void;
  setVerifyMessage(message: string): void;
  destroy(): void;
}

// These maps deliberately pass each catalog key as an explicit STRING-LITERAL argument
// rather than a computed template key (e.g. one built from the mode/action name): the i18n
// extraction gate (scripts/i18n-check.mjs) discovers used keys by matching string-literal
// arguments, so a computed key would read as unused and FAIL CI. The Record type also
// enforces exhaustive coverage, and the thunks defer resolution for a future locale switch.
const COLOUR_LABEL: Record<ColourMode, () => string> = {
  default: () => t('settings.colourMode.default'),
  protan: () => t('settings.colourMode.protan'),
  deutan: () => t('settings.colourMode.deutan'),
  tritan: () => t('settings.colourMode.tritan'),
};
const ACTION_LABEL: Record<GameAction, () => string> = {
  up: () => t('action.up'),
  down: () => t('action.down'),
  left: () => t('action.left'),
  right: () => t('action.right'),
  confirm: () => t('action.confirm'),
  sell: () => t('action.sell'),
  callWave: () => t('action.callWave'),
  pause: () => t('action.pause'),
  speed: () => t('action.speed'),
};

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

export interface OverlayOptions {
  /** Extra elements OUTSIDE the overlay (e.g. the game board, a sibling in the app root)
   *  to mark `inert` while the results dialog is open, completing the modal focus trap. */
  readonly inertWhileModal?: readonly HTMLElement[];
  /** Where to move focus when the results dialog closes (else focus falls to <body>). */
  readonly restoreFocusOnClose?: HTMLElement | null;
}

/**
 * Build the overlay into `doc`. `onAction` receives control intents; `settings`/`keymap`
 * are mutated directly by the settings panel (session-scoped). Returns a handle whose
 * `update()` refreshes the HUD each frame and `showResults()` reveals the end screen.
 */
export function createOverlay(
  doc: Document,
  onAction: (action: UiAction) => void,
  settings: SettingsStore,
  keymap: Keymap,
  options: OverlayOptions = {},
): Overlay {
  const root = doc.createElement('div');
  root.className = 'wy-overlay';

  // --- HUD readout ---
  // A labelled group, NOT a live region: these numbers change up to ~20×/s during
  // combat, so a polite live region would flood the AT announcement queue and drown out
  // the results dialog. Players read the HUD visually / on demand; only the results
  // dialog (a role=dialog) announces the outcome.
  const hudBox = doc.createElement('div');
  hudBox.className = 'wy-hud';
  hudBox.setAttribute('role', 'group');
  hudBox.setAttribute('aria-label', t('hud.label'));
  const livesEl = doc.createElement('span');
  const bountyEl = doc.createElement('span');
  const scoreEl = doc.createElement('span');
  const waveEl = doc.createElement('span');
  const starsEl = doc.createElement('span');
  hudBox.append(livesEl, bountyEl, scoreEl, waveEl, starsEl);

  // --- Controls ---
  const controls = doc.createElement('div');
  controls.className = 'wy-controls';
  const pauseBtn = button(doc, 'wy-btn', t('controls.pause'));
  const speedBtn = button(doc, 'wy-btn', t('controls.speed', { factor: 1 }));
  const callBtn = button(doc, 'wy-btn', t('controls.callWave'));
  const sellBtn = button(doc, 'wy-btn', t('controls.sell', { refund: 0 }));
  const settingsBtn = button(doc, 'wy-btn', t('controls.settings'));
  settingsBtn.setAttribute('aria-expanded', 'false');
  controls.append(pauseBtn, speedBtn, callBtn, sellBtn, settingsBtn);

  pauseBtn.addEventListener('click', () => onAction({ type: 'togglePause' }));
  speedBtn.addEventListener('click', () => onAction({ type: 'cycleSpeed' }));
  callBtn.addEventListener('click', () => onAction({ type: 'callWave' }));
  sellBtn.addEventListener('click', () => onAction({ type: 'sell' }));

  // --- Settings panel (session-scoped a11y) ---
  const panel = doc.createElement('section');
  panel.className = 'wy-settings';
  panel.hidden = true;
  panel.setAttribute('aria-label', t('settings.title'));
  const heading = doc.createElement('h2');
  heading.textContent = t('settings.title');
  panel.appendChild(heading);

  // Colour-vision mode
  const cbGroup = doc.createElement('fieldset');
  const cbLegend = doc.createElement('legend');
  cbLegend.textContent = t('settings.colourMode');
  cbGroup.appendChild(cbLegend);
  for (const mode of COLOUR_MODES) {
    const id = `wy-cb-${mode}`;
    const label = doc.createElement('label');
    label.htmlFor = id;
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = 'wy-colour-mode';
    radio.id = id;
    radio.value = mode;
    radio.checked = settings.get().colourMode === mode;
    radio.addEventListener('change', () => {
      if (radio.checked) settings.setColourMode(mode);
    });
    const span = doc.createElement('span');
    span.textContent = COLOUR_LABEL[mode]();
    label.append(radio, span);
    cbGroup.appendChild(label);
  }
  panel.appendChild(cbGroup);

  // Reduced motion
  const motionLabel = doc.createElement('label');
  motionLabel.className = 'wy-toggle';
  const motion = doc.createElement('input');
  motion.type = 'checkbox';
  motion.checked = settings.get().reducedMotion;
  motion.addEventListener('change', () => settings.setReducedMotion(motion.checked));
  const motionText = doc.createElement('span');
  motionText.textContent = t('settings.reducedMotion');
  motionLabel.append(motion, motionText);
  panel.appendChild(motionLabel);

  // Rebindable controls. Only ONE rebind can be listening at a time: starting a new
  // rebind (or destroying the overlay) cancels any pending capture, so an abandoned
  // rebind can never silently steal the next unrelated keypress or leak a listener.
  const rebindList = doc.createElement('ul');
  rebindList.className = 'wy-rebind';
  const rebindButtons = new Map<GameAction, HTMLButtonElement>();
  let cancelCapture: (() => void) | null = null;

  const codeLabel = (action: GameAction): string => keymap.codeFor(action) ?? t('settings.unbound');

  for (const action of GAME_ACTIONS) {
    const li = doc.createElement('li');
    const name = doc.createElement('span');
    name.textContent = ACTION_LABEL[action]();
    const rebindBtn = button(doc, 'wy-btn wy-rebind-btn', codeLabel(action));
    rebindBtn.setAttribute('aria-label', t('settings.rebind', { action: ACTION_LABEL[action]() }));
    rebindBtn.addEventListener('click', () => {
      cancelCapture?.(); // cancel any other in-flight rebind first
      rebindBtn.setAttribute(
        'aria-label',
        t('settings.rebind.prompt', { action: ACTION_LABEL[action]() }),
      );
      rebindBtn.classList.add('wy-listening');
      const capture = (e: KeyboardEvent): void => {
        // Never consume navigation/abort keys — that would trap a keyboard/AT user in the
        // rebind. Escape aborts the rebind; Tab is allowed to move focus (both unbindable).
        if (e.code === 'Escape') {
          e.preventDefault();
          cancelCapture?.();
          return;
        }
        if (e.code === 'Tab') {
          cancelCapture?.(); // let the browser move focus (no preventDefault)
          return;
        }
        e.preventDefault();
        keymap.rebind(action, e.code);
        cancelCapture?.(); // tears down the listener AND refreshes labels (incl. this button)
      };
      cancelCapture = (): void => {
        doc.removeEventListener('keydown', capture, true);
        rebindBtn.classList.remove('wy-listening');
        cancelCapture = null;
        refreshRebindLabels(); // restore the accessible name (drop the "Press a key…" prompt)
      };
      doc.addEventListener('keydown', capture, true);
    });
    rebindButtons.set(action, rebindBtn);
    li.append(name, rebindBtn);
    rebindList.appendChild(li);
  }
  panel.appendChild(rebindList);

  function refreshRebindLabels(): void {
    for (const [action, btn] of rebindButtons) {
      btn.textContent = codeLabel(action);
      btn.setAttribute('aria-label', t('settings.rebind', { action: ACTION_LABEL[action]() }));
    }
  }

  settingsBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!panel.hidden));
    // Closing the panel abandons any armed rebind — otherwise its capture listener would
    // survive the panel and hijack the next in-game keypress.
    if (panel.hidden) cancelCapture?.();
  });

  // --- Results overlay ---
  const results = doc.createElement('div');
  results.className = 'wy-results';
  results.setAttribute('role', 'dialog');
  results.setAttribute('aria-modal', 'true');
  results.hidden = true;
  const resultTitle = doc.createElement('h2');
  const resultSummary = doc.createElement('p');
  const playAgainBtn = button(doc, 'wy-btn wy-primary', t('controls.playAgain'));
  const verifyBtn = button(doc, 'wy-btn', t('controls.verify'));
  const verifyMsg = doc.createElement('p');
  verifyMsg.className = 'wy-verify';
  verifyMsg.setAttribute('role', 'status');
  verifyMsg.setAttribute('aria-live', 'polite');
  playAgainBtn.addEventListener('click', () => onAction({ type: 'playAgain' }));
  verifyBtn.addEventListener('click', () => onAction({ type: 'verify' }));
  results.append(resultTitle, resultSummary, playAgainBtn, verifyBtn, verifyMsg);

  root.append(hudBox, controls, panel, results);

  // The full set inerted while the results dialog is modal: the overlay's own regions plus
  // any external siblings (the game board) the app hands in.
  const modalInertTargets: HTMLElement[] = [
    hudBox,
    controls,
    panel,
    ...(options.inertWhileModal ?? []),
  ];

  return {
    root,
    update(view: HudView): void {
      const { hud } = view;
      livesEl.textContent = t('hud.lives', { count: hud.lives });
      bountyEl.textContent = t('hud.bounty', { count: hud.bounty });
      scoreEl.textContent = t('hud.score', { count: hud.score });
      starsEl.textContent = t('hud.stars', { count: hud.stars });
      // countdownSeconds is null for BOTH active and terminal phases — only label a live
      // wave "in progress"; a finished match shows no wave line (its outcome is the dialog).
      waveEl.textContent =
        hud.countdownSeconds !== null
          ? t('hud.countdown', { seconds: hud.countdownSeconds })
          : hud.phase === 'active'
            ? t('hud.wave.active')
            : '';
      pauseBtn.textContent = view.paused ? t('controls.resume') : t('controls.pause');
      pauseBtn.setAttribute('aria-pressed', String(view.paused));
      speedBtn.textContent = t('controls.speed', { factor: view.speed });
      callBtn.disabled = !view.canCallWave;
      sellBtn.disabled = !view.canSell;
      sellBtn.textContent = t('controls.sell', { refund: view.refund });
    },
    showResults(hud: HudVM): void {
      cancelCapture?.(); // a match can end mid-rebind — drop the armed capture so the first
      // Enter activates Play Again instead of being swallowed into a rebind.
      const heading = hud.won ? t('results.won') : t('results.lost');
      resultTitle.textContent = heading;
      resultSummary.textContent = t('results.summary', { score: hud.score, stars: hud.stars });
      results.setAttribute('aria-label', heading);
      verifyMsg.textContent = '';
      results.hidden = false;
      // Modal focus management (the dialog is aria-modal): make everything behind it inert
      // — the overlay's own children AND the sibling game board (passed via options) — so
      // Tab/AT can't reach the obscured game, then move focus into the dialog.
      for (const el of modalInertTargets) el.setAttribute('inert', '');
      playAgainBtn.focus();
    },
    hideResults(): void {
      results.hidden = true;
      verifyMsg.textContent = '';
      // Un-inert BEFORE restoring focus: focusing a still-inert element is a no-op (focus
      // would fall to <body>), so the order matters — clear inert, then focus the board.
      for (const el of modalInertTargets) el.removeAttribute('inert');
      (options.restoreFocusOnClose ?? null)?.focus();
    },
    setVerifyMessage(message: string): void {
      verifyMsg.textContent = message;
    },
    destroy(): void {
      cancelCapture?.(); // drop any in-flight rebind listener so it can't outlive the UI
      root.remove();
    },
  };
}
