// combat-events.test.ts — what one sim step did that the board shows as combat feedback (#181
// C1/C2), as the step reports it: its kills (`StepEvents.killed`), each where the board last drew
// it, with its look and the bounty credited; its leaks (`StepEvents.leaked`); which flyer a
// targeted impact struck, by the creep its point names; and which shots in flight lost their tower.

import { describe, it, expect } from 'vitest';
import type { CreepVM, KillVM, RenderVM, TowerVM, TracerVM } from '@wynding/render';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import {
  markFlyerSparks,
  noteTowerless,
  stepOutcome,
  type StepImpactPoint,
  type StepKill,
} from './combat-events';

const bundle = getBundledRuleset();
const ruleset = compileRuleset(bundle, defaultBoardId(bundle));

const FP = 256;
/** The exit cell's centre in these steps, in fixed-point units. */
const EXIT_AT = { x: 20 * FP + FP / 2, y: 10 * FP + FP / 2 };

const creep = (id: number, opts: Partial<CreepVM> = {}): CreepVM => ({
  id,
  creepId: 'normal',
  domain: 'ground',
  x: 5 * FP,
  y: 5 * FP,
  hpFrac: 1,
  slowed: false,
  poisoned: false,
  stunned: false,
  warded: false,
  boss: false,
  ...opts,
});

const vm = (creeps: readonly CreepVM[], towers: readonly TowerVM[] = []): RenderVM => ({
  tick: 10,
  phase: 'running',
  creeps,
  towers,
});

const tower = (id: number, towerId: string, col: number, row: number): TowerVM => ({
  id,
  col,
  row,
  towerId,
  support: false,
  buffed: false,
  targetId: 0,
});

/** A kill as the step reports it: by default a `normal` killed one budget east of where the
 *  view model drew it, paying 1. */
const killed = (id: number, opts: Partial<StepKill> = {}): StepKill => ({
  id,
  creepId: 'normal',
  x: 5 * FP + 26,
  y: 5 * FP,
  bounty: 1,
  ...opts,
});

describe('stepOutcome — the kills and leaks of one step, as it reports them', () => {
  it('a creep the step reports killed, drawn before it, bursts where it was drawn, in the look it was drawn with, paying the bounty the step credited', () => {
    const before = vm([
      creep(1),
      creep(2, { creepId: 'armored-flyer', domain: 'air', boss: true, x: 7 * FP, y: 3 * FP }),
    ]);
    expect(
      stepOutcome(before, [killed(2, { creepId: 'armored-flyer', x: 7 * FP + 26 })], [], ruleset),
    ).toEqual({
      kills: [
        {
          id: 2,
          x: 7 * FP,
          y: 3 * FP,
          creepId: 'armored-flyer',
          domain: 'air',
          boss: true,
          bounty: 1,
        },
      ] satisfies KillVM[],
      leaks: 0,
    });
  });

  it('takes the step’s own lists as exact: the creeps it names killed are the kills, in its order, and the ids it names leaked the leaks — where a creep stood decides nothing', () => {
    const before = vm([
      creep(1, { x: 2 * FP, y: 2 * FP }),
      creep(2, { x: EXIT_AT.x - 10, y: EXIT_AT.y }),
      creep(3, { x: 9 * FP, y: 9 * FP }),
      creep(4, { x: EXIT_AT.x - 40, y: EXIT_AT.y + 3 }),
      creep(5), // survives
    ]);
    // The far creep leaks and the ones beside the exit die: position does not decide it.
    const one = stepOutcome(before, [killed(2), killed(3), killed(4)], [1], ruleset);
    expect(one.leaks).toBe(1);
    expect(one.kills.map((k) => k.id)).toEqual([2, 3, 4]);
    const two = stepOutcome(before, [killed(3), killed(2)], [4, 1], ruleset);
    expect(two.leaks).toBe(2);
    expect(two.kills.map((k) => k.id)).toEqual([3, 2]);
  });

  it('calls the creep the step named the leak, not the one that began nearer the exit: a faster creep leaks while a slower one beside the exit is killed', () => {
    const before = vm([
      creep(1, { x: EXIT_AT.x - 3 * FP, y: EXIT_AT.y }), // fast: began farther out, reaches the exit
      creep(2, { x: EXIT_AT.x - 20, y: EXIT_AT.y }), // slow: began at the door, killed
    ]);
    const out = stepOutcome(before, [killed(2, { bounty: 2 })], [1], ruleset);
    expect(out.leaks).toBe(1);
    expect(out.kills).toEqual([
      {
        id: 2,
        x: EXIT_AT.x - 20,
        y: EXIT_AT.y,
        creepId: 'normal',
        domain: 'ground',
        boss: false,
        bounty: 2, // the kill pays its bounty; the leaker, which paid none, is no burst
      },
    ]);
  });

  it('counts every leak the step names whatever the view models hold — and reports no kill it does not name', () => {
    expect(stepOutcome(vm([]), [], [7, 8], ruleset)).toEqual({ kills: [], leaks: 2 });
    expect(stepOutcome(vm([creep(1)]), [], [9], ruleset)).toEqual({ kills: [], leaks: 1 });
    // A creep the view model drew and the step did not name is no kill, whatever became of it.
    expect(stepOutcome(vm([creep(1)]), [], [1, 8, 9], ruleset)).toEqual({ kills: [], leaks: 3 });
  });

  it('a kill the view model before the step never drew — a creep the step spawned and killed — shows where the step left it, in the look its catalog id gives', () => {
    const at = { x: FP / 2 + 26, y: 11 * FP + FP / 2 }; // one budget past the entrance's centre
    const before = vm([creep(1)]);
    const out = stepOutcome(
      before,
      [
        killed(7, { creepId: 'flying', ...at, bounty: 2 }),
        killed(8, { creepId: 'boss', ...at, bounty: 25 }),
        killed(9, { creepId: 'nonexistent', ...at, bounty: 0 }),
      ],
      [],
      ruleset,
    );
    expect(out.kills).toEqual([
      { id: 7, ...at, creepId: 'flying', domain: 'air', boss: false, bounty: 2 },
      { id: 8, ...at, creepId: 'boss', domain: 'ground', boss: true, bounty: 25 },
      // An id the catalog does not hold takes the view model's own fallback look.
      { id: 9, ...at, creepId: 'nonexistent', domain: 'ground', boss: false, bounty: 0 },
    ] satisfies KillVM[]);
  });
});

describe('markFlyerSparks — which flyer a targeted impact struck, by the creep its point names', () => {
  const flyer = creep(1, { creepId: 'flying', domain: 'air', x: 800, y: 900 });
  const walker = creep(2, { x: 300, y: 400 });
  const spark = (x: number, y: number, targetId?: number): StepImpactPoint =>
    targetId === undefined ? { x, y, radiusFp: 0 } : { x, y, radiusFp: 0, targetId };
  const blast = (x: number, y: number): StepImpactPoint => ({ x, y, radiusFp: 512 });

  it('marks an impact on a surviving flyer with its look; one on a creep on the ground passes through', () => {
    const out = markFlyerSparks([spark(800, 900, 1), spark(300, 400, 2)], vm([flyer, walker]), []);
    expect(out).toEqual([
      { x: 800, y: 900, radiusFp: 0, targetId: 1, flyer: { creepId: 'flying', boss: false } },
      { x: 300, y: 400, radiusFp: 0, targetId: 2 },
    ]);
  });

  it('marks an impact on a creep the step killed by that kill’s look — only if it flew — wherever its point lies', () => {
    const kills: KillVM[] = [
      { id: 3, x: 1000, y: 1000, creepId: 'armored-flyer', domain: 'air', boss: false, bounty: 1 },
      { id: 4, x: 100, y: 100, creepId: 'normal', domain: 'ground', boss: false, bounty: 1 },
    ];
    // Each point lies beside the OTHER kill: the name decides, not the distance.
    const out = markFlyerSparks([spark(110, 90, 3), spark(990, 1012, 4)], vm([]), kills);
    expect(out[0]!.flyer).toEqual({ creepId: 'armored-flyer', boss: false });
    expect(out[1]!.flyer).toBeUndefined();
    // An impact naming a creep neither standing nor killed passes through.
    expect(markFlyerSparks([spark(5, 5, 9)], vm([flyer]), kills)).toEqual([spark(5, 5, 9)]);
  });

  it('passes every impact through, the same objects in a list of its own, when no flyer stands or fell', () => {
    const points = [spark(300, 400, 2), spark(5, 5, 4), blast(800, 900)];
    const kills: KillVM[] = [
      { id: 4, x: 5, y: 5, creepId: 'normal', domain: 'ground', boss: false, bounty: 1 },
    ];
    const out = markFlyerSparks(points, vm([walker]), kills);
    expect(out).not.toBe(points);
    expect(out).toHaveLength(points.length);
    out.forEach((p, i) => expect(p).toBe(points[i]));
  });

  it('marks only the creep an impact names when a ground creep and a flyer share a point', () => {
    const grounded = creep(2, { x: 800, y: 900 });
    const flying = creep(1, { creepId: 'flying', domain: 'air', x: 800, y: 900 });
    // The impact named the ground creep: the flyer beside it is no hit.
    expect(markFlyerSparks([spark(800, 900, 2)], vm([flying, grounded]), [])[0]!.flyer).toBe(
      undefined,
    );
    // It named the flyer: marked, whichever order the two are listed in.
    for (const order of [
      [flying, grounded],
      [grounded, flying],
    ]) {
      expect(markFlyerSparks([spark(800, 900, 1)], vm(order), [])[0]!.flyer).toEqual({
        creepId: 'flying',
        boss: false,
      });
    }
    // A kill shares the point with a survivor the same way: the named one decides.
    const fell: KillVM[] = [
      { id: 6, x: 800, y: 900, creepId: 'flying', domain: 'air', boss: false, bounty: 1 },
    ];
    expect(markFlyerSparks([spark(800, 900, 2)], vm([grounded]), fell)[0]!.flyer).toBe(undefined);
    expect(markFlyerSparks([spark(800, 900, 6)], vm([grounded]), fell)[0]!.flyer).toEqual({
      creepId: 'flying',
      boss: false,
    });
  });

  it('never marks a blast’s landing, which names no creep, even at a flyer’s point, and hands back a list of its own', () => {
    const points = [blast(800, 900)];
    const out = markFlyerSparks(points, vm([flyer]), []);
    expect(out).toEqual(points);
    expect(out).not.toBe(points);
    // Beside a targeted impact on the same flyer: only the targeted one is marked.
    expect(markFlyerSparks([blast(800, 900), spark(800, 900, 1)], vm([flyer]), [])).toEqual([
      blast(800, 900),
      { ...spark(800, 900, 1), flyer: { creepId: 'flying', boss: false } },
    ]);
  });
});

describe('noteTowerless — the shots in flight whose tower the step took away', () => {
  const basic = tower(1, 'basic', 2, 2); // footprint centre (3, 3) cells
  const slow = tower(2, 'slow', 6, 2);
  const from = (t: TowerVM, launchTick = 5): TracerVM => ({
    kind: 'targeted',
    originX: (t.col + 1) * FP,
    originY: (t.row + 1) * FP,
    targetId: 9,
    launchTick,
    impactTick: launchTick + 4,
  });

  it('gives a shot whose tower was sold that tower’s id — and leaves every other shot as it was, the same objects', () => {
    const a = from(basic);
    const b = from(slow);
    const out = noteTowerless([a, b], vm([], [basic, slow]), vm([], [slow]));
    expect(out).toEqual([{ ...a, towerId: 'basic' }, b]);
    expect(out[1]).toBe(b);
  });

  it('names the tower that fired, not one built on its footprint since', () => {
    const rebuilt = tower(7, 'splash', 2, 2);
    const a = from(basic);
    expect(noteTowerless([a], vm([], [basic]), vm([], [rebuilt]))).toEqual([
      { ...a, towerId: 'basic' },
    ]);
  });

  it('hands back the very list when no shot lost its tower — and an empty one as it is', () => {
    const shots = [from(basic), from(slow)];
    expect(noteTowerless(shots, vm([], [basic, slow]), vm([], [basic, slow]))).toBe(shots);
    const none: TracerVM[] = [];
    expect(noteTowerless(none, vm([], [basic]), vm([], []))).toBe(none);
  });

  it('keeps an id a shot already carries, leaves a mine’s detonation and a shot from no tower alone', () => {
    const named: TracerVM = { ...from(basic), towerId: 'venom' };
    const mine = tower(3, 'mine', 10, 10);
    const detonation: TracerVM = {
      kind: 'blast',
      originX: 11 * FP,
      originY: 11 * FP,
      destX: 11 * FP,
      destY: 11 * FP,
      launchTick: 5,
      impactTick: 5,
    };
    const stray: TracerVM = { ...from(basic), originX: 3 * FP + 1 };
    const shots = [named, detonation, stray];
    expect(noteTowerless(shots, vm([], [basic, mine]), vm([], []))).toBe(shots);
  });
});

describe('stepOutcome / markFlyerSparks — what the attribution tests above could not tell apart', () => {
  it('a targeted impact on a surviving flyer is that flyer’s, whatever else the step killed', () => {
    const flyer = creep(1, { creepId: 'flying', domain: 'air', x: 800, y: 900 });
    const kills: KillVM[] = [
      { id: 4, x: 100, y: 100, creepId: 'normal', domain: 'ground', boss: false, bounty: 1 },
    ];
    const [out] = markFlyerSparks(
      [{ x: 800, y: 900, radiusFp: 0, targetId: 1 }],
      vm([flyer]),
      kills,
    );
    expect(out!.flyer).toEqual({ creepId: 'flying', boss: false });
  });

  it('a flyer and a ground creep killed on one tick by targeted impacts, after moving different distances: each spark takes its own creep’s look (Codex, PR #189)', () => {
    // A flyer (30 fp a tick) just behind a fast walker (44): each impact strikes its creep where
    // the step moved it, which puts the flyer's point nearer where the WALKER was drawn.
    const before = vm([
      creep(1, { creepId: 'flying', domain: 'air', x: 1000, y: 900 }),
      creep(2, { creepId: 'fast', x: 1040, y: 900 }),
    ]);
    const onFlyer = { x: 1000 + 30, y: 900 };
    const onWalker = { x: 1040 + 44, y: 900 };
    const { kills } = stepOutcome(
      before,
      [
        killed(1, { creepId: 'flying', ...onFlyer, bounty: 2 }),
        killed(2, { creepId: 'fast', ...onWalker, bounty: 2 }),
      ],
      [],
      ruleset,
    );
    const d2 = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    expect(
      d2(onFlyer, kills[1]!),
      'the premise: the flyer’s point lies nearer where the walker was drawn',
    ).toBeLessThan(d2(onFlyer, kills[0]!));
    const sparks = markFlyerSparks(
      [
        { ...onFlyer, radiusFp: 0, targetId: 1 },
        { ...onWalker, radiusFp: 0, targetId: 2 },
      ],
      vm([]),
      kills,
    );
    expect(sparks.map((s) => s.flyer)).toEqual([{ creepId: 'flying', boss: false }, undefined]);
  });
});
