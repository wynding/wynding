// replay-parity.test.ts — M2 Story 11 P6, legs 2 and 3: client/server replay parity
// through the REAL `handler()`.
//
// Ruling 7: written the obvious way, client/server parity is structurally incapable of
// failing — both sides import the SAME `@wynding/sim` in one process, so a "does the
// server agree with the client" test that just re-imports the sim and compares its own
// two calls to itself proves nothing about the actual attack surface (a forged/tampered
// REPLAY submitted over the wire). These legs instead prove the handler's actual job:
// (2) a full-arc win submitted as a replay comes back with the SAME score/stars an
// independent client-side simulation of the identical tick log produces; (3) a replay
// whose CLIENT-SIDE SCRIPT was tampered with is still re-simulated from its tick log —
// never trusted, never echoed — so the returned score reflects the tampered inputs
// exactly (known-different, not just "different"), and a forged extra claimed-score
// field on the wire (`Replay` carries none) is silently ignored.
//
// `WINNER_A` ("the poisoner") is reused from `packages/content/src/showcase-builds.ts`
// — the M2-S11 P4/P5 shared test-support module, imported here (never modified) rather
// than re-typed, so this file can't silently drift into scripting a DIFFERENT build
// than the one `story-showcase.test.ts` and `m2-golden.test.ts` already prove wins.
// `@wynding/content`'s package.json `exports` map has no subpath for it, so the import
// below reaches across the package boundary by relative path — verified (by direct
// `tsc -p tsconfig.json` run) to compile cleanly despite `rootDir: "src"`, since
// `apps/server/src` and `apps/server/dist` sit at the same depth under `apps/server`,
// so the relative path resolves identically from either.

import { describe, it, expect } from 'vitest';
import {
  compileRuleset,
  deriveScore,
  deriveStars,
  hashSimState,
  SIM_VERSION,
  type SimInput,
  type CompiledRuleset,
  type SimState,
} from '@wynding/sim';
import { currentRulesetHash, type Replay } from '@wynding/replay';
import { getBundledRuleset, defaultBoardId } from '@wynding/content';
import { WINNER_A, type Placement } from '../../../packages/content/src/showcase-builds';
import { runBuildScript } from '../../../packages/content/src/script-runner';
import { handler } from './handler';

// The seed WINNER A is tuned against (`packages/content/src/m2-golden.test.ts`'s
// `SCENARIO_SEED`) — not exported from `showcase-builds.ts` (only the script is), so
// pinned here as the same literal. A different seed is not guaranteed to still win.
const SCENARIO_SEED = 0x5eed;

const bundle = getBundledRuleset();
const BOARD_ID = defaultBoardId(bundle);
const RULESET_HASH = currentRulesetHash(bundle);

interface ClientRun {
  readonly state: SimState;
  readonly tickInputs: readonly (readonly SimInput[])[];
}

/** Replays a build script against the compiled shipped bundle exactly the way
 *  `m2-golden.test.ts`'s `runGolden()` does — greedily placing the next scripted tower
 *  the tick it becomes affordable (the shared core, `script-runner.ts`'s `runBuildScript`,
 *  G1-b/#94) — but records the CONCRETE per-tick input log actually applied, which is what
 *  a real client would submit as a `Replay`. Stops the instant the sim leaves `'running'`,
 *  so the log ends exactly at the terminal tick (`@wynding/replay`'s `validate()` rejects
 *  any tick logged past termination). */
function runScript(ruleset: CompiledRuleset, script: readonly Placement[]): ClientRun {
  const tickInputs: (readonly SimInput[])[] = [];

  const { state } = runBuildScript(ruleset, SCENARIO_SEED, script, {
    afterStep: (_state, _ruleset, inputs) => {
      tickInputs.push(inputs);
    },
  });

  return { state, tickInputs };
}

function replayFor(tickInputs: readonly (readonly SimInput[])[]): Replay {
  return {
    seed: SCENARIO_SEED,
    boardId: BOARD_ID,
    rulesetHash: RULESET_HASH,
    simVersion: SIM_VERSION,
    tickInputs,
  };
}

describe('M2-S11 P6 — client/server replay parity through the real handler()', () => {
  it('leg 2: a full-arc WINNING run submitted as a replay returns the same score and stars as the independent client-side simulation', async () => {
    const ruleset = compileRuleset(bundle, BOARD_ID);
    const client = runScript(ruleset, WINNER_A);

    // This has to actually be the winning run the plan asks for, not merely "some
    // terminal" — assert it before comparing anything else.
    expect(client.state.phase).toBe('won');

    const clientScore = deriveScore(client.state, ruleset);
    const clientStars = deriveStars(client.state, ruleset);

    const res = await handler({ body: JSON.stringify(replayFor(client.tickInputs)) });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as {
      ok: boolean;
      score: number;
      stars: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.score).toBe(clientScore);
    expect(payload.stars).toBe(clientStars);
  });

  it('leg 3a: a replay whose script differs by one placement is re-simulated and returns the independently derived, known-different score', async () => {
    const ruleset = compileRuleset(bundle, BOARD_ID);

    // WINNER_A's full 40-placement script is so far over the win threshold (P4's
    // diversity/materiality floors, not a minimal build) that dropping any ONE of its
    // placements leaves every wave still fully cleared with all 10 lives intact — a
    // single-tower deletion is a true no-op against it (verified: every index probed).
    // So this leg uses a deliberately TIGHTER slice of the same script — its first 20
    // placements, still a genuine win over the same shipped bundle — where individual
    // placements are load-bearing, to prove the property leg 3a is actually about:
    // ONE differing placement in an otherwise-valid replay changes the re-simulated
    // outcome, and the handler returns exactly that changed value.
    const baseScript = WINNER_A.slice(0, 20);
    const original = runScript(ruleset, baseScript);
    expect(original.state.phase).toBe('won');
    const originalScore = deriveScore(original.state, ruleset);

    // Drop exactly ONE placement (the first: a `basic` wall) — a genuinely different
    // build, re-simulated from scratch, never a claimed-score echo.
    const tamperedIndex = 0;
    expect(baseScript[tamperedIndex]).toBeDefined();
    const tamperedScript = [
      ...baseScript.slice(0, tamperedIndex),
      ...baseScript.slice(tamperedIndex + 1),
    ];
    const tampered = runScript(ruleset, tamperedScript);
    const tamperedScore = deriveScore(tampered.state, ruleset);
    const tamperedStars = deriveStars(tampered.state, ruleset);

    // The mutation must actually change the outcome, or this leg proves nothing.
    expect(tamperedScore).not.toBe(originalScore);

    const res = await handler({ body: JSON.stringify(replayFor(tampered.tickInputs)) });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { ok: boolean; score: number; stars: number };
    expect(payload.ok).toBe(true);

    // The handler was ACCEPTED and RE-SIMULATED the tampered log (not rejected before
    // re-simulation — a pre-simulation rejection would prove nothing here) — and its
    // answer is the SPECIFIC, independently re-derived tampered value.
    expect(payload.score).toBe(tamperedScore);
    expect(payload.stars).toBe(tamperedStars);
    expect(payload.score).not.toBe(originalScore);
  });

  it('leg 3b: a forged extra claimed-score field on the wire is accepted, re-simulated, and ignored', async () => {
    const ruleset = compileRuleset(bundle, BOARD_ID);
    const client = runScript(ruleset, WINNER_A);
    expect(client.state.phase).toBe('won');
    const trueScore = deriveScore(client.state, ruleset);
    const trueStars = deriveStars(client.state, ruleset);

    const replay = replayFor(client.tickInputs);
    // `Replay` carries no claimed-score field to echo — this forges one anyway, plus a
    // second plausible name, to prove BOTH are inert against re-simulation.
    const forgedBody = JSON.stringify({
      ...replay,
      score: 999_999_999,
      claimedScore: 999_999_999,
    });

    const res = await handler({ body: forgedBody });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { ok: boolean; score: number; stars: number };
    expect(payload.ok).toBe(true);

    // Accepted and re-simulated (not rejected pre-simulation), and the forged field
    // influenced NOTHING — the returned score is the real re-simulated one.
    expect(payload.score).toBe(trueScore);
    expect(payload.stars).toBe(trueStars);
    expect(payload.score).not.toBe(999_999_999);
  });
});

describe('#25 item 1 — the terminal contract is STRICT, on a WINNING replay, through the real handler', () => {
  // The case the issue was filed about, and the one `packages/replay`'s own suite cannot
  // state: not "does the validator reject padding" (it does, and that is pinned there over
  // a LOSING replay), but "does a legitimately-WON run get a 422 for one inert trailing
  // tick". It does, deliberately — owner ruling 2026-08-22, item 1: the narrower
  // anti-cheat surface wins over tolerance for hypothetical other clients, and the shipped
  // recorder truncates at the terminal transition so its own logs validate. Both halves
  // live in ONE describe on purpose: the acceptance half is what proves the rejection half
  // is about the PADDING and not about the run.
  const ruleset = compileRuleset(bundle, BOARD_ID);

  it('the recorder’s own truncated-at-terminal log is ACCEPTED, and graded exactly as the client graded it', async () => {
    const client = runScript(ruleset, WINNER_A);
    expect(client.state.phase).toBe('won');

    // The recorder's contract, asserted as a property of the log rather than assumed:
    // the log ends AT the terminal tick, so its length is the terminal tick index + 1.
    expect(client.tickInputs).toHaveLength(client.state.tick);

    const res = await handler({ body: JSON.stringify(replayFor(client.tickInputs)) });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as {
      ok: boolean;
      score: number;
      stars: number;
      finalHash: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.score).toBe(deriveScore(client.state, ruleset));
    expect(payload.stars).toBe(deriveStars(client.state, ruleset));
    expect(payload.finalHash).toBe(hashSimState(client.state));
    // A win, so it carries at least one star — the sv16 floor, seen from the wire.
    expect(payload.stars).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('the SAME winning log plus one inert trailing tick is rejected 422, with the exact reason', async () => {
    const client = runScript(ruleset, WINNER_A);
    expect(client.state.phase).toBe('won');
    const terminalTick = client.tickInputs.length;

    // "Inert" is the whole point: the sim is frozen at a terminal state, so neither of
    // these ticks could change the outcome even if it were simulated. They are rejected
    // for being logged at all, not for what they contain.
    for (const trailing of [[] as SimInput[], [{ kind: 'noop' }] as SimInput[]]) {
      const padded = [...client.tickInputs, trailing];
      const res = await handler({ body: JSON.stringify(replayFor(padded)) });
      expect(res.statusCode).toBe(422);
      const payload = JSON.parse(res.body) as { ok: boolean; error: string };
      expect(payload.ok).toBe(false);
      // The EXACT reason, not a substring match on 'termination' — the message names the
      // offending tick index, and that index is the terminal tick + 0 (the first tick the
      // canonical log must not contain).
      expect(payload.error).toBe(`tick ${String(terminalTick)} is logged past match termination`);
    }
  }, 120_000);
});
