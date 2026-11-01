// waves-entry.ts — the e2e waves harness's entry (M3 story 4). NOT part of the shipped app:
// `e2e-harness/waves.html` is this module's only consumer, built by `vite.e2e.config.ts` into
// `dist-e2e`, a directory nothing that ships reads.
//
// Why a harness: the wave strip states a wave's hit points when its creeps do not have the
// catalog's ("+70% hit points"), and no shipped wave does yet — every wave of the crossing
// board's placeholder schedule is at 100, until stories 5–7 author the ones that grow. So this
// page boots the REAL app (the real scene, overlay and `main.ts`'s requestAnimationFrame
// scheduler) on the shipped bundle with its waves changed, through the controller's content
// seam, and the strip shows the clause from the first frame:
//
// - `?hp=<percent>` sets every wave's `hpPercent` (default 100, the shipped value);
// - `&wave=<n>` gives wave 1 wave n's streams, so a dense wave (9's four streams on two routes)
//   is what the strip shows before Start.
//
// Nothing else changes: the board, the catalog and the rest of each wave are the shipped ones.

import { getBundledRuleset, defaultBoardId, type Ruleset } from '@wynding/content';
import { mount } from '@wynding/render/scene';
import { createApp, rafScheduler } from '../src/main';
import { createController } from '../src/controller';

const params = new URLSearchParams(window.location.search);
const hp = Number(params.get('hp') ?? '100');
const from = Number(params.get('wave') ?? '1');

const bundle = structuredClone(getBundledRuleset()) as Ruleset;
const board = bundle.boards[0] as unknown as {
  waves: { hpPercent: number; entries: unknown[] }[];
};
const source = board.waves[from - 1];
// The message is also `check:build-layering`'s marker for this module: rename it there too.
if (source === undefined) throw new Error(`waves harness: the board has no wave ${String(from)}`);
board.waves[0]!.entries = structuredClone(source.entries);
for (const wave of board.waves) wave.hpPercent = hp;
const content = { bundle, boardId: defaultBoardId(bundle) } as const;

const root = document.getElementById('app');
if (root === null) throw new Error('missing #app root element');
createApp(document, root, {
  sceneFactory: mount,
  schedule: rafScheduler,
  now: () => performance.now(),
  seed: 1,
  controllerFactory: (seed) => createController(seed, content),
});
