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

import { FP_ONE } from '@wynding/engine';
import { COLOUR_MODES, type HudVM, type ColourMode } from '@wynding/render';
import { MS_PER_TICK, type CompiledRuleset } from '@wynding/sim';
import { t } from './i18n/t';
import { formatNumber } from './i18n/number';
import type { SettingsStore } from './settings';
import { GAME_ACTIONS, type GameAction, type Keymap } from './keymap';
import { formatKeyLabel } from './keylabel';
import { createModalOwner, type ModalOverlay } from './modal';
import type { ShellHandle } from './shell';
import type { ArmedTower, UiState, PlacementOutcome } from './controller';

/** A player intent emitted by the overlay for the app to route to the controller. */
export type UiAction =
  | { readonly type: 'togglePause' }
  | { readonly type: 'cycleSpeed' }
  | { readonly type: 'callWave' }
  | { readonly type: 'playAgain' }
  | { readonly type: 'verify' }
  | { readonly type: 'armTower'; readonly tower: ArmedTower }
  | { readonly type: 'escape' }
  | { readonly type: 'sellSelected' }
  | { readonly type: 'closePanel' };

/** Live HUD numbers + control availability for one refresh. */
export interface HudView {
  readonly hud: HudVM;
  readonly paused: boolean;
  readonly speed: number;
  readonly canCallWave: boolean;
  /** The armed/selection state machine snapshot (PLAN.md P2) driving the Card/Panel/live
   *  region. */
  readonly ui: UiState;
  /** Live refund for the current selection (0 if none) — the Panel's Sell button. */
  readonly refund: number;
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
  armTower1: () => t('action.armTower1'),
};

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

/**
 * Build the overlay into `doc`, wiring the Shell's HUD/Dock/Card (built by `shell.ts`) and
 * owning the results + settings dialogs plus the Panel. `onAction` receives control
 * intents; `settings`/`keymap` are mutated directly by the settings dialog
 * (session-scoped). `ruleset` is read-only (M1's single `basic` tower's stats for the
 * Panel — cost/damage/rangeFp/cadenceTicks never change at runtime).
 */
export function createOverlay(
  doc: Document,
  onAction: (action: UiAction) => void,
  settings: SettingsStore,
  keymap: Keymap,
  shell: ShellHandle,
  ruleset: CompiledRuleset,
): Overlay {
  const { hud: hudEls, dock, card, panel, live } = shell;
  const { pause: pauseBtn, speed: speedBtn, callWave: callBtn, settings: settingsBtn } = dock;

  callBtn.textContent = t('controls.callWave');
  settingsBtn.textContent = t('controls.settings');

  pauseBtn.addEventListener('click', () => onAction({ type: 'togglePause' }));
  speedBtn.addEventListener('click', () => onAction({ type: 'cycleSpeed' }));
  callBtn.addEventListener('click', () => onAction({ type: 'callWave' }));

  // --- Card: the single M1 `basic` tower (PLAN.md P2) ---
  card.name.textContent = t('tower.basic.name');
  card.cost.textContent = t('panel.cost', { cost: ruleset.tower.cost });
  card.root.addEventListener('click', () => onAction({ type: 'armTower', tower: 'basic' }));

  function refreshCardHotkey(): void {
    const label = formatKeyLabel(keymap.codeFor('armTower1'));
    card.hotkey.textContent = label ?? t('settings.unbound');
    if (label !== null) card.root.setAttribute('aria-keyshortcuts', label);
    else card.root.removeAttribute('aria-keyshortcuts');
  }
  refreshCardHotkey();

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

  // Routed through the shared key-label formatter (keylabel.ts) rather than the raw
  // `KeyboardEvent.code` — `Digit1`/`ArrowRight`/etc. are physical-key identifiers, not
  // display text (PLAN.md P2).
  const codeLabel = (action: GameAction): string =>
    formatKeyLabel(keymap.codeFor(action)) ?? t('settings.unbound');

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
    // A rebind of ANY action can displace `armTower1` from its key (the keymap is a
    // bijection) — refresh the Card's live hotkey badge on every rebind, not just when the
    // player rebinds armTower1 itself.
    refreshCardHotkey();
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

  // --- Game-level Escape + the armTower1 hotkey: document scope, PLAN.md P2 ---
  // The modal owner's OWN Escape listener (registered above, capture phase) already
  // preventDefault()s + stopPropagation()s whenever a genuinely-open modal is dismissable
  // or state-driven, so this bubble-phase listener never even fires in that case. The one
  // case that reaches here with a modal still open is the rebind capture (settings open,
  // `isEscapeHeld()` true) — guarded below by the SAME `cancelCapture` check, and
  // defensively by the shell's `inert` state (the modal owner's one authority over it) so
  // a hotkey typed while ANY modal is open can never reach the game underneath it.
  const onGameKeydown = (e: KeyboardEvent): void => {
    if (cancelCapture !== null) return; // the rebind capture owns this keypress
    if (shell.root.hasAttribute('inert')) return; // a modal is open — already consumed
    if (e.code === 'Escape') {
      onAction({ type: 'escape' });
      return;
    }
    // Arming works from "any state" (PLAN.md P2 table) regardless of what currently has
    // focus, so it's handled here rather than the board-scoped switch in input.ts. Guard
    // auto-repeat (a held key must not toggle arm on/off/on/off) — the discrete-action
    // repeat-gate input.ts applies to its own switch doesn't reach this listener.
    if (!e.repeat && keymap.actionFor(e.code) === 'armTower1') {
      onAction({ type: 'armTower', tower: 'basic' });
    }
  };
  doc.addEventListener('keydown', onGameKeydown);

  // --- Panel: unified tower details (PLAN.md P2), rebuilt only when WHAT it shows
  // changes (armed kind, or the selected tower's identity) — not on every `uiRev` tick
  // (e.g. a rejected placement while armed re-renders the live region but leaves the
  // Panel's own DOM, and any focus inside it, untouched). ---
  const TICKS_PER_SECOND = 1000 / MS_PER_TICK;

  interface TowerStats {
    readonly name: string;
    readonly cost: number;
    readonly damage: number;
    readonly rangeTiles: string;
    readonly fireRate: string;
    readonly targets: string;
  }

  function towerStats(kind: ArmedTower): TowerStats {
    switch (kind) {
      case 'basic':
        return {
          name: t('tower.basic.name'),
          cost: ruleset.tower.cost,
          damage: ruleset.tower.damage,
          rangeTiles: formatNumber(ruleset.tower.rangeFp / FP_ONE),
          fireRate: formatNumber(TICKS_PER_SECOND / ruleset.tower.cadenceTicks),
          targets: t('tower.targets.ground'),
        };
      default: {
        // M1 ships exactly one tower kind (`ArmedTower` is the single literal 'basic') —
        // an unknown kind reaching here is a programmer error (a new variant added
        // without teaching the Panel its stats). Fail closed rather than render
        // fabricated numbers.
        const exhaustive: never = kind;
        throw new Error(`panel: unknown tower kind ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  function appendStatRows(container: HTMLElement, stats: TowerStats): void {
    const rows = [
      t('panel.cost', { cost: stats.cost }),
      t('panel.damage', { damage: stats.damage }),
      t('panel.range', { tiles: stats.rangeTiles }),
      t('panel.fireRate', { rate: stats.fireRate }),
      t('panel.targets', { targets: stats.targets }),
    ];
    for (const text of rows) {
      const p = doc.createElement('p');
      p.textContent = text;
      container.appendChild(p);
    }
  }

  function clearChildren(el: HTMLElement): void {
    while (el.firstChild !== null) el.removeChild(el.firstChild);
  }

  const UPGRADE_DESC_ID = 'wy-panel-upgrade-desc';

  /** Close button → disarm/deselect + focus returns to the Card (handled by main.ts's
   *  `closePanel` action — this only emits the intent). */
  function appendCloseButton(container: HTMLElement): void {
    const closePanelBtn = button(doc, 'wy-btn', t('panel.close'));
    closePanelBtn.addEventListener('click', () => onAction({ type: 'closePanel' }));
    container.appendChild(closePanelBtn);
  }

  /** Sell (live refund) + the permanent "Max level" Upgrade visual — a FOCUSABLE
   *  `aria-disabled` control (not a native `disabled` button, which would drop it from the
   *  tab order and hide it from AT entirely), activation suppressed. */
  function appendActionRow(container: HTMLElement, refund: number): void {
    const actions = doc.createElement('div');
    actions.className = 'wy-panel-actions';

    const sellPanelBtn = button(doc, 'wy-btn', t('panel.sell', { refund }));
    sellPanelBtn.addEventListener('click', () => onAction({ type: 'sellSelected' }));

    const upgradeBtn = button(doc, 'wy-btn', t('panel.upgrade'));
    upgradeBtn.setAttribute('aria-disabled', 'true');
    upgradeBtn.setAttribute('aria-describedby', UPGRADE_DESC_ID);
    // Activation suppressed: a plain `type="button"` already does nothing on its own, but
    // this explicit no-op listener documents the "Max level" visual's design intent (a
    // permanently-disabled-but-discoverable control, not a live button that merely lacks a
    // handler yet) and guards against a future accidental handler being added elsewhere.
    upgradeBtn.addEventListener('click', (e) => e.preventDefault());

    const upgradeDesc = doc.createElement('p');
    upgradeDesc.id = UPGRADE_DESC_ID;
    upgradeDesc.className = 'wy-sr-only';
    upgradeDesc.textContent = t('panel.upgrade.desc');

    actions.append(sellPanelBtn, upgradeBtn);
    container.append(actions, upgradeDesc);
  }

  let lastPanelKey = '';
  function renderPanel(ui: UiState, refund: number): void {
    const key =
      ui.armed !== null
        ? `armed:${ui.armed}`
        : ui.selection !== null
          ? `sel:${ui.selection.id}`
          : 'closed';
    if (key === lastPanelKey) return;
    lastPanelKey = key;
    clearChildren(panel.root);
    if (ui.armed !== null) {
      const stats = towerStats(ui.armed);
      const heading = doc.createElement('p');
      heading.className = 'wy-panel-name';
      heading.textContent = stats.name;
      panel.root.appendChild(heading);
      appendStatRows(panel.root, stats);
      appendCloseButton(panel.root);
      panel.root.hidden = false;
    } else if (ui.selection !== null) {
      const stats = towerStats('basic'); // M1 ships exactly one placeable kind
      const heading = doc.createElement('p');
      heading.className = 'wy-panel-name';
      heading.textContent = stats.name;
      panel.root.appendChild(heading);
      appendStatRows(panel.root, stats);
      appendActionRow(panel.root, refund);
      appendCloseButton(panel.root);
      panel.root.hidden = false;
    } else {
      panel.root.hidden = true;
    }
  }

  function outcomeMessage(outcome: PlacementOutcome | null): string {
    if (outcome === null) return '';
    const name = t('tower.basic.name');
    switch (outcome.kind) {
      case 'armed':
        return t('live.armed', { name });
      case 'disarmed':
        return t('live.disarmed');
      case 'placed':
        return t('live.placed', { name });
      case 'rejected':
        if (outcome.reason === 'bounty') return t('live.rejected.bounty');
        if (outcome.reason === 'occupied') return t('live.rejected.occupied');
        return t('live.rejected.generic');
      case 'sold':
        return t('live.sold', { refund: outcome.refund });
    }
  }

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
      card.root.setAttribute('aria-pressed', String(view.ui.armed !== null));
      renderPanel(view.ui, view.refund);
      live.textContent = outcomeMessage(view.ui.lastOutcome);
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
      doc.removeEventListener('keydown', onGameKeydown);
      modal.destroy();
      results.remove();
      settingsDialog.remove();
    },
  };
}
