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
// and `main.ts`'s requestAnimationFrame loop (restated below, as it is private there) — and
// opens its results dialog on the first frame, with the run's own numbers. Nothing is forced:
// the outcome, score, stars and stats are the run's.
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

import { createApp } from '../src/main';
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

/** `main.ts`'s requestAnimationFrame scheduler, restated: it is private there, and this page
 *  boots `createApp` the way `boot()` does. */
function rafScheduler(onFrame: (nowMs: number) => void): () => void {
  let id = 0;
  const loop = (now: number): void => {
    onFrame(now);
    id = requestAnimationFrame(loop);
  };
  id = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(id);
}

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
  window.addEventListener(
    'pointerdown',
    () => {
      pressed = true;
      // Bounded: a run that will not end must fail the test, not freeze the page.
      for (let i = 0; i < 100 && !controller.isTerminal(); i++) controller.advance(MS_PER_TICK);
      if (!controller.isTerminal()) throw new Error('results harness: the run did not end');
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

const root = document.getElementById('app');
if (root === null) throw new Error('missing #app root element');
createApp(document, root, {
  sceneFactory: mount,
  schedule: rafScheduler,
  now: () => performance.now(),
  seed: SCENARIO_SEED,
  controllerFactory: (seed) => {
    if (params.get('endOnPress') === '1') return endingOnPress(seed);
    const controller = createController(seed);
    playScript(controller, plan);
    if (!controller.isTerminal()) throw new Error('results harness: the scripted run did not end');
    return controller;
  },
  ...(params.get('survey') === '1' ? { surveyTransport, surveyAsk } : {}),
});
