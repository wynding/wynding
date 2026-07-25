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
import { createModalOwner, type ModalOverlay, type ModalOwner } from './modal';
import { dockButtonParts, type ShellChip, type ShellHandle } from './shell';
import type { ArmedTower, UiState, PlacementOutcome } from './controller';
import type { RotateController } from './rotate';

/** A player intent emitted by the overlay for the app to route to the controller. */
export type UiAction =
  | { readonly type: 'togglePause' }
  | { readonly type: 'cycleSpeed' }
  | { readonly type: 'start' }
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
  /** The single modal owner (results/rotate/settings share one stack, PLAN.md P1) — exposed
   *  so `main.ts` can register the P5 rotate overlay on the SAME instance, rather than a
   *  second, disconnected one. */
  readonly modal: ModalOwner;
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
  start: () => t('action.start'),
  pause: () => t('action.pause'),
  speed: () => t('action.speed'),
  armTower1: () => t('action.armTower1'),
};

/** Glance-form glyphs for the Compact chips and Dock buttons (Story 11 P1).
 *
 *  These are PRESENTATION, not copy: every node they are written into is `aria-hidden`, and
 *  the full localized message sits alongside it as the element's actual accessible text. A
 *  glyph has no language, so routing it through the `t()` catalog would create a
 *  translatable entry with nothing to translate — the same exemption the codebase already
 *  applies to its other pure-glyph presentation (`.wy-rotate-icon`'s inline SVG). The two
 *  genuinely WORDED compact forms (the wave slot's countdown and active markers) do go
 *  through the catalog, as `hud.wave.compact.*`. */
const ICONS = {
  lives: '♥',
  bounty: '◈',
  score: '✦',
  stars: '★',
  settings: '⚙',
  pause: '⏸',
  resume: '⏵',
  /** Multiplication sign for the speed button's glance form ("1×" / "2×"). */
  speed: '×',
} as const;

/** The ONE chip write path (contract §4): both forms are always written together from the
 *  same call, so the visible glance and the accessible full message can never disagree, and
 *  no caller can sentence-split a label away from its value. An empty full form means the
 *  slot has nothing to say and the whole chip hides (the wave slot pre-start and terminal)
 *  — the node itself is retained either way. */
function setChip(chip: ShellChip, full: string, glance: string): void {
  chip.full.textContent = full;
  chip.glance.textContent = glance;
  chip.root.hidden = full === '';
}

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
 * (session-scoped). `controller` is narrowed to the same slice `rotate.ts` reads — opening
 * settings inerts the Shell, so it auto-pauses an active run under the identical guard the
 * rotate prompt uses (the modal family behaves consistently). `abortGesture` cancels any
 * in-flight placement gesture on settings-open, exactly as `rotate.ts` does via the input
 * manager's `abort()` — threaded as a callback (not the input manager itself) because
 * `main.ts` creates the input manager AFTER the overlay, the same forward-reference wiring
 * the hoisted `onAction` uses. `ruleset` is read-only (M1's single `basic` tower's stats
 * for the Panel — cost/damage/rangeFp/cadenceTicks never change at runtime).
 */
export function createOverlay(
  doc: Document,
  onAction: (action: UiAction) => void,
  controller: RotateController,
  settings: SettingsStore,
  keymap: Keymap,
  shell: ShellHandle,
  ruleset: CompiledRuleset,
  abortGesture: () => void,
): Overlay {
  const { hud: hudEls, dock, card, panel, live } = shell;
  const { pause: pauseBtn, speed: speedBtn, settings: settingsBtn, primary: primaryBtn } = dock;

  // Dock markup contract (Story 11 P1): every Dock button carries an aria-hidden icon span
  // plus the localized text span, in both layouts. Resolved once here — the spans are
  // structural (built by `shell.ts`) and never replaced, so `update()` just rewrites their
  // text.
  const pauseParts = dockButtonParts(pauseBtn);
  const speedParts = dockButtonParts(speedBtn);
  const settingsParts = dockButtonParts(settingsBtn);
  const primaryParts = dockButtonParts(primaryBtn);

  settingsParts.icon.textContent = ICONS.settings;
  settingsParts.text.textContent = t('controls.settings');
  // The Dock's headline Start action (PLAN.md P4) — the old "Call wave now" button is
  // gone; `primaryBtn` (the empty slot P1 reserved, carrying the shared `.wy-primary`
  // primary-styled look — ui.css — with the results dialog's contrast spot-check scoped to
  // `.wy-results .wy-primary` so it never samples this Dock button)
  // is wired here. Visibility (visible pre-start, hidden for the rest of the run once
  // pressed) and the Pause button's own hidden-pre-start state are both driven per-frame
  // by `update()` below, since they depend on live `UiState`, not anything fixed at
  // construction time.
  // Start keeps its VISIBLE text label in both layouts (contract §2) — no icon form; the
  // empty icon span collapses (`.wy-btn-icon:empty` has nothing to render).
  primaryParts.text.textContent = t('controls.start');

  pauseBtn.addEventListener('click', () => onAction({ type: 'togglePause' }));
  speedBtn.addEventListener('click', () => onAction({ type: 'cycleSpeed' }));
  primaryBtn.addEventListener('click', () => onAction({ type: 'start' }));

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

  // The board's `aria-label` names the ACTUAL bound movement/confirm/sell keys, not the
  // hardcoded defaults (CodeRabbit) — so screen-reader instructions stay truthful after a
  // rebind. Movement is four separate bindings, joined into the one {move} label; confirm/
  // sell are single bindings; an unbound action falls back to `settings.unbound` (via
  // `codeLabel`). Set here — overlay owns the Shell's dynamic content, like the Card hotkey
  // badge — and refreshed on every rebind below.
  function refreshBoardAria(): void {
    const move = (['up', 'down', 'left', 'right'] as const).map(codeLabel).join(' / ');
    shell.board.setAttribute(
      'aria-label',
      t('board.aria', { move, confirm: codeLabel('confirm'), sell: codeLabel('sell') }),
    );
  }
  refreshBoardAria();

  function refreshRebindLabels(): void {
    for (const [action, btn] of rebindButtons) {
      btn.textContent = codeLabel(action);
      btn.setAttribute('aria-label', t('settings.rebind', { action: ACTION_LABEL[action]() }));
    }
    // A rebind of ANY action can displace `armTower1` from its key (the keymap is a
    // bijection) — refresh the Card's live hotkey badge on every rebind, not just when the
    // player rebinds armTower1 itself.
    refreshCardHotkey();
    // Same bijection reasoning for the board's aria instructions: any rebind can move the
    // movement/confirm/sell keys they name, so refresh them here too.
    refreshBoardAria();
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

  settingsBtn.addEventListener('click', () => {
    // Run the SAME open lifecycle as rotate.ts's `evaluate()` entry path, in order, so the
    // modal family behaves identically (PLAN.md P1/P5). rotate-open steps:
    //   1. input.abort()  — cancel any in-flight placement gesture (P3's cancellation
    //                       contract: ghost cleared always; board-origin stays armed;
    //                       Card-drag disarms). Without this, a pointer held on the board
    //                       when settings opens keeps board pointer-capture, so its later
    //                       pointerup still reaches the release path and could queue a tower
    //                       behind the inert Shell while the player is in the dialog.
    //   2. modal.open(overlay, { priority })  — inert the Shell + show/focus the dialog.
    //   3. auto-pause guard  — pause an ACTIVE, unpaused run (below).
    abortGesture();
    modal.open(settingsOverlay, { priority: 'settings' });
    // Auto-pause an ACTIVE, unpaused run when settings opens — the Shell goes inert and is
    // covered while the dialog is up, so an unpaused wave would keep advancing unseen (lives
    // lost / the run ending inside the dialog). Mirrors rotate.ts's guard exactly (started,
    // not already paused). Idempotent: if rotate already auto-paused, `isPaused()` makes this
    // a no-op. On close the run STAYS paused — the player resumes deliberately from the Dock,
    // like the rotate flow. (Results outranks settings and inerts the Dock, so this handler
    // can't even fire while results is open — no terminal-state pause interaction here.)
    if (controller.uiState().started && !controller.isPaused()) {
      controller.pause();
    }
  });
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
      // Consume the key so a rebind onto Enter/Space can't ALSO activate whatever native
      // button currently has focus (e.g. the settings opener) — the same keypress would both
      // arm and synthetically click it.
      e.preventDefault();
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

  /** Close button → disarm/deselect; this only emits the intent. Focus re-homing is
   *  owned by the renderPanel teardown seam (Card on a disarm-close, board otherwise). */
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
    panelSellBtn = sellPanelBtn; // tracked so a live refund change can patch it in place

    const upgradeBtn = button(doc, 'wy-btn', t('panel.upgrade'));
    upgradeBtn.setAttribute('aria-disabled', 'true');
    upgradeBtn.setAttribute('aria-describedby', UPGRADE_DESC_ID);
    // No click handler: a plain `type="button"` has no default action, so the "Max level"
    // visual is inert on activation by construction (a permanently-disabled-but-discoverable
    // control, per its `aria-disabled`), with nothing to suppress.

    const upgradeDesc = doc.createElement('p');
    upgradeDesc.id = UPGRADE_DESC_ID;
    upgradeDesc.className = 'wy-sr-only';
    upgradeDesc.textContent = t('panel.upgrade.desc');

    actions.append(sellPanelBtn, upgradeBtn);
    container.append(actions, upgradeDesc);
  }

  let lastPanelKey = '';
  // The Panel's live Sell button, tracked across renders so a refund change on the SAME
  // selection can be patched in place (recreating the subtree would drop focus). `null`
  // whenever the Panel isn't showing a selection.
  let panelSellBtn: HTMLButtonElement | null = null;
  // The live region's last-announced outcome sequence (Fix A) — `null` so the very first
  // `update()` call always announces, even when the initial outcome is `null` (message '').
  let lastAnnouncedSeq: number | null = null;
  function renderPanel(ui: UiState, refund: number): void {
    const key =
      ui.armed !== null
        ? `armed:${ui.armed}`
        : ui.selection !== null
          ? `sel:${ui.selection.id}`
          : 'closed';
    if (key === lastPanelKey) {
      // Same Panel identity (same armed kind / selection) — the subtree is preserved to keep
      // focus, but the Sell refund can still change while the SAME tower stays selected (the
      // pending queue changed). Patch the existing button's label in place rather than
      // re-keying/recreating the Panel on `refund`.
      if (panelSellBtn !== null) panelSellBtn.textContent = t('panel.sell', { refund });
      return;
    }
    // Focus re-homing seam (PLAN.md P2 Focus rules): renderPanel is the ONE place the Panel
    // subtree is torn down, so EVERY close route funnels through here — Close button, Sell,
    // Escape-disarm/deselect, a placement transition (armed→selected), and a tick that sold
    // or removed the selected tower. When focus is inside the Panel at teardown, moving it
    // deliberately here — rather than at each call site, which could forget — keeps board-
    // scoped shortcuts alive instead of letting the removed subtree drop focus to
    // document.body. A disarm-close returns focus to the Card that armed it; a deselect/sell/
    // removal (and the rare placement transition with focus still in the Panel) returns it to
    // the board. Focus already OUTSIDE the Panel is never stolen.
    const prevKey = lastPanelKey;
    const hadPanelFocus = panel.root.contains(doc.activeElement);
    lastPanelKey = key;
    panelSellBtn = null;
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
    // Re-home only when the torn-down subtree actually held focus AND the rebuild didn't
    // re-establish it inside the Panel (the Panel never auto-focuses, so a previously-held
    // focus always lands on document.body here). A disarm-close (was armed, now closed) →
    // the Card; every other close/transition → the board.
    if (hadPanelFocus && !panel.root.contains(doc.activeElement)) {
      if (prevKey.startsWith('armed:') && key === 'closed') card.root.focus();
      else shell.board.focus();
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
        if (outcome.reason === 'pendingCap') return t('live.rejected.pendingCap');
        return t('live.rejected.generic');
      case 'sold':
        return t('live.sold', { refund: outcome.refund });
    }
  }

  return {
    resultsEl: results,
    settingsEl: settingsDialog,
    modal,
    update(view: HudView): void {
      const { hud } = view;
      setChip(hudEls.lives, t('hud.lives', { count: hud.lives }), `${ICONS.lives} ${hud.lives}`);
      setChip(
        hudEls.bounty,
        t('hud.bounty', { count: hud.bounty }),
        `${ICONS.bounty} ${hud.bounty}`,
      );
      setChip(hudEls.score, t('hud.score', { count: hud.score }), `${ICONS.score} ${hud.score}`);
      setChip(hudEls.stars, t('hud.stars', { count: hud.stars }), `${ICONS.stars} ${hud.stars}`);
      // Wave slot states (Story 11 P1). Pre-start the slot is HIDDEN rather than carrying a
      // prompt: the sim's countdown figure is meaningless while held (it never ticks down
      // until Start), and the Dock's headline "Start" button is the affordance that says so
      // — a chip repeating it would just cost a row of the Compact column. Once started,
      // countdownSeconds is null for BOTH active and terminal phases — only label a live
      // wave "in progress"; a finished match shows no wave chip (its outcome is the dialog).
      const counting = view.ui.started && hud.countdownSeconds !== null;
      const active = view.ui.started && hud.countdownSeconds === null && hud.phase === 'active';
      setChip(
        hudEls.wave,
        counting
          ? t('hud.countdown', { seconds: hud.countdownSeconds as number })
          : active
            ? t('hud.wave.active')
            : '',
        counting
          ? t('hud.wave.compact.countdown', { s: hud.countdownSeconds as number })
          : active
            ? t('hud.wave.compact.active')
            : '',
      );
      // Pause is HIDDEN (not disabled) pre-start (PLAN.md P4) — there's nothing to pause
      // yet, and a hidden control can't be tabbed to or announced as a false affordance.
      pauseBtn.hidden = !view.ui.started;
      pauseParts.icon.textContent = view.paused ? ICONS.resume : ICONS.pause;
      pauseParts.text.textContent = view.paused ? t('controls.resume') : t('controls.pause');
      pauseBtn.setAttribute('aria-pressed', String(view.paused));
      speedParts.icon.textContent = `${view.speed}${ICONS.speed}`;
      speedParts.text.textContent = t('controls.speed', { factor: view.speed });
      // The primary Start action hides for the rest of the run once pressed (PLAN.md P4:
      // M1 ships exactly one wave — there's no later-wave affordance to show instead).
      primaryBtn.hidden = view.ui.started;
      card.root.setAttribute('aria-pressed', String(view.ui.armed !== null));
      renderPanel(view.ui, view.refund);
      // The HUD updates every tick, but the outcome message only changes on an actual
      // placement/arm/sell event — writing `textContent` unconditionally re-announces the
      // SAME stale message to assistive tech on every tick of a wave. Guard the write so it
      // only fires when a NEW outcome was recorded — keyed on `outcomeSeq` (identity), not
      // text equality: two consecutive occurrences of the SAME outcome (e.g. rejecting the
      // same occupied cell twice) are two distinct announcements, even though their message
      // text is identical, so a text-equality guard would wrongly swallow the second one.
      if (view.ui.outcomeSeq !== lastAnnouncedSeq) {
        lastAnnouncedSeq = view.ui.outcomeSeq;
        const nextLive = outcomeMessage(view.ui.lastOutcome);
        // A new outcome whose message happens to read identically to what's already in the
        // live region (the repeated-outcome case above) would otherwise be a same-value
        // `textContent` write, which most AT does NOT re-announce. Force a real mutation by
        // appending an invisible trailing space whenever the text would collide — reading
        // `live.textContent` as the toggle means it self-alternates on/off across any run
        // of repeats (space in → next collision compares against the space-suffixed value
        // and mismatches → space out → …), with no extra state to track. The accessible
        // text (after `.trim()`) still reads the same to a human either way.
        live.textContent = nextLive === live.textContent ? nextLive + ' ' : nextLive;
      }
    },
    showResults(hud: HudVM): void {
      // Modal-family open lifecycle (same as settings/rotate): abort any in-flight
      // placement gesture first — the input manager's inert commit-guard is the net, but
      // every opener aborts for itself so the ghost never lingers behind the dialog.
      abortGesture();
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
