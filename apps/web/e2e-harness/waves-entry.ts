// waves-entry.ts — the e2e waves harness's entry (M3 story 4). NOT part of the shipped app:
// `e2e-harness/waves.html` is this module's only consumer, built by `vite.e2e.config.ts` into
// `dist-e2e`, a directory nothing that ships reads.
//
// Why a harness: the wave strip states a wave's hit points when its creeps do not have the
// catalog's ("+70% hit points"), and no shipped wave does yet — block 1's are all at 100, until
// stories 6–7 author the ones that grow; nor does block 1 carry a wave of more than two
// streams, where the arc's densest carry four. So this page boots the REAL app (the real scene,
// overlay and `main.ts`'s requestAnimationFrame scheduler) on the shipped bundle with its waves
// changed, through the controller's content seam, and the strip shows them from the first frame:
//
// - `?hp=<percent>` sets every wave's `hpPercent` (default 100, the shipped value);
// - `&wave=<n>[,<m>…]` gives wave 1 the streams of waves n, m, … in that order, so a dense line
//   (`8,9`: four streams on two routes) is what the strip shows before Start;
// - `&streams=<creep>:<entrance>:<count>,…` gives wave 1 those streams instead, overriding
//   `&wave=` (each stream's creeps 20 ticks apart, every stream from the launch), so a spec can
//   show a wave the shipped schedule does not have yet — m3.md's arc, say;
// - `&as=<n>/<N>` titles every upcoming preview "Wave n of N" instead of its own title, so a
//   wave shown from the arc (before Start) is measured with its real title's width. Only the
//   HUD's preview numbers change; the run itself is the shipped schedule's.
//
// Nothing else changes: the board, the catalog and the rest of each wave are the shipped ones.

import { getBundledRuleset, defaultBoardId, type Ruleset } from '@wynding/content';
import { mount } from '@wynding/render/scene';
import { createApp, rafScheduler } from '../src/main';
import { createController, type Controller } from '../src/controller';

const params = new URLSearchParams(window.location.search);
const hp = Number(params.get('hp') ?? '100');

const bundle = structuredClone(getBundledRuleset()) as Ruleset;
const board = bundle.boards[0] as unknown as {
  waves: { hpPercent: number; entries: unknown[] }[];
};
const streams = params.get('streams');
if (streams !== null) {
  // `&streams=` overrides `&wave=`, which is then neither read nor checked.
  board.waves[0]!.entries = streams.split(',').map((stream) => {
    const [creepId, entrance, count] = stream.split(':');
    return { creepId, entrance, count: Number(count), spacingTicks: 20 };
  });
} else {
  const from = (params.get('wave') ?? '1').split(',').map(Number);
  const entries = from.flatMap((n) => {
    const source = board.waves[n - 1];
    // The message is also `check:build-layering`'s marker for this module: rename it there too.
    if (source === undefined) throw new Error(`waves harness: the board has no wave ${String(n)}`);
    return source.entries;
  });
  board.waves[0]!.entries = structuredClone(entries);
}
for (const wave of board.waves) wave.hpPercent = hp;
const content = { bundle, boardId: defaultBoardId(bundle) } as const;
const as = params.get('as')?.split('/').map(Number);

/** The run, its upcoming wave's title numbers replaced by `&as=`'s. */
function titled(controller: Controller): Controller {
  if (as === undefined) return controller;
  const [waveNumber, waveCount] = as as [number, number];
  return {
    ...controller,
    hud: () => {
      const hud = controller.hud();
      return hud.preview?.kind === 'upcoming'
        ? { ...hud, preview: { ...hud.preview, waveNumber, waveCount } }
        : hud;
    },
  };
}

const root = document.getElementById('app');
if (root === null) throw new Error('missing #app root element');
createApp(document, root, {
  sceneFactory: mount,
  schedule: rafScheduler,
  now: () => performance.now(),
  seed: 1,
  controllerFactory: (seed) => titled(createController(seed, content)),
});
