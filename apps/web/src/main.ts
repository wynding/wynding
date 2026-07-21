// apps/web — the PWA entry point.
//
// This is the platform/render layer: it may use wall-clock time and requestAnimationFrame
// (both banned inside the sim). It drives the deterministic sim on a fixed-timestep
// loop and hands each snapshot to the renderer. Real Phaser scene + service-worker
// registration land later; this wires the seam end to end.

import { createFixedLoop } from '@wynding/engine';
import {
  createInitialState,
  loadBoard,
  step,
  MS_PER_TICK,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { mount } from '@wynding/render';
import { sampleBoard } from '@wynding/content';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing #app root element');

const title = document.createElement('h1');
title.textContent = `Wynding — ${sampleBoard.name}`;
app.appendChild(title);

const board = loadBoard(sampleBoard);
let sim: SimState = createInitialState(Date.now() >>> 0);
const view = mount(app, sim);

let tickCount = 0;
const loop = createFixedLoop(
  () => {
    // Demo schedule: send a creep every 20 ticks (1s at 20 Hz).
    const inputs: SimInput[] = tickCount % 20 === 0 ? [{ kind: 'spawnCreep', hp: 12 }] : [];
    sim = step(sim, inputs, board);
    tickCount += 1;
    view.update(sim);
  },
  { msPerTick: MS_PER_TICK },
);

let last = performance.now();
function frame(now: number): void {
  loop.advance(now - last);
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
