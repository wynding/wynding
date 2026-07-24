// overlay.ts — the results + settings dialogs, and the Dock/HUD wiring (ADR 0003 §3: the
// HUD/controls are a DOM overlay, NOT canvas text, so axe audits real semantic elements,
// text resizes to 200% and reflows, and focus/keyboard are native). Every user-facing
// string comes through `t()` (the no-ui-literals rule forbids raw literals in text sinks).
// Buttons are real <button>s sized ≥ 44×44 CSS px via ui.css. Colour is always paired with
// text/shape — never the sole signal.
//
// The Shell's DOM topology (status bar, Dock, Rail, board) is built by `shell.ts`; this
// module fills in HUD values, wires the Dock buttons, and owns the results/settings
// dialogs — both sibling to the Shell (PLAN.md P1) and migrated onto the modal owner
// (`modal.ts`), which is the single authority over `inert` on `.wy-shell` and focus
// save/restore.

import { COLOUR_MODES, type HudVM, type ColourMode } from '@wynding/render';
import { t } from './i18n/t';
import type { SettingsStore } from './settings';
import { GAME_ACTIONS, type GameAction, type Keymap } from './keymap';
import { createModalOwner, type ModalOverlay } from './modal';
import type { ShellHandle } from './shell';

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
  /** Sibling elements the caller appends alongside the Shell (results/settings). */
  readonly resultsEl: HTMLElement;
  readonly settingsEl: HTMLElement;
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

/**
 * Build the overlay into `doc`, wiring the Shell's HUD/Dock (built by `shell.ts`) and
 * owning the results + settings dialogs. `onAction` receives control intents;
 * `settings`/`keymap` are mutated directly by the settings dialog (session-scoped).
 */
export function createOverlay(
  doc: Document,
  onAction: (action: UiAction) => void,
  settings: SettingsStore,
  keymap: Keymap,
  shell: ShellHandle,
): Overlay {
  const { hud: hudEls, dock } = shell;
  const {
    pause: pauseBtn,
    speed: speedBtn,
    callWave: callBtn,
    sell: sellBtn,
    settings: settingsBtn,
  } = dock;

  callBtn.textContent = t('controls.callWave');
  settingsBtn.textContent = t('controls.settings');

  pauseBtn.addEventListener('click', () => onAction({ type: 'togglePause' }));
  speedBtn.addEventListener('click', () => onAction({ type: 'cycleSpeed' }));
  callBtn.addEventListener('click', () => onAction({ type: 'callWave' }));
  sellBtn.addEventListener('click', () => onAction({ type: 'sell' }));

  // --- Settings dialog (sibling of the Shell — the Shell is inert while it's open) ---
  const settingsDialog = doc.createElement('div');
  settingsDialog.className = 'wy-settings';
  settingsDialog.hidden = true;
  settingsDialog.setAttribute('role', 'dialog');
  settingsDialog.setAttribute('aria-modal', 'true');
  settingsDialog.setAttribute('aria-label', t('settings.title'));
  settingsDialog.tabIndex = -1;

  const settingsInner = doc.createElement('div');
  settingsInner.className = 'wy-settings-inner';
  settingsDialog.appendChild(settingsInner);

  const settingsHeader = doc.createElement('div');
  settingsHeader.className = 'wy-settings-header';
  const heading = doc.createElement('h2');
  heading.textContent = t('settings.title');
  const closeBtn = button(doc, 'wy-btn wy-settings-close', t('settings.close'));
  closeBtn.setAttribute('aria-label', t('settings.close'));
  settingsHeader.append(heading, closeBtn);
  settingsInner.appendChild(settingsHeader);

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
  settingsInner.appendChild(cbGroup);

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
  settingsInner.appendChild(motionLabel);

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
        // Stop the same key from ALSO reaching the board (e.g. rebinding "sell" onto a
        // key the board listens for would otherwise both rebind AND fire the board action
        // on this very keydown — the capture-phase listener runs first, but propagation
        // continues to the board's own listener unless stopped here). NOT
        // stopImmediatePropagation() — no other same-node listener needs blocking.
        e.stopPropagation();
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
  settingsInner.appendChild(rebindList);

  function refreshRebindLabels(): void {
    for (const [action, btn] of rebindButtons) {
      btn.textContent = codeLabel(action);
      btn.setAttribute('aria-label', t('settings.rebind', { action: ACTION_LABEL[action]() }));
    }
  }

  // --- Results dialog (sibling of the Shell) ---
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

  // --- Modal owner: single authority over `.wy-shell`'s inert + focus save/restore ---
  const modal = createModalOwner(doc, shell.root, {
    // "Existing capture wins" (PLAN.md P2's Focus rules, already load-bearing here since
    // this is the app's first document-scope Escape handler): while a rebind is armed,
    // its own Escape-cancels-the-rebind handling must run instead of closing the dialog.
    isEscapeHeld: () => cancelCapture !== null,
  });

  const resultsOverlay: ModalOverlay = {
    show(): void {
      results.hidden = false;
      playAgainBtn.focus();
    },
    hide(): void {
      results.hidden = true;
    },
  };
  const settingsOverlay: ModalOverlay = {
    show(): void {
      settingsDialog.hidden = false;
      settingsDialog.focus();
    },
    hide(): void {
      settingsDialog.hidden = true;
      // Closing the dialog abandons any armed rebind — otherwise its capture listener
      // would survive the dialog and hijack the next in-game keypress.
      cancelCapture?.();
    },
  };

  settingsBtn.addEventListener('click', () =>
    modal.open(settingsOverlay, { priority: 'settings' }),
  );
  closeBtn.addEventListener('click', () => modal.close(settingsOverlay));

  return {
    resultsEl: results,
    settingsEl: settingsDialog,
    update(view: HudView): void {
      const { hud } = view;
      hudEls.lives.textContent = t('hud.lives', { count: hud.lives });
      hudEls.bounty.textContent = t('hud.bounty', { count: hud.bounty });
      hudEls.score.textContent = t('hud.score', { count: hud.score });
      hudEls.stars.textContent = t('hud.stars', { count: hud.stars });
      // countdownSeconds is null for BOTH active and terminal phases — only label a live
      // wave "in progress"; a finished match shows no wave line (its outcome is the dialog).
      hudEls.wave.textContent =
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
      modal.open(resultsOverlay, { priority: 'results' });
    },
    hideResults(): void {
      verifyMsg.textContent = '';
      modal.close(resultsOverlay);
    },
    setVerifyMessage(message: string): void {
      verifyMsg.textContent = message;
    },
    destroy(): void {
      cancelCapture?.(); // drop any in-flight rebind listener so it can't outlive the UI
      modal.destroy();
      results.remove();
      settingsDialog.remove();
    },
  };
}
