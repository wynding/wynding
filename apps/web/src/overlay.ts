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
import {
  COLOUR_MODES,
  type HudVM,
  type HudPreview,
  type PreviewEntryVM,
  type ColourMode,
} from '@wynding/render';
import {
  MS_PER_TICK,
  isTerminalPhase,
  buffAmount,
  SUPPORT_MUL_IDENTITY,
  type CompiledRuleset,
} from '@wynding/sim';
import { t } from './i18n/t';
import { formatNumber } from './i18n/number';
import type { SettingsStore } from './settings';
import { ARM_TOWER_ACTIONS, GAME_ACTIONS, type GameAction, type Keymap } from './keymap';
import { formatKeyLabel } from './keylabel';
import { createModalOwner, type ModalOverlay, type ModalOwner } from './modal';
import { dockButtonParts, type ShellChip, type ShellHandle } from './shell';
import type { InstallHandle, InstallState } from './install';
import type { ArmedTower, UiState, PlacementOutcome } from './controller';

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
  /** The iOS Add-to-Home-Screen instructions dialog (Story 11 P3) — a first-class modal,
   *  its own sibling of the Shell, registered at `settings` priority. */
  readonly instructionsEl: HTMLElement;
  /** The leave-this-run confirm dialog — another first-class modal sibling of the Shell,
   *  also registered at `settings` priority (rotate and results both still outrank it). */
  readonly leaveEl: HTMLElement;
  /** The single modal owner (results/rotate/settings share one stack, PLAN.md P1) — exposed
   *  so `main.ts` can register the P5 rotate overlay on the SAME instance, rather than a
   *  second, disconnected one. */
  readonly modal: ModalOwner;
  update(view: HudView): void;
  /** Open the leave-this-run confirm dialog. PRESENTATION ONLY — the decision to open it
   *  (the modified-activation check and the live-run state read) is `main.ts`'s, which owns
   *  the guard; this just shows the dialog and calls `onConfirm` if the player commits. */
  showLeave(onConfirm: () => void): void;
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
// `armTower1`..`armTower9` stay spelled out here — the one thing `keymap.ts`'s
// `ARM_TOWER_ACTIONS` list must NOT drive (PLAN.md P6, Codex R1-13): a computed
// `t(`action.armTower${n}`)` key reads as unused to the i18n-check gate above, and
// `Record<GameAction, ...>` against the derived union keeps a missing entry a compile
// error rather than a runtime fallback.
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
  armTower2: () => t('action.armTower2'),
  armTower3: () => t('action.armTower3'),
  armTower4: () => t('action.armTower4'),
  armTower5: () => t('action.armTower5'),
  armTower6: () => t('action.armTower6'),
  armTower7: () => t('action.armTower7'),
  armTower8: () => t('action.armTower8'),
  armTower9: () => t('action.armTower9'),
};

/** Tower display names by catalog id (M2-S3) — a PARTIAL literal-key map (mirrors
 *  `CREEP_NAME`'s strategy exactly, Codex R1-5): catalog ids are OPEN strings (any
 *  schema-valid direct/aoe/slow tower compiles at sv8), so a closed union/exhaustive switch
 *  would crash on a legitimate modded bundle. An id this build doesn't recognize falls
 *  back to the localized `tower.unknown.name` (never a raw id) plus a dev-mode console
 *  warning — the mapping-gap diagnostic, same posture as `warnUnmappedCreeps`. The map is
 *  null-prototype (Codex #73): a schema-legal id that collides with an inherited
 *  `Object.prototype` key (`'constructor'`, `'toString'`, …) must miss and take the
 *  fallback, never resolve to an inherited member — the same guard the paint maps carry. */
const TOWER_NAME: Readonly<Partial<Record<string, () => string>>> = Object.assign(
  Object.create(null) as Partial<Record<string, () => string>>,
  // `satisfies` (QC r3): as `Object.assign`'s inferred source the literal is otherwise
  // checked against NOTHING — an eager `t(...)` entry (the exact thunk-contract slip
  // this map exists to prevent) would compile clean and crash at render.
  {
    basic: () => t('tower.basic.name'),
    slow: () => t('tower.slow.name'),
    splash: () => t('tower.splash.name'),
    venom: () => t('tower.venom.name'),
    stun: () => t('tower.stun.name'),
    antiair: () => t('tower.antiair.name'),
    beacon: () => t('tower.beacon.name'),
    mine: () => t('tower.mine.name'),
  } satisfies Record<string, () => string>,
);

function towerName(towerId: string): string {
  const label = TOWER_NAME[towerId];
  if (label !== undefined) return label();
  if (import.meta.env.DEV) {
    console.warn(`tower: catalog id '${towerId}' has no display name — using the fallback`);
  }
  return t('tower.unknown.name', { id: towerId });
}

/** Glance-form glyphs for the Compact chips and Dock buttons (Story 11 P1).
 *
 *  These are PRESENTATION, not copy: every node they are written into is `aria-hidden`, and
 *  the full localized message sits alongside it as the element's actual accessible text. A
 *  glyph has no language, so routing it through the `t()` catalog would create a
 *  translatable entry with nothing to translate — the same exemption the codebase already
 *  applies to its other pure-glyph presentation (`.wy-rotate-icon`'s inline SVG). The one
 *  genuinely WORDED compact form (the wave slot's countdown) goes through the catalog, as
 *  `hud.wave.compact.countdown`. */
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
  /** The install banner's dismiss glyph (a multiplication sign, the conventional "close"). */
  dismiss: '×',
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
 * (session-scoped). `ensurePaused` is the ONE app-level pause seam: opening settings inerts
 * the Shell, so it auto-pauses an active run — but through `main.ts` rather than by touching
 * the controller here, so every pause mutation in the app (this one, the rotate prompt's, the
 * Dock's, the keymapped pause key's, the leave guard's defensive one) lands in a single place
 * that also refreshes the home link's visibility synchronously. It owns the
 * started-and-unpaused guard itself, so calling it is unconditionally safe. `abortGesture` cancels any
 * in-flight placement gesture on settings-open, exactly as `rotate.ts` does via the input
 * manager's `abort()` — threaded as a callback (not the input manager itself) because
 * `main.ts` creates the input manager AFTER the overlay, the same forward-reference wiring
 * the hoisted `onAction` uses. `ruleset` is never MUTATED here, but M2-S8 falsified the
 * stronger claim this line used to make ("cost/damage/rangeFp/cadenceTicks never change at
 * runtime"), in both halves: the Panel's Damage and Poison rows are now recomputed from
 * `ui.selection.buffMulFp` whenever the support aura reaching the selected tower moves —
 * which is exactly why `renderPanel` patches those rows in place — and `rangeFp`/
 * `cadenceTicks` are no longer flat `CompiledTower` fields at all (they live under the
 * optional `attack`, absent on a support bundle). Catalog stats are static; the rows
 * derived from them are not, so they must not be cached per `towerId`.
 */
export function createOverlay(
  doc: Document,
  onAction: (action: UiAction) => void,
  ensurePaused: () => void,
  settings: SettingsStore,
  keymap: Keymap,
  shell: ShellHandle,
  ruleset: CompiledRuleset,
  abortGesture: () => void,
  install: InstallHandle,
): Overlay {
  const { hud: hudEls, preview: previewEl, dock, cards, panel, live, banner } = shell;
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
  // The Dock's MORPHING primary action (PLAN.md P3 step 15/17, M2-S2): `primaryBtn` (the
  // empty slot P1 reserved, carrying the shared `.wy-primary` primary-styled look —
  // ui.css — with the results dialog's contrast spot-check scoped to `.wy-results
  // .wy-primary` so it never samples this Dock button) is wired here. Pre-start it reads
  // "Start" and starts the run (which no longer claims wave 1 — Start ≠ claiming); once
  // started it reads "Call wave" and enqueues `callWaveEarly` for whichever wave is next;
  // it hides once the run is terminal. Text/visibility/the `aria-disabled` states are all
  // driven per-frame by `update()`'s `renderPrimary` below, since they depend on live
  // `HudVM`/`UiState`, not anything fixed at construction time.
  // The button keeps its VISIBLE text label in both layouts in every state (contract §2)
  // — no icon form; the empty icon span collapses (`.wy-btn-icon:empty` has nothing to
  // render).
  primaryParts.text.textContent = t('controls.start');

  pauseBtn.addEventListener('click', () => onAction({ type: 'togglePause' }));
  speedBtn.addEventListener('click', () => onAction({ type: 'cycleSpeed' }));
  // `aria-disabled` (never native `disabled` — dynamically disabling
  // the FOCUSED primary control, e.g. a just-clicked call landing pending, must not strand
  // focus by dropping it from the tab order) is activation-suppressed here, at the one
  // click site, rather than by removing the listener per state.
  primaryBtn.addEventListener('click', () => {
    if (primaryBtn.getAttribute('aria-disabled') === 'true') return;
    onAction({ type: 'start' });
  });

  // --- Cards: one per catalog tower (M2-S3, PLAN.md P2), wired in a loop ---
  // The catalog-index → hotkey ACTION map: a card at index ≥ 9 (a modded bundle; sv10's
  // `maxTowerCatalogSize` allows 64 CATALOG entries — `MAX_TOWERS` (1,000) is the
  // separate cap on PLACED towers) has NO hotkey at all (Codex R2-2, widened M2-S4a,
  // generalized to nine slots PLAN.md P6) — scaling the hotkey model past nine slots is
  // S12. `keymap.ts`'s `ARM_TOWER_ACTIONS` is the single place that ceiling lives.
  const ARM_HOTKEY_ACTIONS: readonly GameAction[] = ARM_TOWER_ACTIONS;
  const hotkeyActionForCardIndex = (index: number): GameAction | null =>
    ARM_HOTKEY_ACTIONS[index] ?? null;

  for (const c of cards) {
    c.name.textContent = towerName(c.towerId);
    const cost = ruleset.towerById[c.towerId]?.cost ?? 0;
    c.cost.textContent = t('panel.cost', { cost });
    c.root.addEventListener('click', () => onAction({ type: 'armTower', tower: c.towerId }));
  }

  /** Refresh card at `index`'s live hotkey badge — a card at catalog index ≥ 3 gets no
   *  badge/`aria-keyshortcuts` at all (Codex R2-2, widened M2-S4a), remaining fully
   *  keyboard-operable as a native button in the tab order. */
  function refreshCardHotkey(index: number): void {
    const c = cards[index];
    if (c === undefined) return;
    const action = hotkeyActionForCardIndex(index);
    if (action === null) {
      // No hotkey slot for this card at all (catalog index ≥ 3) — badge hidden, no
      // aria-keyshortcuts, still fully keyboard-operable as a native button.
      c.hotkey.textContent = '';
      c.root.removeAttribute('aria-keyshortcuts');
      return;
    }
    const label = formatKeyLabel(keymap.codeFor(action));
    c.hotkey.textContent = label ?? t('settings.unbound');
    if (label !== null) c.root.setAttribute('aria-keyshortcuts', label);
    else c.root.removeAttribute('aria-keyshortcuts');
  }
  function refreshAllCardHotkeys(): void {
    for (let i = 0; i < cards.length; i++) refreshCardHotkey(i);
  }
  refreshAllCardHotkeys();

  // The scaffold both dialog modals share: a hidden `role="dialog"` sibling of the Shell, an
  // inner box, and a header carrying the `<h2>` title and an aria-labelled close button. Each
  // caller fills the returned `inner` with its own body.
  function dialogScaffold(opts: {
    readonly className: string;
    readonly title: string;
    readonly closeClass: string;
    readonly closeLabel: string;
  }): {
    dialog: HTMLDivElement;
    inner: HTMLDivElement;
    closeBtn: HTMLButtonElement;
  } {
    const dialog = doc.createElement('div');
    dialog.className = opts.className;
    dialog.hidden = true;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', opts.title);
    dialog.tabIndex = -1;

    const inner = doc.createElement('div');
    inner.className = 'wy-settings-inner';
    dialog.appendChild(inner);

    const header = doc.createElement('div');
    header.className = 'wy-settings-header';
    const heading = doc.createElement('h2');
    heading.textContent = opts.title;
    const closeBtn = button(doc, opts.closeClass, opts.closeLabel);
    closeBtn.setAttribute('aria-label', opts.closeLabel);
    header.append(heading, closeBtn);
    inner.appendChild(header);

    return { dialog, inner, closeBtn };
  }

  // --- Settings dialog (sibling of the Shell — the Shell is inert while it's open) ---
  const {
    dialog: settingsDialog,
    inner: settingsInner,
    closeBtn,
  } = dialogScaffold({
    className: 'wy-settings',
    title: t('settings.title'),
    closeClass: 'wy-btn wy-settings-close',
    closeLabel: t('settings.close'),
  });

  // --- Install row (Story 11 P3): PERMANENT, unlike the once-dismissible banner. The
  // dialog is where a player looks for "how do I get this properly on my phone?" long after
  // the banner is gone, so the affordance lives here for the whole session. A promptable
  // DESKTOP session gets this row and no banner — the banner is phone-oriented. ---
  const installSection = doc.createElement('section');
  installSection.className = 'wy-install-row';
  const installHeading = doc.createElement('h3');
  installHeading.textContent = t('install.settings.row');
  const installAction = button(doc, 'wy-btn wy-install-action', t('install.banner.install'));
  // `other`: no captured prompt and no known flow to describe precisely — say where to look
  // rather than render a button that cannot do anything.
  const installExplain = doc.createElement('p');
  installExplain.className = 'wy-install-explain';
  installExplain.textContent = t('install.settings.explain');
  installSection.append(installHeading, installAction, installExplain);
  settingsInner.appendChild(installSection);

  // The dialog is now "Settings" (Story 11 P3, decision 5 — flagged as product-visible), so
  // the accessibility controls need their own heading to stay a named group rather than
  // becoming the dialog's unlabelled remainder.
  const a11yHeading = doc.createElement('h3');
  a11yHeading.textContent = t('settings.accessibility');
  settingsInner.appendChild(a11yHeading);

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

  // Slot actions are CATALOG-GATED (Codex R3-1, widened M2-S4a for `armTower3`,
  // generalized to nine slots PLAN.md P6): a slot beyond `cards.length` names a Card
  // that doesn't exist — filtered out of the rebind list entirely (no phantom
  // rebindable action). One slot-index compare replaces the old two-line ladder, and it
  // keeps the same result for slots 2/3 that the ladder already gave. `armTower1` stays
  // listed as long as at least one tower exists (M2 ships ≥ 1, per the schema).
  const REBINDABLE_ACTIONS = GAME_ACTIONS.filter((action) => {
    const slotIndex = ARM_HOTKEY_ACTIONS.indexOf(action);
    if (slotIndex === -1) return true; // not a slot action at all
    return cards.length > slotIndex;
  });

  for (const action of REBINDABLE_ACTIONS) {
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
  // hardcoded defaults — so screen-reader instructions stay truthful after a rebind.
  // Movement is four separate bindings, joined into the one {move} label; confirm/
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
    // A rebind of ANY action can displace `armTower1`/`armTower2` from its key (the
    // keymap is a bijection) — refresh every Card's live hotkey badge on every rebind,
    // not just when the player rebinds an arm action itself.
    refreshAllCardHotkeys();
    // Same bijection reasoning for the board's aria instructions: any rebind can move the
    // movement/confirm/sell keys they name, so refresh them here too.
    refreshBoardAria();
  }

  // --- iOS Add-to-Home-Screen instructions (Story 11 P3): a first-class modal, its own
  // sibling of the Shell. Safari has no `beforeinstallprompt` and no programmatic install,
  // so precise instructions ARE the affordance — not a fallback. ---
  const {
    dialog: instructions,
    inner: instructionsInner,
    closeBtn: instructionsClose,
  } = dialogScaffold({
    className: 'wy-settings wy-instructions',
    title: t('install.ios.title'),
    closeClass: 'wy-btn wy-instructions-close',
    closeLabel: t('install.ios.close'),
  });
  const instructionsBody = doc.createElement('p');
  instructionsBody.textContent = t('install.ios.body');
  instructionsInner.appendChild(instructionsBody);

  const LEAVE_DESC_ID = 'wy-leave-desc';

  // --- Leave-this-run confirm dialog: another first-class modal sibling of the Shell.
  // NOT `window.confirm()` — native confirm is not i18n-able, not stylable, and bypasses the
  // modal owner's inert-shell + Escape + focus-restore machinery the app already owns.
  //
  // The scaffold's close button IS the Stay action: staying is exactly this dialog's "close
  // without doing anything" route, so it needs no second identity, and Escape reaching it
  // through `dismissOnEscape` therefore MEANS stay. Confirm is the only other control. ---
  const {
    dialog: leaveDialog,
    inner: leaveInner,
    closeBtn: leaveStayBtn,
  } = dialogScaffold({
    className: 'wy-settings wy-leave',
    title: t('leave.title'),
    closeClass: 'wy-btn wy-leave-stay',
    closeLabel: t('leave.stay'),
  });
  const leaveBody = doc.createElement('p');
  leaveBody.id = LEAVE_DESC_ID;
  leaveBody.textContent = t('leave.body');
  // Point the dialog at its own body, or the consequence is never spoken. `show()` moves focus
  // straight to Stay, and the scaffold gives the dialog only a name — so without this a screen
  // reader announces "Leave this run?, dialog. Stay, button." and stops. The player would have
  // to browse the dialog manually to discover that leaving discards the run, which defeats the
  // entire reason this dialog exists: it is here to make an irreversible cost explicit, and it
  // was making it explicit only to people who can see it. axe does not flag a missing
  // description, so the e2e scan passed the whole time.
  leaveDialog.setAttribute('aria-describedby', LEAVE_DESC_ID);
  const leaveActions = doc.createElement('div');
  leaveActions.className = 'wy-leave-actions';
  const leaveConfirmBtn = button(doc, 'wy-btn wy-leave-confirm', t('leave.confirm'));
  // The scaffold puts its close button in the HEADER, which is right for a settings dialog
  // but wrong for a two-choice one: it would split the safe option away from the destructive
  // one, so a player scanning the dialog would see a lone "Leave the run" in the body and
  // have to hunt the header for the way out. Move Stay down into the action row beside it —
  // safe option FIRST, and it keeps its single identity (it is still the scaffold's close
  // button, so Escape and the close route stay one thing).
  leaveActions.append(leaveStayBtn, leaveConfirmBtn);
  leaveInner.append(leaveBody, leaveActions);

  // What to run if the player commits. Deliberately NOT cleared in `hide()`: the modal owner
  // calls `hide()` whenever this overlay is DEPOSED by a higher-priority one, not only when
  // it is closed, and the deposed entry stays on the stack to be re-`show()`n later. Rotate
  // outranks `settings`, so clearing on hide left a real dead button: pause → tap home →
  // rotate to portrait (rotate deposes the dialog, handler cleared) → rotate back (the
  // dialog re-appears, fully functional-looking) → "Leave the run" silently did nothing.
  //
  // Instead the handler lives until the dialog is GENUINELY dismissed, and the confirm path
  // below refuses to fire while the dialog isn't showing — which is what actually makes a
  // stale confirmation impossible, and is true on every close route (Stay, Escape, deposition)
  // without needing a hook on each.
  let leaveConfirmHandler: (() => void) | null = null;
  const leaveOverlay: ModalOverlay = {
    show(): void {
      leaveDialog.hidden = false;
      // Initial focus on the SAFE action (Stay), not the destructive one.
      leaveStayBtn.focus();
    },
    hide(): void {
      leaveDialog.hidden = true;
    },
  };
  leaveStayBtn.addEventListener('click', () => modal.close(leaveOverlay));
  leaveConfirmBtn.addEventListener('click', () => {
    // Leaving a run is destructive and irreversible, so it fires ONLY from a dialog the
    // player can actually see. A click while hidden is never a player decision.
    if (leaveDialog.hidden) return;
    // Consume the handler before closing, so a double-activation cannot navigate twice.
    const confirmed = leaveConfirmHandler;
    leaveConfirmHandler = null;
    modal.close(leaveOverlay);
    confirmed?.();
  });

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
  const instructionsOverlay: ModalOverlay = {
    show(): void {
      instructions.hidden = false;
      instructionsClose.focus();
    },
    hide(): void {
      instructions.hidden = true;
    },
  };

  // --- Install UI: banner + settings row + the iOS instructions route (Story 11 P3) ---

  banner.text.textContent = t('install.banner.text');
  banner.dismissGlyph.textContent = ICONS.dismiss;
  banner.dismiss.setAttribute('aria-label', t('install.banner.dismiss'));

  /** Open the instructions dialog. Registered at `settings` PRIORITY — it only ever opens
   *  after the settings dialog closes (or straight from the banner, with nothing else open),
   *  so an equal rank is unambiguous rather than a race. `dismissOnEscape` is per-overlay
   *  metadata now (modal.ts), so Escape dismisses it exactly like settings. */
  function openInstructions(): void {
    abortGesture();
    modal.open(instructionsOverlay, { priority: 'settings', dismissOnEscape: true });
  }
  instructionsClose.addEventListener('click', () => modal.close(instructionsOverlay));

  /** Fire the held prompt. `install.prompt()` owns the single-use contract — including the
   *  concurrent case — and resolves to `'unavailable'` rather than rejecting on a refusal, so
   *  there is nothing to guard or catch here. */
  function runPrompt(): void {
    void install.prompt();
  }

  const installActivate = (): void => {
    if (install.state().branch === 'ios') openInstructions();
    else runPrompt();
  };

  banner.action.addEventListener('click', installActivate);
  banner.dismiss.addEventListener('click', () => install.dismiss());
  installAction.addEventListener('click', () => {
    if (install.state().branch === 'ios') {
      // Open-from-settings: close settings FIRST, then open instructions, so the two never
      // sit on the stack at equal priority. Focus return then follows the modal owner's own
      // stack rules — closing instructions restores the settings opener.
      modal.close(settingsOverlay);
      openInstructions();
      return;
    }
    runPrompt();
  });

  /** Re-home focus that a just-removed install surface was holding (the Story 10 rule: UI
   *  teardown never strands focus on `document.body`). Banner-contained focus goes to the
   *  Dock's Start button — the natural next action pre-start; settings-row-contained focus
   *  goes to the dialog's own close target, per the modal owner's stack rules. */
  function reHomeFrom(container: HTMLElement, fallback: HTMLElement): void {
    if (container.contains(doc.activeElement)) fallback.focus();
  }

  /** The single install-UI write path: recomputes both surfaces from `install.state()` plus
   *  the run's `started` flag, and re-homes any focus it strands. */
  function renderInstall(started: boolean): void {
    const state: InstallState = install.state();
    const hidden = state.standalone || state.installed;

    // Banner: browser-tab mode ∧ audience ∧ pre-start ∧ un-dismissed ∧ not ended for this
    // session (the last survives Play-again, which returns to a pre-start state).
    const showBanner =
      !hidden &&
      state.bannerAudience &&
      !started &&
      !state.dismissed &&
      !install.bannerEndedForSession();
    if (showBanner !== !banner.root.hidden) {
      // A banner visibility change RESIZES the stage (it is a reserved grid row), so any
      // in-flight captured gesture must cancel by the Story 10 contract rather than commit
      // against geometry that moved underneath it.
      abortGesture();
      // `focus()` on a hidden element no-ops (stranding focus on `document.body`), so the
      // fallback must be conditionally GUARANTEED-focusable rather than hardcoded to one
      // target: `primaryBtn` stays visible through the Start edge now (M2-S2's morph, PLAN.md
      // P3 step 17 — it hides only once the run is terminal, never merely on Start), so it IS
      // the fallback in the common case; the board remains the fallback for the one state
      // where `primaryBtn` genuinely is hidden (terminal).
      if (!showBanner) reHomeFrom(banner.root, primaryBtn.hidden ? shell.board : primaryBtn);
      banner.root.hidden = !showBanner;
    }
    // `renderInstall` runs on every `update()` tick, so — like the visibility flips above —
    // each DOM write below is guarded on an ACTUAL change, so a steady state re-announces
    // nothing to assistive tech and does no needless layout work.
    const actionLabel =
      state.branch === 'ios' ? t('install.banner.how') : t('install.banner.install');
    if (showBanner && banner.action.textContent !== actionLabel) {
      banner.action.textContent = actionLabel;
    }

    // Settings row: permanent while the app is not installed, and never offers a button it
    // cannot honour.
    if (hidden !== installSection.hidden) {
      if (hidden) reHomeFrom(installSection, closeBtn);
      installSection.hidden = hidden;
    }
    const canAct = state.branch === 'ios' || state.canPrompt;
    if (!canAct && installAction.contains(doc.activeElement)) closeBtn.focus();
    if (installAction.hidden !== !canAct) installAction.hidden = !canAct;
    if (installAction.textContent !== actionLabel) installAction.textContent = actionLabel;
    if (installExplain.hidden !== canAct) installExplain.hidden = canAct;
    // After a declined browser prompt the held event is gone, so the row falls back to the
    // explanation — but "your browser doesn't offer an install prompt" is untrue for a
    // session that just saw one. Say what actually happened instead.
    if (!canAct) {
      const explainLabel = state.promptDeclined
        ? t('install.settings.declined')
        : t('install.settings.explain');
      if (installExplain.textContent !== explainLabel) installExplain.textContent = explainLabel;
    }
  }

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
    modal.open(settingsOverlay, { priority: 'settings', dismissOnEscape: true });
    // Auto-pause an ACTIVE, unpaused run when settings opens — the Shell goes inert and is
    // covered while the dialog is up, so an unpaused wave would keep advancing unseen (lives
    // lost / the run ending inside the dialog). Routed through the app-level seam, which owns
    // the started-and-unpaused guard (identical to the one rotate.ts used to inline) and is
    // idempotent: if rotate already auto-paused, this is a no-op. On close the run STAYS
    // paused — the player resumes deliberately from the Dock, like the rotate flow. (Results
    // outranks settings and inerts the Dock, so this handler can't even fire while results is
    // open — no terminal-state pause interaction here.)
    ensurePaused();
  });
  closeBtn.addEventListener('click', () => modal.close(settingsOverlay));

  // --- Game-level Escape + the armTower1..armTower9 hotkeys: document scope, PLAN.md P2, M2-S3/S4a/P6 ---
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
    // `armTower1`..`armTower9` map to catalog index 0..8 (M2-S3, widened M2-S4a,
    // generalized to nine slots PLAN.md P6) via `ARM_HOTKEY_ACTIONS`' own order — a
    // catalog-gated no-op when there is no tower/Card at that index (Codex R3-1's
    // `towers[n]` guard, mirrored here on `cards[n]`).
    if (e.repeat) return;
    const action = keymap.actionFor(e.code);
    const index = action === null ? -1 : ARM_HOTKEY_ACTIONS.indexOf(action);
    if (index === -1) return;
    const c = cards[index];
    if (c === undefined) return; // no such slot (e.g. armTower3 on a two-tower bundle)
    // Consume the key so a rebind onto Enter/Space can't ALSO activate whatever native
    // button currently has focus (e.g. the settings opener) — the same keypress would both
    // arm and synthetically click it.
    e.preventDefault();
    onAction({ type: 'armTower', tower: c.towerId });
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
    /** M2-S8: `null` for a SUPPORT tower, whose bundle carries no attack at all — the
     *  Damage/Range/Fire rate/Targets rows are OMITTED rather than shown as zeros, the
     *  same omit-rather-than-lie posture `blastRadiusTiles`/`dot`/`stun` already take.
     *  A beacon has no damage, not zero damage. */
    readonly damage: number | null;
    readonly rangeTiles: string | null;
    readonly fireRate: string | null;
    readonly targets: string | null;
    /** Whether a support aura is currently raising `damage` above the catalog's base
     *  (M2-S8) — the Panel labels the row differently so the buffed number is never
     *  mistaken for the tower's own printed stat. */
    readonly buffed: boolean;
    /** The percentage a SUPPORT tower adds to adjacent attackers, derived from the def's
     *  own `damageMulFp` — `null` for an attacking tower. Derived, never the hardcoded
     *  "+50%" the shipped beacon happens to have: every other row here is data-driven,
     *  and a modded bundle's Panel must not lie. */
    readonly supportPercent: string | null;
    /** The AoE blast radius, in tiles — `null` for a tower with no `aoe` effect (the
     *  shipped `basic`/`slow`), so the Panel row is omitted rather than reading "0"
     *  (M2-S4a). Text, not ring-only (PLAN.md step 14/15's a11y obligation). */
    readonly blastRadiusTiles: string | null;
    /** The DoT's per-tick damage, cadence, and duration (in seconds, matching
     *  `fireRate`'s own tick→second conversion) — `null` for a tower with no `dot`
     *  effect (the shipped `basic`/`slow`/`splash`), so the Panel row is omitted
     *  rather than reading zeros (M2-S5a P7, mirrors `blastRadiusTiles`'s posture). */
    readonly dot: {
      readonly damage: number;
      readonly cadence: string;
      readonly duration: string;
      /** Whether THIS row's number was raised by an aura (M2-S8) — tracked separately
       *  from `buffed`, which describes the Damage row. A bundle whose direct amount
       *  floors unchanged while its DoT does not (direct 1 → 1, dot 4 → 6) would
       *  otherwise print a silently-buffed Poison row under an unlabelled Damage row:
       *  the mirror of the "(boosted)" lie this file is otherwise careful about. */
      readonly buffed: boolean;
    } | null;
    /** The stun's chance (out of the effect's `chanceNum`/256, as a whole percent) and
     *  duration (in seconds, matching `fireRate`/`dot`'s own tick→second conversion) —
     *  `null` for a tower with no `stun` effect, so the Panel row is omitted rather than
     *  reading zeros (M2-S6 P7, mirrors `dot`'s posture). */
    readonly stun: {
      readonly chance: string;
      readonly duration: string;
    } | null;
    /** The tower's firing discipline (M2-S9), `null` when it does not attack at all
     *  (the `beacon` support case, same posture `damage`/`rangeTiles`/`fireRate`/
     *  `targets` already take). ONE field rather than two booleans (a "is trigger
     *  range" flag plus an "is single-use" flag) because both the range row's LABEL
     *  and the single-use row below are asking the exact same question — is this
     *  tower's firing discipline burst? — so a single field keeps them from ever
     *  disagreeing; two independently-set booleans could drift out of sync in a way a
     *  single derived value structurally cannot. */
    readonly attackMode: 'cadenced' | 'burst' | null;
  }

  /** The Panel's Targets row text for a tower's `attack.domain` (M2-S7): `'ground'`,
   *  `'air'`, or `'both'` (the widened `TowerTargetDomain` axis, PLAN.md P3) each get
   *  their own localized key (ADR 0004) — `undefined` (a forged/unresolved towerId, the
   *  same defensive posture `towerStats` already takes on an absent `def`) falls back
   *  to `'ground'`, matching every other unresolved-domain totality rail in this story
   *  (placement's clauses 3/5, the render VM's `warded`-style join). Each branch calls
   *  `t()` with its own literal key (rather than resolving a `MessageKey` value and
   *  calling `t()` once) so every call site stays a concrete, per-key-typed lookup. */
  function targetsFor(domain: 'ground' | 'air' | 'both' | undefined): string {
    if (domain === 'air') return t('tower.targets.air');
    if (domain === 'both') return t('tower.targets.both');
    return t('tower.targets.ground');
  }

  /** Data-driven from the armed/selected `CompiledTower` (M2-S3 retires the closed-union
   *  `exhaustive: never` throw — catalog ids are OPEN, so a legitimate modded bundle's
   *  tower must render real stats, never crash the Panel). `damage` is Σ of the tower's
   *  `direct` AND `aoe` effect amounts, in authored order (both are direct damage's two
   *  forms — CONTEXT.md's Effect primitive entry — so `splash`'s blast damage must count here just
   *  as `basic`'s single-target damage does; the shipped `slow` tower's row reads its
   *  own direct total, 2; QC round 2 corrected this line's earlier zero-direct-effects
   *  claim). M2-S8: a pure-support bundle no longer "reads 0" — `damage`/`rangeTiles`/
   *  `fireRate`/`targets` are all `null` for a tower with no `attack`, and their rows are
   *  OMITTED rather than printed as zeros, which is this story's headline a11y claim. The
   *  same now holds for a `towerId` this build's catalog doesn't resolve (defensive — the
   *  armed/selection state machine only ever holds a validated id): those four rows are
   *  omitted rather than zeroed, and `cost` still falls back to 0 rather than throwing. */
  function towerStats(towerId: string, buffMulFp: number = SUPPORT_MUL_IDENTITY): TowerStats {
    const def = ruleset.towerById[towerId];
    // Buffed PER EFFECT, then summed — never `buffAmount(Σ)`. The two differ under
    // floor-rounding (amounts 3 + 3 at ×1.5 are a real 4 + 4 = 8, but `floor(6 · 1.5)`
    // is 9), and the sim buffs each snapshotted effect independently. Unobservable in
    // the shipped catalog, which has no two-direct-effect tower; wrong the moment one
    // exists, which is exactly when nobody would be looking.
    const damage =
      def === undefined || def.attack === undefined
        ? null
        : def.effects.reduce(
            (sum, e) =>
              e.kind === 'direct' || e.kind === 'aoe' ? sum + buffAmount(e.amount, buffMulFp) : sum,
            0,
          );
    // The UNBUFFED total, kept so the "(boosted)" label can be keyed on the number
    // actually changing rather than on the multiplier being > 1. `buffAmount` FLOORS, so
    // a weak multiplier is a no-op on small amounts — the schema admits `damageMulFp`
    // 257 (×1.004), which floors away for every amount below 256 — and labelling an
    // unchanged number "boosted" is the same kind of lie as the zeroed rows this
    // function omits. Not reachable with the shipped catalog (its smallest direct amount
    // is `venom`'s 2, and ×1.5 moves it), so this is about what the Panel promises, not
    // about a bug a player can see today.
    const baseDamage =
      def === undefined || def.attack === undefined
        ? null
        : def.effects.reduce(
            (sum, e) => (e.kind === 'direct' || e.kind === 'aoe' ? sum + e.amount : sum),
            0,
          );
    const aoeEffect = def?.effects.find((e) => e.kind === 'aoe');
    const dotEffect = def?.effects.find((e) => e.kind === 'dot');
    const stunEffect = def?.effects.find((e) => e.kind === 'stun');
    return {
      name: towerName(towerId),
      cost: def?.cost ?? 0,
      damage,
      buffed: damage !== null && baseDamage !== null && damage > baseDamage,
      supportPercent:
        def?.support === undefined
          ? null
          : formatNumber(
              ((def.support.damageMulFp - SUPPORT_MUL_IDENTITY) / SUPPORT_MUL_IDENTITY) * 100,
            ),
      rangeTiles: def?.attack === undefined ? null : formatNumber(def.attack.rangeFp / FP_ONE),
      // M2-S9: a burst tower has no cadence, so there is no fire rate to report — the
      // omit-rather-than-zero precedent the `beacon` and the `dot`/`stun` rows already
      // set. `attack.mode` makes this a compile error rather than a `?? 0` lie.
      fireRate:
        def?.attack === undefined || def.attack.mode !== 'cadenced'
          ? null
          : formatNumber(TICKS_PER_SECOND / def.attack.cadenceTicks),
      // M2-S7: the capability profile compiles `attack.domain` as `'ground'`/`'air'`/
      // `'both'` (the widened `TowerTargetDomain` axis) — sv7's `antiair` is the first
      // catalog entry to compile anything other than `'ground'`, so this row must
      // actually READ the def's domain instead of the old literal `'ground'`, or
      // `antiair` would honestly-falsely display "Targets: Ground". `def === undefined`
      // (a forged/unresolved towerId) falls back to `'ground'`, the same totality rail
      // every other field in this function already takes on an absent definition.
      targets: def?.attack === undefined ? null : targetsFor(def.attack.domain),
      blastRadiusTiles: aoeEffect === undefined ? null : formatNumber(aoeEffect.radiusFp / FP_ONE),
      dot:
        dotEffect === undefined
          ? null
          : {
              // Buffed like the direct/aoe amounts above, and for the same reason: the sim
              // buffs a `dot`'s per-tick amount at FIRE time (`snapshotEffects`), so a
              // `venom` beside a beacon really does apply 6/tick, not 4. Showing the raw
              // catalog number here would misreport half of that tower's damage output —
              // on precisely the pairing this story exists to showcase — and the Panel is
              // the only non-canvas carrier of it. Cadence and duration are NOT buffed
              // (m2.md: "Non-damage magnitudes and durations ... are never buffed"), so
              // they stay raw, which is also what makes this line's asymmetry deliberate.
              damage: buffAmount(dotEffect.amount, buffMulFp),
              cadence: formatNumber(dotEffect.cadenceTicks / TICKS_PER_SECOND),
              duration: formatNumber(dotEffect.durationTicks / TICKS_PER_SECOND),
              buffed: buffAmount(dotEffect.amount, buffMulFp) > dotEffect.amount,
            },
      stun:
        stunEffect === undefined
          ? null
          : {
              // 256 here is the RNG DRAW RANGE (`rng.nextInt(256) < chanceNum`, the sim's
              // pinned stun roll), NOT `FP_ONE`. The two constants happen to share a value;
              // coupling this to `FP_ONE` would tie the probability denominator to the
              // fixed-point scale, so a change to either would silently corrupt the other.
              chance: formatNumber((stunEffect.chanceNum / 256) * 100),
              duration: formatNumber(stunEffect.durationTicks / TICKS_PER_SECOND),
            },
      attackMode: def?.attack?.mode ?? null,
    };
  }

  function appendStatRows(container: HTMLElement, stats: TowerStats): void {
    const rows = [
      t('panel.cost', { cost: stats.cost }),
      // M2-S8: each attack-derived row is present iff the tower actually attacks. A
      // support tower shows the Support row in their place — the same omit-rather-than-
      // zero rule the DoT/stun rows already follow, applied to the base stats.
      ...(stats.damage === null
        ? []
        : [
            stats.buffed
              ? t('panel.damageBuffed', { damage: stats.damage })
              : t('panel.damage', { damage: stats.damage }),
          ]),
      // M2-S9: a burst tower's range is a TRIGGER range, not a firing range — the mine
      // sits idle until a creep enters this ring, it does not shoot at it — so the row
      // takes a distinct label rather than reusing `panel.range`'s "fires within" framing.
      ...(stats.rangeTiles === null
        ? []
        : [
            stats.attackMode === 'burst'
              ? t('panel.triggerRange', { tiles: stats.rangeTiles })
              : t('panel.range', { tiles: stats.rangeTiles }),
          ]),
      ...(stats.fireRate === null ? [] : [t('panel.fireRate', { rate: stats.fireRate })]),
      ...(stats.targets === null ? [] : [t('panel.targets', { targets: stats.targets })]),
      ...(stats.supportPercent === null
        ? []
        : [t('panel.support', { percent: stats.supportPercent })]),
      ...(stats.blastRadiusTiles === null
        ? []
        : [t('panel.blastRadius', { tiles: stats.blastRadiusTiles })]),
      // The single most important fact about a burst tower — it is CONSUMED when it
      // fires — and nothing else on screen conveys it: the board draws no "used up" cue,
      // and every other row here describes what the tower does while it's still there.
      ...(stats.attackMode === 'burst' ? [t('panel.singleUse')] : []),
      ...(stats.dot === null
        ? []
        : [
            stats.dot.buffed
              ? t('panel.dotBuffed', {
                  damage: stats.dot.damage,
                  cadence: stats.dot.cadence,
                  duration: stats.dot.duration,
                })
              : t('panel.dot', {
                  damage: stats.dot.damage,
                  cadence: stats.dot.cadence,
                  duration: stats.dot.duration,
                }),
          ]),
      ...(stats.stun === null
        ? []
        : [
            t('panel.stun', {
              chance: stats.stun.chance,
              duration: stats.stun.duration,
            }),
          ]),
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
  /** The stat-rows container, tracked so a live aura change can re-render just those rows
   *  without tearing down the Panel subtree (and its focus) — M2-S8, mirroring
   *  `panelSellBtn`'s in-place patching. `null` whenever the Panel isn't showing stats. */
  let panelStatsEl: HTMLElement | null = null;
  /** The multiplier `panelStatsEl`'s rows were last rendered at, so the patch above is a
   *  no-op on the overwhelmingly common frame where the aura has not moved. */
  let panelStatsBuffMulFp = SUPPORT_MUL_IDENTITY;
  // The live region's last-announced outcome sequence (Fix A) — `null` so the very first
  // `update()` call always announces, even when the initial outcome is `null` (message '').
  let lastAnnouncedSeq: number | null = null;
  // The Start→Call-wave morph announcement's own one-shot latch (M2-S2, PLAN.md P3 step
  // 17) — separate from `lastAnnouncedSeq` (which tracks placement/arm/sell outcomes, not
  // this transition) so the two announcements can never suppress each other. Starts `true`
  // (not `false`): the announcement is for a GENUINE `started` false→true edge, so it must
  // stay silent unless `update()` actually observed the `false` side first — a caller whose
  // very first `update()` call already has `ui.started === true` (a resumed/host-provided
  // snapshot, not necessarily a fresh boot) must not read as "just started".
  let announcedStarted = true;
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
      // The support aura reaching an already-selected tower can change too (M2-S8) — a
      // beacon built or sold beside it — and the stat rows are built ONCE on the rebuild
      // path below, so without this the Damage/(boosted)/Poison rows froze at whatever
      // the aura was when the tower was selected: the sim fired 15 while the Panel went
      // on reading 10, until the player deselected and reselected.
      //
      // Patched IN PLACE rather than folded into `key`. Putting it in the key does fix
      // the staleness, but it also fails the early return and runs the full teardown —
      // `clearChildren` plus the focus re-home at the end of this function — so a
      // keyboard user with focus on Sell or Close would lose it to the board while the
      // Panel stayed open on the same selection. That is exactly the trap the refund
      // label above is patched in place to avoid; the buff must not reintroduce it.
      if (panelStatsEl !== null && ui.armed === null && ui.selection !== null) {
        const nextBuff = ui.selection.buffMulFp;
        if (nextBuff !== panelStatsBuffMulFp) {
          panelStatsBuffMulFp = nextBuff;
          clearChildren(panelStatsEl);
          appendStatRows(panelStatsEl, towerStats(ui.selection.towerId, nextBuff));
        }
      }
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
    panelStatsEl = null;
    panelStatsBuffMulFp = SUPPORT_MUL_IDENTITY;
    clearChildren(panel.root);
    if (ui.armed !== null) {
      const stats = towerStats(ui.armed);
      const heading = doc.createElement('p');
      heading.className = 'wy-panel-name';
      heading.textContent = stats.name;
      panel.root.appendChild(heading);
      panelStatsEl = doc.createElement('div');
      panel.root.appendChild(panelStatsEl);
      appendStatRows(panelStatsEl, stats);
      appendCloseButton(panel.root);
      panel.root.hidden = false;
    } else if (ui.selection !== null) {
      const stats = towerStats(ui.selection.towerId, ui.selection.buffMulFp);
      const heading = doc.createElement('p');
      heading.className = 'wy-panel-name';
      heading.textContent = stats.name;
      panel.root.appendChild(heading);
      panelStatsEl = doc.createElement('div');
      panel.root.appendChild(panelStatsEl);
      appendStatRows(panelStatsEl, stats);
      panelStatsBuffMulFp = ui.selection.buffMulFp;
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
      // A disarm-close re-homes to the CARD that armed it — resolved via `shell.cards`
      // (the `armed:${towerId}` teardown key already switches on re-arm, M2-S3).
      const armedTowerId = prevKey.startsWith('armed:') ? prevKey.slice('armed:'.length) : null;
      const armedCard =
        armedTowerId === null ? undefined : cards.find((c) => c.towerId === armedTowerId);
      if (armedTowerId !== null && key === 'closed' && armedCard !== undefined)
        armedCard.root.focus();
      else shell.board.focus();
    }
  }

  // --- Wave preview (M2-S2, PLAN.md P3 steps 16-17): its own visible surface in BOTH
  // layouts, near the countdown, hosted inside the existing keyboard-scrollable `.wy-hud`
  // group — never chip-hosted: the Compact chip's full text is screen-reader-only,
  // so a chip-hosted preview would be invisible to sighted Compact users. ---

  // Exhaustive literal-key lookup (never a computed key — the i18n extraction gate reads
  // string-literal `t()` arguments only) for every catalog-id creep name. A creepId that
  // isn't in the catalog (a forged/future content id this build doesn't know) falls back
  // to the localized generic name rather than ever rendering a raw id (ADR 0004:
  // no user-facing string outside the catalog) — dev-mode-only, since a genuinely
  // compiled ruleset can't produce one (the preview's `entriesSummary` is derived
  // from validated, catalog-resolved entries).
  // Null-prototype for the same reason as `TOWER_NAME` (Codex #73): an id like
  // `'constructor'` must miss, not resolve to an inherited `Object.prototype` member.
  const CREEP_NAME: Readonly<Partial<Record<string, () => string>>> = Object.assign(
    Object.create(null) as Partial<Record<string, () => string>>,
    {
      normal: () => t('creep.normal.name'),
      fast: () => t('creep.fast.name'),
      swarm: () => t('creep.swarm.name'),
      armored: () => t('creep.armored.name'),
      resolute: () => t('creep.resolute.name'),
      flying: () => t('creep.flying.name'),
    } satisfies Record<string, () => string>, // QC r3: same rationale as `TOWER_NAME`
  );
  // PURE name derivation — no side effects: the render-skip sentinel calls this
  // every tick, and a should-I-skip comparison must never execute observable
  // effects to compute its own inputs. The dev-mode
  // mapping-gap warning lives in `warnUnmappedCreeps`, invoked only on the
  // REBUILD path — once per rebuild, never per tick.
  function creepName(id: string): string {
    const label = CREEP_NAME[id];
    if (label !== undefined) return label();
    return t('creep.unknown.name', { id });
  }
  function warnUnmappedCreeps(entries: readonly { readonly creepId: string }[]): void {
    if (!import.meta.env.DEV) return;
    for (const entry of entries) {
      if (CREEP_NAME[entry.creepId] === undefined) {
        // The ONE dev-mode diagnostic in this module — a mapping gap here is a
        // content/catalog bug, worth surfacing loudly in dev (bounded: fires per
        // preview REBUILD, not per tick).
        console.warn(
          `wave preview: creep id '${entry.creepId}' has no catalog name — using the fallback`,
        );
      }
    }
  }

  // `domain`/`immunities` are CLOSED unions (`PreviewEntryVM`), fully enumerable today —
  // unlike `creepId`, there's no "future content this build hasn't catalogued" case to
  // fall back for, so both get exhaustive literal-key maps and the compiler catches the
  // next variant instead of a raw sv6 token leaking into accessible text.
  const DOMAIN_NAME: Readonly<Record<PreviewEntryVM['domain'], () => string>> = {
    ground: () => t('hud.preview.domain.ground'),
    air: () => t('hud.preview.domain.air'),
  };
  const IMMUNITY_NAME: Readonly<Record<PreviewEntryVM['immunities'][number], () => string>> = {
    slow: () => t('hud.preview.immunity.slow'),
    stun: () => t('hud.preview.immunity.stun'),
  };

  /** "{count} × {name} — {domain}, armor {n}, {immunities}" (PLAN.md P3 step 17), never
   *  colour/icon-only. */
  function previewEntryText(entry: PreviewEntryVM): string {
    const domain = DOMAIN_NAME[entry.domain]();
    const immunities =
      entry.immunities.length === 0
        ? t('hud.preview.immunities.none')
        : entry.immunities.map((i) => IMMUNITY_NAME[i]()).join(', ');
    return t('hud.preview.entry', {
      count: entry.count,
      name: creepName(entry.creepId),
      domain,
      armor: t('hud.preview.armor', { armor: entry.armor }),
      immunities,
    });
  }

  // The preview's content only changes when `waveCursor` moves — a handful of times per
  // run — while `update()` runs on every HUD memo-key change (~20×/s). Guarded like every
  // other write path in this module (`setChip`, `renderInstall`, `renderPanel`'s
  // `lastPanelKey`): a screen-reader virtual cursor or braille display parked on a preview
  // row must not have its node torn down and rebuilt underneath it every tick.
  let lastPreviewKey = '';
  function renderPreview(preview: HudPreview | null): void {
    if (preview === null) {
      previewEl.root.hidden = true;
      lastPreviewKey = '';
      return;
    }
    previewEl.root.hidden = false;
    const key =
      preview.kind === 'lastWave'
        ? 'last'
        : `${preview.waveNumber}/${preview.waveCount}:${preview.entries
            .map((e) => `${e.creepId}x${e.count}:${e.domain}:${e.armor}:${e.immunities.join('+')}`)
            .join('|')}`;
    // Locale self-heal: the key is CONTENT-only, so a runtime
    // locale/catalog change would otherwise leave stale-language DOM until the wave
    // moved — defeating the module's deferred-`t()` convention (line ~86). Like
    // `renderPrimary`, the sentinel compares the exact strings this render would
    // write: the title AND the first entry row (rows read five catalog keys the
    // title doesn't — a title-only sentinel would self-heal the heading while the
    // rows stayed stale). On drift, fall through and rebuild.
    // Unreachable while only `en` ships; load-bearing the day a second locale
    // lands. (Consciously untested: exercising it would mean faking a runtime
    // catalog-swap mechanism that does not exist. The MEMO direction — unchanged
    // preview never rebuilds rows — IS pinned: overlay.test.ts node-identity test.)
    const expectedTitle =
      preview.kind === 'lastWave'
        ? t('hud.preview.lastWave')
        : t('hud.preview.title', { waveNumber: preview.waveNumber, waveCount: preview.waveCount });
    const firstEntry = preview.kind === 'upcoming' ? preview.entries[0] : undefined;
    const expectedFirstRow = firstEntry === undefined ? null : previewEntryText(firstEntry);
    const firstRowCurrent = previewEl.list.firstElementChild?.textContent ?? null;
    if (
      key === lastPreviewKey &&
      previewEl.title.textContent === expectedTitle &&
      firstRowCurrent === expectedFirstRow
    ) {
      return;
    }
    lastPreviewKey = key;
    if (preview.kind === 'lastWave') {
      previewEl.title.textContent = t('hud.preview.lastWave');
      clearChildren(previewEl.list);
      return;
    }
    previewEl.title.textContent = t('hud.preview.title', {
      waveNumber: preview.waveNumber,
      waveCount: preview.waveCount,
    });
    clearChildren(previewEl.list);
    warnUnmappedCreeps(preview.entries); // dev diagnostic — rebuild path only
    for (const entry of preview.entries) {
      const li = doc.createElement('li');
      li.textContent = previewEntryText(entry);
      previewEl.list.appendChild(li);
    }
  }

  /** The morphing primary control's text + `aria-disabled` state (PLAN.md P3 step 17):
   *  pre-start "Start" (always enabled); once started, "Call wave" — `aria-disabled` while
   *  a call is pending (own pending-launch label) OR the buffer is momentarily full
   *  (`UiState.callWaveReady` folds both `HudVM.callable` and buffer capacity) OR the
   *  last wave has already launched (visible-disabled, never hidden — the
   *  callable/launchPending distinction plus the explicit after-final-launch state);
   *  hidden once the run is terminal. `aria-disabled`, never
   *  native `disabled` — the click listener above suppresses
   *  activation instead, so a disabled state never drops focus off a control that may
   *  hold it (e.g. the just-clicked button landing pending). */
  function renderPrimary(hud: HudVM, ui: UiState): void {
    if (isTerminalPhase(hud.phase)) {
      primaryBtn.hidden = true;
      return;
    }
    primaryBtn.hidden = false;
    if (!ui.started) {
      if (primaryParts.text.textContent !== t('controls.start')) {
        primaryParts.text.textContent = t('controls.start');
      }
      primaryBtn.setAttribute('aria-disabled', 'false');
      return;
    }
    const label = hud.launchPending ? t('controls.callWave.pending') : t('controls.callWave');
    if (primaryParts.text.textContent !== label) primaryParts.text.textContent = label;
    primaryBtn.setAttribute('aria-disabled', String(!ui.callWaveReady));
  }

  function outcomeMessage(outcome: PlacementOutcome | null): string {
    if (outcome === null) return '';
    switch (outcome.kind) {
      case 'armed':
        return t('live.armed', { name: towerName(outcome.towerId) });
      case 'disarmed':
        return t('live.disarmed');
      case 'placed':
        return t('live.placed', { name: towerName(outcome.towerId) });
      case 'rejected':
        if (outcome.reason === 'bounty') return t('live.rejected.bounty');
        if (outcome.reason === 'occupied') return t('live.rejected.occupied');
        if (outcome.reason === 'pendingCap') return t('live.rejected.pendingCap');
        return t('live.rejected.generic');
      case 'sold':
        return t('live.sold', { refund: outcome.refund });
      case 'destroyed':
        return t('live.destroyed');
    }
  }

  return {
    resultsEl: results,
    settingsEl: settingsDialog,
    instructionsEl: instructions,
    leaveEl: leaveDialog,
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
      // Wave chip: COUNTDOWN-ONLY (M2-S2, PLAN.md P3 step 17 — the composition text moved
      // to its own preview surface below, so the chip no longer carries an "in progress"
      // fallback). VISIBLE PRE-START now too (`HudVM.countdownSeconds` reads the sim's real
      // `countdownRemaining`, which is meaningful before `start()` — the Start decouple —
      // not just after); hidden once every wave has launched (its preview surface shows the
      // last-wave marker instead) or the run is terminal.
      setChip(
        hudEls.wave,
        hud.countdownSeconds !== null ? t('hud.countdown', { seconds: hud.countdownSeconds }) : '',
        hud.countdownSeconds !== null
          ? t('hud.wave.compact.countdown', { s: hud.countdownSeconds })
          : '',
      );
      renderPreview(hud.preview);
      // Pause is HIDDEN (not disabled) pre-start (PLAN.md P4) — there's nothing to pause
      // yet, and a hidden control can't be tabbed to or announced as a false affordance.
      pauseBtn.hidden = !view.ui.started;
      pauseParts.icon.textContent = view.paused ? ICONS.resume : ICONS.pause;
      pauseParts.text.textContent = view.paused ? t('controls.resume') : t('controls.pause');
      pauseBtn.setAttribute('aria-pressed', String(view.paused));
      speedParts.icon.textContent = `${view.speed}${ICONS.speed}`;
      speedParts.text.textContent = t('controls.speed', { factor: view.speed });
      renderPrimary(hud, view.ui);
      // The Start→Call-wave morph is announced through the existing polite live region:
      // Start moves focus to the board and the HUD itself is not
      // live, so without this the morph is undiscoverable to AT users. Fires exactly once
      // per run, on the `started` false→true edge — `announcedStarted` resets with every
      // fresh run (it goes false the moment `ui.started` itself does, e.g. Play-again), so
      // the announcement re-arms for the next run rather than firing only the session's
      // first Start.
      if (!view.ui.started) {
        announcedStarted = false;
      } else if (!announcedStarted) {
        announcedStarted = true;
        live.textContent = t('live.started');
      }
      for (const c of cards) {
        c.root.setAttribute('aria-pressed', String(view.ui.armed === c.towerId));
      }
      // Home link auto-hide. VISIBLE while the run is held pre-start, while paused, and once
      // it resolves; HIDDEN for any started-and-unpaused moment — including the started
      // wave-1 countdown, which is why this reads `ui.started` rather than the sim phase
      // (the sim has no "held" concept; it counts down toward wave 1 either way).
      //
      // `inert` is set HERE, in the same synchronous write as `data-live`, rather than being
      // left to the CSS transition: it removes the tab stop and every activation path the
      // instant the flip happens, so the link can never be an interactable ghost mid-fade.
      // `ui.css`'s `pointer-events: none` is the other half of the same pair; only `opacity`
      // is allowed to take time. Every caller that can flip this OUTSIDE a tick — Start, the
      // five pause paths, Play-again — refreshes the HUD synchronously in its own handler, so
      // a throttled or missing frame can never strand a stale state. The terminal transition
      // is the one exception, and it needs no handler: a run can only reach `won`/`lost` ON a
      // tick, i.e. inside a frame, whose tick change moves the memo key and refreshes anyway.
      const runLive = view.ui.started && !view.paused && !isTerminalPhase(hud.phase);
      shell.home.toggleAttribute('data-live', runLive);
      shell.home.toggleAttribute('inert', runLive);
      renderInstall(view.ui.started);
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
    showLeave(onConfirm: () => void): void {
      // Same modal-family open lifecycle as settings/rotate/results: abort any in-flight
      // placement gesture first, then register. `settings` PRIORITY (rotate still outranks
      // it, and results outranks both — a terminal run never reaches this guard anyway).
      abortGesture();
      leaveConfirmHandler = onConfirm;
      modal.open(leaveOverlay, { priority: 'settings', dismissOnEscape: true });
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
      // Results is state-driven: Escape is consumed, never a dismissal (no `dismissOnEscape`).
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
      instructions.remove();
      leaveDialog.remove();
    },
  };
}
