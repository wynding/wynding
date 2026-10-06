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
import { createController, type CaptureSnapshot, type Controller } from './controller';
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
import { buildSurveyPayload, replayDigest } from '@wynding/feedback';
import {
  createSessionIdentity,
  createSurvey,
  loadSurveyAsk,
  parseStoredSurveyAsk,
  SURVEY_ASK_KEY,
  type StoredSurveyAsk,
  type SurveyAsk,
  type SurveyTransport,
} from './survey';
import { createSurveyForm, type SurveyForm } from './survey-form';
import type { Replay } from '@wynding/replay';
import { createRotate, type MatchMediaFn, type RotateMediaQueryList } from './rotate';
import { COMPACT_QUERY } from './layout';
import { clearDockReserve, syncDockCue, syncDockReserve } from './dock-reserve';
import { clearHudCut, syncHudCut } from './hud-cut';
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
import type { HudVM, RenderHandle, RenderOverlay } from '@wynding/render';

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
  /** ADR 0014's end-of-run survey — AND ITS FEATURE SWITCH. The survey is offered only
   *  where a transport is injected: the shipped entry injects one only for the web game
   *  served from wynding.net (`shippedSurveyTransport`), where the endpoint and the §7
   *  privacy notice live. One fact, not a second flag that could disagree with it. Needs
   *  `surveyAsk` too; either alone offers nothing. */
  readonly surveyTransport?: SurveyTransport;
  /** The survey's ask state (§3), hydrated by `boot()` off the same seam as settings. */
  readonly surveyAsk?: SurveyAsk;
  /** The build's `gameVersion` (§4). Defaults to the build-time define. */
  readonly gameVersion?: string;
  /** Wall clock for the survey session's age (ADR 0011 §3); the monotonic half is `now`.
   *  Defaults to `Date.now`. */
  readonly wallNow?: () => number;
  /** The survey's opaque id mint (session id and idempotency keys). Defaults to v4 UUIDs. */
  readonly mintSurveyId?: () => string;
  /** Capacitor's App plugin (#138), for hardware Back and the native lifecycle. Injected
   *  because jsdom has no Capacitor bridge; production discovers it off `window` and ONLY
   *  when `hosted` is true (ADR 0012 — told, never inferred).
   *
   *  AN INJECTED PLUGIN MUST ALREADY SATISFY THE PROMISE CONTRACT. This path bypasses
   *  `findCapacitorApp`, which is where the legacy-bridge normalization lives — so a raw
   *  synchronous plugin handed in here would reach `createBackHandler` unadapted. Test
   *  doubles are promise-shaped and the native side has no reason to inject at all; if one
   *  ever does, it must pass its plugin through `findCapacitorApp` rather than here. */
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
  /** ADR 0011 §3's session id, which the survey carries and shows as its reference (§7):
   *  in memory only, rotated by run count and age. Every run start counts, the first too. */
  const mintSurveyId =
    deps.mintSurveyId ?? ((): string => mintUuid(ambientCrypto(doc.defaultView)));
  const sessionIdentity = createSessionIdentity({
    mint: mintSurveyId,
    now: deps.wallNow ?? (() => Date.now()),
    monotonicNow: () => deps.now(),
  });
  sessionIdentity.beginRun();
  const beginRun = (): number => {
    runId = mintRunId();
    sessionIdentity.beginRun();
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
  // Dock pass uses, for the reason the `resultsShown` declaration a few lines below
  // spells out: `createRotate` calls `evaluate()` eagerly at construction, that reaches
  // `ensurePaused()` and can reach `refreshHud()`, and a `const` declared after that
  // wiring would sit in its temporal dead zone. The viewport bucket is therefore resolved
  // LAZILY, at capture time — once per results dialog, not per frame — rather than by
  // holding a MediaQueryList this early.
  const playtraceViewport = (): PlaytraceViewport =>
    matchMediaFn(COMPACT_QUERY).matches ? 'compact' : 'standard';
  const playtrace = createPlaytraceRecorder({
    // Wall clock for the exported TIMESTAMPS only.
    now: () => Date.now(),
    // ...and the monotonic frame clock for the six-hour bound itself. `deps.now` is
    // `performance.now` in production, which cannot regress — the wall clock can, and a
    // backward step made every run eligible indefinitely, silently defeating ADR 0011 §3's
    // bounded-linkage promise.
    monotonicNow: () => deps.now(),
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
  /** The results dialog's live-region claim counter (#133 review round). Declared HERE,
   *  beside `resultsShown`, for the reason the comment above gives: `refreshHud` can be
   *  reached during construction, and a `let` declared further down would sit in its
   *  temporal dead zone. */
  let resultsStatusSeq = 0;
  /** The finished run the open results dialog is about — captured ONCE at the terminal edge
   *  (with the playtrace), which the survey's payload is built from. Null between runs. */
  let terminalRun: {
    readonly replay: Replay;
    readonly snapshot: CaptureSnapshot;
    readonly hud: HudVM;
  } | null = null;
  /** The survey form, or null where no survey is offered. Assigned after the overlay
   *  exists; declared here for the temporal-dead-zone reason above. */
  let surveyForm: SurveyForm | null = null;
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
  // ADR 0014: the survey exists only with BOTH a transport (the switch) and its ask state.
  if (deps.surveyTransport !== undefined && deps.surveyAsk !== undefined) {
    const ask = deps.surveyAsk;
    const gameVersion = deps.gameVersion ?? import.meta.env.WYNDING_GAME_VERSION;
    const survey = createSurvey({ ask, transport: deps.surveyTransport, mintKey: mintSurveyId });
    surveyForm = createSurveyForm(doc, overlay.resultsSurveySlot, {
      survey,
      refreshAsk: () => ask.refresh(),
      compose(idempotencyKey) {
        // The form only exists on an open dialog, and the dialog only opens after the
        // terminal capture below — so a null here is a wiring bug, not a state to handle.
        if (terminalRun === null) throw new Error('survey: no finished run to describe');
        const { replay, snapshot, hud } = terminalRun;
        return buildSurveyPayload({
          answers: survey.state().answers,
          idempotencyKey,
          run: {
            runId,
            sessionId: sessionIdentity.current(),
            gameVersion,
            simVersion: replay.simVersion,
            rulesetHash: replay.rulesetHash,
            boardId: replay.boardId,
            seed: replay.seed,
            outcome: hud.won ? 'won' : 'lost',
            score: hud.score,
            stars: hud.stars,
            waveCursor: hud.waveCursor,
            finalTick: snapshot.ticksCompleted,
            finalHash: snapshot.stateHash,
            // Synchronous (§4): the digest completes inside the Send handler.
            replayDigest: replayDigest(replay.tickInputs),
          },
        });
      },
      reference: () => sessionIdentity.current(),
      claimStatus: () => claimResultsStatus(),
      writeStatus: (message) => overlay.setResultsStatus(message),
      statusText: () => overlay.resultsStatusText(),
      setRegionHeld: (held) => overlay.setResultsWritersLocked(held),
      focusPlayAgain: () => overlay.focusPlayAgain(),
    });
  }
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
   *  again on a colour-mode change, never per frame. The wave strip's creep icons (#181 L1)
   *  ride the same hook: the overlay inks them from the boot mode itself and re-inks them in
   *  place on a change. */
  const paintSwatches = (): void => {
    for (const c of shell.cards) paintSwatch(c.swatch, c.towerId, colourMode);
  };
  paintSwatches();
  const unsubscribe = settings.subscribe((s) => {
    // Write-through (#142). First, and unconditionally: persistence must not depend on
    // which of the two settings moved, and it must not be skipped by the memo below.
    deps.settingsPersistence?.write(s);
    // The swatches' (and the strip icons') one palette input — repainted only when the mode
    // actually moved, so a reduced-motion toggle never repaints nine canvases for nothing.
    const modeChanged = s.colourMode !== colourMode;
    colourMode = s.colourMode;
    reducedMotion = s.reducedMotion;
    reflectReducedMotion(s.reducedMotion);
    if (modeChanged) {
      paintSwatches();
      overlay.setColourMode(s.colourMode);
    }
  });

  // The layout fork, read through the same injectable matchMedia seam as the rotate prompt:
  // the Dock pass below clears every Standard-only grant on Compact. (The wave preview has ONE
  // home since #181 — the `.wy-hud` group, styled per layout by `ui.css` — so nothing here
  // places it any more.)
  const compactMq = matchMediaFn(COMPACT_QUERY);
  // Reads the injected document's view, not the global — the same discipline as the dpr
  // lookup. jsdom, which lacks it, also lacks the rendering that would make its signals
  // meaningful.
  const RO = doc.defaultView?.ResizeObserver;

  // THE STANDARD DOCK'S FOOTPRINT (#152) — `dock-reserve.ts` owns the measurement and the
  // whole-row bound, `ui.css` spends them. The board's row count is the one geometry input no
  // stylesheet can hold (the cell floor is a stylesheet token; the rows are board data). The
  // same pass sizes the countdown dial inside the primary control and decides, from its
  // label's measured ink, whether there is room for it (#181 QC round 2).
  const dockTargets = {
    shell: shell.root,
    stage: shell.stage,
    dock: shell.dock.root,
    rows: grid.height,
    primary: shell.dock.primary,
  };
  const syncDock = (): void => syncDockReserve(dockTargets, compactMq.matches);
  syncDock();
  // No `compactMq` listener of its own: crossing the fork re-lays out BOTH observed boxes (the
  // Dock goes from a floating row to an in-column block, the Stage loses the status row), so
  // the observer below already runs the pass that clears or re-measures.
  //
  // Deferred a frame out of the observer callback, deliberately. A pass writes the bound,
  // which can resize the observed Dock itself; doing that INSIDE the callback leaves a
  // same-depth notification undelivered and raises the browser's "ResizeObserver loop"
  // error. One coalesced frame later the resize is an ordinary new observation, and the pass
  // it triggers converges (it writes the values already in force, which resizes nothing).
  let dockFrame = 0;
  const dockResizeObserver =
    RO && view
      ? new RO(() => {
          if (dockFrame !== 0) return;
          dockFrame = view.requestAnimationFrame(() => {
            dockFrame = 0;
            syncDock();
          });
        })
      : null;
  dockResizeObserver?.observe(shell.dock.root);
  dockResizeObserver?.observe(shell.stage);
  // ...and each CONTROL. Start giving way to Pause + Call wave re-wraps the rows, and a Dock
  // already held at its bound does not change size when that happens — its controls do
  // (a hidden control's box collapses to nothing), so they are what reports the change.
  for (const control of Array.from(shell.dock.root.children)) dockResizeObserver?.observe(control);
  // ...and the primary control's LABEL (#181 QC round 2): the dial's room is decided from the
  // words in it, and "Start" giving way to "Call wave" can change them inside a control its
  // row holds at one width — the label's own box is what reports that.
  const primaryLabel = shell.dock.primary.querySelector('.wy-btn-text');
  if (primaryLabel) dockResizeObserver?.observe(primaryLabel);
  // ...and the bottom SAFE-AREA INSET. In scroll form the inset lifts the Dock by `bottom`,
  // which MOVES it without resizing any box above, so a runtime inset change (a native write
  // of `--safe-area-inset-bottom`, or `env()` changing) would leave the reserve stale and the
  // lifted Dock over buildable cells again. An inert probe sized BY the inset turns that change
  // into a resize the same observer sees.
  const insetProbe = doc.createElement('div');
  insetProbe.className = 'wy-inset-probe';
  insetProbe.setAttribute('aria-hidden', 'true');
  root.append(insetProbe); // beside the shell, outside the layout regions it declares
  dockResizeObserver?.observe(insetProbe);
  // The scroll cue points down while rows remain below the scrollport, up at the end.
  const dockScroll = new AbortController();
  shell.dock.root.addEventListener('scroll', () => syncDockCue(shell.dock.root), {
    passive: true,
    signal: dockScroll.signal,
  });

  // COMPACT'S CHIPS COLUMN RESTS ON WHOLE ITEMS (#181 QC round 2) — `hud-cut.ts` owns the cut,
  // `ui.css` spends it. Re-measured, one coalesced frame later (the Dock pass's reason), when
  // anything that decides where the column's room ends, or where an item does, changes size:
  // the column itself, the Dock under the chips (Start giving way to Pause + Call wave), each
  // chip, and the wave strip. Never the chips scrollport: the cut is ITS size.
  const syncCut = (): void => syncHudCut(shell.hudBox, compactMq.matches);
  syncCut();
  let cutFrame = 0;
  const cutObserver =
    RO && view
      ? new RO(() => {
          if (cutFrame !== 0) return;
          cutFrame = view.requestAnimationFrame(() => {
            cutFrame = 0;
            syncCut();
          });
        })
      : null;
  for (const target of [
    shell.status,
    shell.dock.root,
    shell.hud.wave.root,
    shell.hud.lives.root,
    shell.hud.bounty.root,
    shell.hud.stars.root,
    shell.hud.score.root,
    shell.preview.root,
  ]) {
    cutObserver?.observe(target);
  }

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
      capturePlaytrace(hud);
      // Opening a dialog invalidates anything still in flight for the previous one. The
      // invariant held via `resultsShown` + `playAgain` alone, but only by accident of
      // there being one re-open path; enforcing it where the dialog actually opens means a
      // second path cannot silently inherit a stale announcement.
      abandonResultsStatus();
      overlay.showResults(hud);
      surveyForm?.dialogOpened();
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
  function capturePlaytrace(hud: HudVM): void {
    const snapshot = controller.capture();
    const replay = controller.buildReplay();
    // The survey describes this same capture (ADR 0014 §4), so the two can never disagree
    // about which moment the run ended at.
    terminalRun = { replay, snapshot, hud };
    playtrace.capture({
      runId,
      replay,
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
  /** The results dialog's ONE live region has ONE current request (#133 review round).
   *
   *  Only the clipboard action is asynchronous, which is exactly what made this subtle:
   *  a slow or refused Copy could land its announcement AFTER a later Save had already
   *  written the region — announcing a failure for an export that succeeded — or, worse,
   *  after Play again had opened the next run's dialog, where a stale "could not export"
   *  refers to a run that is no longer on screen. Every writer claims the region first,
   *  and a completion that is no longer the current claim says nothing at all. */
  function claimResultsStatus(): (message: string) => void {
    const token = ++resultsStatusSeq;
    return (message: string): void => {
      if (token === resultsStatusSeq) overlay.setResultsStatus(message);
    };
  }
  /** Invalidate any in-flight claim without making one — used when the dialog goes away,
   *  so nothing pending can write onto the next run's results. */
  function abandonResultsStatus(): void {
    resultsStatusSeq++;
  }

  function exportPlaytrace(destination: 'clipboard' | 'file'): void {
    // The claim is taken AFTER the work that can throw. Taken before, a failure in
    // `buildExport`/`formatPlaytraceExport` — both outside the `try` below — would bump the
    // token, silence any in-flight Copy, and announce nothing: the press would look like it
    // did nothing while leaving the previous message standing as if it were this press's
    // answer. That is the exact failure mode the live region exists to prevent.
    let announce: (message: string) => void;
    let payload: ReturnType<typeof playtrace.buildExport>;
    let text: string;
    try {
      payload = playtrace.buildExport();
      text = formatPlaytraceExport(payload);
      announce = claimResultsStatus();
    } catch (error) {
      if (import.meta.env.DEV) console.warn('playtrace export could not be built:', error);
      claimResultsStatus()(t('playtrace.failed'));
      return;
    }
    if (destination === 'file') {
      const filename = playtraceFilename(payload.exportedAt);
      try {
        delivery.save(filename, text);
        announce(t('playtrace.saved', { filename }));
      } catch (error) {
        // BOUND, not discarded. A bare `catch {}` collapsed a missing window, a refused
        // `createObjectURL`, a security policy blocking the click and any future refactor's
        // TypeError into one identical string — leaving "Save does nothing" undebuggable
        // with no artifact to look at.
        if (import.meta.env.DEV) console.warn('playtrace save failed:', error);
        announce(t('playtrace.failed'));
      }
      return;
    }
    // The clipboard write is async and can be REFUSED (no permission, a non-secure
    // context, a WebView without one), so the announcement waits for the outcome instead
    // of claiming success optimistically.
    delivery.copy(text).then(
      () => announce(t('playtrace.copied')),
      (error: unknown) => {
        if (import.meta.env.DEV) console.warn('playtrace clipboard copy failed:', error);
        announce(t('playtrace.failed'));
      },
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
        // ADR 0014 §1: the single run-start choke point cancels the whole submission
        // operation, releases the region, and commits nothing.
        surveyForm?.dialogClosed();
        terminalRun = null;
        abandonResultsStatus(); // nothing in flight may write onto the next run's dialog
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
        claimResultsStatus()(message);
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
      // The Dock footprint (#152): observer, scroll listener, pending frame, and every property and
      // class it wrote — cleared by its owner.
      dockResizeObserver?.disconnect();
      dockScroll.abort();
      if (dockFrame !== 0) view?.cancelAnimationFrame(dockFrame);
      clearDockReserve(dockTargets);
      insetProbe.remove();
      // The chips cut (#181 QC round 2): observer, pending frame, and the property it wrote.
      cutObserver?.disconnect();
      if (cutFrame !== 0) view?.cancelAnimationFrame(cutFrame);
      clearHudCut(shell.hudBox);
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
      surveyForm?.destroy();
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
export function boot(doc: Document, options: BootOptions = {}): Promise<AppHandle> | null {
  const root = doc.getElementById('app');
  if (root === null) return null;
  return bootInto(doc, root, options);
}

/** What a caller may add to a boot. The shipped entry (`boot-entry.ts`) passes a survey
 *  transport only when served from wynding.net (`shippedSurveyTransport`), so every other
 *  origin boots with no survey (ADR 0014: the transport IS the switch). The e2e survey
 *  harness (`e2e-harness/`) injects its own, from a separate build. */
export interface BootOptions {
  readonly surveyTransport?: SurveyTransport;
  /** Overrides the build-time `gameVersion` — the harness's way to stand in for a second
   *  deploy without a second build. */
  readonly gameVersion?: string;
}

async function bootInto(
  doc: Document,
  root: HTMLElement,
  options: BootOptions,
): Promise<AppHandle> {
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
  // ADR 0014 §3's ask state — read ONLY where a survey can be offered. With no transport
  // (any origin but https://wynding.net) the survey slot is never created, read or written.
  const gameVersion = options.gameVersion ?? import.meta.env.WYNDING_GAME_VERSION;
  const surveyAsk =
    options.surveyTransport === undefined
      ? undefined
      : await loadSurveyAsk(
          // Its own slot, beside `settings` and the playtrace opt-out, and through the
          // Web Locks `lock`: the ask's read-modify-write merges across tabs only under it.
          createSaveSlot<StoredSurveyAsk>({
            driver,
            key: SURVEY_ASK_KEY,
            deviceId,
            parse: parseStoredSurveyAsk,
            lock,
          }),
          gameVersion,
        );
  return createApp(doc, root, {
    sceneFactory: phaserSceneFactory,
    surveyTransport: options.surveyTransport,
    surveyAsk,
    gameVersion,
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
    // build-time constant baked into the Host build (ADR 0013). This and `boot-entry.ts`
    // (the survey switch) are the only production reads — every consumer downstream takes
    // it as an injected dependency off `AppDeps`, which is what keeps them reachable in jsdom.
    hosted: import.meta.env.WYNDING_HOSTED === true,
  });
}
