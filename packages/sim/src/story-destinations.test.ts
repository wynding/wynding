// story-destinations.test.ts — M3 story 3: entrances, exits and destinations (ADR 0015).
//
// A small two-pair CROSSING fixture board, like M3's but 12 × 10: west (0,4) → east
// (11,4) and north (5,0) → south (5,9), the routes crossing at (5,4). The done-criteria
// this file proves, each against the real `step()`/`runCombat` (no mocks):
//
//   - the board runs deterministically (same inputs → same world-hash trace, and a
//     mid-run JSON round-trip resumes byte-identically);
//   - a creep spawns at its entry's entrance and keeps that entrance's destination;
//     same-tick spawn order is still table-row order, never entrance order;
//   - a build sealing EITHER route is rejected, and the invariant is PER DESTINATION —
//     a build that splits the board but leaves every entrance and live ground creep a
//     way to its OWN exit is accepted;
//   - a creep never leaks at another pair's exit — it walks through it as an ordinary
//     cell — and every leak happens at the leaking creep's own exit;
//   - "first" targeting compares creeps on different routes by their OWN remaining
//     distance (ground: their own field; air: straight line to their own exit), and a
//     cadenced AoE's lead clamps at the target's own exit;
//   - a flyer heads for its own exit, not another pair's;
//   - a forged destination index is dropped like any other unattributable row;
//   - the wave preview's streams aggregate per (creep, entrance), and the compiled wave
//     carries its `hpPercent`;
//   - `step` rebuilds EVERY destination's field on a maze change — a placement, a sell,
//     a mine consuming itself — so each creep follows its own route, live;
//   - on a THREE-entrance, two-destination board (two entrances share an exit, so an
//     entrance's index is not its destination's), spawning, the invariant and the
//     spawn lookup all go through the entrance's destination, never its index;
//   - a real creep walled into a pocket is protected even while its entrance still
//     reaches its exit, and a flyer crossing another pair's exit does not leak there.

import { describe, it, expect } from 'vitest';
import type { Cell, CreepDef, Ruleset, TowerDef } from '@wynding/types';
import {
  createInitialState,
  step,
  previewInputs,
  hashSimState,
  type SimInput,
  type SimState,
} from './index';
import { compileRuleset, type CompiledRuleset } from './ruleset';
import { computeDistanceField, isReachable, type DistanceField } from './pathfinding';
import { canPlaceTower, materializeTowerMask, type TowerArrays } from './tower';
import { runCombat, emptyCreeps, type CombatCreeps, type StepEvents } from './combat';
import { deriveValidCreepPosition, firstDescentNeighbor } from './movement';
import { entranceSpawn } from './context';
import { GridError } from './board';
import {
  TEST_TOWER,
  TEST_AOE_TOWER,
  TEST_BURST_TOWER,
  TEST_RNG_SEED,
  pushCreep,
} from './test-support';
import { Rng } from '@wynding/engine';

const cx = (col: number): number => col * 256 + 128;
const cy = (row: number): number => row * 256 + 128;

const WEST = { col: 0, row: 4 } as const;
const EAST = { col: 11, row: 4 } as const;
const NORTH = { col: 5, row: 0 } as const;
const SOUTH = { col: 5, row: 9 } as const;

const NORMAL: CreepDef = {
  id: 'normal',
  hp: 20,
  speedFp: 26,
  armor: 0,
  domain: 'ground',
  immunities: [],
  leakCost: 1,
  bounty: 1,
};
const FLYER: CreepDef = { ...NORMAL, id: 'flyer', domain: 'air' };
const BOTH_TOWER: TowerDef = {
  ...TEST_TOWER,
  id: 'both',
  attack: { ...TEST_TOWER.attack!, domain: 'both' },
};

type Entry = Ruleset['boards'][number]['waves'][number]['entries'][number];

/** The crossing fixture bundle: entrance `west` → exit `east`, entrance `north` → exit
 *  `south` — so `board.fields` is [east, south] (first use over the entrances) and a
 *  west creep carries destination 0, a north creep destination 1. */
function crossingBundle(
  entries: readonly Entry[],
  opts: { readonly creepHp?: number; readonly towers?: readonly TowerDef[] } = {},
): Ruleset {
  const hp = opts.creepHp ?? NORMAL.hp;
  return {
    formatVersion: 3,
    rulesetId: 'crossing-fixture',
    version: 1,
    creepCatalog: [
      { ...NORMAL, hp },
      { ...FLYER, hp },
    ],
    // Overridable: a catalog with a mine cannot also carry the aoe tower (one blast
    // radius per catalog — the radius-uniform capability gate).
    towerCatalog: [...(opts.towers ?? [TEST_TOWER, TEST_AOE_TOWER, BOTH_TOWER])],
    balance: {
      startingLives: 20,
      startingBounty: 200,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 0,
    },
    scoring: { survivalMul: 25, starThresholds: [1, 12, 18], earlyCallScoreDivisor: 0 },
    boards: [
      {
        id: 'crossing',
        widthTiles: 12,
        heightTiles: 10,
        entrances: [
          { id: 'west', cell: WEST, destination: ['east'] },
          { id: 'north', cell: NORTH, destination: ['south'] },
        ],
        exits: [
          { id: 'east', cell: EAST },
          { id: 'south', cell: SOUTH },
        ],
        waves: [{ index: 0, countdownTicks: 10, clearBonus: 0, hpPercent: 100, entries }],
      },
    ],
  };
}

const BOTH_STREAMS: readonly Entry[] = [
  { creepId: 'normal', entrance: 'west', count: 4, spacingTicks: 15 },
  { creepId: 'normal', entrance: 'north', count: 4, spacingTicks: 15, offsetTicks: 5 },
];
const RULESET = compileRuleset(crossingBundle(BOTH_STREAMS), 'crossing');
const EAST_FIELD = 0;
const SOUTH_FIELD = 1;

const place = (col: number, row: number, towerId = 'basic'): SimInput => ({
  kind: 'placeTower',
  anchor: { col, row },
  towerId,
});

/** Step `state` until terminal or `cap` ticks, collecting leaks and the head cell each
 *  creep had on the tick before it vanished (a leaking creep's head IS the exit it is
 *  walking into). */
function runToEnd(
  ruleset: CompiledRuleset,
  state: SimState,
  cap = 3_000,
  inputs: (tick: number) => SimInput[] = () => [],
): {
  state: SimState;
  leaks: { id: number; destination: number; lastHead: { col: number; row: number } }[];
  trace: string[];
} {
  const lastSeen = new Map<number, { destination: number; col: number; row: number }>();
  const leaks: { id: number; destination: number; lastHead: { col: number; row: number } }[] = [];
  const trace: string[] = [];
  for (let t = 0; t < cap && state.phase === 'running'; t++) {
    const events: StepEvents = { impactPoints: [], fired: [], leaked: [] };
    step(state, ruleset, inputs(state.tick), events);
    for (const id of events.leaked!) {
      const seen = lastSeen.get(id)!;
      leaks.push({ id, destination: seen.destination, lastHead: { col: seen.col, row: seen.row } });
    }
    for (let i = 0; i < state.creeps.id.length; i++) {
      lastSeen.set(state.creeps.id[i]!, {
        destination: state.creeps.destination[i]!,
        col: state.creeps.headCol[i]!,
        row: state.creeps.headRow[i]!,
      });
    }
    trace.push(hashSimState(state));
  }
  return { state, leaks, trace };
}

describe('M3 story 3 — the two-pair crossing board compiles into one field per destination', () => {
  it('builds [east, south] in first-use order and maps west → 0, north → 1', () => {
    expect(RULESET.board.fields.map((f) => f.exit)).toEqual([EAST, SOUTH]);
    expect(RULESET.board.entranceDestination).toEqual([EAST_FIELD, SOUTH_FIELD]);
    expect(RULESET.board.grid.entrances).toEqual([WEST, NORTH]);
    // Every spawn carries its entry's entrance index, and the entrance is NOT a sort key:
    // the two streams interleave by (offset, table row) exactly as before.
    const spawns = RULESET.waves[0]!.spawns;
    expect(spawns.map((s) => [s.offsetTicks, s.entrance])).toEqual([
      [0, 0],
      [5, 1],
      [15, 0],
      [20, 1],
      [30, 0],
      [35, 1],
      [45, 0],
      [50, 1],
    ]);
  });

  it('rejects a board whose entrance cannot reach its own destination at compile time', () => {
    // North's destination moved to an exit boxed into a corner the north entrance can
    // never reach: (0,9)'s only interior neighbour is a corner-cut diagonal.
    const b = JSON.parse(JSON.stringify(crossingBundle(BOTH_STREAMS))) as Ruleset;
    (b.boards[0]!.exits[1] as { cell: { col: number; row: number } }).cell = { col: 0, row: 9 };
    expect(() => compileRuleset(b, 'crossing')).toThrow(/cannot reach its destination exit/);
  });
});

describe('spawning at the named entrance, keeping its destination', () => {
  it('spawns each stream at its own entrance centre with that entrance’s destination, for life', () => {
    const s = createInitialState(1, RULESET);
    step(s, RULESET, [{ kind: 'callWaveEarly' }]); // tick 0: launch + the first west creep
    // Its spawn tick's movement has started it along its first edge (26 fp of 256), so
    // its segment still STARTS at the entrance centre.
    expect(s.creeps.destination).toEqual([EAST_FIELD]);
    expect([s.creeps.fromX[0], s.creeps.fromY[0]]).toEqual([cx(WEST.col), cy(WEST.row)]);
    for (let t = 0; t < 5; t++) step(s, RULESET, []); // tick 5: the first north creep
    expect(s.creeps.destination).toEqual([EAST_FIELD, SOUTH_FIELD]);
    expect([s.creeps.fromX[1], s.creeps.fromY[1]]).toEqual([cx(NORTH.col), cy(NORTH.row)]);

    // Over the whole run, a creep's destination never changes from the one it spawned
    // with — and north creeps (even ids here, spawned second each pair) are the south-bound.
    const first = new Map<number, number>();
    for (let t = 0; t < 2_000 && s.phase === 'running'; t++) {
      step(s, RULESET, t === 3 ? [place(4, 3)] : []);
      s.creeps.id.forEach((id, i) => {
        const d = s.creeps.destination[i]!;
        if (!first.has(id)) first.set(id, d);
        expect(d).toBe(first.get(id));
      });
    }
    expect(first.size).toBe(8);
    expect([...first.values()].filter((d) => d === SOUTH_FIELD)).toHaveLength(4);
  });

  it('keeps same-tick spawn order by table row, not by entrance', () => {
    // North is table row 0, west row 1, both at offset 0: north spawns first (lower id),
    // even though west is entrance 0.
    const r = compileRuleset(
      crossingBundle([
        { creepId: 'normal', entrance: 'north', count: 1, spacingTicks: 5 },
        { creepId: 'normal', entrance: 'west', count: 1, spacingTicks: 5 },
      ]),
      'crossing',
    );
    const s = createInitialState(1, r);
    step(s, r, [{ kind: 'callWaveEarly' }]);
    expect(s.creeps.id).toEqual([1, 2]);
    expect(s.creeps.destination).toEqual([SOUTH_FIELD, EAST_FIELD]);
  });
});

describe('determinism on the two-pair board', () => {
  const inputs = (tick: number): SimInput[] => {
    if (tick === 0) return [{ kind: 'callWaveEarly' }];
    // A tower ON the crossing re-routes BOTH streams at once.
    if (tick === 8) return [place(4, 3)];
    if (tick === 30) return [place(7, 5, 'aoe')];
    return [];
  };

  it('reproduces the same world-hash trace from the same inputs', () => {
    const a = runToEnd(RULESET, createInitialState(42, RULESET), 3_000, inputs);
    const b = runToEnd(RULESET, createInitialState(42, RULESET), 3_000, inputs);
    expect(a.trace.length).toBeGreaterThan(50);
    expect(a.trace).toEqual(b.trace);
    expect(a.state.phase).not.toBe('running');
  });

  it('resumes byte-identically from a mid-run JSON round-trip', () => {
    const live = createInitialState(42, RULESET);
    for (let t = 0; t < 40; t++) step(live, RULESET, inputs(t));
    expect(live.creeps.destination).toContain(EAST_FIELD);
    expect(live.creeps.destination).toContain(SOUTH_FIELD);
    const restored = JSON.parse(JSON.stringify(live)) as SimState;
    const ref = runToEnd(RULESET, live, 3_000, inputs);
    const resumed = runToEnd(RULESET, restored, 3_000, inputs);
    expect(resumed.trace).toEqual(ref.trace);
  });
});

describe('leaking only at a creep’s own exit', () => {
  it('every creep of both streams leaks at its own pair’s exit, a tower at the crossing notwithstanding', () => {
    // Creeps too tough for the crossing tower to kill, so every one of the 8 reaches an exit.
    const tough = compileRuleset(crossingBundle(BOTH_STREAMS, { creepHp: 1_000_000 }), 'crossing');
    const s = createInitialState(7, tough);
    const { leaks, state } = runToEnd(tough, s, 3_000, (t) =>
      t === 0 ? [{ kind: 'callWaveEarly' }] : t === 8 ? [place(4, 3)] : [],
    );
    expect(state.towers.id).toHaveLength(1); // the crossing tower stood
    expect(leaks).toHaveLength(8);
    for (const leak of leaks) {
      expect(leak.lastHead).toEqual(leak.destination === EAST_FIELD ? EAST : SOUTH);
    }
    expect(leaks.filter((l) => l.destination === EAST_FIELD)).toHaveLength(4);
    expect(state.lives).toBe(20 - 8);
  });

  it('a creep standing ON another pair’s exit walks through it and leaks only at its own', () => {
    // A north-pair creep (destination south) resting exactly on the EAST exit centre —
    // the cell that would leak a west creep instantly.
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 50, hp: 100, col: EAST.col, row: EAST.row, destination: SOUTH_FIELD });
    const lives = s.lives;
    step(s, RULESET, []);
    expect(s.creeps.id).toEqual([50]); // still in play — not leaked, not dropped
    expect(s.lives).toBe(lives);
    // (The fixture's own wave launches meanwhile; only creep 50's leaks matter here.)
    const { leaks } = runToEnd(RULESET, s, 1_000);
    expect(leaks.filter((l) => l.id === 50)).toEqual([
      { id: 50, destination: SOUTH_FIELD, lastHead: SOUTH },
    ]);

    // And the mirror: a west-pair creep on the SOUTH exit leaks at east.
    const t = createInitialState(1, RULESET);
    pushCreep(t, { id: 51, hp: 100, col: SOUTH.col, row: SOUTH.row, destination: EAST_FIELD });
    step(t, RULESET, []);
    expect(t.creeps.id).toEqual([51]);
    expect(runToEnd(RULESET, t, 1_000).leaks.filter((l) => l.id === 51)).toEqual([
      { id: 51, destination: EAST_FIELD, lastHead: EAST },
    ]);
  });

  it('a flyer heads for its OWN exit: a north flyer leaks south, a west flyer east', () => {
    const r = compileRuleset(
      crossingBundle([
        { creepId: 'flyer', entrance: 'north', count: 1, spacingTicks: 5 },
        { creepId: 'flyer', entrance: 'west', count: 1, spacingTicks: 5 },
      ]),
      'crossing',
    );
    const { leaks } = runToEnd(
      r,
      createInitialState(1, r),
      2_000,
      (t) => (t === 0 ? [{ kind: 'callWaveEarly' }, place(4, 3)] : []), // flyers ignore it
    );
    expect(leaks.map(({ destination, lastHead }) => ({ destination, lastHead }))).toEqual([
      { destination: SOUTH_FIELD, lastHead: SOUTH }, // the north flyer: straight down col 5
      { destination: EAST_FIELD, lastHead: EAST }, // the west flyer: straight along row 4
    ]);
  });
});

describe('the maze invariant, per destination', () => {
  /** Place `anchors` one per tick from a fresh state; return how many stood. */
  function buildAll(ruleset: CompiledRuleset, anchors: readonly [number, number][]): SimState {
    const s = createInitialState(1, ruleset);
    for (const [c, r] of anchors) step(s, ruleset, [place(c, r)]);
    return s;
  }
  const accepts = (s: SimState, ruleset: CompiledRuleset, c: number, r: number): boolean =>
    previewInputs(s, ruleset, [place(c, r)]).accepted[0]!;

  it('rejects the build that would seal the west → east route, while north → south stays open', () => {
    // A 2-wide wall down cols 8-9, rows 1-8; the fourth tower closes it.
    const s = buildAll(RULESET, [
      [8, 1],
      [8, 3],
      [8, 7],
    ]);
    expect(s.towers.id).toHaveLength(3);
    expect(accepts(s, RULESET, 8, 5)).toBe(false);
    // A tower elsewhere lengthens without sealing, and is accepted.
    expect(accepts(s, RULESET, 6, 1)).toBe(true);
  });

  it('rejects the build that would seal the north → south route, while west → east stays open', () => {
    // A 2-tall wall across rows 7-8, cols 1-10; the fifth tower closes it.
    const s = buildAll(RULESET, [
      [1, 7],
      [3, 7],
      [7, 7],
      [9, 7],
    ]);
    expect(s.towers.id).toHaveLength(4);
    expect(accepts(s, RULESET, 5, 7)).toBe(false);
  });

  // Two PARALLEL pairs (12 × 7): top (0,1) → (11,1), bottom (0,5) → (11,5). A wall across
  // rows 3-4 splits the board in two, and each pair keeps its own half — so the split is
  // LEGAL. A one-destination invariant ("every entrance reaches every exit", or every
  // creep checked against one field) would wrongly reject the last tower.
  const PARALLEL = compileRuleset(
    {
      ...crossingBundle([{ creepId: 'normal', entrance: 'top', count: 1, spacingTicks: 5 }]),
      boards: [
        {
          id: 'parallel',
          widthTiles: 12,
          heightTiles: 7,
          entrances: [
            { id: 'top', cell: { col: 0, row: 1 }, destination: ['top-out'] },
            { id: 'bottom', cell: { col: 0, row: 5 }, destination: ['bottom-out'] },
          ],
          exits: [
            { id: 'top-out', cell: { col: 11, row: 1 } },
            { id: 'bottom-out', cell: { col: 11, row: 5 } },
          ],
          waves: [
            {
              index: 0,
              countdownTicks: 10,
              clearBonus: 0,
              hpPercent: 100,
              entries: [{ creepId: 'normal', entrance: 'top', count: 1, spacingTicks: 5 }],
            },
          ],
        },
      ],
    },
    'parallel',
  );
  const SPLIT: [number, number][] = [
    [1, 3],
    [3, 3],
    [5, 3],
    [7, 3],
  ];

  it('accepts a build that splits the board when every entrance keeps its OWN exit', () => {
    const s = buildAll(PARALLEL, SPLIT);
    expect(s.towers.id).toHaveLength(4);
    expect(accepts(s, PARALLEL, 9, 3)).toBe(true);
  });

  it('checks each live ground creep against its OWN destination', () => {
    // A bottom-pair creep in the bottom half still reaches its exit after the split…
    const ok = buildAll(PARALLEL, SPLIT);
    pushCreep(ok, { id: 90, hp: 100, col: 3, row: 5, destination: 1 });
    expect(accepts(ok, PARALLEL, 9, 3)).toBe(true);
    // …but a TOP-pair creep that wandered into the bottom half would be stranded.
    const stranded = buildAll(PARALLEL, SPLIT);
    pushCreep(stranded, { id: 91, hp: 100, col: 3, row: 5, destination: 0 });
    expect(accepts(stranded, PARALLEL, 9, 3)).toBe(false);
    // A flyer never constrains the invariant, whichever half it is over.
    const flying = buildAll(PARALLEL, SPLIT);
    pushCreep(flying, { id: 92, hp: 100, col: 3, row: 5, destination: 0, creepId: 'flyer' });
    expect(accepts(flying, PARALLEL, 9, 3)).toBe(true);
  });
});

describe('"first" targeting and the AoE lead, measured against each creep’s OWN destination', () => {
  const GRID = RULESET.board.grid;

  /** One tower of `towerId` at `anchor`, ready to fire. */
  function towerAt(towerId: string, col: number, row: number): TowerArrays {
    return {
      id: [100],
      col: [col],
      row: [row],
      spend: [RULESET.towerById[towerId]!.cost],
      targetId: [0],
      nextFireTick: [0],
      towerId: [towerId],
    };
  }

  /** The board's [east, south] fields under `towers` — what `step()` would derive. */
  function fieldsUnder(towers: TowerArrays): DistanceField[] {
    const mask = materializeTowerMask(GRID, towers, RULESET.towerById);
    return [computeDistanceField(GRID, EAST, mask), computeDistanceField(GRID, SOUTH, mask)];
  }

  function creeps(
    rows: readonly { id: number; col: number; row: number; dest: number; creepId?: string }[],
    speed = 26,
  ): CombatCreeps {
    const c = emptyCreeps();
    for (const r of rows) {
      c.id.push(r.id);
      c.hp.push(100);
      c.bounty.push(1);
      c.speed.push(speed);
      c.fromX.push(cx(r.col));
      c.fromY.push(cy(r.row));
      c.headCol.push(r.col);
      c.headRow.push(r.row);
      c.progress.push(0);
      c.wave.push(0);
      c.creepId.push(r.creepId ?? 'normal');
      c.slowMulFp.push(0);
      c.slowUntilTick.push(0);
      c.stunUntilTick.push(0);
      c.destination.push(r.dest);
    }
    return c;
  }

  const fire = (c: CombatCreeps, t: TowerArrays, fields: readonly DistanceField[]) =>
    runCombat(
      c,
      t,
      [],
      [],
      0,
      0,
      fields,
      GRID,
      RULESET.towerById,
      RULESET.creepById,
      1,
      4,
      new Rng(TEST_RNG_SEED),
    );

  const at = (f: DistanceField, col: number, row: number): number => f.dist[row * f.width + col]!;

  it('ground: picks the creep nearer its OWN exit, where either single field would pick the other', () => {
    const towers = towerAt('basic', 6, 2);
    const [east, south] = fieldsUnder(towers) as [DistanceField, DistanceField];
    // A (west pair, bound east) at (8,1); B (north pair, bound south) at (9,2).
    // The premise, read off the real fields — so this test cannot pass vacuously:
    expect(at(east, 9, 2)).toBeLessThan(at(east, 8, 1)); // all-east would pick B
    expect(at(south, 9, 2)).toBeLessThan(at(south, 8, 1)); // all-south would pick B
    expect(at(east, 8, 1)).toBeLessThan(at(south, 9, 2)); // own-destination picks A
    const out = fire(
      creeps([
        { id: 2, col: 9, row: 2, dest: SOUTH_FIELD }, // B — the LOWER id, so ties cannot help A
        { id: 3, col: 8, row: 1, dest: EAST_FIELD }, // A
      ]),
      towers,
      [east, south],
    );
    expect(out.towers.targetId[0]).toBe(3);
  });

  it('air: a flyer is measured straight to its OWN exit centre, in the same unit as ground', () => {
    // F (north flyer, bound south) at (5,6): 3 tiles straight to the south exit.
    // G (west ground creep, bound east) at (7,5): its east-field distance is larger.
    // Measured to the EAST exit instead, F would be ~6.3 tiles out and G would win.
    const towers = towerAt('both', 5, 4);
    const [east, south] = fieldsUnder(towers) as [DistanceField, DistanceField];
    expect(at(east, 7, 5)).toBe(44); // G: 4.4 tiles in field units — between F's two readings
    const out = fire(
      creeps([
        { id: 2, col: 7, row: 5, dest: EAST_FIELD }, // G — lower id
        { id: 3, col: 5, row: 6, dest: SOUTH_FIELD, creepId: 'flyer' }, // F
      ]),
      towers,
      [east, south],
    );
    expect(out.towers.targetId[0]).toBe(3);
  });

  it('a cadenced AoE’s lead clamps at the target’s OWN exit, never another pair’s', () => {
    // A fast north-pair creep one cell short of the south exit: an 8-tick lead overruns
    // the exit, so the blast point clamps to the SOUTH exit centre.
    const towers = towerAt('aoe', 6, 6);
    const fields = fieldsUnder(towers);
    const out = fire(creeps([{ id: 2, col: 5, row: 8, dest: SOUTH_FIELD }], 64), towers, fields);
    expect(out.impacts).toHaveLength(1);
    expect(out.impacts[0]).toMatchObject({ kind: 'blast', x: cx(SOUTH.col), y: cy(SOUTH.row) });
  });

  it('a destination index naming no field is never a target (the forged-row rail)', () => {
    const towers = towerAt('basic', 6, 2);
    const out = fire(creeps([{ id: 2, col: 8, row: 1, dest: 7 }]), towers, fieldsUnder(towers));
    expect(out.towers.targetId[0]).toBe(0);
    expect(out.impacts).toHaveLength(0);
  });

  it('nor is a NON-INTEGER destination — it is carried as -1, never coerced onto field 0’s route', () => {
    const towers = towerAt('basic', 6, 2);
    for (const forged of [0.5, Number.NaN, undefined]) {
      const c = creeps([{ id: 3, col: 8, row: 1, dest: 0 }]);
      c.destination[0] = forged as number;
      const out = fire(c, towers, fieldsUnder(towers));
      expect(out.towers.targetId[0], String(forged)).toBe(0);
      expect(out.impacts).toHaveLength(0);
      expect(out.creeps.destination).toEqual([-1]); // names no field; coerceSoa drops it next
    }
  });
});

describe('destination column totality (coerceSoa)', () => {
  it('drops a row whose destination names no field, and costs no life', () => {
    const s = createInitialState(1, RULESET);
    pushCreep(s, { id: 60, hp: 100, col: 3, row: 4, destination: 0 });
    pushCreep(s, { id: 61, hp: 100, col: 3, row: 5, destination: 2 }); // only 0 and 1 exist
    pushCreep(s, { id: 62, hp: 100, col: 3, row: 6, destination: -1 });
    step(s, RULESET, []);
    expect(s.creeps.id).toEqual([60]);
    expect(s.lives).toBe(20);
  });

  it('drops every row when the column is missing, and truncates a column longer than id', () => {
    const missing = createInitialState(1, RULESET);
    pushCreep(missing, { id: 63, hp: 100, col: 3, row: 4 });
    delete (missing.creeps as Partial<SimState['creeps']>).destination;
    step(missing, RULESET, []);
    expect(missing.creeps.id).toEqual([]);
    expect(missing.creeps.destination).toEqual([]);

    const long = createInitialState(1, RULESET);
    pushCreep(long, { id: 64, hp: 100, col: 3, row: 4, destination: 1 });
    long.creeps.destination.push(0);
    step(long, RULESET, []);
    expect(long.creeps.id).toEqual([64]);
    expect(long.creeps.destination).toEqual([1]);
  });
});

describe('wave-preview streams aggregate per (creep, route)', () => {
  it('sums entries sharing a creep AND an entrance, splits the same creep across entrances, in first-arrival order', () => {
    const compiled = compileRuleset(
      crossingBundle([
        { creepId: 'normal', entrance: 'west', count: 2, spacingTicks: 10, offsetTicks: 20 },
        { creepId: 'normal', entrance: 'north', count: 3, spacingTicks: 10 }, // arrives first
        { creepId: 'normal', entrance: 'west', count: 4, spacingTicks: 10, offsetTicks: 40 },
        { creepId: 'flyer', entrance: 'west', count: 1, spacingTicks: 10, offsetTicks: 25 },
      ]),
      'crossing',
    );
    expect(compiled.waves[0]!.entriesSummary).toEqual([
      { creepId: 'normal', entrance: 'north', destination: ['south'], count: 3 },
      { creepId: 'normal', entrance: 'west', destination: ['east'], count: 6 },
      { creepId: 'flyer', entrance: 'west', destination: ['east'], count: 1 },
    ]);
  });

  it('exposes the wave’s hpPercent on the compiled wave', () => {
    const bundle = crossingBundle(BOTH_STREAMS);
    (bundle.boards[0]!.waves[0]! as { hpPercent: number }).hpPercent = 170;
    expect(compileRuleset(bundle, 'crossing').waves[0]!.hpPercent).toBe(170);
    expect(RULESET.waves[0]!.hpPercent).toBe(100);
  });
});

// ── QC round 1: the gaps between "correct" and "proven" ──────────────────────────────

/** A custom board on the crossing fixture's catalog/economy (the `PARALLEL` idiom). */
function boardBundle(
  board: Omit<Ruleset['boards'][number], 'waves'>,
  entries: readonly Entry[],
  opts: { readonly creepHp?: number } = {},
): Ruleset {
  return {
    ...crossingBundle(entries, opts),
    boards: [
      {
        ...board,
        waves: [{ index: 0, countdownTicks: 10, clearBonus: 0, hpPercent: 100, entries }],
      },
    ],
  };
}

const sameMask = (a: Uint8Array, b: Uint8Array): boolean => a.every((v, i) => v === b[i]);

describe('step rebuilds EVERY destination’s field on a maze change — placement, sell, mine', () => {
  interface FollowRun {
    readonly state: SimState;
    /** Ground creep-ticks checked against a live descent, per destination. */
    readonly checked: readonly number[];
    /** Per maze change: per destination, the checked creep-ticks whose next cell differs
     *  from the one the field BEFORE that change would have given — the rebuild steered
     *  them. Proves each scenario genuinely exercises each destination's rebuild. */
    readonly steered: readonly (readonly number[])[];
    /** Every maze change: its tick, the tower cells blocked before and after it, and the
     *  towers standing once that tick's `step` is done. */
    readonly changes: readonly {
      readonly tick: number;
      readonly cellsBefore: number;
      readonly cellsAfter: number;
      readonly towersAfter: number;
    }[];
  }

  /**
   * Run `ruleset` under `script`, checking after EVERY tick, for every ground creep, that
   * it followed its OWN destination's field as the maze stood this tick — the field
   * `step`'s movement phase must read, built here independently from the towers once this
   * tick's inputs apply (`previewInputs`, the input phase's own authority). Never inside a
   * tower; never heading into one; and its next cell exactly the one movement's rule
   * gives in that field (movement.ts, `advanceCreep`):
   *   - its segment START moved this tick (a waypoint reached, a mid-edge turn, a fresh
   *     spawn or a rest) ⇒ the head is the descent from the cell that start lies in;
   *   - otherwise, if it began the tick on the from-side of its edge, movement re-derived
   *     the descent from the cell it then occupied and kept the head ⇒ it is that descent;
   *   - otherwise it was committed past the edge's boundary, and nothing was re-derived.
   * A `step` that rebuilt only some destinations' fields would leave the others' creeps on
   * a stale route, and this fails on the first tick they diverge.
   */
  function runFollowing(
    ruleset: CompiledRuleset,
    script: (s: SimState) => SimInput[],
    ticks: number,
  ): FollowRun {
    const grid = ruleset.board.grid;
    const at = (mask: Uint8Array, c: { col: number; row: number }): number =>
      mask[c.row * grid.width + c.col]!;
    const cellOfFp = (x: number, y: number) => ({
      col: Math.floor(x / 256),
      row: Math.floor(y / 256),
    });
    const s = createInitialState(TEST_RNG_SEED, ruleset);
    const checked = ruleset.board.fields.map(() => 0);
    const steered: number[][] = [];
    const changes: {
      tick: number;
      cellsBefore: number;
      cellsAfter: number;
      towersAfter: number;
    }[] = [];
    const cells = (mask: Uint8Array): number => mask.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);
    let prev: { mask: Uint8Array; fields: DistanceField[] } | null = null;
    let stale: DistanceField[] | null = null;
    for (let t = 0; t < ticks && s.phase === 'running'; t++) {
      const inputs = script(s);
      const { preview } = previewInputs(s, ruleset, inputs);
      const mask = materializeTowerMask(grid, preview.towers, ruleset.towerById);
      const fields = ruleset.board.fields.map((f) => computeDistanceField(grid, f.exit, mask));
      const changed = prev !== null && !sameMask(prev.mask, mask);
      if (changed) {
        changes.push({
          tick: s.tick,
          cellsBefore: cells(prev!.mask),
          cellsAfter: cells(mask),
          towersAfter: -1, // filled in once this tick's step is done
        });
        steered.push(fields.map(() => 0));
        stale = prev!.fields;
      }
      // Each creep's segment as this tick's movement will find it.
      const before = new Map<
        number,
        { fromX: number; fromY: number; occ: Cell; head: Cell; atRest: boolean }
      >();
      for (let i = 0; i < s.creeps.id.length; i++) {
        const c = s.creeps;
        const geom = deriveValidCreepPosition(
          c.fromX[i],
          c.fromY[i],
          c.headCol[i],
          c.headRow[i],
          c.progress[i],
          grid,
        );
        if (geom === null) continue;
        before.set(c.id[i]!, {
          fromX: c.fromX[i]!,
          fromY: c.fromY[i]!,
          occ: geom.occupancyCell,
          head: { col: c.headCol[i]!, row: c.headRow[i]! },
          atRest: c.progress[i] === 0,
        });
      }
      step(s, ruleset, inputs);
      if (changed) changes[changes.length - 1]!.towersAfter = s.towers.id.length;
      const c = s.creeps;
      for (let i = 0; i < c.id.length; i++) {
        if (c.creepId[i] !== 'normal') continue; // ground only
        const d = c.destination[i]!;
        const geom = deriveValidCreepPosition(
          c.fromX[i],
          c.fromY[i],
          c.headCol[i],
          c.headRow[i],
          c.progress[i],
          grid,
        );
        expect(geom, `creep ${c.id[i]} has a valid position`).not.toBeNull();
        const head = { col: c.headCol[i]!, row: c.headRow[i]! };
        const who = `creep ${c.id[i]} (destination ${d}) at tick ${s.tick}`;
        expect(at(mask, geom!.occupancyCell), `${who} stands inside a tower`).toBe(0);
        expect(at(mask, head), `${who} heads into a tower`).toBe(0);
        if (c.progress[i] === 0) continue; // the rest sentinel: head is its own cell
        const was = before.get(c.id[i]!);
        const startMoved =
          was === undefined || was.atRest || was.fromX !== c.fromX[i] || was.fromY !== c.fromY[i];
        let from: Cell;
        if (startMoved) from = cellOfFp(c.fromX[i]!, c.fromY[i]!);
        else if (was.occ.col !== was.head.col || was.occ.row !== was.head.row) from = was.occ;
        else continue; // committed past the boundary: not re-derived this tick
        const next = firstDescentNeighbor(fields[d]!, from.col, from.row);
        expect(
          next && { col: next.col, row: next.row },
          `${who}, descending from (${from.col},${from.row})`,
        ).toEqual(head);
        checked[d]!++;
        if (stale !== null) {
          const old = firstDescentNeighbor(stale[d]!, from.col, from.row);
          if (old === null || old.col !== head.col || old.row !== head.row) {
            steered[steered.length - 1]![d]!++;
          }
        }
      }
      prev = { mask, fields };
    }
    return { state: s, checked, steered, changes };
  }

  /** Every maze change in `run` went from one NON-EMPTY tower mask to a different non-empty
   *  one, with a tower still standing after it — so `step` derived the new fields through
   *  `effectiveFields` (index.ts), never its no-tower shortcut to the board's own fields. */
  function expectNonEmptyToNonEmpty(run: FollowRun): void {
    for (const ch of run.changes) {
      expect(ch.cellsBefore, `tick ${ch.tick}: the mask before`).toBeGreaterThan(0);
      expect(ch.cellsAfter, `tick ${ch.tick}: the mask after`).toBeGreaterThan(0);
      expect(ch.towersAfter, `tick ${ch.tick}: towers standing`).toBeGreaterThanOrEqual(1);
    }
  }

  // Long, tough streams on both routes, so creeps of each destination are always about
  // when the maze changes (tough enough that no tower kills one first).
  const STREAMS: readonly Entry[] = [
    { creepId: 'normal', entrance: 'west', count: 8, spacingTicks: 15 },
    { creepId: 'normal', entrance: 'north', count: 8, spacingTicks: 15, offsetTicks: 5 },
  ];
  // A FRESH compile per test: the field cache is keyed on the compiled board, so a shared
  // ruleset would let one test's last cached mask serve the next test's first change.
  const tough = (towers?: readonly TowerDef[]): CompiledRuleset =>
    compileRuleset(crossingBundle(STREAMS, { creepHp: 1_000_000, towers }), 'crossing');
  // A BYSTANDER tower, off both lines (cols 1-2, rows 7-8), standing from tick 0 to the
  // end of every leg: no maze change below ever starts or ends on an empty board, so `step`
  // reaches every one through `effectiveFields`, never its no-tower shortcut.
  const BYSTANDER = place(1, 7);
  const START: SimInput[] = [{ kind: 'callWaveEarly' }, BYSTANDER];
  // One tower on each stream's line, clear of the crossing and of every creep at tick 20:
  // (8,3) blocks row 4 at cols 8-9 (the west → east line); (5,6) blocks col 5 at rows 6-7
  // (the north → south line). Neither seals anything.
  const ON_BOTH_LINES = [place(8, 3), place(5, 6)];
  const isBystander = (s: SimState, i: number): boolean =>
    s.towers.col[i] === 1 && s.towers.row[i] === 7;

  it('a PLACEMENT re-routes both destinations’ creeps from the next movement step', () => {
    const run = runFollowing(
      tough(),
      (s) => (s.tick === 0 ? START : s.tick === 20 ? ON_BOTH_LINES : []),
      3_000,
    );
    expect(run.changes.map((ch) => ch.tick)).toEqual([20]);
    expectNonEmptyToNonEmpty(run);
    expect(run.state.towers.id).toHaveLength(3);
    expect(run.checked.every((n) => n > 0)).toBe(true);
    expect(run.steered[0]![EAST_FIELD]).toBeGreaterThan(0);
    expect(run.steered[0]![SOUTH_FIELD]).toBeGreaterThan(0);
  });

  it('a SELL that reopens both lines re-routes both destinations back', () => {
    const run = runFollowing(
      tough(),
      (s) => {
        if (s.tick === 0) return START;
        if (s.tick === 20) return ON_BOTH_LINES;
        if (s.tick === 120) {
          // Sell the two line towers; the bystander stays.
          return s.towers.id.flatMap((id, i) =>
            isBystander(s, i) ? [] : [{ kind: 'sellTower' as const, tower: id }],
          );
        }
        return [];
      },
      3_000,
    );
    expect(run.changes.map((ch) => ch.tick)).toEqual([20, 120]);
    expectNonEmptyToNonEmpty(run);
    expect(run.state.towers.id).toHaveLength(1); // the bystander
    expect(run.steered[1]![EAST_FIELD]).toBeGreaterThan(0);
    expect(run.steered[1]![SOUTH_FIELD]).toBeGreaterThan(0);
  });

  it('a MINE consuming itself reopens its line, and that destination’s creeps re-route at once', () => {
    // The mine sits on the north → south line; the north creeps detouring round it set it
    // off (trigger 576 fp from its footprint's centre), and it is consumed — a maze change
    // no command made.
    const run = runFollowing(
      tough([TEST_TOWER, TEST_BURST_TOWER]),
      (s) => (s.tick === 0 ? START : s.tick === 20 ? [place(5, 6, 'mine')] : []),
      3_000,
    );
    expect(run.changes).toHaveLength(2); // the placement, then the detonation
    expect(run.changes[0]!.tick).toBe(20);
    expectNonEmptyToNonEmpty(run);
    expect(run.state.towers.id).toHaveLength(1); // the mine consumed; the bystander stands
    expect(run.steered[0]![SOUTH_FIELD]).toBeGreaterThan(0); // around the mine…
    expect(run.steered[1]![SOUTH_FIELD]).toBeGreaterThan(0); // …and straight again after it
  });
});

// Three entrances, two destinations: two entrances share an exit, so an entrance's index
// is NOT its destination's. 12 × 10: `west-hi` (0,2) and `west-lo` (0,7) both → `east`
// (11,2); `east-lo` (11,7) → `south` (5,9). Fields [east, south]; entrances → [0, 0, 1].
const WEST_HI = { col: 0, row: 2 } as const;
const WEST_LO = { col: 0, row: 7 } as const;
const EAST_LO = { col: 11, row: 7 } as const;
const EAST_HI = { col: 11, row: 2 } as const;
function threeEntranceBundle(westLoTo: 'east' | 'south'): Ruleset {
  return boardBundle(
    {
      id: 'three',
      widthTiles: 12,
      heightTiles: 10,
      entrances: [
        { id: 'west-hi', cell: WEST_HI, destination: ['east'] },
        { id: 'west-lo', cell: WEST_LO, destination: [westLoTo] },
        { id: 'east-lo', cell: EAST_LO, destination: ['south'] },
      ],
      exits: [
        { id: 'east', cell: EAST_HI },
        { id: 'south', cell: SOUTH },
      ],
    },
    [
      { creepId: 'normal', entrance: 'west-lo', count: 1, spacingTicks: 5 },
      { creepId: 'normal', entrance: 'east-lo', count: 1, spacingTicks: 5 },
      { creepId: 'normal', entrance: 'west-hi', count: 1, spacingTicks: 5 },
    ],
  );
}
const THREE = compileRuleset(threeEntranceBundle('east'), 'three');

describe('three entrances, two destinations: an entrance’s index is not its destination’s', () => {
  it('compiles to fields [east, south] and maps the entrances [0, 0, 1]', () => {
    expect(THREE.board.fields.map((f) => f.exit)).toEqual([EAST_HI, SOUTH]);
    expect(THREE.board.entranceDestination).toEqual([0, 0, 1]);
  });

  it('spawns each entry at its entrance with that entrance’s destination: entrance 1 → 0, entrance 2 → 1', () => {
    const s = createInitialState(1, THREE);
    step(s, THREE, [{ kind: 'callWaveEarly' }]); // all three at offset 0, in table order
    expect(s.creeps.destination).toEqual([0, 1, 0]);
    expect(s.creeps.fromX).toEqual([cx(WEST_LO.col), cx(EAST_LO.col), cx(WEST_HI.col)]);
    expect(s.creeps.fromY).toEqual([cy(WEST_LO.row), cy(EAST_LO.row), cy(WEST_HI.row)]);
  });

  it('the spawn lookup resolves an entrance to its cell and destination, and throws on one the board lacks', () => {
    expect(entranceSpawn(THREE.board, 1)).toEqual({ cell: WEST_LO, destination: 0 });
    expect(entranceSpawn(THREE.board, 2)).toEqual({ cell: EAST_LO, destination: 1 });
    expect(() => entranceSpawn(THREE.board, 3)).toThrow(GridError);
    expect(() => entranceSpawn(THREE.board, 3)).toThrow(/names entrance 3, but the board has 3/);
  });

  /** Place `anchors` one per tick from a fresh state; return the state and the verdicts. */
  function build(ruleset: CompiledRuleset, anchors: readonly [number, number][]): boolean[] {
    const s = createInitialState(1, ruleset);
    return anchors.map(([c, r]) => {
      const before = s.towers.id.length;
      step(s, ruleset, [place(c, r)]);
      return s.towers.id.length > before;
    });
  }

  // A wall across rows 4-5, cols 1-10: the fifth tower splits the board into a top half
  // (west-hi, east) and a bottom half (west-lo, east-lo, south).
  const SPLIT_ROWS: [number, number][] = [
    [1, 4],
    [3, 4],
    [5, 4],
    [7, 4],
    [9, 4],
  ];

  it('rejects the split that cuts entrance 1 off from ITS destination (east), though it still reaches the other one (south)', () => {
    expect(build(THREE, SPLIT_ROWS)).toEqual([true, true, true, true, false]);
    // The same wall is legal once entrance 1's own destination is south: the check reads
    // each entrance's destination, not the field at the entrance's index.
    const westLoSouth = compileRuleset(threeEntranceBundle('south'), 'three');
    expect(westLoSouth.board.entranceDestination).toEqual([0, 1, 1]);
    expect(build(westLoSouth, SPLIT_ROWS)).toEqual([true, true, true, true, true]);
  });

  it('rejects the build that seals only entrance 2 (east-lo), while 0 and 1 keep their routes', () => {
    // (9,5) blocks (10,6); (9,7) then blocks (10,7) and (10,8) — east-lo's last ways in.
    expect(
      build(THREE, [
        [9, 5],
        [9, 7],
      ]),
    ).toEqual([true, false]);
  });
});

describe('one policy for a destination naming no field: skipped, then dropped', () => {
  it('canPlaceTower: a forged destination constrains nothing, where a genuine one is protected', () => {
    // The PARALLEL-style split, built directly: a wall across rows 3-4 of a 12 × 7 board
    // with two parallel pairs, the last tower checked by `canPlaceTower` itself (not via
    // `previewInputs`, whose `coerceSoa` would drop the forged row before it got there).
    const parallel = compileRuleset(
      boardBundle(
        {
          id: 'parallel',
          widthTiles: 12,
          heightTiles: 7,
          entrances: [
            { id: 'top', cell: { col: 0, row: 1 }, destination: ['top-out'] },
            { id: 'bottom', cell: { col: 0, row: 5 }, destination: ['bottom-out'] },
          ],
          exits: [
            { id: 'top-out', cell: { col: 11, row: 1 } },
            { id: 'bottom-out', cell: { col: 11, row: 5 } },
          ],
        },
        [{ creepId: 'normal', entrance: 'top', count: 1, spacingTicks: 5 }],
      ),
      'parallel',
    );
    const s = createInitialState(1, parallel);
    for (const c of [1, 3, 5, 7]) step(s, parallel, [place(c, 3)]);
    expect(s.towers.id).toHaveLength(4);
    const mask = materializeTowerMask(parallel.board.grid, s.towers, parallel.towerById);
    const verdict = (destination: number): boolean => {
      const t = createInitialState(1, parallel);
      pushCreep(t, { id: 90, hp: 100, col: 3, row: 5, destination }); // in the bottom half
      return canPlaceTower(
        parallel.board,
        mask,
        { col: 9, row: 3 },
        t.creeps,
        1_000,
        5,
        parallel.creepById,
      );
    };
    expect(verdict(0)).toBe(false); // a top-pair creep in the bottom half: protected
    expect(verdict(1)).toBe(true); // a bottom-pair creep: still reaches its exit
    expect(verdict(7)).toBe(true); // names no field: skipped, like combat skips it
  });
});

describe('a real creep, walled into a pocket while its entrance still reaches its exit', () => {
  // Walls at tick 0 make a 2 × 2 room R (cols 5-6, rows 4-5) on the north → south line,
  // open at the top and the bottom: left wall cols 3-4, right wall cols 7-8, rows 4-5. A
  // north creep walks straight down into R. Each closer leaves the opening beside it its
  // one orthogonal way in — (5,1) below the north entrance, (5,8) above the south exit —
  // since no diagonal may cut a corner past the border.
  const WALLS = [place(3, 4), place(7, 4)];
  const TOP = place(5, 2); // rows 2-3: closes R's top
  const BOTTOM = place(5, 6); // rows 6-7: closes R's bottom
  const NORTH_ONLY = compileRuleset(
    crossingBundle([{ creepId: 'normal', entrance: 'north', count: 1, spacingTicks: 5 }], {
      creepHp: 1_000_000,
    }),
    'crossing',
  );

  /** A fresh run whose one north creep has walked into R (occupying row 4 or 5). */
  function creepInRoom(): SimState {
    const s = createInitialState(1, NORTH_ONLY);
    step(s, NORTH_ONLY, [{ kind: 'callWaveEarly' }, ...WALLS]);
    expect(s.towers.id).toHaveLength(2);
    for (let t = 0; t < 200; t++) {
      const geom = deriveValidCreepPosition(
        s.creeps.fromX[0],
        s.creeps.fromY[0],
        s.creeps.headCol[0],
        s.creeps.headRow[0],
        s.creeps.progress[0],
        NORTH_ONLY.board.grid,
      )!;
      if (geom.occupancyCell.col === 5 && geom.occupancyCell.row >= 4) return s;
      step(s, NORTH_ONLY, []);
    }
    throw new Error('the north creep never walked into the room');
  }

  it('closing ONE side is legal — the creep can still leave by the other', () => {
    expect(previewInputs(creepInRoom(), NORTH_ONLY, [TOP]).accepted).toEqual([true]);
    expect(previewInputs(creepInRoom(), NORTH_ONLY, [BOTTOM]).accepted).toEqual([true]);
  });

  it('closing the second side is rejected: the creep would be stranded, though north still reaches south', () => {
    const s = creepInRoom();
    expect(previewInputs(s, NORTH_ONLY, [BOTTOM, TOP]).accepted).toEqual([true, false]);
    // The premise, read off the real field: with both sides closed, the NORTH ENTRANCE
    // still reaches south (round the walls) — only the creep cannot. So the rejection is
    // the live-creep clause, not the entrance clause.
    const { preview } = previewInputs(s, NORTH_ONLY, [BOTTOM]);
    const grid = NORTH_ONLY.board.grid;
    const mask = materializeTowerMask(grid, preview.towers, NORTH_ONLY.towerById);
    for (const [dc, dr] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      mask[(2 + dr) * grid.width + (5 + dc)] = 1; // TOP's footprint
    }
    const south = computeDistanceField(grid, SOUTH, mask);
    expect(isReachable(south, NORTH)).toBe(true);
    expect(isReachable(south, { col: 5, row: 4 })).toBe(false);
  });
});

describe('a flyer crossing another pair’s exit does not leak there', () => {
  // 12 × 10, both openings of one pair on the TOP border: `tl` (2,0) → `tr` (9,0), so its
  // flyers fly straight along row 0 — straight over (5,0), the `mid` exit of the other
  // pair, `bottom` (5,9) → `mid`.
  const MID = { col: 5, row: 0 } as const;
  const TR = { col: 9, row: 0 } as const;
  const BORDER = compileRuleset(
    boardBundle(
      {
        id: 'border',
        widthTiles: 12,
        heightTiles: 10,
        entrances: [
          { id: 'tl', cell: { col: 2, row: 0 }, destination: ['tr'] },
          { id: 'bottom', cell: { col: 5, row: 9 }, destination: ['mid'] },
        ],
        exits: [
          { id: 'tr', cell: TR },
          { id: 'mid', cell: MID },
        ],
      },
      [{ creepId: 'flyer', entrance: 'tl', count: 1, spacingTicks: 5 }],
    ),
    'border',
  );

  it('flies over the foreign exit cell and leaks only at its own', () => {
    const s = createInitialState(1, BORDER);
    step(s, BORDER, [{ kind: 'callWaveEarly' }]);
    let overMid = false;
    for (let t = 0; t < 400 && s.creeps.id.length > 0; t++) {
      const geom = deriveValidCreepPosition(
        s.creeps.fromX[0],
        s.creeps.fromY[0],
        s.creeps.headCol[0],
        s.creeps.headRow[0],
        s.creeps.progress[0],
        BORDER.board.grid,
      )!;
      if (geom.occupancyCell.col === MID.col && geom.occupancyCell.row === MID.row) overMid = true;
      expect(geom.occupancyCell.row).toBe(0); // straight along the border row
      step(s, BORDER, []);
    }
    expect(overMid).toBe(true); // it really crossed the other pair's exit…
    const { leaks } = runToEnd(BORDER, s, 10); // (already gone: no further leaks)
    expect(leaks).toEqual([]);
    expect(s.leakedCount).toBe(1); // …and leaked exactly once,
    expect(s.lives).toBe(19); // for its own leak cost — at `tr`, below
  });

  it('its one leak is at its own exit', () => {
    const { leaks } = runToEnd(BORDER, createInitialState(1, BORDER), 400, (t) =>
      t === 0 ? [{ kind: 'callWaveEarly' }] : [],
    );
    expect(leaks).toEqual([{ id: 1, destination: 0, lastHead: TR }]);
  });
});
