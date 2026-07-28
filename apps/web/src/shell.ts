// shell.ts — builds the pinned app-shell DOM topology (PLAN.md P1). The Shell
// (`.wy-shell`) is the viewport-filling layout grid and the ONLY node the modal owner
// (`modal.ts`) ever toggles `inert` on:
//
//   .wy-shell
//   ├── header.wy-status
//   │   ├── a.wy-home              (board-mark + span.wy-wordmark — the text is Compact-hidden)
//   │   ├── div.wy-hud              (the five status chips; the labelled scrollport)
//   │   └── div.wy-dock             (Pause/Speed/Settings/Start)
//   ├── div.wy-banner  (the install suggestion — a RESERVED grid row, hidden by default)
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
// The banner is the SECOND (and last) deliberate topology amendment (contract §1): a
// reserved grid row of `.wy-shell` with an exact row order — Standard = status (1), banner
// (2), main (3); Compact = status column + main on row 1, banner spanning row 2. It has to
// be a real row rather than a floating strip precisely because the Dock is shell-anchored:
// an overlay banner and an overlay Dock would fight over the same bottom-left corner.
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

/** The wave-preview surface (M2-S2, PLAN.md P3 step 17) — its OWN visible block in BOTH
 *  layouts, never chip-hosted (the Compact chip's `full` text is screen-reader-only, so
 *  entries stuffed into the wave chip would be invisible to sighted Compact users).
 *  Hosted inside `.wy-hud` — the existing focusable, keyboard-scrollable HUD scrollport
 *  (contract §1) — so a long entry list is keyboard-reachable by inheritance rather than
 *  needing its own tab stop. `overlay.ts` owns all three nodes' content/visibility every
 *  frame; the Shell only builds the scaffolding. */
export interface ShellPreview {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  readonly list: HTMLUListElement;
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

/** The install suggestion strip (Story 11 P3) — a reserved `.wy-shell` row, `hidden` unless
 *  the session is pre-start, un-dismissed and in the banner's audience. `overlay.ts` owns
 *  its text/visibility; the Shell only reserves the row and the nodes. */
export interface ShellBanner {
  readonly root: HTMLElement;
  readonly text: HTMLElement;
  /** "Install" (promptable) or "Show me how" (iOS) — `overlay.ts` picks per branch. */
  readonly action: HTMLButtonElement;
  readonly dismiss: HTMLButtonElement;
  /** The dismiss button's aria-hidden glyph slot. Empty here; `overlay.ts` writes it, like
   *  the Dock buttons' `.wy-btn-icon` — every glance glyph in the app has one home. */
  readonly dismissGlyph: HTMLSpanElement;
}

export interface ShellHandle {
  readonly root: HTMLElement; // .wy-shell
  readonly status: HTMLElement; // header.wy-status
  /** The site home link (`a.wy-home[href="/"]`) — the board-mark plus the wordmark. Its
   *  auto-hide (`data-live` + `inert`) is driven by `overlay.ts`; the live-run exit guard
   *  that intercepts its activation is owned by `main.ts`. */
  readonly home: HTMLAnchorElement;
  readonly board: HTMLElement; // .wy-board — the scene mount point
  readonly rail: HTMLElement; // aside.wy-rail
  /** The chips list — the labelled, keyboard-reachable scrollport (contract §1). */
  readonly hudBox: HTMLElement;
  readonly hud: ShellHud;
  readonly preview: ShellPreview;
  readonly dock: ShellDock;
  readonly card: ShellCard;
  readonly panel: ShellPanel;
  readonly banner: ShellBanner;
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

/** Where the home link goes. Root-absolute, so it is correct from `/play/` regardless of the
 *  build's `--base` rewrite. Exported so `main.ts`'s confirmed-exit navigation and the
 *  anchor's own `href` are ONE declaration — a guard that navigated somewhere the link itself
 *  doesn't point would be a silent divergence.
 *
 *  KNOWN CONSEQUENCE, flagged rather than overlooked: this is OUTSIDE the installed PWA's
 *  scope. Production builds with `--base=/play/`, and the manifest's relative `"scope": "."`
 *  resolves against the manifest URL — so the installed app is scoped to `/play/`, and `/` is
 *  not in it (see the manifest schema test in `icons.test.ts`). In a `display: standalone`
 *  window an out-of-scope navigation is not handled in-app: Android/Chrome hands it to a
 *  Custom Tab, iOS/Safari drops the player out of the standalone window entirely. So for an
 *  INSTALLED player this link leaves the app, not just the page — and neither the guard nor
 *  the dialog copy says so.
 *
 *  Deliberately not "fixed" here, because every option is a product decision, not a defect
 *  repair: widening the manifest scope to `/` redefines what "the app" is, and suppressing the
 *  link when `install.state().standalone || .installed` contradicts the one-home-link design.
 *  PLAN.md ratified `/` as the destination, and leaving `/play` for the site root inherently
 *  leaves a `/play`-scoped app. Raise it as a product question. */
export const HOME_HREF = '/';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The site's dark-scheme mark values, hardcoded. The game UI is fixed dark (`--wy-bg`, no
 *  `prefers-color-scheme` anywhere in `ui.css`), so the source mark's `<style>` block and its
 *  colour-scheme media query are dropped in favour of presentation attributes — a scoped
 *  `<style>` inside an inline SVG would also leak its class names into the whole document. */
const MARK_INK = '#e6e9ee';
const MARK_ROUTE = '#e8552f';

/** The canonical Wynding board-mark (grid edge + two tower-walls + the vermilion route) —
 *  the same artwork as the site favicon/masthead, which is what ties `/play` visually to the
 *  rest of wynding.net. Deliberately NOT the blue/gold PWA icon from `scripts/gen-icons.mjs`:
 *  that is a different mark for a different surface.
 *
 *  Purely decorative (`aria-hidden`, `focusable="false"` for legacy IE-era focus behaviour):
 *  the anchor's own localized `aria-label` carries the whole accessible name, so AT never
 *  hears the link twice. No `width`/`height` attributes — `ui.css` sizes it per layout. */
function boardMark(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'wy-mark');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const edge = doc.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of [
    ['x', '4'],
    ['y', '4'],
    ['width', '24'],
    ['height', '24'],
    ['fill', 'none'],
    ['stroke', MARK_INK],
    ['stroke-width', '2.5'],
    ['stroke-linejoin', 'miter'],
  ] as const) {
    edge.setAttribute(k, v);
  }

  const walls = (['9,14,5,9', '18,4,5,10'] as const).map((spec) => {
    const [x, y, width, height] = spec.split(',') as [string, string, string, string];
    const r = doc.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of [
      ['x', x],
      ['y', y],
      ['width', width],
      ['height', height],
      ['fill', MARK_INK],
    ] as const) {
      r.setAttribute(k, v);
    }
    return r;
  });

  const route = doc.createElementNS(SVG_NS, 'polyline');
  for (const [k, v] of [
    ['points', '4,9 16,9 16,19 28,19'],
    ['fill', 'none'],
    ['stroke', MARK_ROUTE],
    ['stroke-width', '3'],
    ['stroke-linecap', 'square'],
    ['stroke-linejoin', 'miter'],
  ] as const) {
    route.setAttribute(k, v);
  }

  svg.append(edge, ...walls, route);
  return svg;
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

  // --- Home link: the ONE site affordance (`/play` is otherwise a dead end). The existing
  // wordmark is UPGRADED into this anchor rather than joined by a parallel element — one
  // element, one "Wynding" brand in the bar, and Compact pays for a single item. `href` is
  // root-absolute so it is correct from `/play/` regardless of the build's `--base` rewrite.
  // The accessible name comes from the catalog (ADR 0004) rather than the mark's own
  // `aria-label`; the artwork itself is `aria-hidden` decoration alongside it. ---
  const home = doc.createElement('a');
  home.className = 'wy-home';
  home.href = HOME_HREF;
  home.setAttribute('aria-label', t('app.home'));
  // NO `title` here, deliberately. It was tried as a tooltip for the sighted mouse user in
  // Compact (where the mark renders alone), on the reasoning that `aria-label` wins for naming
  // so a matching `title` costs AT nothing. That is wrong: per accname, once the name comes
  // from `aria-label` the `title` becomes the accessible DESCRIPTION, so NVDA/JAWS announce
  // "Wynding — home, link" and then the description "Wynding — home" — the same string twice.
  // The hover affordance is carried by `.wy-home:hover`'s surface tint instead (ui.css), which
  // costs assistive tech nothing and, unlike a tooltip, is visible to touch users too.
  home.append(boardMark(doc), wordmark);

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

  // --- Wave preview (M2-S2): its own block, near the countdown, inside the SAME
  // keyboard-scrollable `.wy-hud` group the chips live in — never chip-hosted (see the
  // `ShellPreview` doc comment). `overlay.ts` fills in the title/list text and toggles
  // `hidden`; empty/hidden here is the safe pre-first-render default. ---
  const preview = doc.createElement('div');
  preview.className = 'wy-wave-preview';
  preview.hidden = true;
  const previewTitle = doc.createElement('p');
  previewTitle.className = 'wy-wave-preview-title';
  const previewList = doc.createElement('ul');
  previewList.className = 'wy-wave-preview-list';
  preview.append(previewTitle, previewList);

  hudBox.append(lives.root, bounty.root, score.root, wave.root, preview, stars.root);

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

  // FOCUS-ORDER TRADE-OFF (recorded, not silent — see docs/accessibility-checklist.md, the
  // Story 11 audit's "Dock focus order" row). `header.wy-status` precedes `.wy-main`, so the
  // Dock is tabbed BEFORE the board in both layouts. In Compact that matches the paint order
  // exactly (the Dock is in the left column, under the chips, left of the board). In Standard
  // the Dock is painted bottom-left over the Stage, so a Standard keyboard user reaches it
  // one stop earlier than its position suggests — a deliberate WCAG 2.4.3 deviation accepted
  // because a single DOM topology has to serve both layouts, the Dock is a four-control
  // labelled cluster reached immediately after the status chips (never a detour past
  // unrelated content), and it is the same "chrome before content" order the wordmark and
  // chips already establish. `compact.spec.ts` pins the order so it cannot drift unnoticed.
  //
  // The home link is the status row's FIRST child in both layouts, so it is also the Shell's
  // first tab stop — conventional "skip to site" chrome-first ordering, and it leaves the tab
  // order entirely (`visibility: hidden`) while a run is live.
  status.append(home, hudBox, dock);

  // --- Banner: the reserved install-suggestion row (Story 11 P3) ---
  const banner = doc.createElement('div');
  banner.className = 'wy-banner';
  banner.setAttribute(REGION_ATTR, 'banner');
  banner.hidden = true;
  const bannerText = doc.createElement('p');
  bannerText.className = 'wy-banner-text';
  const bannerAction = doc.createElement('button');
  bannerAction.type = 'button';
  bannerAction.className = 'wy-btn wy-banner-action';
  const bannerDismiss = doc.createElement('button');
  bannerDismiss.type = 'button';
  bannerDismiss.className = 'wy-btn wy-banner-dismiss';
  // The visible glyph is presentation, written by `overlay.ts` alongside the other glance
  // glyphs; the button's accessible name is the localized `install.banner.dismiss`
  // aria-label it also sets.
  const bannerDismissGlyph = doc.createElement('span');
  bannerDismissGlyph.className = 'wy-btn-icon';
  bannerDismissGlyph.setAttribute('aria-hidden', 'true');
  bannerDismiss.appendChild(bannerDismissGlyph);
  banner.append(bannerText, bannerAction, bannerDismiss);

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

  shell.append(status, banner, main, live);

  return {
    root: shell,
    status,
    home,
    board,
    rail,
    hudBox,
    hud: { lives, bounty, score, wave, stars },
    preview: { root: preview, title: previewTitle, list: previewList },
    dock: {
      root: dock,
      pause: pauseBtn,
      speed: speedBtn,
      settings: settingsBtn,
      primary: primaryBtn,
    },
    card: { root: card, name: cardName, cost: cardCost, hotkey: cardHotkey },
    panel: { root: panel },
    banner: {
      root: banner,
      text: bannerText,
      action: bannerAction,
      dismiss: bannerDismiss,
      dismissGlyph: bannerDismissGlyph,
    },
    live,
    destroy(): void {
      shell.remove();
    },
  };
}
