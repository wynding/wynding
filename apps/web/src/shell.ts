// shell.ts — builds the pinned app-shell DOM topology (PLAN.md P1). The Shell
// (`.wy-shell`) is the viewport-filling layout grid and the ONLY node the modal owner
// (`modal.ts`) ever toggles `inert` on:
//
//   .wy-shell
//   ├── header.wy-status
//   │   ├── span.wy-wordmark        (Compact-hidden)
//   │   ├── div.wy-hud              (the five status chips; the labelled scrollport)
//   │   └── div.wy-dock             (Pause/Speed/Settings/Start)
//   └── div.wy-main
//       ├── div.wy-stage   (position: relative)
//       │   └── div.wy-board  (canvas mounts here, as before)
//       └── aside.wy-rail  (button.wy-card + div.wy-panel, PLAN.md P2 — the Panel opens
//                            below the Card; the Card stays visible/clickable while it's
//                            open)
//
// **The Dock lives in `header.wy-status`, in BOTH layouts** (Story 11's two-layouts
// contract §1 — the first of exactly two deliberate topology amendments). An ancestor grid
// cannot place a grandchild, so the Compact layout's "status header is the full-height left
// column, with the Dock flowing statically inside it" requires the node to move ONCE in the
// DOM rather than be conditionally reparented per layout. Standard rendering is unchanged:
// `ui.css` positions `.wy-dock` absolutely against `.wy-shell` so it still floats over the
// Stage's bottom-left exactly as before.
//
// Every layout region carries `data-wy-region` (contract §5) so `compact.spec.ts` can
// enforce a declared-region registry: a future element added to the Shell without a region
// declaration fails the undeclared-child detection.
//
// Purely structural: no game logic, no i18n beyond the static wordmark/HUD-group label and
// the Card/Panel's static scaffolding. `overlay.ts` fills in chip/Dock content (including
// the board's dynamic, keymap-derived aria-label) and wires the Dock/Card buttons'
// behavior; `main.ts` mounts the Phaser scene into `board`.

import { t } from './i18n/t';
import { REGION_ATTR } from './layout';

/** One status readout in the Shell (contract §4 — dual-form chips, ADR 0004-safe).
 *
 *  `full` carries the COMPLETE localized ICU message ("Lives: 10") and is the chip's
 *  accessible text in BOTH layouts — Compact merely renders it visually-hidden (`ui.css`),
 *  never truncating or sentence-splitting it. `glance` is the Compact-only presentation
 *  (icon + value), `aria-hidden` so assistive tech reads the full message exactly once. */
export interface ShellChip {
  readonly root: HTMLSpanElement;
  readonly full: HTMLSpanElement;
  readonly glance: HTMLSpanElement;
}

export interface ShellHud {
  readonly lives: ShellChip;
  readonly bounty: ShellChip;
  readonly score: ShellChip;
  readonly wave: ShellChip;
  readonly stars: ShellChip;
}

export interface ShellDock {
  readonly root: HTMLElement;
  readonly pause: HTMLButtonElement;
  readonly speed: HTMLButtonElement;
  readonly settings: HTMLButtonElement;
  /** The headline Start action (PLAN.md P4) — primary styling, reads "Start" pre-run and
   *  hides for the rest of the run once pressed. `overlay.ts` owns its text/visibility;
   *  this is the empty slot P1 reserved. */
  readonly primary: HTMLButtonElement;
}

/** The single M1 tower Card (PLAN.md P2) — a whole clickable/focusable button so its
 *  name/cost/hotkey children never need their own separate hit targets. */
export interface ShellCard {
  readonly root: HTMLButtonElement;
  readonly name: HTMLSpanElement;
  readonly cost: HTMLSpanElement;
  readonly hotkey: HTMLSpanElement;
}

/** The unified tower details Panel container (PLAN.md P2) — empty/hidden scaffolding;
 *  `overlay.ts` rebuilds its content on every armed/selection change. */
export interface ShellPanel {
  readonly root: HTMLElement;
}

export interface ShellHandle {
  readonly root: HTMLElement; // .wy-shell
  readonly status: HTMLElement; // header.wy-status
  readonly board: HTMLElement; // .wy-board — the scene mount point
  readonly rail: HTMLElement; // aside.wy-rail
  /** The chips list — the labelled, keyboard-reachable scrollport (contract §1). */
  readonly hudBox: HTMLElement;
  readonly hud: ShellHud;
  readonly dock: ShellDock;
  readonly card: ShellCard;
  readonly panel: ShellPanel;
  /** The assistive `aria-live` announcer (PLAN.md P2) — armed/disarmed, placement
   *  success/rejection, sell + refund. Visually unobtrusive (`.wy-sr-only`): it exists to
   *  be heard by assistive tech, not read on-screen alongside the Panel's own text. */
  readonly live: HTMLElement;
  /** Remove the Shell from its parent. */
  destroy(): void;
}

/** The two spans every Dock button carries (P1's Dock markup contract, both layouts) —
 *  `.wy-btn-icon` is `aria-hidden` glance presentation, `.wy-btn-text` is the localized
 *  accessible name. Throws rather than returning null: a Dock button without its pinned
 *  parts is a construction bug, not a runtime condition to paper over. */
export function dockButtonParts(btn: HTMLButtonElement): {
  readonly icon: HTMLSpanElement;
  readonly text: HTMLSpanElement;
} {
  const icon = btn.querySelector<HTMLSpanElement>(':scope > .wy-btn-icon');
  const text = btn.querySelector<HTMLSpanElement>(':scope > .wy-btn-text');
  if (icon === null || text === null) throw new Error('dock button missing its icon/text spans');
  return { icon, text };
}

/** A Dock button built to the markup contract: an aria-hidden icon span followed by the
 *  localized text span. Compact renders `.wy-btn-text` visually-hidden for every button
 *  EXCEPT Start (which keeps its visible label in both layouts) — the accessible name is
 *  identical either way. */
function dockButton(doc: Document, className: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = className;
  const icon = doc.createElement('span');
  icon.className = 'wy-btn-icon';
  icon.setAttribute('aria-hidden', 'true');
  const text = doc.createElement('span');
  text.className = 'wy-btn-text';
  b.append(icon, text);
  return b;
}

/** One dual-form chip slot. Both nodes always exist; `overlay.ts` writes both through its
 *  single `setChip` path, and `ui.css` decides which one is visible per layout. */
function chip(doc: Document, slot: string): ShellChip {
  const root = doc.createElement('span');
  root.className = 'wy-chip';
  root.dataset.wyChip = slot;
  const full = doc.createElement('span');
  full.className = 'wy-chip-full';
  const glance = doc.createElement('span');
  glance.className = 'wy-chip-glance';
  glance.setAttribute('aria-hidden', 'true');
  root.append(full, glance);
  return { root, full, glance };
}

/** Build the Shell into a detached root; the caller appends `handle.root` wherever the
 *  pinned topology requires (a direct child of `#app`, alongside the results/settings/
 *  rotate siblings). */
export function createShell(doc: Document): ShellHandle {
  const shell = doc.createElement('div');
  shell.className = 'wy-shell';

  // --- Status: the top bar (Standard) / the full-height left column (Compact) ---
  const status = doc.createElement('header');
  status.className = 'wy-status';
  status.setAttribute(REGION_ATTR, 'status');

  const wordmark = doc.createElement('span');
  wordmark.className = 'wy-wordmark';
  // Static "Wynding" (not the board name) — a ratified PLAN §8 decision: RulesetBoard.name
  // is a runtime content string that cannot be a generated typed catalog key, and shipping
  // it raw would be untranslatable UI (ADR 0004). M1 has one board, so no board-identity
  // is lost in practice. Hidden on Compact (ui.css) — the column's width belongs to the
  // chips and controls, and the browser tab/manifest already name the game.
  wordmark.textContent = t('app.title');

  // The chips list is the labelled, keyboard-reachable SCROLLPORT (contract §1): now that
  // the Dock shares the status header, bounded scrolling lives here rather than on
  // `.wy-status` — chips can never scroll behind the controls, and an absolutely-positioned
  // Standard Dock is never clipped by an ancestor scroll box. `tabindex="0"` makes the
  // scrollable region reachable by keyboard in BOTH layouts (an intentional accessibility
  // improvement, decision 10 — a scrollable region must be operable without a pointer).
  const hudBox = doc.createElement('div');
  hudBox.className = 'wy-hud';
  hudBox.setAttribute('role', 'group');
  hudBox.setAttribute('aria-label', t('hud.label'));
  hudBox.tabIndex = 0;
  const lives = chip(doc, 'lives');
  const bounty = chip(doc, 'bounty');
  const score = chip(doc, 'score');
  const wave = chip(doc, 'wave');
  const stars = chip(doc, 'stars');
  hudBox.append(lives.root, bounty.root, score.root, wave.root, stars.root);

  // --- Dock: a status child in BOTH layouts (contract §1's topology amendment) ---
  const dock = doc.createElement('div');
  dock.className = 'wy-dock';
  dock.setAttribute(REGION_ATTR, 'dock');
  const pauseBtn = dockButton(doc, 'wy-btn');
  const speedBtn = dockButton(doc, 'wy-btn');
  const settingsBtn = dockButton(doc, 'wy-btn');
  // The headline Start action shares the single `.wy-primary` styling (ui.css) with the
  // results dialog's Play-again button — the e2e contrast spot-check scopes its selector
  // (`.wy-results .wy-primary`) so it never samples this Dock button. `overlay.ts` owns its
  // text ("Start", PLAN.md P4) and hidden state (visible pre-start, hidden for the rest of
  // the run once pressed — the empty slot P1 reserved).
  const primaryBtn = dockButton(doc, 'wy-btn wy-primary');
  primaryBtn.hidden = true; // safe default before overlay.ts's first render
  // The global Sell button is removed (PLAN.md P2) — Sell lives in the Panel now; the `X`
  // hotkey still sells the current selection directly via the controller (input.ts).
  dock.append(pauseBtn, speedBtn, settingsBtn, primaryBtn);

  status.append(wordmark, hudBox, dock);

  // --- Main: Stage (board) + Rail ---
  const main = doc.createElement('div');
  main.className = 'wy-main';

  const stage = doc.createElement('div');
  stage.className = 'wy-stage';
  stage.setAttribute(REGION_ATTR, 'stage');

  const board = doc.createElement('div');
  board.className = 'wy-board';
  board.tabIndex = 0; // focusable for the keyboard build cursor
  board.setAttribute('role', 'application');
  // The board's `aria-label` is dynamic — it names the ACTUAL bound movement/confirm/sell
  // keys and is refreshed after a rebind — so `overlay.ts` sets it (like the Card's live
  // hotkey badge) rather than the Shell baking in the default-key text here.

  stage.append(board);

  const rail = doc.createElement('aside');
  rail.className = 'wy-rail';
  rail.setAttribute(REGION_ATTR, 'rail');

  // --- Card: the single M1 `basic` tower (PLAN.md P2). Name/cost/hotkey content and
  // aria-pressed/aria-keyshortcuts are filled in by overlay.ts (dynamic: the hotkey badge
  // is live, re-rendered after rebinding). ---
  const card = doc.createElement('button');
  card.type = 'button';
  card.className = 'wy-card';
  card.setAttribute('aria-pressed', 'false');
  const cardName = doc.createElement('span');
  cardName.className = 'wy-card-name';
  const cardCost = doc.createElement('span');
  cardCost.className = 'wy-card-cost';
  const cardHotkey = doc.createElement('span');
  cardHotkey.className = 'wy-card-hotkey';
  card.append(cardName, cardCost, cardHotkey);

  // --- Panel: opens below the Card, inside the Rail (PLAN.md P2). Empty scaffolding —
  // overlay.ts rebuilds its content per armed/selection change and toggles `hidden`. ---
  const panel = doc.createElement('div');
  panel.className = 'wy-panel';
  panel.hidden = true;

  rail.append(card, panel);

  // --- Assistive live region (PLAN.md P2): visually hidden, always present in the DOM so
  // a screen reader picks up the very first announcement (a region inserted only when
  // first needed can miss its own initial text change). Deliberately carries NO region
  // attribute — it has no layout box of its own, and the registry check excludes it. ---
  const live = doc.createElement('div');
  live.className = 'wy-sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  main.append(stage, rail);

  shell.append(status, main, live);

  return {
    root: shell,
    status,
    board,
    rail,
    hudBox,
    hud: { lives, bounty, score, wave, stars },
    dock: {
      root: dock,
      pause: pauseBtn,
      speed: speedBtn,
      settings: settingsBtn,
      primary: primaryBtn,
    },
    card: { root: card, name: cardName, cost: cardCost, hotkey: cardHotkey },
    panel: { root: panel },
    live,
    destroy(): void {
      shell.remove();
    },
  };
}
