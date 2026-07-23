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
import { attachInput, type InputHandle } from './input';
import { createSettings } from './settings';
import { createKeymap } from './keymap';
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

  const title = doc.createElement('h1');
  title.className = 'wy-title';
  // Static "Wynding" (not the board name) — a ratified PLAN §8 decision: RulesetBoard.name
  // is a runtime content string that cannot be a generated typed catalog key, and shipping
  // it raw would be untranslatable UI (ADR 0004). Localizing board names + excluding them
  // from the ruleset hash is deferred ADR 0007 content work. M1 has one board, so no
  // board-identity is lost in practice.
  title.textContent = t('app.title');

  const board = doc.createElement('div');
  board.className = 'wy-board';
  board.tabIndex = 0; // focusable for the keyboard build cursor
  board.setAttribute('role', 'application');
  board.setAttribute('aria-label', t('board.aria'));

  // The board is a sibling of the overlay, so hand it in as a modal-inert + focus-restore
  // target: while the results dialog is open the board is inert (can't be Tabbed onto), and
  // closing the dialog (Play again) returns focus to the board rather than dropping to body.
  const overlay = createOverlay(doc, onAction, settings, keymap, {
    inertWhileModal: [board],
    restoreFocusOnClose: board,
  });
  root.append(title, board, overlay.root);

  const grid = controller.ruleset.board.grid;
  const geometry: BoardGeometry = {
    cols: grid.width,
    rows: grid.height,
    entrance: { col: grid.entrance.col, row: grid.entrance.row },
    exit: { col: grid.exit.col, row: grid.exit.row },
  };
  const handle = deps.sceneFactory(board, geometry);
  const input: InputHandle = attachInput(doc, board, controller, keymap);

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
      case 'callWave':
        controller.callWaveEarly();
        break;
      case 'sell':
        controller.sellSelected();
        break;
      case 'playAgain':
        controller.startRun(nextSeed());
        handle.reset();
        overlay.hideResults();
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
      colourMode,
      reducedMotion,
    };
    handle.draw(f.prevVm, f.curVm, f.alpha, ov);
    // ...but the HUD only changes on a tick/pause/speed/selection boundary, so gate its
    // recompute + DOM writes on that (they're redundant on the ~60 fps render hot path).
    const selPresent = f.selection !== null;
    // Key on selection IDENTITY (its cell), not just presence: switching between two towers
    // while paused (no tick change) must still refresh the Sell refund for the new tower.
    const selId = f.selection === null ? 'none' : `${f.selection.col},${f.selection.row}`;
    const hudKey = `${f.curVm.tick}|${controller.isPaused()}|${controller.speed()}|${selId}`;
    if (hudKey !== lastHudKey) {
      lastHudKey = hudKey;
      const hud = controller.hud();
      overlay.update({
        hud,
        paused: controller.isPaused(),
        speed: controller.speed(),
        canSell: selPresent,
        refund: controller.refundForSelection(),
        canCallWave: hud.phase === 'pre-wave',
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
      input.destroy();
      handle.destroy();
      overlay.destroy();
      // Remove the app-owned siblings too — overlay.destroy() only removes its own root,
      // so leaving these behind would stack a duplicate title/board (an extra keyboard
      // focus target, possibly still inert from an open results dialog) on every
      // createApp() a host runs in the same root.
      title.remove();
      board.remove();
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
