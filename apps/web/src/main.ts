// apps/web — the PWA entry point.
//
// This is the platform/render layer: it may use wall-clock time and requestAnimationFrame
// (both banned inside the sim). It drives the deterministic sim on a fixed-timestep
// loop and hands each snapshot to the renderer. Real Phaser scene + service-worker
// registration land later; this wires the seam end to end.

import { createFixedLoop } from '@wynding/engine';
import {
  createInitialState,
  compileRuleset,
  step,
  MS_PER_TICK,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { mount } from '@wynding/render';
import { m1Ruleset, M1_BOARD_ID } from '@wynding/content';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing #app root element');

const board = m1Ruleset.boards.find((b) => b.id === M1_BOARD_ID);
const title = document.createElement('h1');
title.textContent = `Wynding — ${board?.name ?? M1_BOARD_ID}`;
app.appendChild(title);

const ruleset = compileRuleset(m1Ruleset, M1_BOARD_ID);
let sim: SimState = createInitialState(Date.now() >>> 0, ruleset);
const view = mount(app, sim);

const loop = createFixedLoop(
  () => {
    // Demo schedule: call the wave early on the first tick; creeps then spawn from
    // the ruleset schedule (the manual spawn command is gone — spawns are content).
    // Drive off the sim's authoritative tick, not a shadow counter.
    const inputs: SimInput[] = sim.tick === 0 ? [{ kind: 'callWaveEarly' }] : [];
    sim = step(sim, ruleset, inputs);
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
