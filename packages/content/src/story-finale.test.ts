// story-finale.test.ts — M2 Story 10 P6: the finale content (`boss`, `armored-flyer`,
// `frost-splash`), measured against the shipped bundle.
//
// LOCATION NOTE, same reasoning as `story-mine.test.ts`'s own header: this file lives
// beside `parity.test.ts` (not in `packages/sim`, which cannot import `@wynding/content`)
// so every scenario below runs the REAL shipped `wynding-core` bundle through
// `compileRuleset` -> `step()`, not a hand-assembled replica of the boss.
//
// The sim RULE (the multi-life leak) is covered at sim level, with a purpose-built
// fixture, in `packages/sim/src/story-boss.test.ts` — NOT duplicated here. This file
// covers the CONTENT side: the shipped `boss`'s own numbers (armor 8, leakCost 3,
// stun-immune), `armored-flyer`'s domain gating, and `frost-splash`'s composability.
//
// Regenerate every literal below with:
//   pnpm --filter @wynding/content exec vitest run story-finale
// The goldens are `console.log`'d on every run — they are MEASURED, never hand-computed.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  createInitialState,
  step,
  MAX_MATCH_TICKS,
  projectCreep,
  type SimInput,
  type SimState,
} from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';

const SCENARIO_SEED = 0x5eed;

interface CreepSnapshot {
  readonly id: number;
  readonly creepId: string;
  readonly hp: number;
  readonly slowMulFp: number;
  readonly fromX: number;
}

interface SceneResult {
  readonly state: SimState;
  readonly livesByTick: readonly number[]; // index = tick, value = lives AFTER that tick's step
  readonly creepsByTick: ReadonlyMap<number, readonly CreepSnapshot[]>;
  readonly rngStateByTick: readonly number[]; // rngState AFTER that tick's step
  readonly ruleset: ReturnType<typeof compileRuleset>;
}

/** One tower placed every `spacingTicks` ticks (default 10) in `anchors` order,
 *  starting at `startTick` — same idiom as `story-flying-wave.test.ts`'s
 *  `anchorWallInputs`, redefined here per this repo's self-contained-story-file
 *  convention. */
function anchorWallInputs(
  anchors: readonly { col: number; row: number }[],
  towerId: string,
  startTick = 0,
  spacingTicks = 10,
): (tick: number) => SimInput[] {
  let next = 0;
  return (tick: number): SimInput[] => {
    const out: SimInput[] = [];
    if (tick >= startTick && (tick - startTick) % spacingTicks === 0 && next < anchors.length) {
      out.push({ kind: 'placeTower', anchor: anchors[next]!, towerId });
      next++;
    }
    return out;
  };
}

// ---------------------------------------------------------------------------------
// GEOMETRY. The shipped board is 28x24 with entrance (0,11) and exit (27,11).
//
// SURVIVAL_WALL is byte-identical to `story-flying-wave.test.ts`'s scenario #2 (its
// own header: "an `antiair` wall built ahead of wave 5 kills every `flying` creep"),
// ALREADY MEASURED there (M2-S10 P3, re-pinned) to survive past wave index 6 and
// into wave index 7 — the boss's own wave — ending 'won' at tick 3141 with 3 lives,
// `waveLeaked` true at both index 6 and 7. Reused here (not imported — each story
// file is self-contained, per this repo's convention) as the ONE build every
// boss-facing scenario below stands on, so the boss actually launches and crosses
// the board rather than the run freezing on an earlier wave.
//
// PROBE_COL (22) is chosen so a tower placed there is the ONLY ground-domain
// tower in range of anything passing that column: `basic` (cols 2/6/10, rangeFp
// 1024 = 4 tiles) reaches at most to about col 14; `venom` (col 16) reaches to
// about col 20; `antiair` (cols 20/24) is `air`-domain only and never touches a
// ground creep regardless of position. Column 22 sits clear of both the venom
// pair's footprint and reach AND the antiair wall's own footprint (cols 20-21,
// 24-25), so a probe tower placed there is the FIRST and ONLY ground-domain
// weapon anything meets from column ~20 onward — isolating its effect on the
// boss from the rest of the wall.
// ---------------------------------------------------------------------------------
const basicAnchors: { col: number; row: number }[] = [
  { col: 2, row: 10 },
  { col: 2, row: 12 },
  { col: 6, row: 10 },
  { col: 6, row: 12 },
  { col: 10, row: 10 },
  { col: 10, row: 12 },
];
const column16Anchors: { col: number; row: number }[] = [
  { col: 16, row: 10 },
  { col: 16, row: 12 },
];
const antiairAnchors: { col: number; row: number }[] = [
  { col: 20, row: 10 },
  { col: 20, row: 12 },
  { col: 24, row: 10 },
  { col: 24, row: 12 },
];
const PROBE_A = { col: 22, row: 10 } as const;
const PROBE_B = { col: 22, row: 12 } as const;

function survivalWallInputs(
  extra: (tick: number) => SimInput[] = () => [],
): (tick: number) => SimInput[] {
  const basicWall = anchorWallInputs(basicAnchors, 'basic');
  const antiairWall = anchorWallInputs(antiairAnchors, 'antiair', 1900, 10);
  return (tick: number): SimInput[] => {
    const out = basicWall(tick);
    if (tick === 1300)
      out.push({ kind: 'placeTower', anchor: column16Anchors[0]!, towerId: 'venom' });
    if (tick === 1310)
      out.push({ kind: 'placeTower', anchor: column16Anchors[1]!, towerId: 'venom' });
    out.push(...antiairWall(tick));
    out.push(...extra(tick));
    return out;
  };
}

/** Run `survivalWallInputs(extra)` end to end, capturing lives/rngState/creep rows
 *  after every tick's step — the wall itself is timer-driven, so this drives
 *  `step()` directly rather than going through a fixed placement-list shape. */
function runSurvivalScene(extra: (tick: number) => SimInput[] = () => []): SceneResult {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
  const inputs = survivalWallInputs(extra);
  const livesByTick: number[] = [];
  const rngStateByTick: number[] = [];
  const creepsByTick = new Map<number, readonly CreepSnapshot[]>();

  for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
    state = step(state, ruleset, inputs(t));
    livesByTick[t] = state.lives;
    rngStateByTick[t] = state.rngState;
    creepsByTick.set(
      t,
      state.creeps.id.map((id, i) => ({
        id,
        creepId: state.creeps.creepId[i]!,
        hp: state.creeps.hp[i]!,
        slowMulFp: state.creeps.slowMulFp[i]!,
        fromX: state.creeps.fromX[i]!,
      })),
    );
  }
  return { state, livesByTick, creepsByTick, rngStateByTick, ruleset };
}

/** Resolve the entity id a tower placed at `anchor` was assigned, once it appears
 *  in `state.towers` — the sim assigns entity ids, so a probe's own `sourceId`
 *  has to be read back rather than assumed. Same idiom as `story-mine.test.ts`'s
 *  `idByPlacement` resolution, narrowed to a single anchor. */
function resolveTowerId(state: SimState, anchor: { col: number; row: number }): number | undefined {
  for (let r = 0; r < state.towers.id.length; r++) {
    if (state.towers.col[r] === anchor.col && state.towers.row[r] === anchor.row) {
      return state.towers.id[r] as number;
    }
  }
  return undefined;
}

/** One captured impact from a specific `sourceId`, snapshotted every tick it is
 *  still resident in `state.impacts` — same de-dup-by-`(sourceId, impactTick)`
 *  posture as `story-mine.test.ts`'s own capture, but keeping every tick it is
 *  seen (not just the first) is what let the diagnostic pass above pin the EXACT
 *  tick each blast/shot resolves against a moving, armored target. */
interface ProbeFire {
  readonly impactTick: number;
  readonly targetId?: number;
  readonly kind: string;
  readonly effects: SimState['impacts'][number]['effects'];
  /** A `blast` impact is point-locked (`combat.ts`): these are its landing point and
   *  radius. Captured so an "armor fully absorbed it" measurement can prove the boss was
   *  INSIDE the blast — an unchanged hp reading alone cannot distinguish absorption from
   *  a blast that simply landed out of range (ship-review P2). */
  readonly x?: number;
  readonly y?: number;
  readonly radiusFp?: number;
}

/** Run the `SURVIVAL_WALL` (see the GEOMETRY block above) with one extra probe
 *  tower at `PROBE_A`, capturing every impact it fires and the `boss` creep's own
 *  hp/slow/dots snapshot on every tick it is alive. This is the shared engine
 *  behind every boss-probe scenario below — `splash`, `frost-splash`, `venom`,
 *  `stun` (each isolated at column 22, per the GEOMETRY note: the only
 *  ground-domain tower anything meets from ~column 20 onward). */
function runBossProbe(probeTowerId: string): {
  readonly state: SimState;
  readonly fires: readonly ProbeFire[];
  readonly bossHpAt: ReadonlyMap<number, number>; // tick -> hp, every tick boss is alive
  readonly bossPosAt: ReadonlyMap<number, { x: number; y: number }>; // tick -> fixed-point position
  readonly bossSlowAt: ReadonlyMap<number, number>; // tick -> slowMulFp
  readonly bossDotsAt: ReadonlyMap<number, readonly SimState['dots'][number][]>;
  readonly rngStateAt: readonly number[];
  readonly bossId: number | undefined; // the boss's entity id, for target-identity witnesses
} {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
  const inputs = survivalWallInputs(anchorWallInputs([PROBE_A], probeTowerId, 1950, 10));
  let sourceId: number | undefined;
  const fires: ProbeFire[] = [];
  const seen = new Set<string>();
  const bossHpAt = new Map<number, number>();
  const bossPosAt = new Map<number, { x: number; y: number }>();
  const bossSlowAt = new Map<number, number>();
  const bossDotsAt = new Map<number, readonly SimState['dots'][number][]>();
  const rngStateAt: number[] = [];
  let bossId: number | undefined;

  for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
    state = step(state, ruleset, inputs(t));
    rngStateAt[t] = state.rngState;
    if (sourceId === undefined) sourceId = resolveTowerId(state, PROBE_A);
    for (const im of state.impacts) {
      if (im.sourceId !== sourceId) continue;
      const key = `${im.sourceId}|${im.impactTick}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const blast = im as { x?: number; y?: number; radiusFp?: number };
      fires.push({
        impactTick: im.impactTick,
        targetId: (im as { targetId?: number }).targetId,
        kind: im.kind,
        effects: im.effects,
        x: blast.x,
        y: blast.y,
        radiusFp: blast.radiusFp,
      });
    }
    for (let i = 0; i < state.creeps.id.length; i++) {
      if (state.creeps.creepId[i] !== 'boss') continue;
      const id = state.creeps.id[i] as number;
      bossId = id;
      bossHpAt.set(t, state.creeps.hp[i] as number);
      // `projectCreep` is the sim's OWN public position derivation — the same one the
      // renderer uses — so this is not a second copy of the movement geometry.
      const pos = projectCreep(state.creeps, i, ruleset.board.grid);
      if (pos !== null) bossPosAt.set(t, pos);
      bossSlowAt.set(t, state.creeps.slowMulFp[i] as number);
      bossDotsAt.set(
        t,
        state.dots.filter((d) => d.targetId === id),
      );
    }
  }
  return { state, fires, bossHpAt, bossPosAt, bossSlowAt, bossDotsAt, rngStateAt, bossId };
}

describe('M2-S10 — the finale: `boss`, `armored-flyer`, `frost-splash`, measured against the shipped bundle', () => {
  it("the boss's own leak costs 3 lives, in one clean single-leak overshoot event — the SURVIVAL_WALL, unmodified", () => {
    const result = runSurvivalScene();

    // MID-TRACE PROOF THE FEATURE ENGAGED, before any terminal assertion: a live
    // `boss` creep was actually observed at full hp at some point (the wave really
    // launched it, not merely scheduled it).
    let sawFullHpBoss = false;
    for (let t = 0; t < result.state.tick; t++) {
      const boss = result.creepsByTick.get(t)!.find((c) => c.creepId === 'boss');
      if (boss && boss.hp === result.ruleset.creepById['boss']?.hp) sawFullHpBoss = true;
    }
    expect(sawFullHpBoss).toBe(true);

    // Walk the recorded trace to find the tick lives dropped AND a live boss row
    // (hp > 0 the tick before) disappeared — a LEAK, never a kill (a kill only
    // ever removes a row whose hp already reached <= 0, and never touches lives).
    let prevLives = result.ruleset.balance.startingLives;
    let prevCreeps: readonly CreepSnapshot[] = [];
    let bossLeakTick = -1;
    let bossLeakDelta = 0;
    let bossHpAtLeak = -1;
    for (let t = 0; t < result.state.tick; t++) {
      const lives = result.livesByTick[t]!;
      const creeps = result.creepsByTick.get(t)!;
      if (lives < prevLives) {
        const nowIds = new Set(creeps.map((c) => c.id));
        const departedBoss = prevCreeps.find(
          (c) => c.creepId === 'boss' && c.hp > 0 && !nowIds.has(c.id),
        );
        if (departedBoss) {
          bossLeakTick = t;
          bossLeakDelta = lives - prevLives;
          bossHpAtLeak = departedBoss.hp;
        }
      }
      prevLives = lives;
      prevCreeps = creeps;
    }

    console.log(
      `[story-finale] boss leak: tick=${bossLeakTick} delta=${bossLeakDelta} hpAtLeak=${bossHpAtLeak} ` +
        `finalPhase=${result.state.phase} finalTick=${result.state.tick} finalLives=${result.state.lives} ` +
        `waveLeaked=${JSON.stringify(result.state.waveLeaked)}`,
    );
    expect(bossLeakTick).toBeGreaterThan(0); // a boss leak really was observed
    // THE MEASUREMENT: the boss's own leakCost (3), not the pre-S10 collapsed 1 —
    // and no aggregate confound (a SAME-tick second leak would show as a larger
    // delta; this run's ONLY departure at this tick is the boss itself).
    expect(bossLeakDelta).toBe(-3);
    expect(result.ruleset.creepById['boss']?.leakCost).toBe(3);
    expect(result.state.phase).toBe('won');
    expect(result.state.tick).toBe(3141);
    expect(result.state.lives).toBe(3);
    expect(result.state.waveLeaked[7]).toBe(true); // the boss's own wave
  });

  it("`splash` is fully negated by the boss's armor 8 — 0 net damage, deliberately (m2.md:139)", () => {
    const { fires, bossHpAt, bossPosAt } = runBossProbe('splash');

    // PROOF THE FEATURE ENGAGED: splash genuinely fired ON the boss — a blast, raw
    // (unbuffed, pre-armor) damage 8, matching the catalog exactly.
    console.log(`[story-finale] splash fires on boss: ${JSON.stringify(fires)}`);
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.kind === 'blast')).toBe(true);
    expect(fires.every((f) => f.effects.some((e) => e.kind === 'direct' && e.amount === 8))).toBe(
      true,
    );

    // THE MEASUREMENT: at each blast's own impactTick, the boss's hp is IDENTICAL
    // to the tick immediately before — armor 8 fully absorbs the raw 8, net 0.
    //
    // AND, at each of those ticks, the boss is PROVEN INSIDE the blast radius. Without
    // that second witness this test is ambiguous: a blast that landed out of range
    // leaves hp equally unchanged, so "armor absorbed it" and "it never reached the
    // boss" would be indistinguishable and the test would pass either way
    // (ship-review P2). Its `frost-splash` sibling below needs no such witness — its
    // `slowMulFp === 179` assertion already proves the boss was in the radius.
    for (const f of fires) {
      const before = bossHpAt.get(f.impactTick - 1);
      const at = bossHpAt.get(f.impactTick);
      const pos = bossPosAt.get(f.impactTick);
      expect(pos).toBeDefined();
      expect(f.x).toBeDefined();
      expect(f.radiusFp).toBeDefined();
      const dx = pos!.x - f.x!;
      const dy = pos!.y - f.y!;
      const distSq = dx * dx + dy * dy;
      const radSq = f.radiusFp! * f.radiusFp!;
      console.log(
        `[story-finale] splash impactTick=${f.impactTick}: hp ${before} -> ${at}, ` +
          `boss dist^2=${distSq} vs radius^2=${radSq} (inside=${distSq <= radSq})`,
      );
      expect(before).toBeDefined();
      expect(distSq).toBeLessThanOrEqual(radSq); // the blast genuinely covered the boss
      expect(at).toBe(before); // ...and armor 8 still absorbed all 8 of it
    }
  });

  it("`frost-splash` is likewise fully negated by the boss's armor 8 (m2.md:139) — but its SLOW still lands", () => {
    const { fires, bossHpAt, bossSlowAt } = runBossProbe('frost-splash');

    console.log(`[story-finale] frost-splash fires on boss: ${JSON.stringify(fires)}`);
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.kind === 'blast')).toBe(true);
    expect(fires.every((f) => f.effects.some((e) => e.kind === 'direct' && e.amount === 6))).toBe(
      true,
    );
    expect(fires.every((f) => f.effects.some((e) => e.kind === 'slow' && e.mulFp === 179))).toBe(
      true,
    );

    for (const f of fires) {
      const before = bossHpAt.get(f.impactTick - 1);
      const at = bossHpAt.get(f.impactTick);
      const slowAt = bossSlowAt.get(f.impactTick);
      console.log(
        `[story-finale] frost-splash impactTick=${f.impactTick}: hp ${before} -> ${at}, slowMulFp=${slowAt}`,
      );
      expect(at).toBe(before); // damage: 0 net, same as splash
      expect(slowAt).toBe(179); // but the slow DOES land — armor gates damage, not status
    }
  });

  it("a beacon-buffed `basic` gets through the boss's armor at 7/hit (10 x 1.5 = 15 nominal, 15 - 8 = 7 net)", () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    const wall = survivalWallInputs();
    let sourceId: number | undefined;
    const fires: ProbeFire[] = [];
    const seen = new Set<string>();
    const bossHpAt = new Map<number, number>();
    for (let t = 0; t < MAX_MATCH_TICKS && state.phase === 'running'; t++) {
      const inputs = wall(t);
      if (t === 1950) inputs.push({ kind: 'placeTower', anchor: PROBE_A, towerId: 'basic' });
      if (t === 1960) inputs.push({ kind: 'placeTower', anchor: PROBE_B, towerId: 'beacon' });
      state = step(state, ruleset, inputs);
      if (sourceId === undefined) sourceId = resolveTowerId(state, PROBE_A);
      for (const im of state.impacts) {
        if (im.sourceId !== sourceId) continue;
        const key = `${im.sourceId}|${im.impactTick}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fires.push({
          impactTick: im.impactTick,
          targetId: (im as { targetId?: number }).targetId,
          kind: im.kind,
          effects: im.effects,
        });
      }
      for (let i = 0; i < state.creeps.id.length; i++) {
        if (state.creeps.creepId[i] === 'boss') bossHpAt.set(t, state.creeps.hp[i] as number);
      }
    }

    // PROOF THE FEATURE ENGAGED: the buff really applied — the SNAPSHOTTED amount is
    // 15 (buffed), not `basic`'s bare 10.
    console.log(`[story-finale] beacon-buffed basic fires on boss: ${JSON.stringify(fires)}`);
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.kind === 'targeted')).toBe(true);
    expect(fires.every((f) => f.effects.some((e) => e.kind === 'direct' && e.amount === 15))).toBe(
      true,
    );
    expect(fires.every((f) => f.targetId !== undefined)).toBe(true);

    // THE MEASUREMENT: net hp loss at each impactTick is exactly 7 — armor-piercing
    // (m2.md), not the naive +50% (which alone would still be fully blocked: 10+50%
    // clipped by armor 8 nets nothing extra unless it clears the floor, which it does
    // here specifically because the buff pushes the nominal amount past armor).
    for (const f of fires) {
      const before = bossHpAt.get(f.impactTick - 1)!;
      const at = bossHpAt.get(f.impactTick)!;
      console.log(`[story-finale] beacon-basic impactTick=${f.impactTick}: hp ${before} -> ${at}`);
      expect(before - at).toBe(7);
    }
  });

  it("venom's DoT bypasses the boss's armor while its direct component is fully blocked", () => {
    const { fires, bossHpAt, bossDotsAt } = runBossProbe('venom');

    // PROOF THE FEATURE ENGAGED: the probe fires a direct-then-dot impact on the
    // boss, snapshotted amounts matching the catalog exactly (2 direct, 4/tick dot).
    console.log(`[story-finale] venom fires on boss: ${JSON.stringify(fires)}`);
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.effects.some((e) => e.kind === 'direct' && e.amount === 2))).toBe(
      true,
    );
    expect(fires.every((f) => f.effects.some((e) => e.kind === 'dot' && e.amount === 4))).toBe(
      true,
    );

    // THE DIRECT COMPONENT IS BLOCKED: armor 8 fully absorbs the raw 2 — proved
    // by ACCOUNTING rather than picking an isolated tick, because venom's own
    // cadence (30) is a multiple of its DoT's cadenceTicks (10): from the SECOND
    // fire onward, this probe's own prior DoT record always ticks on the SAME
    // tick its next direct hit lands (a resonance this file's own diagnostic pass
    // surfaced empirically), and the survival wall's OWN `venom` pair (col 16)
    // can ALSO have a resident DoT ticking on the boss at the same moment by pure
    // coincidence of timing. So: for the first fire (before this probe's own DoT
    // record exists to tick), the total observed hp delta must equal EXACTLY the
    // sum of whatever OTHER dot records were already scheduled to tick this exact
    // tick — leaving nothing over for the direct-2 to have contributed.
    const firstFire = fires[0]!;
    const preFireDots = bossDotsAt.get(firstFire.impactTick - 1) ?? [];
    const expectedOtherDotDamage = preFireDots
      .filter((d) => d.nextTickTick === firstFire.impactTick)
      .reduce((sum, d) => sum + d.amount, 0);
    const hpBefore = bossHpAt.get(firstFire.impactTick - 1)!;
    const hpAt = bossHpAt.get(firstFire.impactTick)!;
    console.log(
      `[story-finale] venom direct component at impactTick=${firstFire.impactTick}: hp ${hpBefore} -> ${hpAt} ` +
        `(other dots ticking this same tick: ${expectedOtherDotDamage})`,
    );
    // The delta is accounted for ENTIRELY by other dots' own scheduled ticks —
    // this probe's direct-2 contributed 0.
    expect(hpBefore - hpAt).toBe(expectedOtherDotDamage);

    // THE DOT COMPONENT BYPASSES ARMOR: the probe's own DoT RECORD carries the FULL
    // authored amount (4), never reduced for a target with armor 8 — proof the
    // mechanism doesn't touch armor at the record level at all, only at direct-hit
    // resolution. Cross-checked at the record's own scheduled tick: hp genuinely
    // falls (never by less than 4) exactly when its `nextTickTick` advances.
    let sawFullAmountDotRecord = false;
    let sawDotTickLandDamage = false;
    let prevRecord: SimState['dots'][number] | undefined;
    for (let t = firstFire.impactTick; t < firstFire.impactTick + 100; t++) {
      const dots = bossDotsAt.get(t) ?? [];
      const ownRecord = dots.find((d) => d.amount === 4 && d.cadenceTicks === 10);
      if (ownRecord) sawFullAmountDotRecord = true;
      if (ownRecord && prevRecord && ownRecord.nextTickTick !== prevRecord.nextTickTick) {
        const before = bossHpAt.get(t - 1)!;
        const at = bossHpAt.get(t)!;
        console.log(
          `[story-finale] venom DoT tick at ${t}: hp ${before} -> ${at} (>= -4 expected)`,
        );
        if (before - at >= 4) sawDotTickLandDamage = true;
      }
      prevRecord = ownRecord;
    }
    expect(sawFullAmountDotRecord).toBe(true); // amount 4, unreduced by armor
    expect(sawDotTickLandDamage).toBe(true); // and it genuinely lands, over time
  });

  it('the boss consumes NO RNG draw from a stun tower (stun-immune) — the same mechanic pinned at story-stun.test.ts:447, here for the shipped boss', () => {
    const { fires, rngStateAt, bossId } = runBossProbe('stun');

    // PROOF THE FEATURE ENGAGED: the stun tower really fired ON the boss (a
    // direct-then-stun impact, chanceNum 64, matching the catalog).
    console.log(`[story-finale] stun fires on boss: ${JSON.stringify(fires)}`);
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.effects.some((e) => e.kind === 'stun' && e.chanceNum === 64))).toBe(
      true,
    );
    // ...and fired AT THE BOSS SPECIFICALLY, not merely at something. Without this the
    // unchanged `rngState` below is ambiguous: a shot whose target died in flight takes
    // the dead-target early-out and also draws nothing, so "stun-immune" and "target
    // gone" would be indistinguishable (ship-review round 2). Same shape as the splash
    // in-radius witness above.
    expect(bossId).toBeDefined();
    expect(fires.every((f) => f.targetId === bossId)).toBe(true);

    // THE MEASUREMENT: rngState is BYTE-IDENTICAL from before the first stun attempt
    // to after the last one — every attempt against the boss specifically drew
    // nothing, mirroring `story-stun.test.ts`'s own "a stun-immune target consumes
    // no draw — rngState unchanged, never stunned" (line 447: `runCombat` there,
    // `rng.getState()` before/after a single impact against a hand-built
    // `c-stun-immune` fixture; this is the same claim, pinned against the SHIPPED
    // `boss` across a real multi-shot run). The mechanism drawing AT ALL for a
    // non-immune target is proven elsewhere (`story-stun.test.ts`'s own tests 1/2,
    // and `story-armored-wave.test.ts`'s `rngState` movement against `resolute`) —
    // not re-derived here, per this repo's "verify, do not rebuild" convention.
    const lastImpactTick = fires[fires.length - 1]!.impactTick;
    const rngBefore = rngStateAt[fires[0]!.impactTick - 1];
    const rngAfter = rngStateAt[lastImpactTick];
    console.log(
      `[story-finale] stun vs boss: rngState before first attempt=${rngBefore}, after last=${rngAfter}`,
    );
    expect(rngAfter).toBe(rngBefore);
  });

  it('`armored-flyer` is hit by `antiair` and NEVER targeted by `basic` (domain gating)', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    const inputs = survivalWallInputs();
    const towerKindById = new Map<number, string>();
    const basicImpactsOnFlyer: number[] = [];
    const antiairHpTrace: { tick: number; targetId: number; hp: number }[] = [];
    for (let t = 0; t < 2700 && state.phase === 'running'; t++) {
      state = step(state, ruleset, inputs(t));
      for (let r = 0; r < state.towers.id.length; r++) {
        towerKindById.set(state.towers.id[r] as number, state.towers.towerId[r] as string);
      }
      const creepById = new Map(
        state.creeps.id.map((id, i) => [
          id,
          { creepId: state.creeps.creepId[i]!, hp: state.creeps.hp[i]! },
        ]),
      );
      for (const im of state.impacts) {
        const targetId = (im as { targetId?: number }).targetId;
        if (targetId === undefined) continue;
        const target = creepById.get(targetId);
        if (target?.creepId !== 'armored-flyer') continue;
        const kind = towerKindById.get(im.sourceId);
        if (kind === 'basic') basicImpactsOnFlyer.push(t);
        if (kind === 'antiair') antiairHpTrace.push({ tick: t, targetId, hp: target.hp });
      }
    }

    console.log(
      `[story-finale] armored-flyer domain gating: basicImpacts=${basicImpactsOnFlyer.length} ` +
        `antiairImpacts=${antiairHpTrace.length} sample=${JSON.stringify(antiairHpTrace.slice(0, 6))}`,
    );
    // PROOF THE FEATURE ENGAGED + THE MEASUREMENT, together: antiair genuinely
    // fired on armored-flyer many times (the wave really launched and crossed the
    // antiair wall's range) — and basic (ground-domain) never once targeted it,
    // across the entire run.
    expect(antiairHpTrace.length).toBeGreaterThan(0);
    expect(basicImpactsOnFlyer).toHaveLength(0);

    // Net damage per antiair hit is 3 (8 - armor 5) — measured off the first
    // creep's own hp trace, distinct hits only (armored-flyer hp: 30, 27, 24, ...).
    // Four antiair towers stand (cadence 20 each), so two can land on the SAME
    // creep on the same or adjacent ticks — every observed drop is therefore a
    // MULTIPLE of 3 (one hit's worth), not always exactly 3.
    const firstTargetId = antiairHpTrace[0]!.targetId;
    const hpSeq = antiairHpTrace
      .filter((h) => h.targetId === firstTargetId)
      .map((h) => h.hp)
      .filter((hp, i, arr) => i === 0 || hp !== arr[i - 1]);
    console.log(
      `[story-finale] armored-flyer id=${firstTargetId} distinct hp sequence: ${JSON.stringify(hpSeq)}`,
    );
    expect(hpSeq.length).toBeGreaterThan(1); // genuinely hit more than once
    for (let i = 1; i < hpSeq.length; i++) {
      const delta = hpSeq[i - 1]! - hpSeq[i]!;
      expect(delta).toBeGreaterThan(0); // monotonically damaged, never healed
      expect(delta % 3).toBe(0); // always a whole number of 3-net hits
    }
  });

  it('`frost-splash` slows EVERY member within one blast radius — the composability proof (m2.md, ruleset.ts:603-609)', () => {
    const bundle = getBundledRuleset();
    const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
    let state: SimState = createInitialState(SCENARIO_SEED, ruleset);
    // Wave index 1 (`swarm`, 16 x, spacingTicks 5) bunches creeps close enough
    // together (speed 30 fp/tick x 5 ticks = 150 fp apart) that a single 384 fp
    // blast radius reliably catches several at once.
    let maxSimultaneous = 0;
    let maxSimultaneousIds: number[] = [];
    for (let t = 0; t < 900; t++) {
      const inputs: SimInput[] =
        t === 0
          ? [{ kind: 'placeTower', anchor: { col: 2, row: 10 }, towerId: 'frost-splash' }]
          : [];
      state = step(state, ruleset, inputs);
      const slowed = state.creeps.id
        .map((id, i) => ({
          id,
          creepId: state.creeps.creepId[i]!,
          slow: state.creeps.slowMulFp[i]!,
        }))
        // MAGNITUDE-pinned, not merely nonzero (ship-review P3): `!== 0` would survive
        // any `mulFp` regression that still writes a slow, so the blast's own 179 is the
        // filter. NB the plan's stated mutation `179 -> 256` is unbuildable — the schema
        // bounds `mulFp` at 1..255 (`ruleset-schema.ts`) — so the executable form of that
        // check is `179 -> 255`, which this assertion catches and `!== 0` would not.
        .filter((c) => c.creepId === 'swarm' && c.slow === 179);
      if (slowed.length > maxSimultaneous) {
        maxSimultaneous = slowed.length;
        maxSimultaneousIds = slowed.map((s) => s.id);
      }
    }

    console.log(
      `[story-finale] frost-splash vs swarm: max simultaneously-slowed swarm creeps=${maxSimultaneous}, ids=${JSON.stringify(maxSimultaneousIds)}`,
    );
    // PROOF THE FEATURE ENGAGED + THE MEASUREMENT: MULTIPLE distinct creeps carry a
    // nonzero `slowMulFp` at the SAME tick, from a single tower's single blast radius
    // — a single-target test cannot witness this (m2.md's own composability claim).
    // Pinned at the MEASURED 3, not a >= 2 lower bound: cadence 60 exceeds duration 30,
    // so overlapping slows cannot come from two different blasts of this tower — every
    // simultaneously-slowed creep here was caught by ONE blast, which is the claim.
    expect(maxSimultaneous).toBe(3);
  });
});
