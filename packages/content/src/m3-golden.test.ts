// m3-golden.test.ts — M3 story 8: the M3 determinism golden (m3.md, "What tuned means", A4).
//
// A full WINNING run over the shipped thirty-wave arc on the crossing board, played by the
// strongest reference build, THE SERPENTINE (`./reference-builds.ts`, the first build of M3's
// set — compiled from its grid, never re-typed; `balance-crossing.test.ts` pins that it wins on
// all 20 lives and that the report names it the strongest), against the REAL shipped bundle
// (the registry's default ruleset and its default board, through `compileRuleset` ->
// `createInitialState` -> `step`). It pins `finalHash` and `traceDigest` (m2-golden's
// pattern: the per-tick hash trace of `packages/sim/src/determinism.test.ts`) plus score and
// stars.
//
// A MID-TRACE ENGAGEMENT PROBE runs BEFORE the terminal pins: the run reaches wave 30 (the
// finale, located by content as the arc's last boss wave), one of the finale's bosses took
// damage before it died, and the terminal is a win. A change that made the finale unreachable
// or its bosses unengaged fails there by name, before a re-recorded hash could hide it.
//
// `scripts/check-determinism-version.mjs` watches this file beside `m2-golden.test.ts`: a
// move here alongside a change to the sim's own source needs a SIM_VERSION bump. A content
// retune moves it too — the shipped bundle is its input — and is re-pinned like every hash
// pin (m3.md, "Determinism & data").
//
// Every value below is MEASURED and `console.log`'d on every run — regenerate with:
//   pnpm --filter @wynding/content exec vitest run m3-golden

import { afterEach, describe, it, expect } from 'vitest';
import {
  compileRuleset,
  hashSimState,
  deriveScore,
  deriveStars,
  type SimState,
  type CompiledRuleset,
} from '@wynding/sim';
import { defaultBoardId, getBundledRuleset } from './registry';
import { compileReferenceBuild } from './reference-build';
import { M3_CROSSING, M3_SERPENTINE } from './reference-builds';
import { runBuildScript } from './script-runner';
// The package's ONE fnv1a copy (test-digest.ts), as m2-golden.test.ts digests through.
import { fnv1a } from './test-digest';

interface GoldenRun {
  readonly state: SimState;
  readonly ruleset: CompiledRuleset;
  readonly trace: readonly string[];
  /** The arc's last boss wave — the finale — by index. */
  readonly finale: number;
  /** A boss of the finale had its hp DECREASE at least once before the terminal: a real
   *  hit landed mid-run, not merely a full-hp boss seen spawning. */
  readonly finaleBossDamaged: boolean;
}

/** Play the serpentine on the shipped bundle to its terminal, collecting the per-tick hash
 *  trace and the engagement probe's observations. */
function runGolden(): GoldenRun {
  const bundle = getBundledRuleset();
  const ruleset = compileRuleset(bundle, defaultBoardId(bundle));
  const isBoss = (creepId: string) => ruleset.creepById[creepId]!.role === 'boss';
  const finale = ruleset.waves
    .map((w) => w.spawns.some((s) => isBoss(s.creepId)))
    .lastIndexOf(true);
  const trace: string[] = [];
  const prevHp = new Map<number, number>();
  let finaleBossDamaged = false;

  const { state } = runBuildScript(
    ruleset,
    M3_CROSSING.seed,
    compileReferenceBuild(M3_SERPENTINE, ruleset),
    {
      afterStep: (state) => {
        const c = state.creeps;
        for (let i = 0; i < c.id.length; i++) {
          if (c.wave[i] !== finale || !isBoss(c.creepId[i]!)) continue;
          const id = c.id[i]!;
          const prev = prevHp.get(id);
          if (prev !== undefined && c.hp[i]! < prev) finaleBossDamaged = true;
          prevHp.set(id, c.hp[i]!);
        }
        trace.push(hashSimState(state));
      },
    },
  );
  return { state, ruleset, trace, finale, finaleBossDamaged };
}

// A run of the arc is about 19,500 ticks. The probe's run is shared with the pins (one run
// per test at most); the reproduction test makes its own second run to compare against it.
let memo: GoldenRun | undefined;
const golden = (): GoldenRun => (memo ??= runGolden());

// Yield a macrotask after each test so the worker reads Vitest's RPC replies between whole-arc
// runs (birpc times a reply out at 60 s), as `balance-crossing.test.ts` does.
// eslint-disable-next-line no-restricted-globals -- yield between tests, not inside a run
afterEach(() => new Promise<void>((r) => setImmediate(r)));

// --- GOLDEN — a move here alongside a sim-source change requires a SIM_VERSION bump -----
// Recompute with: pnpm --filter @wynding/content exec vitest run m3-golden
const GOLDEN = {
  finalHash: '57fd957b',
  traceDigest: '791fd5eb',
  score: 1588,
  stars: 3,
  tick: 19549,
} as const;
// -------------------------------------------------------------------------------------

describe('M3 story 8 — the M3 determinism golden (the serpentine over the shipped thirty-wave arc)', () => {
  it('plays the strongest reference build on the shipped bundle’s default board', () => {
    const bundle = getBundledRuleset();
    expect([bundle.rulesetId, defaultBoardId(bundle)]).toEqual([
      M3_CROSSING.rulesetId,
      M3_CROSSING.boardId,
    ]);
    expect(M3_CROSSING.fullBoard).toBe(M3_SERPENTINE);
  });

  it(
    'the MID-TRACE ENGAGEMENT PROBE, before any terminal pin: wave 30 is reached, a finale boss took damage mid-run, and the terminal is a win',
    { timeout: 120_000 },
    () => {
      const r = golden();
      console.log(
        `[m3-golden] finale=${r.finale} finaleLaunchTick=${r.state.waveLaunchTick[r.finale]} ` +
          `finaleBossDamaged=${r.finaleBossDamaged} phase=${r.state.phase}`,
      );
      // The finale is wave 30, the arc's last — located by content, re-asserted as the literal
      // so a schedule edit that moves it fails here by name.
      expect(r.finale).toBe(29);
      expect(r.ruleset.waves).toHaveLength(30);
      expect(r.state.waveCursor).toBe(30);
      expect(r.state.waveLaunchTick[r.finale]).toBeGreaterThan(0);
      expect(r.finaleBossDamaged).toBe(true);
      expect(r.state.phase).toBe('won');
    },
  );

  it(
    'matches the committed golden: finalHash, traceDigest, score, stars and the final tick',
    { timeout: 120_000 },
    () => {
      const r = golden();
      const finalHash = hashSimState(r.state);
      const traceDigest = fnv1a(r.trace.join(':'));
      const score = deriveScore(r.state, r.ruleset);
      const stars = deriveStars(r.state, r.ruleset);
      console.log(
        `[m3-golden] finalHash=${finalHash} traceDigest=${traceDigest} score=${score} stars=${stars} ` +
          `tick=${r.state.tick} lives=${r.state.lives} phase=${r.state.phase}`,
      );
      expect(finalHash).toBe(GOLDEN.finalHash);
      expect(traceDigest).toBe(GOLDEN.traceDigest);
      expect(score).toBe(GOLDEN.score);
      expect(stars).toBe(GOLDEN.stars);
      expect(r.state.tick).toBe(GOLDEN.tick);
    },
  );

  it('reproduces a byte-identical trace from the same (seed, build)', { timeout: 120_000 }, () => {
    const again = runGolden();
    expect(again.trace).toEqual(golden().trace);
    expect(hashSimState(again.state)).toBe(hashSimState(golden().state));
  });
});
