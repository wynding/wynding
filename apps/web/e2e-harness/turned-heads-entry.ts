// turned-heads-entry.ts — the e2e turned-heads harness's entry (#181, T3). NOT part of the
// shipped app: `e2e-harness/turned-heads.html` is this module's only consumer, built by
// `vite.e2e.config.ts` into `dist-e2e`, a directory nothing that ships reads.
//
// Why a harness: a head turns toward where its target creep is drawn, and in a game that is
// wherever the run has taken the creep — no bearing a spec can choose. Here the REAL renderer
// (`@wynding/render/scene`, the board the game mounts) draws a scene the spec sets through
// `window.__wyTurnedHeads` — its towers, and creeps that stand still — so a head turns to
// exactly the bearing of the creep it is locked on, and holds it. Each frame takes a tick of
// render time, so a head is on its bearing within ten frames (it turns at most 18° a tick).
//
// `?cell=<px>` sizes the board to that many CSS px a cell (28×24 cells, `GRID` in the specs).

import { mount } from '@wynding/render/scene';
import type { ColourMode, CreepVM, RenderOverlay, RenderVM, TowerVM } from '@wynding/render';

interface HarnessControl {
  towers: TowerVM[];
  creeps: CreepVM[];
  colourMode: ColourMode;
  /** Frames drawn so far. */
  frames: number;
}

const COLS = 28;
const ROWS = 24;
const cell = Number(new URLSearchParams(window.location.search).get('cell') ?? '11');
const el = document.getElementById('board');
if (el === null) throw new Error('missing #board');
el.style.width = `${COLS * cell}px`;
el.style.height = `${ROWS * cell}px`;

const control: HarnessControl = { towers: [], creeps: [], colourMode: 'default', frames: 0 };
// Deliberately not a `declare global` (see `tsconfig.json`'s note on test-only globals).
// The name is also `check:build-layering`'s marker for this module: rename it there too.
(window as unknown as { __wyTurnedHeads: HarnessControl }).__wyTurnedHeads = control;

const handle = mount(el, {
  cols: COLS,
  rows: ROWS,
  entrance: { col: 0, row: 11 },
  exit: { col: COLS - 1, row: 11 },
});
let prev: RenderVM | null = null;
let tick = 0;
const frame = (): void => {
  tick += 1;
  const cur: RenderVM = { tick, phase: 'running', towers: control.towers, creeps: control.creeps };
  const overlay: RenderOverlay = {
    ghost: null,
    selection: null,
    sparks: [],
    pendingAdds: [],
    pendingSells: [],
    colourMode: control.colourMode,
    reducedMotion: false,
    tracers: [],
  };
  handle.draw(prev, cur, 1, overlay);
  prev = cur;
  control.frames += 1;
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
