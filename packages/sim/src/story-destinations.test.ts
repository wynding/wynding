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
//     carries its `hpPercent`.

import { describe, it, expect } from 'vitest';
import type { CreepDef, Ruleset, TowerDef } from '@wynding/types';
import {
  createInitialState,
  step,
  previewInputs,
  hashSimState,
  type SimInput,
  type SimState,
} from './index';
import { compileRuleset, type CompiledRuleset } from './ruleset';
import { computeDistanceField, type DistanceField } from './pathfinding';
import { materializeTowerMask, type TowerArrays } from './tower';
import { runCombat, emptyCreeps, type CombatCreeps, type StepEvents } from './combat';
import { TEST_TOWER, TEST_AOE_TOWER, TEST_RNG_SEED, pushCreep } from './test-support';
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
  opts: { readonly creepHp?: number } = {},
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
    towerCatalog: [TEST_TOWER, TEST_AOE_TOWER, BOTH_TOWER],
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
