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
import { createShell } from './shell';
import { attachInput, type InputHandle } from './input';
import { createSettings } from './settings';
import { createKeymap } from './keymap';
import { createRotate, type MatchMediaFn, type RotateMediaQueryList } from './rotate';
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
  /** matchMedia lookup for viewport-gated features (the P5 rotate prompt) — injectable
   *  for tests; defaults to `doc.defaultView.matchMedia` when available, or an
   *  always-non-matching stub otherwise (e.g. jsdom without a stub). */
  readonly matchMedia?: MatchMediaFn;
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
  // Distinct Play-again seeds even if two clicks land in the same millisecond (or the
  // source is coarse): mix in a monotonic run counter so consecutive runs never repeat.
  let runCounter = 0;
  const nextSeed = (): number => ((seedSource() >>> 0) ^ Math.imul(++runCounter, 0x9e3779b1)) >>> 0;

  // Pinned DOM topology (PLAN.md P1): #app > .wy-shell (status + main/stage/board+dock +
  // rail) as siblings of the results/settings/rotate overlays — the Shell is the ONLY node
  // the modal owner (`modal.ts`, wired inside `createOverlay`) ever toggles `inert` on.
  const shell = createShell(doc);
  const board = shell.board;
  const overlay = createOverlay(
    doc,
    onAction,
    controller,
    settings,
    keymap,
    shell,
    controller.ruleset,
    // Cancel any in-flight placement gesture when settings opens, exactly as the rotate
    // prompt does. The input manager is created below (it needs `shell.card.root`), so this
    // is a deferred forward reference — the same wiring as the hoisted `onAction` above; the
    // closure only runs at click time, long after `input` is initialized.
    () => input.abort(),
  );
  const rotate = doc.createElement('div');
  rotate.className = 'wy-rotate';
  root.append(shell.root, overlay.resultsEl, overlay.settingsEl, rotate);

  const grid = controller.ruleset.board.grid;
  const geometry: BoardGeometry = {
    cols: grid.width,
    rows: grid.height,
    entrance: { col: grid.entrance.col, row: grid.entrance.row },
    exit: { col: grid.exit.col, row: grid.exit.row },
  };
  const handle = deps.sceneFactory(board, geometry);
  const input: InputHandle = attachInput(doc, board, [shell.card.root], controller, keymap, {
    // The class guard (independent of any opener's abort): a placement release must never
    // COMMIT behind an open modal. `.wy-shell`'s `inert` attribute is the modal owner's own
    // ground truth (set for exactly the open interval), so read it directly — no new signal.
    isModalOpen: () => shell.root.hasAttribute('inert'),
  });

  // The rotate prompt (PLAN.md P5) shares the SAME modal owner `overlay.ts` created (one
  // stack for results/rotate/settings). `deps.matchMedia` lets tests drive both queries
  // deterministically; the real default reads `doc.defaultView.matchMedia` (absent under
  // jsdom unless a test stubs it — same fallback shape as `boot()`'s reduced-motion read
  // below), degrading to an always-non-matching stub rather than throwing when it's missing.
  const matchMediaFn: MatchMediaFn =
    deps.matchMedia ??
    ((query: string): RotateMediaQueryList => {
      const mm = doc.defaultView?.matchMedia;
      if (typeof mm === 'function') return mm.call(doc.defaultView, query);
      return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
    });
  const rotateHandle = createRotate(doc, rotate, overlay.modal, controller, input, matchMediaFn);

  const initialSettings = settings.get(); // one snapshot (get() clones), read both fields
  let colourMode = initialSettings.colourMode;
  let reducedMotion = initialSettings.reducedMotion;
  const unsubscribe = settings.subscribe((s) => {
    colourMode = s.colourMode;
    reducedMotion = s.reducedMotion;
  });

  let resultsShown = false;
  let lastHudKey = '';

  function onAction(action: UiAction): void {
    switch (action.type) {
      case 'togglePause':
        controller.togglePause();
        break;
      case 'cycleSpeed':
        controller.cycleSpeed();
        break;
      case 'start':
        controller.start();
        // overlay.update() hides the primary Dock button for the rest of the run once
        // started (PLAN.md P4), and hiding the focused element drops focus to
        // document.body. Re-home focus on the board — the natural next actionable place for
        // a keyboard user (it owns the arrow-cursor + Enter placement path).
        board.focus();
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
    // `data-sim-phase` mirror the real sim (frozen at 0/'pre-wave' while held — the sim
    // itself has no "held" concept), `data-run-started` is the one place that distinction
    // becomes visible, and `data-pending-adds` mirrors the Pending-build count shown by
    // the board's own paused-planning presentation.
    board.dataset.simTick = String(f.curVm.tick);
    board.dataset.simPhase = f.curVm.phase;
    board.dataset.runStarted = String(controller.uiState().started);
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
    const hudKey = `${f.curVm.tick}|${controller.isPaused()}|${controller.speed()}|${selId}|${f.pendingRevision}|${controller.uiRev()}`;
    if (hudKey !== lastHudKey) {
      lastHudKey = hudKey;
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
  });

  return {
    destroy(): void {
      cancel();
      unsubscribe();
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
