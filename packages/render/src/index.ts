// @wynding/render — the presentation layer.
//
// The renderer READS simulation state and draws it; it never mutates the sim.
// Real drawing is done with Phaser 3 (a declared dependency) — a WebGL2 scene
// wired up later. For now this establishes the seam the app calls: mount(el,
// sim) attaches a view to a DOM element and returns a handle whose update() is
// fed fresh sim snapshots each frame (interpolated between fixed ticks).

import type { SimState } from '@wynding/sim';

/** Live handle to a mounted view. */
export interface RenderHandle {
  /** Push the latest sim snapshot to be drawn. */
  update(sim: SimState): void;
  /** Tear down the view and release resources. */
  destroy(): void;
}

/**
 * Attach a view to `el` and draw the initial `sim` state.
 *
 * Placeholder implementation: renders a lightweight DOM readout (tick, lives,
 * creep count) so the app wiring is exercisable before the Phaser scene exists.
 * The signature is the stable contract; the internals get replaced by Phaser.
 */
export function mount(el: HTMLElement, sim: SimState): RenderHandle {
  const root = el.ownerDocument.createElement('div');
  root.className = 'wynding-view';
  el.appendChild(root);

  const draw = (state: SimState): void => {
    root.textContent = `tick ${state.tick} · lives ${state.lives} · creeps ${state.creeps.id.length}`;
  };
  draw(sim);

  return {
    update(next: SimState): void {
      draw(next);
    },
    destroy(): void {
      root.remove();
    },
  };
}
