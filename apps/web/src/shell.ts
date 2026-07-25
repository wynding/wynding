// shell.ts — builds the pinned app-shell DOM topology (PLAN.md P1). The Shell
// (`.wy-shell`) is the viewport-filling layout grid and the ONLY node the modal owner
// (`modal.ts`) ever toggles `inert` on:
//
//   .wy-shell
//   ├── header.wy-status  (wordmark span + Lives/Bounty/Score/Stars/wave spans)
//   └── div.wy-main
//       ├── div.wy-stage   (position: relative)
//       │   ├── div.wy-board  (canvas mounts here, as before)
//       │   └── div.wy-dock   (absolute bottom-left, overlaps the board border)
//       └── aside.wy-rail  (button.wy-card + div.wy-panel, PLAN.md P2 — the Panel opens
//                            below the Card; the Card stays visible/clickable while it's
//                            open)
//
// Purely structural: no game logic, no i18n beyond the static wordmark/HUD-group label and
// the Card/Panel's static scaffolding. `overlay.ts` fills in HUD/Card/Panel content
// (including the board's dynamic, keymap-derived aria-label) and wires the Dock/Card
// buttons' behavior; `main.ts` mounts the Phaser scene into `board`.

import { t } from './i18n/t';

export interface ShellHud {
  readonly lives: HTMLSpanElement;
  readonly bounty: HTMLSpanElement;
  readonly score: HTMLSpanElement;
  readonly wave: HTMLSpanElement;
  readonly stars: HTMLSpanElement;
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
  readonly board: HTMLElement; // .wy-board — the scene mount point
  readonly rail: HTMLElement; // aside.wy-rail
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

function button(doc: Document, className: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = className;
  return b;
}

/** Build the Shell into a detached root; the caller appends `handle.root` wherever the
 *  pinned topology requires (a direct child of `#app`, alongside the results/settings/
 *  rotate siblings). */
export function createShell(doc: Document): ShellHandle {
  const shell = doc.createElement('div');
  shell.className = 'wy-shell';

  // --- Status bar ---
  const status = doc.createElement('header');
  status.className = 'wy-status';

  const wordmark = doc.createElement('span');
  wordmark.className = 'wy-wordmark';
  // Static "Wynding" (not the board name) — a ratified PLAN §8 decision: RulesetBoard.name
  // is a runtime content string that cannot be a generated typed catalog key, and shipping
  // it raw would be untranslatable UI (ADR 0004). M1 has one board, so no board-identity
  // is lost in practice.
  wordmark.textContent = t('app.title');

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

  status.append(wordmark, hudBox);

  // --- Main: Stage (board + Dock) + Rail ---
  const main = doc.createElement('div');
  main.className = 'wy-main';

  const stage = doc.createElement('div');
  stage.className = 'wy-stage';

  const board = doc.createElement('div');
  board.className = 'wy-board';
  board.tabIndex = 0; // focusable for the keyboard build cursor
  board.setAttribute('role', 'application');
  // The board's `aria-label` is dynamic — it names the ACTUAL bound movement/confirm/sell
  // keys and is refreshed after a rebind — so `overlay.ts` sets it (like the Card's live
  // hotkey badge) rather than the Shell baking in the default-key text here.

  const dock = doc.createElement('div');
  dock.className = 'wy-dock';
  const pauseBtn = button(doc, 'wy-btn');
  const speedBtn = button(doc, 'wy-btn');
  const settingsBtn = button(doc, 'wy-btn');
  // The headline Start action shares the single `.wy-primary` styling (ui.css) with the
  // results dialog's Play-again button — the e2e contrast spot-check scopes its selector
  // (`.wy-results .wy-primary`) so it never samples this Dock button. `overlay.ts` owns its
  // text ("Start", PLAN.md P4) and hidden state (visible pre-start, hidden for the rest of
  // the run once pressed — the empty slot P1 reserved).
  const primaryBtn = button(doc, 'wy-btn wy-primary');
  primaryBtn.hidden = true; // safe default before overlay.ts's first render
  // The global Sell button is removed (PLAN.md P2) — Sell lives in the Panel now; the `X`
  // hotkey still sells the current selection directly via the controller (input.ts).
  dock.append(pauseBtn, speedBtn, settingsBtn, primaryBtn);

  stage.append(board, dock);

  const rail = doc.createElement('aside');
  rail.className = 'wy-rail';

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
  // first needed can miss its own initial text change). ---
  const live = doc.createElement('div');
  live.className = 'wy-sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  main.append(stage, rail);

  shell.append(status, main, live);

  return {
    root: shell,
    board,
    rail,
    hud: { lives: livesEl, bounty: bountyEl, score: scoreEl, wave: waveEl, stars: starsEl },
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
