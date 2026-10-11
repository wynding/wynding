// combat-events.test.ts — what one sim step did that the board shows as combat feedback (#181
// C1/C2), read from data the controller already holds: which vanished creeps were kills and
// which leaks (the sim's own leak count, nearest the exit), each kill's look, position and
// bounty; which flyer a targeted impact struck; and which shots in flight lost their tower.

import { describe, it, expect } from 'vitest';
import type { CreepVM, KillVM, RenderVM, SparkPoint, TowerVM, TracerVM } from '@wynding/render';
import type { SimState } from '@wynding/sim';
import { dueTargets, markFlyerSparks, noteTowerless, stepOutcome } from './combat-events';

const FP = 256;
/** The exit cell in these steps, and its centre in fixed-point units. */
const EXIT = { col: 20, row: 10 } as const;
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

/** Every creep pays its id in bounty. */
const bountyIsId = (id: number): number => id;

describe('stepOutcome — the kills and leaks of one step', () => {
  it('a creep the step removed, with no leak counted, is a kill: its look, where it stood as the step began, and its bounty', () => {
    const before = vm([
      creep(1),
      creep(2, { creepId: 'armored-flyer', domain: 'air', boss: true, x: 7 * FP, y: 3 * FP }),
    ]);
    const after = vm([creep(1)]);
    expect(stepOutcome(before, after, 0, EXIT, bountyIsId)).toEqual({
      kills: [
        {
          id: 2,
          x: 7 * FP,
          y: 3 * FP,
          creepId: 'armored-flyer',
          domain: 'air',
          boss: true,
          bounty: 2,
        },
      ] satisfies KillVM[],
      leaks: 0,
    });
  });

  it('takes the sim’s leak count as exact: the vanished creeps nearest the exit are the leaks, the rest the kills, in view-model order', () => {
    const before = vm([
      creep(1, { x: 2 * FP, y: 2 * FP }), // far from the exit
      creep(2, { x: EXIT_AT.x - 10, y: EXIT_AT.y }), // at the exit
      creep(3, { x: 9 * FP, y: 9 * FP }),
      creep(4, { x: EXIT_AT.x - 40, y: EXIT_AT.y + 3 }), // next to it
      creep(5), // survives
    ]);
    const after = vm([creep(5)]);
    const one = stepOutcome(before, after, 1, EXIT, bountyIsId);
    expect(one.leaks).toBe(1);
    expect(one.kills.map((k) => k.id)).toEqual([1, 3, 4]);
    const two = stepOutcome(before, after, 2, EXIT, bountyIsId);
    expect(two.leaks).toBe(2);
    expect(two.kills.map((k) => k.id)).toEqual([1, 3]);
  });

  it('breaks a tie in distance by view-model order: the first is the leak', () => {
    const before = vm([
      creep(1, { x: EXIT_AT.x - 64, y: EXIT_AT.y }),
      creep(2, { x: EXIT_AT.x + 64, y: EXIT_AT.y }),
    ]);
    expect(stepOutcome(before, vm([]), 1, EXIT, bountyIsId).kills.map((k) => k.id)).toEqual([2]);
  });

  it('counts every leak even when no creep it knows vanished — and reports no kill', () => {
    expect(stepOutcome(vm([]), vm([]), 2, EXIT, bountyIsId)).toEqual({ kills: [], leaks: 2 });
    expect(stepOutcome(vm([creep(1)]), vm([creep(1)]), 1, EXIT, bountyIsId)).toEqual({
      kills: [],
      leaks: 1,
    });
    // More leaks than creeps vanished: every one of them leaked.
    expect(stepOutcome(vm([creep(1)]), vm([]), 3, EXIT, bountyIsId)).toEqual({
      kills: [],
      leaks: 3,
    });
  });

  it('reads no leak from a counter that did not rise by a whole number', () => {
    for (const leaked of [0, -1, 0.5, NaN, Infinity]) {
      expect(stepOutcome(vm([creep(1)]), vm([]), leaked, EXIT, bountyIsId), String(leaked)).toEqual(
        expect.objectContaining({ leaks: 0 }),
      );
    }
  });

  it('finds the same vanished creeps whether or not the view models list them in rising id order', () => {
    // As the sim lists them: rising ids, a spawn (7) appended after the survivors.
    const before = vm([1, 2, 3, 4, 5, 6].map((id) => creep(id, { x: id * FP })));
    const after = vm([creep(2, { x: 2 * FP }), creep(5, { x: 5 * FP }), creep(7)]);
    expect(stepOutcome(before, after, 0, EXIT, bountyIsId).kills.map((k) => k.id)).toEqual([
      1, 3, 4, 6,
    ]);
    // Out of order — a forged state's — the same creeps vanished, reported in `before`'s order.
    const shuffled = (v: RenderVM): RenderVM => vm([...v.creeps].reverse());
    expect(
      stepOutcome(shuffled(before), shuffled(after), 0, EXIT, bountyIsId).kills.map((k) => k.id),
    ).toEqual([6, 4, 3, 1]);
    // Nothing vanished, with and without a spawn: no kill.
    expect(stepOutcome(before, before, 0, EXIT, bountyIsId).kills).toEqual([]);
    expect(
      stepOutcome(before, vm([...before.creeps, creep(9)]), 0, EXIT, bountyIsId).kills,
    ).toEqual([]);
  });

  it('credits a kill the bounty its creep’s column held — and 0 for a value the sweep would not credit', () => {
    const before = vm([creep(1), creep(2), creep(3), creep(4)]);
    const bounty = (id: number): number => [0, 7, -2, 1.5, NaN][id] as number;
    expect(stepOutcome(before, vm([]), 0, EXIT, bounty).kills.map((k) => k.bounty)).toEqual([
      7, 0, 0, 0,
    ]);
  });
});

describe('markFlyerSparks — which flyer a targeted impact struck', () => {
  const flyer = creep(1, { creepId: 'flying', domain: 'air', x: 800, y: 900 });
  const walker = creep(2, { x: 300, y: 400 });
  const spark = (x: number, y: number, radiusFp = 0): SparkPoint => ({ x, y, radiusFp });

  it('marks an impact at a surviving flyer’s point with its look; one at a creep on the ground passes through', () => {
    const out = markFlyerSparks(
      [spark(800, 900), spark(300, 400)],
      vm([flyer, walker]),
      [],
      new Set([1, 2]),
    );
    expect(out).toEqual([
      { x: 800, y: 900, radiusFp: 0, flyer: { creepId: 'flying', boss: false } },
      { x: 300, y: 400, radiusFp: 0 },
    ]);
  });

  it('takes an impact that matches no survivor for the kill nearest it — marked only if that one flew', () => {
    const kills: KillVM[] = [
      { id: 3, x: 1000, y: 1000, creepId: 'armored-flyer', domain: 'air', boss: false, bounty: 1 },
      { id: 4, x: 100, y: 100, creepId: 'normal', domain: 'ground', boss: false, bounty: 1 },
    ];
    const out = markFlyerSparks([spark(990, 1012), spark(120, 90)], vm([]), kills, new Set([3, 4]));
    expect(out[0]!.flyer).toEqual({ creepId: 'armored-flyer', boss: false });
    expect(out[1]!.flyer).toBeUndefined();
    // With nothing to match, it passes through.
    expect(markFlyerSparks([spark(5, 5)], vm([]), [], new Set([1]))).toEqual([spark(5, 5)]);
  });

  it('passes every impact through, in a list of its own, when no flyer stands or fell', () => {
    const points = [spark(300, 400), spark(5, 5), spark(800, 900, 512)];
    const kills: KillVM[] = [
      { id: 4, x: 5, y: 5, creepId: 'normal', domain: 'ground', boss: false, bounty: 1 },
    ];
    const out = markFlyerSparks(points, vm([walker]), kills, new Set([2, 4]));
    expect(out).not.toBe(points);
    expect(out).toHaveLength(points.length);
    out.forEach((p, i) => expect(p).toBe(points[i]));
  });

  it('marks only the creep an impact names when a ground creep and a flyer share a point', () => {
    const grounded = creep(2, { x: 800, y: 900 });
    const flying = creep(1, { creepId: 'flying', domain: 'air', x: 800, y: 900 });
    const points = [spark(800, 900)];
    // The impact named the ground creep: the flyer beside it is no hit.
    expect(markFlyerSparks(points, vm([flying, grounded]), [], new Set([2]))[0]!.flyer).toBe(
      undefined,
    );
    // It named the flyer: marked, whichever order the two are listed in.
    for (const order of [
      [flying, grounded],
      [grounded, flying],
    ]) {
      expect(markFlyerSparks(points, vm(order), [], new Set([1]))[0]!.flyer).toEqual({
        creepId: 'flying',
        boss: false,
      });
    }
    // A kill shares the point with a survivor the same way: the struck one decides.
    const fell: KillVM[] = [
      { id: 6, x: 800, y: 900, creepId: 'flying', domain: 'air', boss: false, bounty: 1 },
    ];
    expect(markFlyerSparks(points, vm([]), fell, new Set([7]))[0]!.flyer).toBe(undefined);
    expect(markFlyerSparks(points, vm([]), fell, new Set([6]))[0]!.flyer).toBeDefined();
  });

  it('never marks a blast’s landing, even at a flyer’s point, and hands back a list of its own', () => {
    const points = [spark(800, 900, 512)];
    const out = markFlyerSparks(points, vm([flyer]), [], new Set([1]));
    expect(out).toEqual(points);
    expect(out).not.toBe(points);
    // Beside a targeted impact on the same flyer: only the targeted one is marked.
    expect(
      markFlyerSparks([spark(800, 900, 512), spark(800, 900)], vm([flyer]), [], new Set([1])),
    ).toEqual([
      spark(800, 900, 512),
      { ...spark(800, 900), flyer: { creepId: 'flying', boss: false } },
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
  it('measures nearness to the exit in both axes: a creep in the exit’s row or column but cells away is no leak beside one at its door', () => {
    const inColumn = vm([
      creep(1, { x: EXIT_AT.x, y: EXIT_AT.y - 6 * FP }), // the exit's own column, six cells up
      creep(2, { x: EXIT_AT.x - 20, y: EXIT_AT.y }), // at the door
    ]);
    expect(stepOutcome(inColumn, vm([]), 1, EXIT, bountyIsId).kills.map((k) => k.id)).toEqual([1]);
    const inRow = vm([
      creep(3, { x: EXIT_AT.x - 6 * FP, y: EXIT_AT.y }), // the exit's own row, six cells back
      creep(4, { x: EXIT_AT.x, y: EXIT_AT.y + 20 }), // at the door
    ]);
    expect(stepOutcome(inRow, vm([]), 1, EXIT, bountyIsId).kills.map((k) => k.id)).toEqual([3]);
  });

  it('a targeted impact at a surviving flyer’s point is that flyer’s, whatever else the step killed', () => {
    const flyer = creep(1, { creepId: 'flying', domain: 'air', x: 800, y: 900 });
    const kills: KillVM[] = [
      { id: 4, x: 100, y: 100, creepId: 'normal', domain: 'ground', boss: false, bounty: 1 },
    ];
    const [out] = markFlyerSparks(
      [{ x: 800, y: 900, radiusFp: 0 }],
      vm([flyer]),
      kills,
      new Set([1, 4]),
    );
    expect(out!.flyer).toEqual({ creepId: 'flying', boss: false });
  });

  it('tells apart two creeps whose coordinates sum alike: an impact on the walker is no flyer’s', () => {
    const walker = creep(5, { x: 900, y: 800 });
    const flyer = creep(1, { creepId: 'flying', domain: 'air', x: 800, y: 900 });
    const [out] = markFlyerSparks(
      [{ x: 900, y: 800, radiusFp: 0 }],
      vm([walker, flyer]),
      [],
      new Set([5]),
    );
    expect(out!.flyer).toBeUndefined();
  });
});

describe('dueTargets — the creeps the next step strikes (C2)', () => {
  type Impact = SimState['impacts'][number];
  const effects = [{ kind: 'direct', amount: 1 }] as const;
  const targeted = (targetId: number, impactTick: number): Impact => ({
    kind: 'targeted',
    impactTick,
    targetId,
    sourceId: 90,
    domain: 'both',
    effects: [...effects],
  });
  const blast = (impactTick: number): Impact => ({
    kind: 'blast',
    impactTick,
    x: 512,
    y: 512,
    radiusFp: 384,
    sourceId: 91,
    domain: 'ground',
    effects: [...effects],
  });

  it('names the target of each targeted impact due by the tick, one overdue too — none still in flight, and no blast', () => {
    const impacts = [
      targeted(1, 9),
      targeted(2, 10),
      targeted(3, 11),
      targeted(4, 12),
      targeted(2, 13),
      blast(10),
    ];
    expect(dueTargets({ tick: 10, impacts })).toEqual(new Set([1, 2]));
    expect(dueTargets({ tick: 11, impacts })).toEqual(new Set([1, 2, 3]));
    expect(dueTargets({ tick: 8, impacts })).toEqual(new Set());
    expect(dueTargets({ tick: 10, impacts: [] })).toEqual(new Set());
  });
});
