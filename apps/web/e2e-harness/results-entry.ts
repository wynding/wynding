// results-entry.ts — the e2e results harness's entry (#181 H2). NOT part of the shipped app:
// `e2e-harness/results.html` is this module's only consumer, built by `vite.e2e.config.ts`
// into `dist-e2e`, a directory nothing that ships reads.
//
// Why a harness: the results panel's WIN treatment needs a won run, and no e2e spec can play
// one through the page — a win takes a ten-wave maze and a boss. So this page plays a proven
// build script through the REAL controller before the app mounts (`scripted-run.ts`, the
// content package's greedy rule): `?run=win` plays the content suite's winning showcase build
// (WINNER_A, won on 10 lives), `?run=loss` its 12-tower prefix (lost on wave 9 of 10). The
// app then boots on that finished run as `boot()` would — the real scene, the real overlay,
// and `main.ts`'s own requestAnimationFrame scheduler — and opens its results dialog on the
// first frame, with the run's own numbers. Nothing is forced: the outcome, score, stars and
// stats are the run's.
//
// `&survey=1` adds an always-offered survey with a transport that accepts every send, so the
// panel's Give feedback can be checked (and seen) beside Play again and Run data. `&text=200`
// sets the e2e suite's text zoom (`compact.spec.ts`'s `:root { font-size: 200% }`) BEFORE the
// app mounts: the dialog opens on the first frame, so a zoom applied after load would come too
// late for where the panel opens and what takes focus.
//
// The survey's ask refresh takes a Web Lock, as production's storage read does (`persist.ts`'s
// `browserLockFn`), so Give feedback arrives a task AFTER the dialog opens and the panel first
// settles, never in the same task. A refresh that settled in a microtask would hide the panel's
// re-settle on a late arrival, the case production always hits (#181 H2). `&askLock=0` gives the
// instant refresh, and `&askLock=1` names the default explicitly.
//
// `&sendDelay=<ms>` holds each survey send that long, as a slow network does: room for the player
// to switch to the keyboard while a Send is in flight. `&endOnPress=1` stops the run one tick
// short of its end and plays that tick on the page's first press, so the dialog opens on the next
// frame under a pointer that was pressing the board: what the press guard's arming is for.
// With it, `&endDelay=<ms>` plays that tick that long after the press, and `&endOnKey=1` plays it
// on the first keydown instead.
//
// `&stop=step` and `&stop=draw` open the dialog's STOPPED form instead (#191): the run is played
// to wave 3 and left live, then from the app's tenth frame a sim step throws (`step`), or every
// draw throws until the frame loop's bound stops the run (`draw`). Nine good frames first, so the
// HUD the message reads its wave from has refreshed.
//
// `&stop=render` and `&stop=render-once` break Phaser's own frame loop instead (#195), the loop
// that makes the board's pixels from what the app's draw records. From the app's tenth frame,
// `MultiPipeline#batchSprite`, which batches every image Phaser's WebGL renderer draws, throws on
// every call (`render`) or on its next call only (`render-once`): Phaser's real render pass
// throws, as it would on a sprite left on a removed texture. The run is `draw`'s, live at wave 3;
// the lasting break stops it as a draw stop does, and the run carries on past the one-off.
// `window.__wyRenderBreak` counts the throws and reads Phaser's frame count. It is the harness's
// one reach into Phaser itself, through apps/web's `phaser` dev dependency, which resolves to the
// install the scene runs on: one module, so the patch reaches the game the app mounts. Both
// packages take Phaser's version from the workspace catalog (`pnpm-workspace.yaml`), so a bump
// moves them together; were the two ever to resolve apart, the breaks would miss the game and
// their specs would fail.

import Phaser from 'phaser';
import { createApp, rafScheduler } from '../src/main';
import { createController } from '../src/controller';
import { playScript } from '../src/scripted-run';
import type { Controller } from '../src/controller';
import { MS_PER_TICK } from '@wynding/sim';
import type { SurveyAsk, SurveyTransport } from '../src/survey';
import { mount } from '@wynding/render/scene';
// Reached by relative path, as `apps/server`'s replay-parity test does: the content
// package's `exports` map has no subpath for its test support, and this harness never ships.
import { WINNER_A } from '../../../packages/content/src/showcase-builds';

/** The seed WINNER_A is tuned against (`packages/content/src/m2-golden.test.ts`). */
const SCENARIO_SEED = 0x5eed;

const params = new URLSearchParams(window.location.search);
if (params.get('text') === '200') {
  const zoom = document.createElement('style');
  zoom.textContent = ':root { font-size: 200% }';
  document.head.append(zoom);
}
const plan = params.get('run') === 'loss' ? WINNER_A.slice(0, 12) : WINNER_A;

let offered = true;
const surveyAsk: SurveyAsk = {
  offered: () => offered,
  refresh: async () => {
    if (params.get('askLock') !== '0') await navigator.locks.request('wy-harness-ask', () => {});
  },
  commit: async () => {
    offered = false;
  },
};
const sendDelay = Number(params.get('sendDelay') ?? '0');
const surveyTransport: SurveyTransport = {
  send: async () => {
    if (sendDelay > 0) await new Promise((resolve) => setTimeout(resolve, sendDelay));
    return 'accepted';
  },
};

/** The run, played one tick short of its end; its last tick plays on the page's first press. */
function endingOnPress(seed: number): Controller {
  // How many ticks the whole run takes, counted on a throwaway controller.
  const probe = createController(seed);
  let ticks = 0;
  playScript(
    {
      ...probe,
      advance: (ms: number) => {
        ticks++;
        probe.advance(ms);
      },
    },
    plan,
  );
  const controller = createController(seed);
  playScript(controller, plan, ticks - 1);
  if (controller.isTerminal()) throw new Error('results harness: the run ended a tick early');
  // Until the press, time stands still: the app's frame loop advances nothing.
  let pressed = false;
  // `&endDelay=<ms>` plays that last tick that long after the first press, as a run whose end
  // comes a moment after the press that was aimed at the board; `&endOnKey=1` ends on the first
  // keydown instead of the first pointerdown. `__endedAt` is when the tick was played.
  const endDelay = Number(params.get('endDelay') ?? '0');
  const finish = (): void => {
    pressed = true;
    (window as unknown as { __endedAt?: number }).__endedAt = performance.now();
    // Bounded: a run that will not end must fail the test, not freeze the page.
    for (let i = 0; i < 100 && !controller.isTerminal(); i++) controller.advance(MS_PER_TICK);
    if (!controller.isTerminal()) throw new Error('results harness: the run did not end');
  };
  window.addEventListener(
    params.get('endOnKey') === '1' ? 'keydown' : 'pointerdown',
    () => {
      if (endDelay > 0) setTimeout(finish, endDelay);
      else finish();
    },
    { capture: true, once: true },
  );
  return {
    ...controller,
    advance: (ms: number) => {
      if (pressed) controller.advance(ms);
    },
  };
}

/** A run left live at wave 3 (#191's stopped form): with `step`, its tenth `advance` throws, as a
 *  sim step that throws would; otherwise it plays on, until a broken draw or render stops it. */
function stoppingRun(seed: number, stop: 'step' | 'draw' | 'render'): Controller {
  const controller = createController(seed);
  playScript(controller, plan, 1_200); // wave 3 launched, the run live
  if (controller.isTerminal()) throw new Error('results harness: the stopping run ended');
  if (stop !== 'step') return controller;
  let calls = 0;
  return {
    ...controller,
    advance: (ms: number) => {
      if (++calls === 10) throw new Error('results harness: the step broke');
      controller.advance(ms);
    },
  };
}

/** What `&stop=render` and `&stop=render-once` let a spec read, as `window.__wyRenderBreak`
 *  (deliberately not a `declare global`: see `tsconfig.json`'s note on test-only globals). */
interface RenderBreak {
  /** Throws made so far. */
  threw: number;
  /** Phaser's frame count (`Game#getFrame`): -1 until Phaser has batched an image. */
  frame: () => number;
}

/** Break Phaser's real render pass from the returned `arm()` on (#195): `MultiPipeline#
 *  batchSprite` throws on every call, or on its next call only. Patched on the prototype, so it
 *  reaches every pipeline that batches images, and before the scene mounts. */
function breakRender(once: boolean): () => void {
  const control: RenderBreak = { threw: 0, frame: () => -1 };
  (window as unknown as { __wyRenderBreak: RenderBreak }).__wyRenderBreak = control;
  type Pipeline = Phaser.Renderer.WebGL.Pipelines.MultiPipeline;
  const proto = Phaser.Renderer.WebGL.Pipelines.MultiPipeline.prototype;
  const batchSprite = proto.batchSprite;
  let armed = false;
  proto.batchSprite = function (this: Pipeline, ...args: Parameters<Pipeline['batchSprite']>) {
    const game = this.game;
    control.frame = () => game.getFrame();
    if (armed) {
      armed = !once;
      control.threw += 1;
      throw new Error('results harness: the render broke');
    }
    batchSprite.apply(this, args);
  };
  return () => {
    armed = true;
  };
}

/** Break Phaser's boot ahead of the scene's READY listener (#195): `SceneManager#bootQueue`, which
 *  Phaser's own READY listener runs before the scene's, throws once, so READY never reaches the
 *  scene, Phaser's loop never starts and nothing draws the board, as a renderer whose boot failed
 *  (a shader that will not compile, a context lost while booting) leaves it. */
function breakBoot(): void {
  const proto = Phaser.Scenes.SceneManager.prototype as unknown as { bootQueue: () => void };
  const bootQueue = proto.bootQueue;
  proto.bootQueue = function () {
    proto.bootQueue = bootQueue;
    throw new Error('results harness: the boot broke');
  };
}

const stop = params.get('stop');
if (stop === 'boot') breakBoot();
const armRenderBreak =
  stop === 'render' || stop === 'render-once' ? breakRender(stop === 'render-once') : null;
const root = document.getElementById('app');
if (root === null) throw new Error('missing #app root element');
createApp(document, root, {
  sceneFactory:
    stop === 'draw'
      ? (el, geometry) => {
          const handle = mount(el, geometry);
          let draws = 0;
          return {
            ...handle,
            draw: (prev, cur, alpha, overlay) => {
              if (++draws >= 10) throw new Error('results harness: the draw broke');
              handle.draw(prev, cur, alpha, overlay);
            },
          };
        }
      : armRenderBreak !== null
        ? (el, geometry) => {
            const handle = mount(el, geometry);
            let draws = 0;
            return {
              ...handle,
              draw: (prev, cur, alpha, overlay) => {
                if (++draws === 10) armRenderBreak();
                handle.draw(prev, cur, alpha, overlay);
              },
            };
          }
        : mount,
  schedule: rafScheduler,
  now: () => performance.now(),
  seed: SCENARIO_SEED,
  controllerFactory: (seed) => {
    if (stop === 'step' || stop === 'draw') return stoppingRun(seed, stop);
    if (armRenderBreak !== null || stop === 'boot') return stoppingRun(seed, 'render');
    if (params.get('endOnPress') === '1') return endingOnPress(seed);
    const controller = createController(seed);
    playScript(controller, plan);
    // The message is also `check:build-layering`'s marker for this module: rename it there too.
    if (!controller.isTerminal()) throw new Error('results harness: the scripted run did not end');
    return controller;
  },
  ...(params.get('survey') === '1' ? { surveyTransport, surveyAsk } : {}),
});
