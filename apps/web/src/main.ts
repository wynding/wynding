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
import { createController } from './controller';
import { createOverlay, type UiAction } from './overlay';
import { createShell, HOME_HREF } from './shell';
import { attachInput, type InputHandle } from './input';
import { createSettings } from './settings';
import { createKeymap } from './keymap';
import { createRotate, type MatchMediaFn, type RotateMediaQueryList } from './rotate';
import { requestFullscreen } from './fullscreen';
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
  /** Wide-entropy seed source for Play-again (defaults to wall-clock `Date.now`). Kept
   *  separate from `now` (a monotonic frame clock) so a fresh run varies per reload. */
  readonly seedSource?: () => number;
  readonly prefersReducedMotion?: boolean;
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
}

export interface AppHandle {
  destroy(): void;
}

/** Wire the whole app into `root`. Pure of Phaser/rAF (both injected via `deps`). */
export function createApp(doc: Document, root: HTMLElement, deps: AppDeps): AppHandle {
  const settings = createSettings({ reducedMotion: deps.prefersReducedMotion ?? false });
  const keymap = createKeymap();
  const controller = createController(deps.seed);
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

  // Pinned DOM topology (PLAN.md P1): #app > .wy-shell (status + main/stage/board+dock +
  // rail) as siblings of the results/settings/rotate overlays — the Shell is the ONLY node
  // the modal owner (`modal.ts`, wired inside `createOverlay`) ever toggles `inert` on.
  const shell = createShell(doc);
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
  const install: InstallHandle = createInstall({
    storage: deps.storage ?? createStorageAdapter(view),
    matchMedia: matchMediaFn,
    // `window` is the spec'd target for both `beforeinstallprompt` and `appinstalled`.
    // Under jsdom without a window (or a detached document) nothing can fire them, so a
    // no-op target degrades to the `other` branch rather than throwing at construction.
    target: view ?? { addEventListener: () => {}, removeEventListener: () => {} },
    navigator: view?.navigator ?? { platform: '', maxTouchPoints: 0 },
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
    // prompt does. The input manager is created below (it needs `shell.card.root`), so this
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
  const input: InputHandle = attachInput(doc, board, [shell.card.root], controller, keymap, {
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
  const unsubscribe = settings.subscribe((s) => {
    colourMode = s.colourMode;
    reducedMotion = s.reducedMotion;
    reflectReducedMotion(s.reducedMotion);
  });

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
      overlay.showResults(hud);
      resultsShown = true;
    }
  }

  /** The ONE app-level pause seam. EVERY pause mutation in the app routes through here or
   *  `togglePause` below — the keymapped pause key (`input.ts`'s `onTogglePause`), the Dock's
   *  Pause button (`onAction`), the settings dialog's auto-pause, the rotate prompt's
   *  auto-pause, and the leave guard's defensive pause — because pausing makes the home link
   *  reappear, and that flip has to be SYNCHRONOUS with the pause itself. Leaving it to the
   *  frame loop's memo-key gate would let the link sit hidden (or, worse, interactable in a
   *  stale state) for a frame — indefinitely if frames are throttled in a background tab.
   *
   *  Owns the started-and-unpaused guard, so any caller can invoke it unconditionally: a
   *  held pre-start run and an already-paused one are both no-ops, and the refresh is skipped
   *  with them since nothing changed. */
  function ensurePaused(): void {
    if (!controller.uiState().started || controller.isPaused()) return;
    controller.pause();
    refreshHud();
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
   *  makes the next Start eligible again. `startRun` itself no longer enqueues
   *  `callWaveEarly` (`controller.start()` is now a trivial flag flip, PLAN.md P3 step 15 —
   *  the Start decouple) — `primaryAction` below is what routes between this and the
   *  Call-wave path once `started`. */
  function startRun(): void {
    const wasStarted = controller.uiState().started;
    controller.start();
    if (!wasStarted && controller.uiState().started) {
      requestFullscreen({
        doc,
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
      // INSIDE the edge, deliberately: the keymapped start key routes here too, and pressing
      // it again mid-run is a no-op on the controller. Re-homing unconditionally would yank
      // focus off the Card or the chips scrollport and lose the player's place for nothing.
      board.focus();
    }
    // Starting HIDES the home link (started + unpaused = live), so the flip has to land in
    // this handler rather than waiting for the frame loop — same reasoning as `ensurePaused`
    // above. Outside the edge deliberately: a repeat Start is a controller no-op, but the
    // refresh is cheap and keeps this path unconditionally correct.
    refreshHud();
  }

  /** The morphed primary action (PLAN.md P3 step 15, M2-S2): the SAME control routes to
   *  `startRun()` (with its fullscreen/install/focus edge handling) while `!started`, and
   *  to `callWaveEarly()` once the run is under way. One function so the Dock button's
   *  click and the keymapped `start` action (which now triggers the SAME morphed control,
   *  not a fixed "Start") can never diverge on which path they take. */
  function primaryAction(): void {
    if (!controller.uiState().started) {
      startRun();
      return;
    }
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
        controller.startRun(nextSeed());
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
        overlay.setVerifyMessage(message);
        break;
      }
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
      guardListener.abort(); // the home-link exit guard
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

/** Boot the app against the real browser globals. Guarded so importing this module under
 *  the test runner (which has no #app until a test mounts one) does not auto-run. */
export function boot(doc: Document): AppHandle | null {
  const root = doc.getElementById('app');
  if (root === null) return null;
  const prefersReducedMotion =
    typeof doc.defaultView?.matchMedia === 'function' &&
    doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return createApp(doc, root, {
    sceneFactory: phaserSceneFactory,
    schedule: rafScheduler,
    now: () => performance.now(),
    // Wall-clock seed (wide entropy). performance.now() would be a small navigation-
    // relative value that clusters across reloads, collapsing the RNG's variety.
    seed: Date.now() >>> 0,
    prefersReducedMotion,
    storage: dismissalStorage(),
  });
}

/** True under the Vitest runner — used to keep the module-load auto-boot (and its loud
 *  missing-#app failure) from firing when a test merely imports this module. */
function isTestRunner(): boolean {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return !!g.process?.env?.VITEST;
}

// Auto-boot in a real browser. A missing/mis-IDed #app mount point is a hard,
// visible failure (a blank page with a thrown error), never a silent no-op.
if (typeof document !== 'undefined' && !isTestRunner()) {
  if (boot(document) === null) {
    throw new Error('missing #app root element');
  }
}
