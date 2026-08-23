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
    'frost-splash': () => t('tower.frost-splash.name'),
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
  setLabel(chip.full, full);
  setLabel(chip.glance, glance);
  chip.root.hidden = full === '';
}

/** Change-gated `textContent` write for a PERSISTENT LEAF text node that is rewritten across
 *  refreshes (#98): a same-value `textContent` assignment still replaces the descendant Text
 *  node, and WebKit — unlike Chromium — does not synthesize `click` for a press that straddles
 *  such a replacement under the pointer, so an unguarded per-tick write silently kills any firm
 *  press on that control in Safari. Scope is precise: leaves only (`pauseParts.icon`/`.text`,
 *  not `pauseBtn` itself) — a guarded write on a composite container would flatten its element
 *  children into one Text node — and never the outcome live region (the `outcomeSeq`-gated
 *  write in `update()`), which deliberately FORCES a mutation on repeated messages so
 *  assistive tech re-announces them. */
/** Returns whether it actually wrote. Callers on the render-loop path use that to gate
 *  follow-on work — a label patched to the value it already held must not cost a layout
 *  read 20 times a second. */
function setLabel(el: Element, text: string): boolean {
  if (el.textContent === text) return false;
  el.textContent = text;
  return true;
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

  /** Refresh card at `index`'s live hotkey badge — a card past the last hotkey slot
   *  (catalog index ≥ `ARM_TOWER_ACTIONS.length`, i.e. ≥ 9) gets no
   *  badge/`aria-keyshortcuts` at all (Codex R2-2, widened M2-S4a and again at M2-S5a's
   *  nine-slot generalization), remaining fully keyboard-operable as a native button in
   *  the tab order. */
  function refreshCardHotkey(index: number): void {
    const c = cards[index];
    if (c === undefined) return;
    const action = hotkeyActionForCardIndex(index);
    if (action === null) {
      // No hotkey slot for this card at all (catalog index ≥ ARM_TOWER_ACTIONS.length,
      // i.e. ≥ 9) — badge hidden, no aria-keyshortcuts, still fully keyboard-operable
      // as a native button.
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
    // The ONE derivation both install surfaces gate on, so a third can never read a subset
    // of it: already installed, installed in THIS tab, or HOSTED — a Host has no install
    // flow to offer and never will (ADR 0012, #146). `bannerAudience` carries the same fact
    // independently, so the banner is doubly covered; the settings row has only this.
    const hidden = state.standalone || state.installed || state.hosted;

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
    if (showBanner) setLabel(banner.action, actionLabel);

    // Settings row: permanent while the app is not installed, and never offers a button it
    // cannot honour.
    if (hidden !== installSection.hidden) {
      if (hidden) reHomeFrom(installSection, closeBtn);
      installSection.hidden = hidden;
    }
    const canAct = state.branch === 'ios' || state.canPrompt;
    if (!canAct && installAction.contains(doc.activeElement)) closeBtn.focus();
    if (installAction.hidden !== !canAct) installAction.hidden = !canAct;
    setLabel(installAction, actionLabel);
    if (installExplain.hidden !== canAct) installExplain.hidden = canAct;
    // After a declined browser prompt the held event is gone, so the row falls back to the
    // explanation — but "your browser doesn't offer an install prompt" is untrue for a
    // session that just saw one. Say what actually happened instead.
    if (!canAct) {
      const explainLabel = state.promptDeclined
        ? t('install.settings.declined')
        : t('install.settings.explain');
      setLabel(installExplain, explainLabel);
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
    /** The slow's speed reduction (derived from the effect's own `mulFp`, `(256 −
     *  mulFp) / 256`, as a percent — NEVER hardcoded, so `frost-splash` prints the true
     *  30.1%, not a rounded "30%": 0.7 × 256 = 179.2 is not an integer, and the catalog
     *  stores 179) and duration (seconds, matching `fireRate`/`dot`/`stun`'s own
     *  tick→second conversion) — `null` for a tower with no `slow` effect. Fixes a
     *  pre-existing gap: `slow`'s own tower shipped since M2-S3 with no Panel row at all
     *  (m2.md ruling 5, M2-S10). NOT buff-aware, matching `stun`'s own posture above and
     *  m2.md:101 ("non-damage magnitudes and durations … are never buffed"). */
    readonly slow: {
      readonly percent: string;
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
    const slowEffect = def?.effects.find((e) => e.kind === 'slow');
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
      slow:
        slowEffect === undefined
          ? null
          : {
              // 256 here is the same fixed-point base `effectiveSpeedFp` divides by
              // (ruleset-shared.ts) — NOT buffed, matching `stun`'s posture above: this is
              // a derivation off the catalog's own `mulFp`, never a hardcoded round number,
              // so `frost-splash`'s 179 (not a clean 179.2) prints 30.1%, not 30%.
              percent: formatNumber(((256 - slowEffect.mulFp) / 256) * 100),
              duration: formatNumber(slowEffect.durationTicks / TICKS_PER_SECOND),
            },
      attackMode: def?.attack?.mode ?? null,
    };
  }

  function fullStatRows(stats: TowerStats): readonly string[] {
    return [
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
      ...(stats.slow === null
        ? []
        : [
            t('panel.slow', {
              percent: stats.slow.percent,
              duration: stats.slow.duration,
            }),
          ]),
    ];
  }

  /** THE VISIBLE FORM at a narrow Rail (M2-S12a P2) — the same facts with the labels the
   *  line already implies dropped, and related fields grouped onto one line. The full
   *  sentences above remain the Panel's accessible text at every width (Act 1 ruling 1);
   *  this block is `aria-hidden`, so nothing here is ever the only carrier of a fact.
   *
   *  GROUPED, not abbreviated one-for-one, which is why this is a second builder over the
   *  same struct rather than a per-row pair of spans: cost and damage share a line, as do
   *  range and rate, so there is no row to pair against.
   *
   *  Written for the catalog's REAL shapes rather than one template with optional slots —
   *  `beacon` has no attack at all (cost and support only), and `mine` is a burst tower
   *  with a TRIGGER range and no fire rate. Each variant is therefore its own literal key
   *  at its own call: `i18n-check.mjs` extracts a quoted string immediately after the
   *  translate call, so a key selected by a ternary inside one call is invisible to it and
   *  every variant reports as dead. */
  function glanceStatRows(stats: TowerStats): readonly string[] {
    const rows: string[] = [];
    // Cost leads, in the `◈` vocabulary the Compact bounty chip already teaches — never a
    // `g` suffix, which reintroduces exactly the gold/coin metaphor `docs/CONTEXT.md`'s
    // Bounty entry avoids.
    // The glyph comes from `ICONS`, which this file documents as owning it — never baked
    // into the catalog string. A glyph has no language, so a copy in `en.json` is not a
    // translation, it is a SECOND source of truth: change `ICONS.bounty` and the Compact
    // bounty chip renders the new mark while the Panel's cost line keeps the old one, on the
    // same screen, with nothing to detect the drift.
    if (stats.damage === null) {
      rows.push(t('panel.glance.cost', { bounty: ICONS.bounty, cost: stats.cost }));
    } else if (stats.buffed) {
      rows.push(
        t('panel.glance.costDamageBuffed', {
          bounty: ICONS.bounty,
          cost: stats.cost,
          damage: stats.damage,
        }),
      );
    } else {
      rows.push(
        t('panel.glance.costDamage', {
          bounty: ICONS.bounty,
          cost: stats.cost,
          damage: stats.damage,
        }),
      );
    }
    if (stats.rangeTiles !== null) {
      if (stats.attackMode === 'burst') {
        rows.push(t('panel.glance.triggerRange', { tiles: stats.rangeTiles }));
      } else if (stats.fireRate !== null) {
        rows.push(t('panel.glance.rangeRate', { tiles: stats.rangeTiles, rate: stats.fireRate }));
      }
      // No `else`, deliberately. A range implies `def.attack`, and `attack.mode` is exactly
      // `'cadenced' | 'burst'`, so a non-burst tower with a range always has a fire rate and
      // the remaining branch is unreachable. A defensive range-only variant would be a string
      // no player or translator could ever see rendered — and `i18n-check` could not tell:
      // a key quoted at a live call site counts as used however unreachable that call is.
      // Should the impossible happen, the row is OMITTED rather than printed with a hole,
      // which is the rule the rest of this builder already follows.
    }
    if (stats.targets !== null) rows.push(t('panel.glance.targets', { targets: stats.targets }));
    if (stats.supportPercent !== null) {
      rows.push(t('panel.glance.support', { percent: stats.supportPercent }));
    }
    if (stats.blastRadiusTiles !== null) {
      rows.push(t('panel.glance.blastRadius', { tiles: stats.blastRadiusTiles }));
    }
    if (stats.attackMode === 'burst') rows.push(t('panel.glance.singleUse'));
    if (stats.dot !== null) {
      rows.push(
        stats.dot.buffed
          ? t('panel.glance.dotBuffed', {
              damage: stats.dot.damage,
              // The CADENCE is carried, not dropped. It is the one number in this whole
              // block whose absence changes what the row MEANS rather than how long it is:
              // "Poison 4 for 3.0s" reads as 4 total, where `venom` applies 4 every 0.5s
              // across 3.0s — about 24, against a direct hit of 2. Without it the condensed
              // Panel makes the catalog's headline poisoner read as strictly worse than
              // `basic`.
              cadence: stats.dot.cadence,
              duration: stats.dot.duration,
            })
          : t('panel.glance.dot', {
              damage: stats.dot.damage,
              cadence: stats.dot.cadence,
              duration: stats.dot.duration,
            }),
      );
    }
    if (stats.stun !== null) {
      rows.push(
        t('panel.glance.stun', { chance: stats.stun.chance, duration: stats.stun.duration }),
      );
    }
    if (stats.slow !== null) {
      rows.push(
        t('panel.glance.slow', { percent: stats.slow.percent, duration: stats.slow.duration }),
      );
    }
    return rows;
  }

  function appendRowsTo(block: HTMLElement, rows: readonly string[]): void {
    for (const text of rows) {
      const p = doc.createElement('p');
      p.textContent = text;
      block.appendChild(p);
    }
  }

  /** Both forms, as SIBLING BLOCKS — `ui.css`'s container query decides which one is
   *  visible, and the default outside it is the full form. The glance block carries
   *  `aria-hidden` permanently, so the accessible text is the full sentence set at every
   *  width and only the presentation forks (#130's shipped pattern). */
  function appendStatRows(container: HTMLElement, stats: TowerStats): void {
    const full = doc.createElement('div');
    full.className = 'wy-stats-full';
    appendRowsTo(full, fullStatRows(stats));
    const glance = doc.createElement('div');
    glance.className = 'wy-stats-glance';
    glance.setAttribute('aria-hidden', 'true');
    appendRowsTo(glance, glanceStatRows(stats));
    container.append(full, glance);
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

  /** The Panel's SCROLLPORT (M2-S12a P3) — heading, stat rows, and (for a selection) the
   *  action row the caller appends into the returned element. EVERYTHING the cap cannot
   *  squeeze lives in here, and the Close button alone stays outside as the Panel's fixed
   *  footer.
   *
   *  That split is the whole point: the cap can only squeeze a box that is allowed to
   *  shrink, and a `<p>` of wrapped text or a 44px button is not. Measured at 658×320 with
   *  a tower selected, the heading + Sell + Max level + Close needed 220px of a 182px cap,
   *  so the surplus overflowed the capped box into the void below the Rail's bottom edge —
   *  zero stat rows rendered and 17 of the Close button's 44px on screen. Inside the
   *  scrollport that same surplus scrolls (ADR 0003's posture for every capped region here)
   *  and the footer is never in the overflow to begin with.
   *
   *  Returned rather than closed over so the caller decides what else belongs inside — the
   *  armed form has no action row. */
  function appendScrollport(stats: TowerStats): { scroll: HTMLElement; statsEl: HTMLElement } {
    const scroll = doc.createElement('div');
    scroll.className = 'wy-panel-scroll';
    const heading = doc.createElement('p');
    heading.className = 'wy-panel-name';
    heading.textContent = stats.name;
    // The rows keep a container of their OWN inside the scrollport: the live aura patch
    // below clears it, and clearing the scrollport would take the heading and the buttons
    // (and any focus inside them) with it.
    const statsEl = doc.createElement('div');
    statsEl.className = 'wy-panel-stats';
    appendStatRows(statsEl, stats);
    scroll.append(heading, statsEl);
    panel.root.appendChild(scroll);
    // BOTH handles returned, neither latched here. This used to assign `panelScrollEl` and
    // `panelStatsEl` as a side effect while also returning the node — three responsibilities,
    // one of them invisible at the call site, since neither caller read the assignments it
    // depended on. `renderPanel` owns that state and now visibly sets it.
    return { scroll, statsEl };
  }

  /** Owns BOTH P4 resources so neither can be forgotten separately: the passive scroll
   *  listener aborts with this signal, the observer disconnects beside it, and `destroy()`
   *  does both in one place. */
  const railAffordanceAbort = new AbortController();
  let railAffordanceObserver: ResizeObserver | null = null;

  /** Recompute the Rail's scroll affordance, the focus reserve and the rows block's tab
   *  stop (M2-S12a P3/P4). Idempotent and cheap — three class/attribute toggles guarded on
   *  the value actually changing — so every trigger can call it unconditionally.
   *
   *  Deliberately NOT driven from the render loop: `overlay.update()` is gated on `hudKey`
   *  (`main.ts`), which carries no scroll component, so a scroll would never reach it — and
   *  per-frame `scrollTop`/`scrollHeight` reads would add layout work to a budget ADR 0005
   *  already records as breached. */
  function syncRailAffordances(focusLeavingScrollport = false): void {
    const rail = shell.rail;
    // A pinned Panel overlays the Cards, so the Rail must reserve room for it when a
    // focused Card scrolls in. Keyed on the Panel being BOTH open and pinned: reserving on
    // Standard, where the Panel sits in flow and covers nothing, would seat focused Cards
    // high for no reason.
    const pinned = !panel.root.hidden && panelIsPinned();
    rail.classList.toggle('wy-rail-panel-pinned', pinned);
    // `scrollHeight - clientHeight` is the maximum scrollTop; anything left is content
    // still below the fold. The 1px slack absorbs sub-pixel rounding at fractional zoom —
    // without it the fade flickers at the end of the scroll on a 1.25x display.
    const hasMore = rail.scrollHeight - rail.clientHeight - rail.scrollTop > 1;
    rail.classList.toggle('wy-rail-has-more', hasMore);
    // The capped scrollport is an internal scroll container, and most of what it holds —
    // the stat rows — are `<p>` elements that cannot take focus, so without a tab stop of
    // its own it would be operable by mouse and test only, a WCAG 2.1.1 regression of this
    // story's own making. Granted only when it ACTUALLY overflows: a tab stop that scrolls
    // nothing is noise in the tab order of the layout least able to afford it.
    if (panelScrollEl !== null) {
      const scrolls = panelScrollEl.scrollHeight - panelScrollEl.clientHeight > 1;
      // GUARDED on the value actually changing, like the two class toggles above — this
      // function is bound to the Rail's `scroll` event, so an unguarded write here re-set
      // `role` and `aria-label` on every rAF-aligned scroll event. An attribute write with
      // an identical value still runs the engine's attribute-modified path and marks the
      // accessibility object dirty, so a flick-scroll churned the AX cache once per frame
      // for no state change — on the layout least able to afford the work.
      if (scrolls && panelScrollEl.getAttribute('tabindex') === null) {
        panelScrollEl.setAttribute('tabindex', '0');
        // `group`, never `region`: a landmark here would announce itself in every landmark
        // list for a box whose only job is to scroll.
        panelScrollEl.setAttribute('role', 'group');
        panelScrollEl.setAttribute('aria-label', t('panel.details.label'));
      } else if (
        !scrolls &&
        panelScrollEl.hasAttribute('tabindex') &&
        (focusLeavingScrollport || doc.activeElement !== panelScrollEl)
      ) {
        // Revoked only while it does NOT hold focus. Removing `tabindex` from the focused
        // element makes it unfocusable and Chromium resets focus to `<body>` — so a
        // keyboard user reading a pinned Panel that stops overflowing (a widened window, a
        // shorter tower) would silently lose their place and Tab from the top of the
        // document. Every other Panel teardown route in this file re-homes focus
        // deliberately; this path has no teardown to hang that on, so it simply waits. The
        // stop is retired by the next recompute after focus moves away, and a tab stop that
        // scrolls nothing is a far smaller cost than a focus jump nobody asked for.
        panelScrollEl.removeAttribute('tabindex');
        panelScrollEl.removeAttribute('role');
        panelScrollEl.removeAttribute('aria-label');
      }
    }
  }

  let lastPanelKey = '';
  // The last `UiState.inspectSeq` renderPanel consumed — `null` before the first frame so
  // boot's seq of 0 isn't mistaken for a fresh inspect (the `selection` guard covers that
  // case anyway; the null keeps the latch semantics explicit).
  let lastInspectSeq: number | null = null;
  // The last armed tower id renderPanel consumed (#145). The arm-reveal below must fire on
  // the arm TRANSITION, never on the armed STATE — `renderPanel` runs on every HUD memo-key
  // change (~20×/s) and a state-keyed reveal would re-yank the Rail out from under a player
  // who scrolled it, every frame, for as long as they stayed armed. Latched exactly like
  // `lastInspectSeq`: read and written before the same-key early return, and written even
  // when `ui.armed` is null so re-arming the SAME tower after a disarm reveals again.
  let lastArmed: string | null = null;
  // The Panel's live Sell button, tracked across renders so a refund change on the SAME
  // selection can be patched in place (recreating the subtree would drop focus). `null`
  // whenever the Panel isn't showing a selection.
  let panelSellBtn: HTMLButtonElement | null = null;
  /** The stat-rows container, tracked so a live aura change can re-render just those rows
   *  without tearing down the Panel subtree (and its focus) — M2-S8, mirroring
   *  `panelSellBtn`'s in-place patching. `null` whenever the Panel isn't showing stats. */
  let panelStatsEl: HTMLElement | null = null;
  /** The Panel's scrollport — the box the cap squeezes and the one that earns the tab stop
   *  when it overflows (`appendScrollport`). Its own element, never the rows container:
   *  the rows are cleared in place on an aura change, and the scrollport holds the heading
   *  and the action row too. `null` whenever the Panel is closed. */
  let panelScrollEl: HTMLElement | null = null;
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
  /** Is the Panel currently pinned to the Rail's bottom edge (M2-S12a P3)? Read from the
   *  Panel's own COMPUTED `position` rather than by restating `ui.css`'s conditions in JS:
   *  the pin has two arms (a narrow Rail, or the Compact fork) and re-deriving either here
   *  would be a second source of truth that drifts the first time one moves. Under jsdom no
   *  stylesheet is applied, so this is `false` and the unit environment keeps the shipped
   *  scroll-and-reveal behaviour unchanged. */
  function panelIsPinned(): boolean {
    const view = doc.defaultView;
    return view !== null && view.getComputedStyle(panel.root).position === 'sticky';
  }

  /** Scroll the Rail so the Panel's TOP edge lands at the top of its scrollport (#69).
   *
   *  Reveal is keyed on DELIBERATE intent, never inferred from panel-state transitions, and
   *  since #145 there are exactly two intents (see `revealRequested` in `renderPanel` for the
   *  measurements behind the second):
   *  - A pointer inspect — a click that lands on a tower (`UiState.inspectSeq`).
   *  - An ARM while the pin is inactive. Arming is a request to read the Panel, and where
   *    the Panel neither fits the Rail nor pins to it, not revealing showed the player zero
   *    pixels of it.
   *  Everything else still moves nothing:
   *  - The keyboard cursor also SELECTS every tower it steps over (`aimAt` via
   *    `moveCursor`), and held-arrow auto-repeat would re-yank the Rail per step —
   *    navigation is not a request to read the Panel.
   *  - A placement's auto-selection (armed→sel) is a build act whose next move is usually
   *    another Card, and `touch.spec.ts` pins that a Card's cached position stays valid
   *    across a placement.
   *  - An arm while the Panel IS pinned — Compact, and any narrow Rail. The Panel is already
   *    fully visible there, so scrolling would yank the tapped Card away from the pointer for
   *    nothing, and tap-again-to-disarm must keep hitting the same Card (`touch.spec.ts`).
   *    That case is enforced by this function's own early return, not by the call-site gate,
   *    so it holds however the gate is later widened.
   *  The armed highlight, the board's focus ring, and the live region carry feedback for
   *  every non-revealing case.
   *
   *  TOP-aligned, not end-aligned: in Compact the Panel is TALLER than the scrollport,
   *  and a scroll-to-end would clip the Panel's heading off the top — "which tower is
   *  this?" gone. Where the Panel fits (Standard), the browser clamps this to the same
   *  end-of-Rail position a scroll-to-end reaches. `offsetTop` on both elements measures
   *  from the shared positioned ancestor (`.wy-shell`), so the difference is the Panel's
   *  offset within the Rail (± the Rail's own top padding — absorbed by the Panel's, so
   *  nothing visible is clipped). `scrollTop`/`offsetTop` are inert under jsdom
   *  (no-op / 0), so the unit environment needs no stubbing. */
  function revealPanel(): void {
    const rail = panel.root.parentElement;
    if (rail === null) return;
    // Where the Panel is pinned it is ALREADY fully visible, so revealing it would scroll
    // the Rail to its end — moving every Card out from under the player's finger — to
    // achieve nothing. The pinned analogue of the top-first reveal below is resetting the
    // Panel's OWN scroll, so a re-inspect of the same selection starts at the heading.
    if (panelIsPinned()) {
      if (panelScrollEl !== null) panelScrollEl.scrollTop = 0;
      return;
    }
    rail.scrollTop = panel.root.offsetTop - rail.offsetTop;
  }
  function renderPanel(ui: UiState, refund: number): void {
    const key =
      ui.armed !== null
        ? `armed:${ui.armed}`
        : ui.selection !== null
          ? `sel:${ui.selection.id}`
          : 'closed';
    // Read and latched BEFORE the same-key early return, so re-clicking the
    // already-selected tower re-reveals a Panel the player has scrolled away from.
    const inspectRequested = ui.inspectSeq !== lastInspectSeq;
    lastInspectSeq = ui.inspectSeq;
    const armRequested = ui.armed !== null && ui.armed !== lastArmed;
    lastArmed = ui.armed;
    /** THE REVEAL INTENT (#145): a pointer inspect, OR an arm while the pin is inactive.
     *
     *  The second half is new, and it closes the band `m2.md` item 12 describes on ORDINARY
     *  desktop windows. M2-S12a pinned the Panel to the Rail's bottom edge so that arming
     *  actually shows it, but the pin has only two arms — a narrow Rail (`@container wy-rail
     *  (max-width: 160px)`) and the Compact fork — and between roughly 980px and 1279px wide
     *  NEITHER matches: measured against the built app, arming `frost-splash` by hotkey from
     *  `railScrollTop === 0` put the Panel's flow offset at 750px inside a 676px scrollport
     *  and showed the player ZERO pixels of it, across 55 swept viewports at 100% zoom (190
     *  at 150%, 180 at 200%). A 10px change in window width flipped between fully solved and
     *  completely unsolved.
     *
     *  Scroll-reveal rather than a wider pin, deliberately: widening the pin would spend the
     *  browsable-Cards trade (a pinned Panel covers Cards) on Standard desktop, where S12a's
     *  Act 1 explicitly declined to weigh it. Where the pin IS active this changes nothing —
     *  `revealPanel()` early-returns there, so Compact's no-scroll-on-arm contract, and the
     *  tap-again-to-disarm gesture it protects (`touch.spec.ts`), are untouched.
     *
     *  THE TRADE, stated: on unpinned Standard, arming now scrolls the Rail. Rail stability
     *  while armed is spent for Panel visibility — the same exchange the pointer-inspect
     *  reveal already makes, and `arming.spec.ts`'s 1000×720 case is rewritten around it.
     *  `panelIsPinned()` is second so its `getComputedStyle` is reached only on an actual arm
     *  transition, never on the same-key render-loop path. */
    const revealRequested =
      (inspectRequested && ui.armed === null && ui.selection !== null) ||
      (armRequested && !panelIsPinned());
    if (key === lastPanelKey) {
      // Same Panel identity (same armed kind / selection) — the subtree is preserved to keep
      // focus, but the Sell refund can still change while the SAME tower stays selected (the
      // pending queue changed). Patch the existing button's label in place rather than
      // re-keying/recreating the Panel on `refund`.
      // `mutated` gates the recompute at the foot of this block. THIS PATH IS THE RENDER
      // LOOP — `update()` calls `renderPanel` on every HUD memo-key change (~20x/s) and the
      // same-key return is what it takes — so an unconditional recompute here would read
      // `scrollHeight`/`clientHeight`/`getComputedStyle` every frame, forcing layout against
      // a budget ADR 0005 already records as breached, and contradicting this function's own
      // "deliberately NOT driven from the render loop" contract. Both mutations below were
      // already change-guarded; only the recompute was not.
      let mutated = false;
      if (panelSellBtn !== null && setLabel(panelSellBtn, t('panel.sell', { refund })))
        mutated = true;
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
          mutated = true;
        }
      }
      if (revealRequested) {
        revealPanel();
        mutated = true; // an unpinned reveal scrolls the Rail, which moves `hasMore`
      }
      // ONE recompute, and only when something on this path actually changed. Rows and the
      // Sell label both alter the scrollport's content height with no visibility transition,
      // and once the cap binds, the Panel STOPS resizing while only the scrollport's
      // `scrollHeight` moves — which no observer of border-box sizes can see, and which is
      // what decides whether the scrollport earns its tab stop. A Sell label wrapping to a
      // second line is enough to tip a near-boundary Panel over; a Sell label rewritten to
      // the value it already held is not, and must cost nothing.
      if (mutated) syncRailAffordances();
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
    panelScrollEl = null;
    panelStatsBuffMulFp = SUPPORT_MUL_IDENTITY;
    clearChildren(panel.root);
    if (ui.armed !== null) {
      ({ scroll: panelScrollEl, statsEl: panelStatsEl } = appendScrollport(towerStats(ui.armed)));
      appendCloseButton(panel.root);
      panel.root.hidden = false;
    } else if (ui.selection !== null) {
      const stats = towerStats(ui.selection.towerId, ui.selection.buffMulFp);
      const built = appendScrollport(stats);
      panelScrollEl = built.scroll;
      panelStatsEl = built.statsEl;
      panelStatsBuffMulFp = ui.selection.buffMulFp;
      appendActionRow(built.scroll, refund);
      appendCloseButton(panel.root);
      panel.root.hidden = false;
    } else {
      panel.root.hidden = true;
    }
    // The rebuild-path half of the auto-reveal — the WHY (and the acts that must never
    // scroll) is documented on `revealPanel` above.
    if (revealRequested) revealPanel();
    // THE recompute seam (M2-S12a P4). Placed here — after the final `hidden` assignment
    // and after any reveal scroll — rather than at the three `appendStatRows` calls: those
    // all run BEFORE `hidden` is written, so they would measure stale visibility, and the
    // close branch never calls them at all, so the fade would survive the Panel that
    // caused it. A reveal moves `scrollTop`, which is one of the inputs, so this must also
    // follow the call above rather than precede it.
    syncRailAffordances();
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
      boss: () => t('creep.boss.name'),
      'armored-flyer': () => t('creep.armored-flyer.name'),
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

  /** THE ACCESSIBLE FORM — every stat slot always named: "{count} × {name} — {domain},
   *  armor {n}, leak cost {n}, {immunities}", never colour/icon-only.
   *
   *  M2-S10 ruling 3 still holds here IN FULL: leak cost is an ALWAYS-PRESENT slot
   *  mirroring `armor`, not conditional on being > 1, following the
   *  `hud.preview.immunities.none` precedent (name the zero case, i.e. the boring value,
   *  rather than omit the slot). The ruling's rationale is LEARNABILITY — a reader who does
   *  not yet know that leak cost 1 is the baseline learns nothing from its absence — and a
   *  screen-reader user cannot glance to pick deviations out of a list, so the vocabulary
   *  that teaches what the stats ARE stays unabridged on this side. */
  function previewEntryFull(entry: PreviewEntryVM): string {
    const domain = DOMAIN_NAME[entry.domain]();
    const immunities =
      entry.immunities.length === 0
        ? t('hud.preview.immunities.none')
        : entry.immunities.map((i) => IMMUNITY_NAME[i]()).join(', ');
    // Two templates rather than one with an optional slot: the role is a LEADING clause, and
    // an empty slot would leave "{name} — , ground, …" in every non-boss row. The one
    // duplicated string is the cheaper failure mode, and it keeps each template independently
    // localizable (a translator may need the role somewhere other than first).
    //
    // Each key is spelled as a LITERAL argument at its own call rather than selected by a
    // ternary inside one call: `i18n-check.mjs` extracts usages by matching a quoted string
    // immediately after the translate call, so a computed key is invisible to it and BOTH
    // templates get reported as dead catalog entries (verified — that is how this first
    // failed). The gate is right; the call shape is what had to change. NB the extractor
    // scans comments too, so prose here must not spell a call-with-quoted-key either.
    // #132, the accessible half: the rule is spelled out in a sentence, PARENTHESISED so it
    // reads as one clause inside the row's comma-separated list rather than dissolving into
    // it. Two literal keys rather than one with an optional tail, on this function's own
    // `entry`/`entry.boss` precedent: an armor of 0 subtracts nothing from anything, so
    // teaching a subtraction rule on that row would be noise at best and wrong at worst.
    // `armor 0` therefore keeps the bare clause it has always had, and only a row that
    // actually mitigates carries the explanation.
    const armorClause =
      entry.armor === 0
        ? t('hud.preview.armor', { armor: entry.armor })
        : t('hud.preview.armor.armored', { armor: entry.armor });
    const params = {
      count: entry.count,
      name: creepName(entry.creepId),
      domain,
      armor: armorClause,
      leakCost: t('hud.preview.leakCost', { leakCost: entry.leakCost }),
      immunities,
    };
    return entry.boss ? t('hud.preview.entry.boss', params) : t('hud.preview.entry', params);
  }

  /** THE VISIBLE FORM — the same row with every BASELINE-VALUED clause omitted, so what is
   *  printed is exactly what deviates. M2-S10 ruling 3 was narrowed to the full form above
   *  by the owner on 2026-08-16 (#101) on measured evidence: the preview is read to answer
   *  two questions — "is air next?" and "is a boss next?" — while a live wave runs, i.e. as
   *  a threat-signature glance, not a stat-table read. Rendering four clauses a row to
   *  answer that tripled the card's height, and the card floats over the playing field.
   *
   *  OMITTED BY SEMANTIC BASELINE, NOT BY FREQUENCY. Each omission means "nothing to say
   *  here": `ground` is the absence of the air threat, `armor 0` the absence of mitigation,
   *  `leakCost 1` the schema floor (uniform across the whole catalog until M2-S10 lifted it
   *  to a per-creep ceiling), `[]` the absence of immunities. That framing is what keeps
   *  this correct for a MODDED bundle — a ruleset shipping nothing but armored creeps still
   *  reads correctly, where a rule tuned to "what today's catalog happens to make rare"
   *  would invert and print the common case while hiding the exception. */
  function previewEntryGlance(entry: PreviewEntryVM): string {
    const notes: string[] = [];
    // Role leads — it is the heaviest thing about a row and the second of the two questions
    // the surface is read to answer. It is NOT part of the omit-at-baseline set below: a
    // role is an identity, not a deviation from a value.
    //
    // Mildly redundant against TODAY's catalog, whose only boss is localized "Boss" — but
    // the redundancy is the safe direction, and it is temporary. `role` is DATA and the name
    // is CONTENT: any bundle may name a boss anything (M3 delivers the tuned campaign), and
    // inferring the role from the name would couple this surface to the copy.
    if (entry.boss) notes.push(t('hud.preview.role.boss'));
    if (entry.domain !== 'ground') notes.push(DOMAIN_NAME[entry.domain]());
    // #132: the glance carries the SIGN and the SCOPE, not just the number. `armor 8` read
    // as a stat with no operator, and the playtest showed the reader guessing at both which
    // way it applied and to what. `armor −8 direct` says both in three tokens.
    //
    // `direct` is load-bearing and was verified against the sim rather than assumed: armor
    // is a flat subtraction applied ONLY to the `direct` kind, and the DoT tick passes a
    // literal `0` armor argument marked as an intentional bypass. An earlier draft of this
    // string said the reduction applied to every hit — which would have told the player
    // their poison was being cut by 8, the exact inverse of the mechanic this exists to
    // expose. The full form beside it spells the same rule out in a sentence.
    if (entry.armor !== 0) notes.push(t('hud.preview.armor.glance', { armor: entry.armor }));
    if (entry.leakCost !== 1) {
      notes.push(t('hud.preview.leakCost', { leakCost: entry.leakCost }));
    }
    if (entry.immunities.length > 0) {
      notes.push(
        t('hud.preview.glance.immune', {
          // Wrapped rather than reusing the full form's bare list: standing alone in a
          // glance, "stun" cannot be told from a creep that INFLICTS one.
          immunities: entry.immunities.map((i) => IMMUNITY_NAME[i]()).join(', '),
        }),
      );
    }
    const count = entry.count;
    const name = creepName(entry.creepId);
    // The join separator is punctuation between already-translated fragments, not copy — the
    // same posture the immunities list above has always taken with its `', '`.
    return notes.length === 0
      ? t('hud.preview.glance', { count, name })
      : t('hud.preview.glance.noted', { count, name, notes: notes.join(' · ') });
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
            .map(
              (e) =>
                `${e.creepId}x${e.count}:${e.domain}:${e.armor}:${e.leakCost}:${e.immunities.join('+')}:${e.boss ? 'boss' : ''}`,
            )
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
    // `textContent` on a row concatenates BOTH forms in document order (full, then glance
    // — the append order below), so this sentinel covers every catalog key either form
    // reads. Comparing one side alone would let a locale swap self-heal that form while
    // the other stayed stale: the two read DISJOINT key sets (`hud.preview.glance*` vs
    // `hud.preview.entry`/`domain.ground`/`immunities.none`).
    const expectedFirstRow =
      firstEntry === undefined
        ? null
        : previewEntryFull(firstEntry) + previewEntryGlance(firstEntry);
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
      // Dual-form row, mirroring `shell.ts`'s `chip()` exactly: both nodes always exist,
      // the glance carries `aria-hidden` so assistive tech reads the full sentence and ONLY
      // the full sentence (never both, which is what an unhidden glance would produce), and
      // `ui.css` owns which one takes the visible slot. Append order is load-bearing for
      // the locale sentinel above.
      const full = doc.createElement('span');
      full.className = 'wy-preview-full';
      full.textContent = previewEntryFull(entry);
      const glance = doc.createElement('span');
      glance.className = 'wy-preview-glance';
      glance.setAttribute('aria-hidden', 'true');
      glance.textContent = previewEntryGlance(entry);
      li.append(full, glance);
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
      setLabel(primaryParts.text, t('controls.start'));
      primaryBtn.setAttribute('aria-disabled', 'false');
      return;
    }
    const label = hud.launchPending ? t('controls.callWave.pending') : t('controls.callWave');
    setLabel(primaryParts.text, label);
    primaryBtn.setAttribute('aria-disabled', String(!ui.callWaveReady));
  }

  function outcomeMessage(outcome: PlacementOutcome | null): string {
    if (outcome === null) return '';
    switch (outcome.kind) {
      case 'armed':
        return t('live.armed', { name: towerName(outcome.towerId) });
      case 'disarmed':
        return t('live.disarmed');
      case 'inspected':
        return t('live.inspected', { name: towerName(outcome.towerId) });
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

  // --- The Rail affordance's four triggers (M2-S12a P4) --------------------------------
  // (1) the scroll itself, (2) any Rail child changing size, (3) the render seam in
  // `renderPanel`, and (4) this initial pass. A `scroll` listener alone is not enough: the
  // Panel opening changes the content height with no scroll at all, and a text-zoom reflow
  // changes both.
  // WRAPPED, never passed as the listener itself. `syncRailAffordances` now takes a leading
  // boolean, and both an `Event` and a `ResizeObserverEntry[]` are truthy — handing either
  // straight to it would read as "focus is leaving the scrollport" and revoke the tab stop
  // out from under a keyboard user on every scroll tick.
  shell.rail.addEventListener('scroll', () => syncRailAffordances(), {
    passive: true,
    signal: railAffordanceAbort.signal,
  });
  // TRIGGER 5 (M2-S12a, Codex P2): the retention branch keeps the tab stop while the
  // scrollport holds focus, which is only half a rule — nothing recomputed when focus left,
  // so after a resize stopped the scrollport overflowing, clicking away left a
  // non-scrollable element sitting in the tab order as a phantom stop for the rest of the
  // session. Neither scroll, resize nor render is guaranteed to follow that click.
  shell.rail.addEventListener(
    'focusout',
    (event) => {
      // `relatedTarget` is the element RECEIVING focus. Moving within the scrollport — the
      // container to its own Sell button — is not leaving it. `contains` counts self.
      // IDENTITY, not containment. The retention rule exists for exactly one hazard: removing
      // `tabindex` from the element that currently HAS focus makes it unfocusable and drops
      // focus to `<body>`. That hazard only exists while the container itself is focused —
      // once focus sits on a DESCENDANT (Tab from the container reaches the Sell button
      // inside it), revoking the container's own tab stop is harmless, because the child
      // keeps focus. A `contains()` guard read the descendant case as "still inside, do not
      // revoke", so the obsolete stop survived and Shift+Tab landed straight back on a
      // non-scrollable container.
      //
      // This also retires a realm hazard rather than working around it: an identity
      // comparison needs no `instanceof Node`, so there is nothing left to resolve against
      // the wrong realm when `createOverlay(doc, ...)` is handed an injected document.
      if ((event as FocusEvent).relatedTarget === panelScrollEl) return;
      // Told explicitly rather than inferred: during a `focusout` the document's
      // `activeElement` is still the outgoing element (or already `body`), so reading it
      // here would keep retaining the stop it is meant to release.
      syncRailAffordances(true);
    },
    { passive: true, signal: railAffordanceAbort.signal },
  );
  // Observes the Rail's CHILDREN, not the window. The e2e suite changes text size by
  // injecting `:root { font-size: … }`, which reflows every Card and the Panel WITHOUT
  // firing `resize` — so a `window.resize` listener would go stale in exactly the case that
  // creates the overflow. (This is not a reversal of the focus reserve's no-observer
  // decision: that reserve tracks a FIXED cap and stays synchronous.) jsdom implements no
  // `ResizeObserver`, so the unit environment simply runs with triggers 1, 3 and 4.
  const view = doc.defaultView;
  if (view !== null && typeof view.ResizeObserver === 'function') {
    railAffordanceObserver = new view.ResizeObserver(() => syncRailAffordances());
    // The RAIL ITSELF, and not only its children. `hasMore` is a function of
    // `scrollHeight - clientHeight`, and `clientHeight` is the Rail's own box — which no
    // child resize reports. Below 800px wide both rail-width formulas resolve to 9rem, so a
    // viewport HEIGHT change there resizes the Rail without resizing a single child and no
    // trigger fires: the fade stays absent exactly when content has just gone below the
    // fold, and — in the other direction — stays painted over a Rail with nothing below it,
    // which cannot self-heal, because a Rail that no longer scrolls can never fire the
    // scroll listener that would clear it.
    railAffordanceObserver.observe(shell.rail);
    for (const child of shell.rail.children) railAffordanceObserver.observe(child);
  }
  syncRailAffordances();

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
      setLabel(pauseParts.icon, view.paused ? ICONS.resume : ICONS.pause);
      setLabel(pauseParts.text, view.paused ? t('controls.resume') : t('controls.pause'));
      pauseBtn.setAttribute('aria-pressed', String(view.paused));
      setLabel(speedParts.icon, `${view.speed}${ICONS.speed}`);
      setLabel(speedParts.text, t('controls.speed', { factor: view.speed }));
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
      // Both P4 resources, released together — one abort for the listener, one disconnect
      // for the observer. A leak here is invisible in normal play and fatal under a
      // re-created app: the listener stays bound to the OLD Rail node and keeps writing
      // classes onto a detached tree.
      railAffordanceAbort.abort();
      railAffordanceObserver?.disconnect();
      railAffordanceObserver = null;
      modal.destroy();
      results.remove();
      settingsDialog.remove();
      instructions.remove();
      leaveDialog.remove();
    },
  };
}
