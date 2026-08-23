// apps/web — the PWA entry point and app wiring.
//
// This is the platform/render layer: it may use wall-clock time and requestAnimationFrame
// (both banned inside the sim). It builds the controller (deterministic sim + input +
// replay recording), the Phaser board scene, and the DOM HUD/controls overlay, and drives
// them on a fixed-timestep loop with interpolation. All real logic lives in the testable
// modules (controller/overlay/input/settings/keymap); the two untestable dependencies —
// the Phaser scene and requestAnimationFrame — are injected so `createApp` is fully unit
// covered, and only `packages/render/src/scene.ts` (Phaser/WebGL) is coverage-excluded.

import './ui.css';
import { createSaveSlot } from '@wynding/platform';
import { createController, type Controller } from './controller';
import { createOverlay, type UiAction } from './overlay';
import { createShell, HOME_HREF } from './shell';
import { attachInput, type InputHandle } from './input';
import { createSettings } from './settings';
import {
  browserLockFn,
  createBrowserStorageDriver,
  loadSettings,
  resolveDeviceId,
  type SettingsPersistence,
} from './persist';
import { ambientCrypto, mintUuid } from './uuid';
import { createBackHandler, findCapacitorApp, type CapacitorAppPlugin } from './back';
import {
  browserDelivery,
  createPlaytraceRecorder,
  formatPlaytraceExport,
  loadPlaytraceOptOut,
  OPT_OUT_KEY,
  parseStoredOptOut,
  playtraceFilename,
  type PlaytraceDelivery,
  type PlaytraceOptOut,
  type PlaytraceViewport,
  type StoredOptOut,
} from './playtrace';
import { createKeymap } from './keymap';
import { createRotate, type MatchMediaFn, type RotateMediaQueryList } from './rotate';
import { COMPACT_QUERY } from './layout';
import { placePreviewFloat, type PreviewFloat, type PreviewFloatInput } from './preview-place';
import { paintSwatch } from './swatch';
import { requestFullscreen } from './fullscreen';
import { createWakeLock, type WakeLockApi } from './wakelock';
import {
  createInstall,
  createStorageAdapter,
  type InstallHandle,
  type StorageAdapter,
} from './install';
import { t } from './i18n/t';
import { mount as mountScene, type BoardGeometry } from '@wynding/render/scene';
import type { RenderHandle, RenderOverlay } from '@wynding/render';

/** Constructs the Phaser board handle (injected so tests can fake it). The geometry
 *  shape is the scene's own `BoardGeometry` — one authoritative declaration. */
export type SceneFactory = (el: HTMLElement, geometry: BoardGeometry) => RenderHandle;

/** Registers a per-frame callback; returns a cancel function. */
export type Scheduler = (onFrame: (nowMs: number) => void) => () => void;

export interface AppDeps {
  readonly sceneFactory: SceneFactory;
  readonly schedule: Scheduler;
  readonly now: () => number;
  readonly seed: number;
  /** Test seam (same pattern as `sceneFactory`/`matchMedia`): lets a test wrap the
   *  real controller to force UI states that are expensive to construct through the
   *  DOM (e.g. `callWaveReady: false`). Defaults to `createController`. */
  readonly controllerFactory?: (seed: number) => Controller;
  /** Wide-entropy seed source for Play-again (defaults to wall-clock `Date.now`). Kept
   *  separate from `now` (a monotonic frame clock) so a fresh run varies per reload. */
  readonly seedSource?: () => number;
  readonly prefersReducedMotion?: boolean;
  /** ADR 0008's persistence seam, already hydrated (#142). `boot()` reads storage BEFORE
   *  calling in here — see `persist.ts`'s header for the measurement that decided that —
   *  so this stays a synchronous constructor and every consumer below it keeps a
   *  synchronous settings API. Absent means "no persistence", which is what the unit
   *  tests and the perf harness run with: settings then seed from
   *  `prefersReducedMotion` alone and nothing is written. */
  readonly settingsPersistence?: SettingsPersistence;
  /** ADR 0011's durable opt-out, hydrated by `boot()` off the same seam as settings
   *  (#133). Absent means "no durable store", which is what unit tests and the perf
   *  harness run with. It gates FUTURE automatic upload only — local capture and export
   *  are ungated by the ADR's own reasoning, so nothing on this page reads it yet. */
  readonly playtraceOptOut?: PlaytraceOptOut;
  /** Where an exported playtrace goes. Injected because a clipboard permission and
   *  `URL.createObjectURL` are both absent under jsdom. */
  readonly playtraceDelivery?: PlaytraceDelivery;
  /** The per-run UUID mint (#133/ADR 0014 §4) — injected so a test can pin `runId`. */
  readonly mintRunId?: () => string;
  /** Capacitor's App plugin (#138), for hardware Back and the native lifecycle. Injected
   *  because jsdom has no Capacitor bridge; production discovers it off `window` and ONLY
   *  when `hosted` is true (ADR 0012 — told, never inferred). */
  readonly capacitorApp?: CapacitorAppPlugin | null;
  /** matchMedia lookup for viewport-gated features (the P5 rotate prompt, Story 11's
   *  install detection) — injectable for tests; defaults to `doc.defaultView.matchMedia`
   *  when available, or an always-non-matching stub otherwise (e.g. jsdom without a stub). */
  readonly matchMedia?: MatchMediaFn;
  /** Where the install banner's dismissal acknowledgement is persisted (Story 11 P3).
   *  Created ONCE at module scope by `boot()` and threaded through here, so a
   *  destroy()/recreate inside one session keeps the same store — with `localStorage`
   *  unavailable, a per-`createApp` in-memory map would resurrect a dismissed banner. */
  readonly storage?: StorageAdapter;
  /** Where the confirmed home-link exit actually goes. Injected because `location.assign`
   *  is untestable under jsdom (and would navigate the Playwright runner), matching the
   *  app's existing dependency pattern (`now`, `schedule`, `sceneFactory`). Defaults to a
   *  real same-document navigation. */
  readonly navigate?: (href: string) => void;
  /** THE host declaration (ADR 0012): the one fact a **Host** — Capacitor on mobile, Tauri
   *  on desktop — tells the web build about itself, and the only place it is ever set. It is
   *  SUPPLIED here, never inferred: this app has no user-agent test, no protocol test and no
   *  probe for a host's globals, because inference is a claim about the set of
   *  environments made by the component that cannot see the set — which is precisely how
   *  `install.ts` came to be confidently wrong inside a WebView (#146).
   *
   *  ABSENT MEANS NOT HOSTED, so the deployed web build passes nothing and behaves exactly
   *  as it does today. Nothing in this phase sets it true outside tests; how a host actually
   *  sets it before the bundle runs is #135's, with both native projects. */
  readonly hosted?: boolean;
  /** `navigator.wakeLock` (#140), injected for the same reason `matchMedia` is: jsdom has no
   *  implementation, so every branch of the lock's lifecycle would otherwise be unreachable
   *  in a unit test. Defaults to the real navigator's, which is legitimately absent on a
   *  supported device (iOS below 16.4) — see `wakelock.ts`. */
  readonly wakeLock?: WakeLockApi | null;
}

export interface AppHandle {
  destroy(): void;
}

/** Wire the whole app into `root`. Pure of Phaser/rAF (both injected via `deps`). */
export function createApp(doc: Document, root: HTMLElement, deps: AppDeps): AppHandle {
  // The host declaration, resolved ONCE (ADR 0012). Read here rather than at each consumer
  // so the three #146 surfaces below can never disagree about the one fact all of them read.
  const hosted = deps.hosted === true;
  const settings = createSettings(
    deps.settingsPersistence?.seed ?? { reducedMotion: deps.prefersReducedMotion ?? false },
  );
  const keymap = createKeymap();
  const controller = (deps.controllerFactory ?? createController)(deps.seed);
  const seedSource = deps.seedSource ?? (() => Date.now() >>> 0);
  const navigate =
    deps.navigate ??
    ((href: string): void => {
      doc.defaultView?.location.assign(href);
    });
  // Distinct Play-again seeds even if two clicks land in the same millisecond (or the
  // source is coarse): mix in a monotonic run counter so consecutive runs never repeat.
  let runCounter = 0;
  const nextSeed = (): number => ((seedSource() >>> 0) ^ Math.imul(++runCounter, 0x9e3779b1)) >>> 0;
  /** ADR 0014 §4's per-run instance identity: a render-layer UUID minted at each run
   *  start. The sim neither reads nor produces it, so nothing about it is a sim change.
   *  It is minted HERE, beside the seed, because this is the one place per-run state is
   *  already minted — and `beginRun` returns the seed so the two can never drift apart. */
  const mintRunId = deps.mintRunId ?? ((): string => mintUuid(ambientCrypto(doc.defaultView)));
  let runId = mintRunId();
  const beginRun = (): number => {
    runId = mintRunId();
    return nextSeed();
  };

  // Pinned DOM topology (PLAN.md P1): #app > .wy-shell (status + main/stage/board+dock +
  // rail) as siblings of the results/settings/rotate overlays — the Shell is the ONLY node
  // the modal owner (`modal.ts`, wired inside `createOverlay`) ever toggles `inert` on.
  // The Rail builds one Card per catalog tower (M2-S3), in catalog order.
  const cardDescriptors = controller.ruleset.towers.map((t) => ({ towerId: t.id }));
  const shell = createShell(doc, cardDescriptors, { hosted });
  const board = shell.board;

  // The install path (Story 11 P3). `matchMediaFn` is resolved below for the rotate prompt;
  // both features want the same injectable lookup, so it is hoisted above the overlay here.
  const matchMediaFn: MatchMediaFn =
    deps.matchMedia ??
    ((query: string): RotateMediaQueryList => {
      const mm = doc.defaultView?.matchMedia;
      if (typeof mm === 'function') return mm.call(doc.defaultView, query);
      return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
    });
  const view = doc.defaultView;

  // --- The playtrace recorder (#133, ADR 0011) ---
  // Declared HERE, above the overlay/rotate wiring, and not beside the `compactMq` the
  // wave preview uses, for the reason the `resultsShown` declaration a few lines below
  // spells out: `createRotate` calls `evaluate()` eagerly at construction, that reaches
  // `ensurePaused()` and can reach `refreshHud()`, and a `const` declared after that
  // wiring would sit in its temporal dead zone. The viewport bucket is therefore resolved
  // LAZILY, at capture time — once per results dialog, not per frame — rather than by
  // holding a MediaQueryList this early.
  const playtraceViewport = (): PlaytraceViewport =>
    matchMediaFn(COMPACT_QUERY).matches ? 'compact' : 'standard';
  const playtrace = createPlaytraceRecorder({
    // WALL-CLOCK, deliberately, not `deps.now` (the monotonic frame clock): the ring's
    // six-hour bound is about elapsed real time across a play session.
    now: () => Date.now(),
    optOut: deps.playtraceOptOut,
  });
  const delivery = deps.playtraceDelivery ?? browserDelivery(doc);

  const install: InstallHandle = createInstall({
    storage: deps.storage ?? createStorageAdapter(view),
    matchMedia: matchMediaFn,
    // `window` is the spec'd target for both `beforeinstallprompt` and `appinstalled`.
    // Under jsdom without a window (or a detached document) nothing can fire them, so a
    // no-op target degrades to the `other` branch rather than throwing at construction.
    target: view ?? { addEventListener: () => {}, removeEventListener: () => {} },
    navigator: view?.navigator ?? { platform: '', maxTouchPoints: 0 },
    hosted,
  });

  // The screen wake lock (#140). Held ONLY while the wave is actually moving: started, not
  // paused, not resolved, and the document visible. Paused planning is real play — builds and
  // sells queue there and drain on resume — and the lock is deliberately NOT held through it:
  // the decision is battery over convenience, so a maze pondered for longer than the device's
  // auto-lock will dim the screen. Visibility is IN the predicate rather than assumed, because
  // the API refuses a hidden document: without that term every reconcile while backgrounded
  // would be a rejected request. Everything else — the async race, single-flight, teardown —
  // is `wakelock.ts`'s; this is only the predicate and the feature detection.
  //
  // Declared HERE, above `createOverlay`/`createRotate`, for the same temporal-dead-zone
  // reason the `let`s below are: `createRotate` calls `evaluate()` eagerly, which can reach
  // `ensurePaused()` and therefore `refreshHud()`, which reconciles this lock.
  const wakeLock = createWakeLock({
    // `undefined` means "use the platform's, whatever it is"; an explicit `null` means
    // "there is none" — the distinction a `??` would silently collapse, and the only way a
    // test can assert the absent-API path in an environment that happens to have one.
    api:
      deps.wakeLock === undefined
        ? (view?.navigator as { wakeLock?: WakeLockApi } | undefined)?.wakeLock
        : deps.wakeLock,
    shouldHold: (): boolean =>
      controller.uiState().started &&
      !controller.isPaused() &&
      !controller.isTerminal() &&
      doc.visibilityState !== 'hidden',
  });

  // Every `let` that `refreshHud` closes over is declared HERE, above all the wiring below,
  // and not beside the code that uses it. `refreshHud` is reachable from hoisted callbacks
  // that run during construction — `createRotate` calls `evaluate()` eagerly, which calls
  // `ensurePaused()` — so a declaration placed after that wiring would sit in its temporal
  // dead zone and throw a ReferenceError at boot rather than merely being stale. Today the
  // only reason it cannot happen is that a freshly-created controller is never `started`, so
  // `ensurePaused` returns early; that is an accident of controller state, not an ordering
  // guarantee, and it should not be what keeps a phone held in portrait from failing to boot.
  let resultsShown = false;
  let lastHudKey = '';
  // Install state changes (a captured `beforeinstallprompt`, a dismissal, an install) arrive
  // OUTSIDE the HUD memo key's inputs — nothing about the sim moved. Fold a revision counter
  // into the key AND force an immediate refresh, so a prompt arriving while the run is held
  // pre-start updates the banner right away rather than waiting for a tick that never comes.
  let installRev = 0;

  const overlay = createOverlay(
    doc,
    onAction,
    // The app-level pause seam (hoisted, like `onAction` — the closure only runs on a
    // settings-open click, long after everything below is initialized).
    ensurePaused,
    settings,
    keymap,
    shell,
    controller.ruleset,
    // Cancel any in-flight placement gesture when settings opens, exactly as the rotate
    // prompt does. The input manager is created below (it needs `shell.cards`), so this
    // is a deferred forward reference — the same wiring as the hoisted `onAction` above; the
    // closure only runs at click time, long after `input` is initialized.
    () => input.abort(),
    install,
  );
  const rotate = doc.createElement('div');
  rotate.className = 'wy-rotate';
  root.append(
    shell.root,
    overlay.resultsEl,
    overlay.settingsEl,
    overlay.instructionsEl,
    overlay.leaveEl,
    rotate,
  );

  const grid = controller.ruleset.board.grid;
  const geometry: BoardGeometry = {
    cols: grid.width,
    rows: grid.height,
    entrance: { col: grid.entrance.col, row: grid.entrance.row },
    exit: { col: grid.exit.col, row: grid.exit.row },
  };
  const handle = deps.sceneFactory(board, geometry);
  const inputCards = shell.cards.map((c) => ({ el: c.root, towerId: c.towerId }));
  const input: InputHandle = attachInput(doc, board, inputCards, controller, keymap, {
    // The keymapped `start` action routes through the SAME morphed app-level primary
    // action as the Dock's primary button (PLAN.md P3 step 15) — otherwise it would call
    // `controller.start()`/`controller.callWaveEarly()` directly and skip the fullscreen
    // request, the banner latch and the focus re-home `startRun()` owns.
    onStart: () => primaryAction(),
    // Same reasoning as `onStart`: the keymapped pause key must run the app-level transition
    // (which refreshes the home link's visibility synchronously), not `controller.togglePause()`.
    onTogglePause: () => togglePause(),
    // The class guard (independent of any opener's abort): a placement release must never
    // COMMIT behind an open modal. `.wy-shell`'s `inert` attribute is the modal owner's own
    // ground truth (set for exactly the open interval), so read it directly — no new signal.
    isModalOpen: () => shell.root.hasAttribute('inert'),
  });

  // The rotate prompt (PLAN.md P5) shares the SAME modal owner `overlay.ts` created (one
  // stack for results/rotate/settings), and the same `matchMediaFn` resolved above.
  const rotateHandle = createRotate(doc, rotate, overlay.modal, ensurePaused, input, matchMediaFn);

  /** Reflect the IN-APP reduced-motion setting onto the Shell so `ui.css` can key on it (the
   *  OS `prefers-reduced-motion` branch is a plain media query and needs nothing here). Owned
   *  by `main.ts` because this is where the settings subscription already lives — the overlay
   *  deliberately does not subscribe, so there is exactly one writer. */
  const REDUCED_MOTION_ATTR = 'data-wy-reduced-motion';
  function reflectReducedMotion(on: boolean): void {
    shell.root.toggleAttribute(REDUCED_MOTION_ATTR, on);
  }

  const initialSettings = settings.get(); // one snapshot (get() clones), read both fields
  let colourMode = initialSettings.colourMode;
  let reducedMotion = initialSettings.reducedMotion;
  reflectReducedMotion(reducedMotion); // initialize from the first snapshot, not just changes
  /** The Cards' footprint-glyph tiles (playtest round, `swatch.ts`) — painted at boot and
   *  again on a colour-mode change, never per frame. */
  const paintSwatches = (): void => {
    for (const c of shell.cards) paintSwatch(c.swatch, c.towerId, colourMode);
  };
  paintSwatches();
  const unsubscribe = settings.subscribe((s) => {
    // Write-through (#142). First, and unconditionally: persistence must not depend on
    // which of the two settings moved, and it must not be skipped by the memo below.
    deps.settingsPersistence?.write(s);
    // The swatches' one palette input — repainted only when the mode actually moved, so a
    // reduced-motion toggle never repaints nine canvases for nothing.
    const modeChanged = s.colourMode !== colourMode;
    colourMode = s.colourMode;
    reducedMotion = s.reducedMotion;
    reflectReducedMotion(s.reducedMotion);
    if (modeChanged) paintSwatches();
  });

  // The wave preview's home (playtest round; re-shaped by #101): floating over the Stage
  // wherever the Stage has dead space wide enough to hold a legible card — at EVERY zoom
  // level (Codex #96 P1: a zoom-keyed hud fallback parked the preview in the content-sized
  // status row, where wave changes re-projected the board for zoomed users; the px-capped
  // card + in-place scroll form serve zoom instead) — and in the bounded chips scrollport
  // on Compact, and wherever no compliant band exists. That last case REPLACED a
  // hand-picked sub-400px width bucket: the same viewports still land in the hud, now
  // because the space was measured rather than because a threshold guessed at it.
  // `shell.placePreview` owns the topology and `preview-place.ts` the geometry; this
  // decides only which home — via the same injectable matchMedia seam as the rotate
  // prompt, plus a ResizeObserver (jsdom, which lacks it, also lacks the rendering that
  // would make its signals meaningful).
  const compactMq = matchMediaFn(COMPACT_QUERY);
  const previewEl = shell.preview.root;
  /** The float's overflow remedy, IN PLACE — a re-home cannot be the remedy for
   *  content-driven overflow: the hud lives in `.wy-status`, the shell's content-sized
   *  first grid row, so moving there re-projects the board mid-run, the exact defect this
   *  round exists to fix (measured: wave 9's four-entry preview arriving would have cost
   *  cellPx 33 → 25-28). The card flips from a click-through overlay to a scrollable one
   *  exactly while its content exceeds its clamp: pointer access to the occluded rows
   *  yields to content completeness (WCAG 1.4.4 — hidden + pointer-none text would be
   *  unreachable by ANY input), and the `.wy-hud` scrollport's own discipline (decision
   *  10, shell.ts) applies to the tab stop — a scrollable region is keyboard-operable AND
   *  named, never a bare div (axe's scrollable-region-focusable checks only the
   *  focusability half). Stable by construction: the toggle changes no geometry (the box
   *  is already at its clamp), so nothing feeds back into the ResizeObserver driving it.
   *  This form serves EVERY zoom level — the card is px-capped, so zoom grows only its
   *  internal wrapping, never its box — which is what lets a Stage with a compliant dead
   *  band keep the float (and the board-stability invariant) at any text size. */
  const setFloatScroll = (scrollable: boolean): void => {
    previewEl.classList.toggle('wy-wave-preview--scroll', scrollable);
    if (scrollable) {
      previewEl.tabIndex = 0;
      previewEl.setAttribute('role', 'group');
      previewEl.setAttribute('aria-label', t('preview.label'));
    } else {
      previewEl.removeAttribute('tabindex');
      previewEl.removeAttribute('role');
      previewEl.removeAttribute('aria-label');
    }
  };
  /** The float's BAND grants (#101) — the three custom properties `ui.css` reads for the
   *  card's compliant position and width cap, plus the reduced-weight companion class. All
   *  cleared together, so a re-home to the hud can never leave a stale cap on the in-flow
   *  form (which sizes to its column, not to a dead band that no longer exists). */
  const setFloatBand = (band: PreviewFloat): void => {
    const style = previewEl.style;
    if (band.kind !== 'band') {
      style.removeProperty('--wy-preview-left');
      style.removeProperty('--wy-preview-right');
      style.removeProperty('--wy-preview-max-w');
      previewEl.classList.remove('wy-wave-preview--over-board');
      return;
    }
    const inset = `${band.inset}px`;
    style.setProperty('--wy-preview-left', band.side === 'left' ? inset : 'auto');
    style.setProperty('--wy-preview-right', band.side === 'right' ? inset : 'auto');
    style.setProperty('--wy-preview-max-w', `${band.maxWidth}px`);
    // Candidate 5 (#101), applied EXACTLY where the plan scopes it: only when the card is
    // borrowing the board's blocked border ring does it need to read as an overlay sitting
    // on terrain rather than as a panel replacing it.
    previewEl.classList.toggle('wy-wave-preview--over-board', band.overBoard);
  };

  /** The home-INDEPENDENT inputs to the placement decision — the ones that change only
   *  because the user changed something (window size, text zoom, the install banner's
   *  reserved row appearing or going).
   *
   *  This key exists to break a feedback loop that is otherwise fatal, not to save work.
   *  The hud home spends the status row's whole 40dvh budget, which SHRINKS the Stage —
   *  measured at 1280×900/200%: stage 819px tall floating, ~550px in the hud. A shorter
   *  Stage means smaller cells, which means WIDER letterbox margins, which would say "a
   *  compliant band exists" and send the card back to the Stage, which restores the tall
   *  Stage and the narrow margins, which says "no band"… forever, once per ResizeObserver
   *  tick. Keying the decision on inputs the home cannot move is what makes it terminate.
   *
   *  BOUNDARY, stated rather than implied: safe-area insets are not in the key. They move
   *  on a device rotation, which moves `innerWidth`/`innerHeight` too, so the key still
   *  turns over — but a hypothetical inset change at a fixed viewport size would not
   *  re-decide until the next real one. */
  const previewHomeKey = (): string => {
    const view = doc.defaultView;
    return [
      view?.innerWidth ?? 0,
      view?.innerHeight ?? 0,
      view === null || view === undefined
        ? ''
        : view.getComputedStyle(doc.documentElement).fontSize,
      shell.banner.root.hidden ? '0' : '1',
    ].join('|');
  };
  /** The key that was in force when the hud last took the card, or `null` while it floats.
   *  ONLY the hud home is latched — see `previewHomeKey`. Floating needs no latch at all:
   *  the card is `position: absolute` inside the Stage, so it contributes nothing to the
   *  layout the decision reads, and re-deciding on every tick from live geometry is both
   *  safe and strictly more correct (a mid-run status-row rewrap re-places the card instead
   *  of stranding it on a stale band). */
  let hudLatchKey: string | null = null;

  /** The placement's inputs, read off whatever frame the card is in right now. */
  const measureStageFrame = (): PreviewFloatInput => {
    const stageBox = shell.stage.getBoundingClientRect();
    const boardBox = shell.board.getBoundingClientRect();
    return {
      stageWidth: stageBox.width,
      stageHeight: stageBox.height,
      boardLeft: boardBox.x - stageBox.x,
      boardWidth: boardBox.width,
      boardHeight: boardBox.height,
      cols: grid.width,
      rows: grid.height,
    };
  };

  /** Send the card to its in-flow hud home and drop every float grant. Idempotent by
   *  construction — `placePreview` moves conditionally and both grant setters are no-ops at
   *  their cleared values — so calling it on an already-parked card mutates no DOM at all,
   *  which is what lets the "stay put" path below cost the chips scrollport nothing. */
  const parkPreviewInHud = (): void => {
    setFloatScroll(false); // the hud scrollport owns overflow in this home
    setFloatBand({ kind: 'none' });
    shell.placePreview('hud');
  };

  /** True while the Compact branch owns the card, so leaving Compact can be told apart from
   *  an ordinary Standard tick. */
  let compactOwned = compactMq.matches;

  const applyPreviewHome = (): void => {
    if (compactMq.matches) {
      parkPreviewInHud();
      hudLatchKey = null; // re-measure on the way back out of Compact
      compactOwned = true;
      return;
    }
    if (compactOwned) {
      // LEAVING COMPACT IS A FRESH START for Standard, so it restores the same starting
      // placement `init` does. Without this the card would stay in the hud wherever the very
      // first Standard tick has no measurement to act on — since "no signal moves nothing"
      // below is now unconditional, nothing else would ever move it back. The transient is
      // bounded and self-correcting: the ResizeObserver fires with a real box immediately
      // after a fork crossing (the crossing IS a resize), so the default placement lasts at
      // most that one tick, and every steady state reaches this function with a measurement.
      compactOwned = false;
      shell.placePreview('stage');
    }
    // Held by the latch: nothing the card can do moves this key, so nothing to re-decide.
    if (hudLatchKey !== null && hudLatchKey === previewHomeKey()) return;

    // MEASURE WHERE WE STAND — no exploratory re-home. Physically moving the live node just
    // to measure would flush layout with the row reservation lifted, and a scroll container
    // whose content shrinks has its `scrollTop` CLAMPED by the browser: a reader scrolled
    // down the chips column would be yanked to the top by nothing more than a window resize.
    //
    // Measuring from the hud home is sound because it is OPTIMISTIC in a provable direction.
    // Stage WIDTH is identical in both homes (the status row spans the shell and the Rail
    // track is viewport-derived); only the height moves, and the reservation can only ADD to
    // the status row, so `stageHeight_hud <= stageHeight_float`. `cellPx` is monotone
    // non-decreasing in stage height, and BOTH tiers' band widths — `(W - cellPx*cols)/2`
    // and that plus one `cellPx` — are monotone non-INcreasing in `cellPx` for any board
    // wider than two cells. So the hud frame reports an UPPER BOUND on the dead space the
    // float frame would offer, and an optimistic "no compliant band" is a PROOF of the real
    // one. That is the common case (a resize while parked), and it now costs zero DOM moves.
    const parked = previewEl.parentElement !== shell.stage;
    let band = placePreviewFloat(measureStageFrame());
    // NO SIGNAL MOVES NOTHING, EVER — one rule, checked before anything else can act on it
    // (CodeRabbit, PR #164). A degenerate box means "nothing was laid out", which is not the
    // claim "there is room" and not the claim "there is none"; the only honest response to
    // no evidence is to leave the card exactly where it is, with the grants it already
    // carries. The starting placement is chosen ONCE, at init, so this branch never has to
    // double as a default — see the `placePreview('stage')` beside `applyPreviewHome()`.
    //
    // Two earlier shapes of this guard each covered one caller and left the other exposed:
    // first `hudLatchKey !== null` (the parked card), then `!parked` beside it (the floating
    // one). The second was still wrong, because `parked` is sampled BEFORE the exploratory
    // move below and the re-measurement can land here with it stale — a Compact→Standard
    // hand-off with a momentarily degenerate box would then fall straight through to
    // `setFloatBand`, clear the grants, and drop the card on the pre-#101 default over the
    // buildable corner. One unconditional rule has no such seam.
    if (band.kind === 'unmeasured') return;
    if (band.kind === 'band' && parked) {
      // Only a MAYBE — the bound above is one-sided. Take the home change we were going to
      // take anyway, then read the truth in the frame that now actually exists, so a band
      // computed against the shrunken Stage is never painted even for a frame.
      const chipsScrollTop = shell.hudBox.scrollTop;
      shell.placePreview('stage');
      band = placePreviewFloat(measureStageFrame());
      if (band.kind !== 'band') {
        // UNDO, keyed on the RE-measurement rather than on anything sampled before the move.
        // Two different reasons to land here and they must not be conflated: `none` is
        // evidence (the one-sided bound did its job) and latches; `unmeasured` is the box
        // going degenerate between the two reads, which is no evidence at all and must leave
        // the latch open so the next real tick decides.
        parkPreviewInHud();
        // The bounce ends where it started, so it must cost the reader nothing either.
        shell.hudBox.scrollTop = chipsScrollTop;
        hudLatchKey = band.kind === 'none' ? previewHomeKey() : null;
        return;
      }
    }
    // NO COMPLIANT BAND — the hud home is the escape hatch the ratified plan names, and the
    // one that already carries the row RESERVATION (`ui.css`: `.wy-hud:has(>
    // .wy-wave-preview)` fixes the hud at its cap) so wave changes cannot re-project the
    // board from there either. This subsumes the old sub-400px width bucket: a stage that
    // narrow has no dead band wide enough for a legible card, so it lands here by
    // measurement rather than by a separate hand-picked threshold.
    if (band.kind === 'none') {
      parkPreviewInHud();
      hudLatchKey = previewHomeKey();
      return;
    }
    // Only a real band reaches here — `unmeasured` returned above and `none` parked.
    shell.placePreview('stage');
    hudLatchKey = null;
    setFloatBand(band);
    setFloatScroll(!previewEl.hidden && previewEl.scrollHeight > previewEl.clientHeight);
  };
  // THE STARTING PLACEMENT, chosen here rather than inside the loop. `shell.ts` builds the
  // preview into its hud slot, and `applyPreviewHome` now treats "no measurement" as "move
  // nothing" without exception — so the Standard default has to be stated once, explicitly,
  // instead of falling out of a branch that also has to answer mid-resize questions. jsdom,
  // which lays nothing out and therefore never measures anything, gets exactly this.
  shell.placePreview('stage');
  applyPreviewHome();
  compactMq.addEventListener('change', applyPreviewHome);
  // Observing BOTH boxes: content and zoom changes resize the preview (the scroll-form
  // trigger); a window resize changes the stage (the placement's own input) without
  // touching the preview's own box. Reads the injected document's view, not the global —
  // the same discipline as the dpr lookup.
  const PreviewRO = doc.defaultView?.ResizeObserver;
  const previewResizeObserver = PreviewRO ? new PreviewRO(() => applyPreviewHome()) : null;
  previewResizeObserver?.observe(shell.preview.root);
  previewResizeObserver?.observe(shell.stage);

  const unsubscribeInstall = install.onChange(() => {
    installRev++;
    refreshHud();
  });

  /** One HUD/overlay refresh from the controller's current state. Called from the frame
   *  loop's memo-key gate, and directly (out of band) when install state changes. */
  function refreshHud(): void {
    const hud = controller.hud();
    overlay.update({
      hud,
      paused: controller.isPaused(),
      speed: controller.speed(),
      ui: controller.uiState(),
      refund: controller.refundForSelection(),
    });
    if (controller.isTerminal() && !resultsShown) {
      // Capture BEFORE the dialog opens (#133). The controller is frozen at the terminal
      // transition, so nothing can move between here and the export — and capturing on
      // the same `!resultsShown` edge means exactly one capture per run, never one per
      // frame the dialog is up.
      capturePlaytrace();
      overlay.showResults(hud);
      resultsShown = true;
    }
    // Every input to the wake lock's predicate except document visibility moves through this
    // function — start, both pause paths, the terminal transition, Play-again — so this is
    // where the lock is reconciled, in ONE place rather than at each of those call sites. An
    // enumeration is what a later refactor gets wrong in the direction of a lock stuck on.
    //
    // Note what that costs, because it is not obvious: this is NOT an edges-only path. The
    // frame loop calls it whenever the memo key moves, and the key leads with the sim tick —
    // so while a wave is running this fires 20×/s at speed 1 and 40×/s at 2×, the fastest the
    // game offers (`Speed = 1 | 2`, `MS_PER_TICK = 50`). `refresh()` is
    // built to be idempotent under exactly that (`wakelock.ts` property 4: a refusal is
    // latched until the predicate cycles), which is what makes one call site correct instead
    // of merely convenient. Visibility has its own listener below, since nothing about the
    // sim moves when the app backgrounds.
    wakeLock.refresh();
  }

  /** The ONE app-level pause seam. EVERY pause mutation in the app routes through here or
   *  `togglePause` below — the keymapped pause key (`input.ts`'s `onTogglePause`), the Dock's
   *  Pause button (`onAction`), the settings dialog's auto-pause, the rotate prompt's
   *  auto-pause, and the leave guard's defensive pause — because pausing makes the home link
   *  reappear, and that flip has to be SYNCHRONOUS with the pause itself. Leaving it to the
   *  frame loop's memo-key gate would let the link sit hidden (or, worse, interactable in a
   *  stale state) for a frame — indefinitely if frames are throttled in a background tab.
   *
   *  Owns the started-and-unpaused-and-unresolved guard, so any caller can invoke it
   *  unconditionally: a held pre-start run, an already-paused one and a RESOLVED one are all
   *  no-ops, and the refresh is skipped with them since nothing changed.
   *
   *  The `isTerminal()` term is #139's rule — a background event must do nothing to a run
   *  that is already over — and it lives HERE rather than at that one call site precisely
   *  because of the contract in the paragraph above. Guarding at the caller would retire
   *  "any caller can invoke it unconditionally" and leave the other three still pausing
   *  finished runs. `overlay.ts`'s own `runLive` has carried the same term all along; this
   *  seam simply lacked it. */
  function ensurePaused(): void {
    if (!controller.uiState().started || controller.isPaused() || controller.isTerminal()) return;
    controller.pause();
    refreshHud();
  }

  /** Fold the just-finished run into the recent-runs ring (#133).
   *
   *  The three capture facts come from ONE `controller.capture()` call rather than three
   *  reads, so `ticksCompleted`, the world hash pinned to that boundary, and the pending
   *  buffer can never describe different moments. */
  function capturePlaytrace(): void {
    const snapshot = controller.capture();
    playtrace.capture({
      runId,
      replay: controller.buildReplay(),
      ticksCompleted: snapshot.ticksCompleted,
      stateHash: snapshot.stateHash,
      pendingInputs: snapshot.pendingInputs,
      viewport: playtraceViewport(),
    });
  }

  /** The two export actions. Local only — nothing leaves the device, which is why neither
   *  consults the opt-out (ADR 0011: "Building a playtrace and letting the player export
   *  it to a file or clipboard sends nothing anywhere"). Both report through the results
   *  dialog's one shared live region, and a failure says so rather than looking like a
   *  press that did nothing. */
  function exportPlaytrace(destination: 'clipboard' | 'file'): void {
    const payload = playtrace.buildExport();
    const text = formatPlaytraceExport(payload);
    if (destination === 'file') {
      const filename = playtraceFilename(payload.exportedAt);
      try {
        delivery.save(filename, text);
        overlay.setResultsStatus(t('playtrace.saved', { filename }));
      } catch {
        overlay.setResultsStatus(t('playtrace.failed'));
      }
      return;
    }
    // The clipboard write is async and can be REFUSED (no permission, a non-secure
    // context, a WebView without one), so the announcement waits for the outcome instead
    // of claiming success optimistically.
    delivery.copy(text).then(
      () => overlay.setResultsStatus(t('playtrace.copied')),
      () => overlay.setResultsStatus(t('playtrace.failed')),
    );
  }

  /** The Pause CONTROL's path (Dock button + keymapped pause key) — a toggle either way, so
   *  unlike `ensurePaused` it always refreshes. */
  function togglePause(): void {
    controller.togglePause();
    refreshHud();
  }

  /** The ONE app-level start path (PLAN.md Story 11 P4). Both the Dock's Start button and
   *  the keymapped start key route through here, so the run transition, the one-shot
   *  fullscreen request, the install-banner latch and the focus re-home can never diverge
   *  between the two.
   *
   *  Fullscreen is requested only on the `started` false→true EDGE: repeated Start presses
   *  mid-run never re-request, while Play-again (which returns the run to a pre-start state)
   *  makes the next Start eligible again.
   *
   *  CLAIM-FIRST COMPOSITION (#70). Pressing Start is what calls wave 1 — there is no
   *  countdown to sit through and no separate "call early" to find — so this handler claims
   *  the wave BEFORE it un-holds the run and before any side effect fires. The order is
   *  load-bearing, not stylistic: un-holding first and claiming second would leave a
   *  rejected claim behind a run that is already live but whose first wave never launched.
   *  `controller.start()` itself remains the pure flag flip it became at M2-S2 — the
   *  composition is the PRODUCT's, and it lives here. The sv15 sim rule is what makes the
   *  opening claim free: there is no "early" for the first wave. `primaryAction` below
   *  routes to the Call-wave path once `started`. */
  function startRun(): void {
    if (controller.uiState().started) {
      // A repeat press: `primaryAction` routes mid-run presses to the Call-wave path, so
      // reaching this is defensive. The refresh stays unconditional (see its note below).
      refreshHud();
      return;
    }
    if (!controller.callWaveEarly()) {
      // The claim was refused — a legally full pre-start buffer announces 'pendingCap'.
      // The run stays held and NOTHING else happens: no fullscreen request, no install-
      // banner latch, no focus move. The refresh still runs so the rejection reaches the
      // live region rather than the press vanishing silently.
      refreshHud();
      return;
    }
    controller.start();
    requestFullscreen({
      doc,
      // #146 consumer 2. A Host already owns the whole screen — there are no browser
      // toolbars to reclaim — and the request is at best a no-op there, at worst a surprise.
      hosted,
      // Matched at request time, not at construction — a tablet can gain or lose a
      // pointer between load and Start.
      matchesCoarsePointer: () => matchMediaFn('(pointer: coarse)').matches,
      // `installed` is checked alongside `standalone` everywhere (PLAN.md P3): an install
      // accepted in THIS tab does not flip the display-mode query.
      isStandalone: () => {
        const s = install.state();
        return s.standalone || s.installed;
      },
    });
    // The install banner never resurrects after the session's first Start — including
    // across Play-again, which returns to a pre-start state (PLAN.md P3). Mid-run chrome
    // that re-appears between runs is noise, not a second chance.
    install.endBannerForSession();
    // overlay.update() hides the primary Dock button for the rest of the run once started
    // (PLAN.md P4), and hiding the focused element drops focus to document.body. Re-home
    // focus on the board — the natural next actionable place for a keyboard user (it owns
    // the arrow-cursor + Enter placement path).
    //
    // Reached only on the false→true transition: the repeat-press and refused-claim paths
    // both returned above. Re-homing unconditionally would yank focus off the Card or the
    // chips scrollport and lose the player's place for nothing.
    board.focus();
    // Starting HIDES the home link (started + unpaused = live), so the flip has to land in
    // this handler rather than waiting for the frame loop — same reasoning as `ensurePaused`
    // above. Every exit path from this function refreshes, the two early returns included,
    // so the HUD and the live region can never lag a press.
    refreshHud();
  }

  /** The morphed primary action (PLAN.md P3 step 15, M2-S2): the SAME control routes to
   *  `startRun()` (with its fullscreen/install/focus edge handling) while `!started`, and
   *  to `callWaveEarly()` once the run is under way. One function so the Dock button's
   *  click and the keymapped `start` action (which now triggers the SAME morphed control,
   *  not a fixed "Start") can never diverge on which path they take. The
   *  `callWaveReady` gate mirrors the overlay's `aria-disabled` click suppression:
   *  the keyboard shortcut and the button must share activation semantics — a
   *  disabled control must not announce a rejection (or dispatch at all) just
   *  because the press arrived through the keymap. */
  function primaryAction(): void {
    const ui = controller.uiState();
    if (!ui.started) {
      startRun();
      return;
    }
    if (!ui.callWaveReady) return; // exposed as disabled — the key press is inert too
    controller.callWaveEarly();
    refreshHud();
  }

  /** The live-run exit guard (PLAN.md step 4). `main.ts` owns ALL of it — the modified-
   *  activation check, the state read and the decision — while `overlay.showLeave` supplies
   *  nothing but presentation. The state is read at CLICK TIME, never cached: a run can start,
   *  pause or resolve between any two clicks.
   *
   *  A plain left-click is intercepted whenever the run is UNRESOLVED and there is something
   *  to lose. Modified activations (cmd/ctrl/shift/alt, middle-click) keep real-link semantics
   *  — open-in-new-tab must keep working — and a resolved run navigates natively, since a
   *  finished match has nothing left to protect.
   *
   *  "Something to lose" is deliberately NOT just `started` (PLAN.md Amendment 1). A held run
   *  is not necessarily empty: the controller buffers pre-start build/sell commands up to the
   *  full per-tick cap (P3 step 15 dropped the reserved slot), so a player can
   *  lay out several towers before pressing Start. Guarding only `started` meant tapping the
   *  mark discarded that layout silently, while the IDENTICAL loss one keypress later opened a
   *  dialog. The original decision read "held pre-start … navigates directly, since there is
   *  nothing in progress to lose" — the behaviour matched the words, but the words were wrong
   *  about the system. */
  // Torn down in `destroy()` like every other listener this module installs. The node itself
  // is removed by `shell.destroy()`, so today the listener dies with it either way — but every
  // other subscription here has a matching teardown, and a future host that reused a Shell
  // across a destroy/recreate (the pattern `dismissalStorage` below already anticipates) would
  // otherwise double-register this guard and open the dialog twice.
  const guardListener = new AbortController();
  // #146 consumer 3, the other half of `createShell`'s span-instead-of-anchor: when hosted
  // there is no link to intercept, so the guard is NEVER REGISTERED rather than registered
  // and made inert. The leave dialog therefore cannot open inside a host — which is the
  // point, since `/` there resolves to the host's own root and confirming would end the run
  // on a blank view. It remains fully reachable in the web build, unchanged.
  //
  // Accepted cost, recorded in the plan rather than papered over: a hosted build has NO
  // mid-run exit at all, because Play-again only appears once a run resolves. A run is ten
  // waves to a boss and swiping the app away is an ordinary phone gesture, so this is
  // deliberately not solved with new UI. Revisit if a playtest says otherwise.
  if (!hosted) {
    shell.home.addEventListener(
      'click',
      (e: MouseEvent) => {
        if (e.defaultPrevented) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (controller.isTerminal()) return; // resolved → nothing to lose, navigate natively
        // Read at click time like every other term here, never cached: a plan can be queued or
        // committed between any two clicks. `frame()` already runs every frame, so one more call
        // on a click costs nothing.
        const pending = controller.frame();
        const hasPlan = pending.pendingAdds.length > 0 || pending.pendingSells.length > 0;
        if (!controller.uiState().started && !hasPlan) return; // held AND empty → native
        e.preventDefault();
        // Defensive pause (belt-and-braces, matching the settings dialog's own open lifecycle).
        // The visibility rule means the link should not be REACHABLE while unpaused — but the
        // guard must not depend on that being true, so it pauses for itself. `showLeave` aborts
        // any in-flight placement gesture as part of the shared modal-open lifecycle.
        ensurePaused();
        // Focus the link BEFORE opening, so the modal owner's generic pre-modal capture has a
        // deterministic thing to restore to on Stay. Browsers disagree about whether a click
        // focuses an anchor at all — Safari on macOS notably does not — so without this the
        // player would be returned to whatever happened to be focused before (the board, after
        // Start), varying by browser. Safe here: the run is paused by the line above, so the link
        // is not `inert` and `focus()` cannot silently no-op.
        shell.home.focus();
        overlay.showLeave(() => navigate(HOME_HREF));
      },
      { signal: guardListener.signal },
    );
  }

  /** The app going to the BACKGROUND (#139) — a phone call, the app switcher, the home
   *  gesture, the screen locking. A run left running there is a run being lost while nobody
   *  is looking at it, so the app pauses itself.
   *
   *  It routes through `ensurePaused`, which means it is one more CALLER of the existing
   *  seam and not a second pause mechanism — and it inherits that seam's whole guard,
   *  including the resolved-run no-op #139 asks for.
   *
   *  NOTHING HERE RESUMES. Returning to the foreground closes nothing and starts nothing; the
   *  player resumes deliberately from the Dock. That is now a house rule with three instances
   *  — the rotate prompt, the settings dialog, and this — rather than a per-case choice: one
   *  rule to learn, and a board you left mid-wave is readable before it starts moving again.
   *
   *  `pagehide` joins `visibilitychange` because the two cover different endings: a tab
   *  becoming hidden fires `visibilitychange`, while a page being frozen into the bfcache or
   *  torn down fires `pagehide`. Android WebViews have historically been the less reliable of
   *  the two on `visibilitychange` (verified on device, not before — a native lifecycle event
   *  supplied the same way is the fallback, and it is additional work under #135, not free).
   *
   *  The wake lock is reconciled on EVERY visibility change, in both directions and
   *  unconditionally — not only via the pause above. The platform drops the lock by itself
   *  when the document hides, so if the pause somehow did not happen (an event that only
   *  fires on restore) the run would otherwise be live with the screen free to sleep and
   *  nothing left to re-acquire. #140 must not be correct only when #139 is. */
  const lifecycle = new AbortController();
  /** Cancel any captured placement gesture, THEN pause — the order every other caller of the
   *  seam uses (settings in `overlay.ts`, the rotate prompt in `rotate.ts`, the leave guard
   *  above). Without it a finger held on the board when the app backgrounds keeps its press
   *  in flight: no modal opened, so `isModalOpen()` is false, and the `pointerup` delivered
   *  on return COMMITS a placement into a run the player never meant to act on. The platform
   *  usually fires `pointercancel` first, so this is belt-and-braces — but Story 10's
   *  cancellation contract is explicitly stated to hold whether or not an opener remembered
   *  to abort, and these were the only two callers outside it. */
  const onBackgrounded = (): void => {
    input.abort();
    ensurePaused();
    wakeLock.refresh();
  };
  doc.addEventListener(
    'visibilitychange',
    () => {
      // Fired in BOTH directions. Only the hide half backgrounds — doing it on return would
      // be a no-op today (the run is already paused) but would encode the wrong rule. The
      // wake lock is reconciled either way, which is what keeps #140 from being correct only
      // when #139 is.
      //
      // The hide half calls the NAMED sequence rather than repeating its two steps: one
      // statement of the contract, one implementation. Spelling it out again here meant a
      // later step added to `onBackgrounded` would silently reach `pagehide` and miss this
      // path — the more common of the two on the platforms this phase targets.
      if (doc.visibilityState === 'hidden') onBackgrounded();
      else wakeLock.refresh();
    },
    { signal: lifecycle.signal },
  );
  view?.addEventListener('pagehide', onBackgrounded, { signal: lifecycle.signal });

  /** Android's hardware Back, and the native app-lifecycle event that arrives with it
   *  (#138, #134's sub-item). A no-op outside a Host: `findCapacitorApp` returns null
   *  unless the app was TOLD it is hosted AND the bridge is actually there. It routes
   *  into the SAME `ensurePaused` seam and the same gesture-abort order as every other
   *  caller — one pause path, not a second one. */
  const backHandler = createBackHandler({
    modal: overlay.modal,
    isRunLive: () =>
      controller.uiState().started && !controller.isPaused() && !controller.isTerminal(),
    // A PAUSED run is still a run the player has — and so is a board full of PENDING
    // BUILDS on a run that has not started yet. This must be the same question the home
    // link's interceptor asks (`!started && !hasPlan` → let the navigation through), or
    // the two ways out of the app disagree about what counts as losing something: a
    // player who queued six towers pre-start and pressed Back would have them thrown
    // away, while the same player clicking the wordmark would be asked first.
    isRunUnresolved: () => {
      if (controller.isTerminal()) return false;
      if (controller.uiState().started) return true;
      const pending = controller.frame();
      return pending.pendingAdds.length > 0 || pending.pendingSells.length > 0;
    },
    showLeaveConfirm: (onConfirm) => {
      // The home link's own lifecycle, minus the parts that are about a link: pause
      // defensively (a no-op here — this row only fires on an already-paused run), put
      // focus somewhere real so the modal owner has something to restore to on Stay, and
      // hand the dialog its commit action. `showLeave` aborts any in-flight gesture.
      ensurePaused();
      shell.home.focus();
      overlay.showLeave(onConfirm);
    },
    ensurePaused,
    abortGesture: () => input.abort(),
    refreshWakeLock: () => wakeLock.refresh(),
    // `=== undefined`, not `??`: `capacitorApp` documents the same explicit-null
    // convention `wakeLock` does (line ~230) — NULL means "this environment has no
    // plugin, do not go looking", UNDEFINED means "find it yourself". `??` collapses the
    // two, so a test passing `null` to prove the inert path would silently get the real
    // discovery instead, and the assertion would pass for the wrong reason.
    plugin: deps.capacitorApp === undefined ? findCapacitorApp(view, hosted) : deps.capacitorApp,
  });

  function onAction(action: UiAction): void {
    switch (action.type) {
      case 'togglePause':
        togglePause();
        break;
      case 'cycleSpeed':
        controller.cycleSpeed();
        break;
      case 'start':
        primaryAction();
        break;
      case 'armTower':
        controller.armTower(action.tower);
        // Focus rules (PLAN.md P2): arming via Card click or keyboard moves focus to the
        // board — it owns the arrow-cursor + Enter placement path, which must keep
        // working while armed.
        board.focus();
        break;
      case 'escape':
        controller.escape();
        break;
      case 'sellSelected':
        // Sell → Panel closes; focus re-homes to the board via overlay.ts's renderPanel —
        // the single Panel-teardown seam that owns focus for EVERY close route (PLAN.md P2),
        // so no call site here can forget it and drop focus to `document.body`.
        controller.sellSelected();
        break;
      case 'closePanel':
        // Close disarms if armed, else deselects (the same one-layer-at-a-time rule as
        // Escape). Focus re-homing on teardown (the Card on a disarm-close, the board on a
        // deselect-close) is unified in renderPanel, so this route no longer re-homes itself.
        controller.escape();
        break;
      case 'playAgain':
        // A fresh seed AND a fresh `runId`, minted together — this is the run-start edge.
        controller.startRun(beginRun());
        input.reset(); // no armed gesture from the previous run identity carries over (#40)
        handle.reset();
        overlay.hideResults();
        // The modal owner restores focus to whatever was focused before the results
        // dialog opened (generic pre-modal capture); Play-again always wants the board
        // specifically — the natural next actionable place for a keyboard user — so this
        // explicit focus wins regardless of what was focused beforehand.
        board.focus();
        resultsShown = false;
        lastHudKey = '';
        // Repaint the HUD NOW rather than waiting for the next scheduled frame (#53): the
        // fresh run is held (un-ticking) at wave 1's initial countdown, so until a frame
        // lands the chips still read the finished run's terminal values — indefinitely if
        // frames are throttled in a background tab. Same out-of-band refresh the
        // install-state listener uses.
        refreshHud();
        break;
      case 'verify': {
        const r = controller.verifyRun();
        let message: string;
        if (!r.ok) message = t('verify.fail', { reason: r.reason ?? '' });
        else if (r.matchedLive === false) message = t('verify.mismatch');
        else message = t('verify.ok');
        overlay.setResultsStatus(message);
        break;
      }
      case 'copyPlaytrace':
        exportPlaytrace('clipboard');
        break;
      case 'savePlaytrace':
        exportPlaytrace('file');
        break;
    }
  }

  let lastNow = deps.now();
  const cancel = deps.schedule((now: number) => {
    const dt = now - lastNow;
    lastNow = now;
    controller.advance(dt);
    const f = controller.frame();
    // The scene draws every frame (interpolation depends on alpha)...
    const ov: RenderOverlay = {
      ghost: f.ghost,
      selection: f.selection,
      sparks: controller.drainSparks(),
      pendingAdds: f.pendingAdds,
      pendingSells: f.pendingSells,
      colourMode,
      reducedMotion,
      tracers: f.tracers,
    };
    handle.draw(f.prevVm, f.curVm, f.alpha, ov);
    // Observable sim clock for e2e test hooks (PLAN.md P4) — NOT user-facing, just plain
    // attributes on the board element so a spec can assert "held"/"frozen" directly
    // instead of inferring it from a short wait. Cheap dataset writes, so unconditional
    // every frame (no need to gate behind the hudKey throttle below): `data-sim-tick`/
    // `data-sim-phase` mirror the real sim (frozen at tick 0, `phase: 'running'`, while
    // held — the sim itself has no "held" concept: `started` gates `advance()`, not the
    // sim's own state machine), `data-started` (M2-S2: renamed from `data-run-started`, no
    // behavior change) is the one place that distinction becomes visible, and
    // `data-pending-adds` mirrors the Pending-build count shown by the board's own
    // paused-planning presentation.
    board.dataset.simTick = String(f.curVm.tick);
    board.dataset.simPhase = f.curVm.phase;
    board.dataset.started = String(controller.uiState().started);
    board.dataset.pendingAdds = String(f.pendingAdds.length);
    // ...but the HUD only changes on a tick/pause/speed/selection boundary, so gate its
    // recompute + DOM writes on that (they're redundant on the ~60 fps render hot path).
    // Key on selection IDENTITY (its cell), not just presence: switching between two towers
    // while paused (no tick change) must still refresh the Sell refund for the new tower.
    const selId = f.selection === null ? 'none' : `${f.selection.col},${f.selection.row}`;
    // Include the pending-buffer revision (#37+#27): while paused, `curVm.tick` never
    // changes, so a same-tick pending build/sell needs its own key component to force a
    // HUD refresh (presented bounty reads the shared projection). `uiRev` (PLAN.md P2)
    // covers arm/disarm/selection/outcome changes that don't otherwise move the tick/
    // pause/speed/selection/pendingRevision key components (e.g. an armed-but-rejected
    // placement, which changes nothing else here).
    const hudKey = `${f.curVm.tick}|${controller.isPaused()}|${controller.speed()}|${selId}|${f.pendingRevision}|${controller.uiRev()}|${installRev}`;
    if (hudKey !== lastHudKey) {
      lastHudKey = hudKey;
      refreshHud();
    }
  });

  return {
    destroy(): void {
      cancel();
      unsubscribe();
      compactMq.removeEventListener('change', applyPreviewHome);
      previewResizeObserver?.disconnect();
      setFloatScroll(false); // the preview grants this module owns, cleared by its owner
      setFloatBand({ kind: 'none' }); // ...and the band grants beside them (#101)
      guardListener.abort(); // the home-link exit guard
      lifecycle.abort(); // the backgrounding listeners (#139)
      backHandler.destroy(); // the native Back + lifecycle listeners (#138)
      // Releases a held lock AND disowns one still in flight, so a request that resolves
      // after teardown cannot leave the screen pinned awake (#140).
      wakeLock.destroy();
      reflectReducedMotion(false); // the attribute this module owns, cleared by its owner
      unsubscribeInstall();
      install.destroy();
      rotateHandle.destroy();
      input.destroy();
      handle.destroy();
      overlay.destroy();
      shell.destroy();
      // Remove the rotate element too — overlay.destroy()/shell.destroy() only remove
      // their own roots, so leaving this behind would stack a duplicate on every
      // createApp() a host runs in the same root.
      rotate.remove();
    },
  };
}

/** The app's ONE storage adapter, module-scoped (Story 11 P3): the install banner's
 *  dismissal must survive a `createApp` destroy/recreate inside the same session even when
 *  `localStorage` is unavailable and the adapter falls back to memory — a per-`createApp`
 *  in-memory map would resurrect a dismissed banner. Built on first `boot()` rather than at
 *  import, so merely importing this module never probes browser storage. */
let appStorage: StorageAdapter | null = null;
function dismissalStorage(): StorageAdapter {
  appStorage ??= createStorageAdapter(typeof window === 'undefined' ? null : window);
  return appStorage;
}

/** requestAnimationFrame-backed scheduler (the real per-frame driver). */
function rafScheduler(onFrame: (nowMs: number) => void): () => void {
  let id = 0;
  const loop = (now: number): void => {
    onFrame(now);
    id = requestAnimationFrame(loop);
  };
  id = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(id);
}

/** The real Phaser scene factory (the `@wynding/render/scene` subpath; mocked in unit
 *  tests so Phaser/WebGL never loads under jsdom). `mountScene` already matches
 *  `SceneFactory`, so it is used directly — the assignment type-checks the arity. */
const phaserSceneFactory: SceneFactory = mountScene;

/** Boot the app against the real browser globals. Returns `null` — SYNCHRONOUSLY, before
 *  anything is awaited — on a missing `#app`, rather than throwing: `./boot-entry.ts` is
 *  the module that decides a missing root is fatal for the shipped app, and it must be
 *  able to make that a plain thrown error rather than an unhandled rejection. This module
 *  has no auto-run of its own (QC round-1 fix 1) precisely so that importing
 *  `createApp`/`boot` — as `apps/web/perf/main-perf.ts` does, to drive the real app
 *  against the stress bundle instead of the shipped ruleset — never has the side effect
 *  of also booting a second, production app into `#app`.
 *
 *  The promise is #142's: settings are read back through ADR 0008's async
 *  `StorageDriver` and the app is constructed with what they say, so nothing renders in
 *  the default palette and then flips. The wait is a measured 0.00075 ms — see
 *  `persist.ts`'s header — and resolves in a microtask, which drains before the first
 *  paint, so it costs no frame. */
export function boot(doc: Document): Promise<AppHandle> | null {
  const root = doc.getElementById('app');
  if (root === null) return null;
  return bootInto(doc, root);
}

async function bootInto(doc: Document, root: HTMLElement): Promise<AppHandle> {
  const view = doc.defaultView;
  const prefersReducedMotion =
    typeof view?.matchMedia === 'function' &&
    view.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const driver = createBrowserStorageDriver(view);
  const lock = browserLockFn(view);
  // ONE device identity for every slot this boot stamps (ADR 0008 §2's `deviceId` +
  // `revision` pair). Resolving it per slot would mint two ids on a fresh device and
  // make the pair meaningless as a per-device write order.
  const deviceId = await resolveDeviceId(driver, ambientCrypto(view), lock);
  const settingsPersistence = await loadSettings({
    driver,
    prefersReducedMotion,
    deviceId,
    lock,
    onUnavailable: (error) => {
      // Fail-closed is not the same as silent: persistence has shut off for the session
      // and the player's settings will not survive a reload. There is no UI for that
      // today, so DEV gets the diagnosis and production gets no console noise — the same
      // posture `controller.ts` takes for its dropped-DoT tripwire. The MESSAGE only,
      // not the Error: this fires under jsdom (which has no `localStorage`) on every
      // unit test that boots, and a stack per boot buries real output.
      if (import.meta.env.DEV) {
        console.warn(
          'settings will not persist this session:',
          error instanceof Error ? error.message : error,
        );
      }
    },
  });
  // ADR 0011's durable opt-out, on the SAME seam and hydrated in the same pass (#133).
  // It is read here rather than lazily so the fail-closed default is settled before the
  // app exists, and so a future upload path can never find it un-hydrated. Its slot is
  // its own — a separate key beside `settings`, not a field inside it, because ADR 0011
  // forbids settings from carrying it and ADR 0008 §5's rules apply per slot.
  const playtraceOptOut = await loadPlaytraceOptOut(
    createSaveSlot<StoredOptOut>({
      driver,
      key: OPT_OUT_KEY,
      deviceId,
      parse: parseStoredOptOut,
      lock,
    }),
  );
  return createApp(doc, root, {
    sceneFactory: phaserSceneFactory,
    schedule: rafScheduler,
    now: () => performance.now(),
    playtraceOptOut,
    // Wall-clock seed (wide entropy). performance.now() would be a small navigation-
    // relative value that clusters across reloads, collapsing the RNG's variety.
    seed: Date.now() >>> 0,
    prefersReducedMotion,
    settingsPersistence,
    storage: dismissalStorage(),
    // ADR 0012: the web build is TOLD it is hosted and never infers. The fact is a
    // build-time constant baked into the Host build (ADR 0013), so this is the one place
    // in production code that reads it — every consumer downstream takes it as an injected
    // dependency off `AppDeps`, which is what keeps them reachable in jsdom.
    hosted: import.meta.env.WYNDING_HOSTED === true,
  });
}
