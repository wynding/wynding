// campaign.test.ts — the campaign scene's Node oracle (M3 story 8): the serpentine on the
// shipped bundle, the densest stretch of its run found by `densestStretch`, and the board at
// the stretch's first tick, which the browser echoes before it times a frame.
//
// The serpentine and its compiler are reached by relative path, as `apps/server`'s parity
// legs and the web e2e harness reach the content package's test support: its `exports` map
// has no subpath for them. This is a test file, so the emitting program never sees the reach.

import { afterEach, describe, expect, it } from 'vitest';
import { compileRuleset, MS_PER_TICK, type SimState } from '@wynding/sim';
import { defaultBoardId, getBundledRuleset } from '@wynding/content';
import { compileReferenceBuild } from '../../content/src/reference-build';
import { M3_CROSSING, M3_SERPENTINE } from '../../content/src/reference-builds';
import { runBuildScript } from '../../content/src/script-runner';
import {
  CAMPAIGN_AT_START,
  CAMPAIGN_SAMPLE_START_TICK,
  CAMPAIGN_SAMPLE_TICKS,
  CAMPAIGN_SLACK_TICKS,
  densestStretch,
} from './campaign';

describe('densestStretch', () => {
  it('finds the window with the most creeps alive, summed', () => {
    expect(densestStretch([0, 1, 5, 5, 1, 0, 0], 2, 0)).toBe(2);
    expect(densestStretch([0, 1, 5, 5, 1, 0, 0], 3, 0)).toBe(1);
  });

  it('takes the earliest of equal windows', () => {
    expect(densestStretch([3, 3, 0, 3, 3], 2, 0)).toBe(0);
  });

  it('never picks a window that ends inside the slack', () => {
    // The best window, ticks 5–6, ends the series; a slack of 2 rules out every window
    // that ends after tick 4.
    expect(densestStretch([0, 2, 2, 0, 0, 9, 9], 2, 0)).toBe(5);
    expect(densestStretch([0, 2, 2, 0, 0, 9, 9], 2, 2)).toBe(1);
  });

  it('finds nothing when no window fits, and the whole series when exactly one does', () => {
    expect(densestStretch([1, 2, 3], 2, 2)).toBeNull();
    expect(densestStretch([1, 2, 3], 0, 0)).toBeNull();
    expect(densestStretch([1, 2, 3], 3, 0)).toBe(0);
  });

  it('defaults to the browser’s window and slack', () => {
    const series = Array.from({ length: CAMPAIGN_SAMPLE_TICKS + CAMPAIGN_SLACK_TICKS }, () => 1);
    expect(densestStretch(series)).toBe(0);
    expect(densestStretch(series.slice(1))).toBeNull();
    // 10 s of frames at the sim's fixed 20 Hz.
    expect(CAMPAIGN_SAMPLE_TICKS * MS_PER_TICK).toBe(10_000);
  });
});

// One whole-arc run, about 19,500 ticks, shared by the tests below. Yield a macrotask after
// each test so the worker reads Vitest's RPC replies between them (birpc times a reply out at
// 60 s), as the content package's whole-arc files do.
afterEach(() => new Promise<void>((r) => setImmediate(r)));

interface SceneRun {
  readonly state: SimState;
  readonly steps: number;
  /** Creeps alive, towers standing and bounty held at each tick, from tick 0. */
  readonly liveCreeps: readonly number[];
  readonly towers: readonly number[];
  readonly bounty: readonly number[];
  readonly waveCursor: readonly number[];
}

let memo: SceneRun | undefined;
function scene(): SceneRun {
  if (memo !== undefined) return memo;
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  const plan = compileReferenceBuild(M3_SERPENTINE, ruleset);
  const liveCreeps = [0];
  const towers = [0];
  const bounty = [ruleset.balance.startingBounty];
  const waveCursor = [0];
  const { state } = runBuildScript(ruleset, M3_CROSSING.seed, plan, {
    afterStep: (s) => {
      liveCreeps[s.tick] = s.creeps.id.length;
      towers[s.tick] = s.towers.id.length;
      bounty[s.tick] = s.bounty;
      waveCursor[s.tick] = s.waveCursor;
    },
  });
  memo = { state, steps: plan.length, liveCreeps, towers, bounty, waveCursor };
  return memo;
}

describe('the campaign scene: the serpentine over the shipped arc’s densest stretch', () => {
  it('plays the strongest reference build on the shipped board — a plan the browser’s greedy driver plays tick for tick', () => {
    const bundle = getBundledRuleset();
    expect([bundle.rulesetId, defaultBoardId(bundle)]).toEqual([
      M3_CROSSING.rulesetId,
      M3_CROSSING.boardId,
    ]);
    expect(M3_CROSSING.fullBoard).toBe(M3_SERPENTINE);
    // `apps/web/src/scripted-run.ts`'s `playScript` places each tower the first tick its
    // cost is covered, as the content runner does — the same run only for a plan with no
    // timed step and no sell, which this one is.
    const plan = compileReferenceBuild(M3_SERPENTINE, compileRuleset(bundle, M3_CROSSING.boardId));
    for (const step of plan) {
      expect(step.kind, `(${step.col},${step.row})`).not.toBe('sell');
      expect(step.notBeforeTick, `(${step.col},${step.row})`).toBeUndefined();
    }
  });

  it(
    'finds the densest stretch where the stretch is pinned, inside the run, with every tower standing',
    { timeout: 120_000 },
    () => {
      const run = scene();
      expect(run.state.phase).toBe('won');
      expect(run.liveCreeps).toHaveLength(run.state.tick + 1);
      const start = densestStretch(run.liveCreeps);
      console.log(
        `[campaign] start=${start} towers=${run.towers[start!]} bounty=${run.bounty[start!]} ` +
          `liveCreeps=${run.liveCreeps[start!]} wave=${run.waveCursor[start!]} terminal=${run.state.tick}`,
      );
      expect(start).toBe(CAMPAIGN_SAMPLE_START_TICK);
      const s = CAMPAIGN_SAMPLE_START_TICK;
      expect(s + CAMPAIGN_SAMPLE_TICKS + CAMPAIGN_SLACK_TICKS).toBeLessThanOrEqual(run.state.tick);
      expect({
        towers: run.towers[s],
        bounty: run.bounty[s],
        liveCreeps: run.liveCreeps[s],
      }).toEqual(CAMPAIGN_AT_START);
      expect(CAMPAIGN_AT_START.towers).toBe(run.steps);
      // Every tower stands through the whole window: nothing is sold, and the last went down
      // before it opened.
      const window = run.towers.slice(s, s + CAMPAIGN_SAMPLE_TICKS);
      expect(window.every((n) => n === run.steps)).toBe(true);
    },
  );

  it(
    'what the stretch carries: the creeps alive across it, and the waves on the board',
    { timeout: 120_000 },
    () => {
      const run = scene();
      const s = CAMPAIGN_SAMPLE_START_TICK;
      const end = s + CAMPAIGN_SAMPLE_TICKS - 1;
      const window = run.liveCreeps.slice(s, end + 1);
      const measured = {
        sum: window.reduce((a, b) => a + b, 0),
        peak: Math.max(...window),
        runPeak: Math.max(...run.liveCreeps),
        wavesLaunched: [run.waveCursor[s], run.waveCursor[end]],
      };
      console.log(`[campaign] window ${JSON.stringify(measured)}`);
      // Wave 28: sixteen armored creeps down both routes and eight fast ones down the west, at
      // the curve's top hit points, winding the whole maze. About 19 alive on average over the
      // window, 22 at most. The run's single busiest tick, 26 alive, falls outside it: a brief
      // crowd, where the window is the 10 s that keep the most creeps on the board.
      expect(measured).toEqual({ sum: 3820, peak: 22, runPeak: 26, wavesLaunched: [28, 28] });
    },
  );
});
