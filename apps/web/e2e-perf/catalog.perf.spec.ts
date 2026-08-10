import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { test, expect, type CDPSession } from '@playwright/test';
import {
  percentile,
  max as maxOf,
  LEFTOVER_BOUNTY_EXACT,
  LIVE_CREEPS_FLOOR,
  CATALOG_TOWER_COUNT,
} from '@wynding/perf';
import { PROFILES } from './profiles';

// catalog.perf.spec.ts — the CATALOG scene's browser frame-time spike (M2-S11 P7).
//
// Its purpose is the browser frame-time spike at TRUE CATALOG SCALE: nine real tower
// kinds, four creep kinds across both domains, a live support aura, resident DoT, stuns,
// slows and burst detonations — the workload the shipped catalog actually produces, as
// opposed to the stress scene's three synthetic towers. Everything it records is keyed by
// SCENE + PROFILE (see `SCENE_ID`); the stress spec was re-keyed in the same packet so
// the two scenes' traces and report records can never collide.
//
// RECORDED-ONLY, exactly like `stress.perf.spec.ts`: the only HARD assertions are the
// ones that prove the scene was genuinely at load before any number is believed — never a
// budget number. Those are the browser-side echoes of the Node oracle's own rows
// (`pnpm perf:catalog`): 165 towers standing, the entire 1,601 starting bounty spent, the
// sustained ≥ 300 live creeps, the sim still advancing, the phase still `running`.
//
// The tower count is 165 and not 155 at every point this spec reads it: every mine pad is
// route-neutral, and the earliest detonation lands far past the tick this scene
// fast-forwards to (1,055) — observed earliest 3,559 on the Node replay, strict
// route-cost bound 3,553 (`layout.ts` states that distinction as load-bearing).
// Detonation is a post-window event that only the Node oracle's leak-probe extension
// observes.

/** This spec's SCENE id. Trace filenames, report records and analyzer inputs are keyed
 *  by scene + profile — never profile alone, which before P7 would have had this scene
 *  overwrite the stress scene's traces file-for-file under the same two projects. */
const SCENE_ID = 'catalog';

/** ~10s of sustained rAF sampling, per ADR 0005's methodology — the same window the
 *  stress spec uses, so the two scenes' frame-time percentiles are comparable. */
const SAMPLE_WINDOW_MS = 10_000;

/** Real pointer interactions dispatched at the arm-toggle Card. */
const INPUT_LATENCY_SAMPLES = 20;

/** Floor on collected frame samples — catches a stalled sampling loop, never a budget.
 *  Matched to the stress spec's own measured-floor reasoning. */
const MIN_FRAME_SAMPLES = 10;

/** The sim must genuinely advance across the window, or a frozen loop would report
 *  beautifully smooth frames over a static scene. */
const MIN_TICKS_ADVANCED = 1;

/** Opt-in DevTools trace capture, same switch the stress spec uses. */
const TRACE_ENABLED = process.env.WY_TRACE === '1';
const TRACE_WARMUP_MS = 1_500;
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'blink.user_timing',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-v8.cpu_profiler',
];

/** Collects a started trace as one JSON string. A LOSSY trace is rejected rather than
 *  analysed — the same ruling `stress.perf.spec.ts` records. */
async function collectTrace(cdp: CDPSession): Promise<string> {
  const complete = new Promise<{ stream?: string; dataLossOccurred: boolean }>((resolve) => {
    cdp.once('Tracing.tracingComplete', (params) => {
      resolve(params as { stream?: string; dataLossOccurred: boolean });
    });
  });
  await cdp.send('Tracing.end');
  const { stream, dataLossOccurred } = await complete;
  if (stream === undefined) throw new Error('Tracing.tracingComplete carried no stream handle');
  try {
    if (dataLossOccurred) {
      throw new Error(
        'Tracing reported dataLossOccurred=true — the trace is NOT attributable and is rejected.',
      );
    }
    const chunks: string[] = [];
    for (;;) {
      const part = (await cdp.send('IO.read', { handle: stream, size: 4 * 1024 * 1024 })) as {
        data: string;
        base64Encoded?: boolean;
        eof: boolean;
      };
      chunks.push(
        part.base64Encoded === true ? Buffer.from(part.data, 'base64').toString('utf8') : part.data,
      );
      if (part.eof) break;
    }
    return chunks.join('');
  } finally {
    await cdp.send('IO.close', { handle: stream });
  }
}

// The `window.wyndingPerfCatalog` shape `apps/web/perf/main-perf-catalog.ts` installs IN
// THE BROWSER — declared locally for the same reason the stress spec declares its twin
// (importing the module as a value would execute its top-level `main()` under Node).
declare global {
  interface Window {
    wyndingPerfCatalog?: {
      ready: boolean;
      tick(): number;
      phase(): string;
      liveCreepCount(): number;
      towerCount(): number;
      bounty(): number;
      startSampling(ms: number): Promise<void>;
      frameDeltas: number[];
      inputLatencies: number[];
    };
  }
}

test('catalog scene: fps / heap / input latency', async ({ page }, testInfo) => {
  const profile = PROFILES[testInfo.project.name];
  if (profile === undefined) {
    throw new Error(`no perf profile registered for project '${testInfo.project.name}'`);
  }

  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottleRate });

  await page.goto('/perf/catalog.html');

  const setupStart = Date.now();
  await page.waitForFunction(() => window.wyndingPerfCatalog?.ready === true, undefined, {
    timeout: 240_000,
  });
  const setupMs = Date.now() - setupStart;

  // The scene must have SPENT ITS WHOLE BOUNTY — the catalog table's placement cost is
  // exactly the bundle's `startingBounty` (1601), so a non-zero leftover proves a
  // placement was silently refused. This is the one placement oracle that survives the
  // detonating-mine finding intact: it is read after the build, before any detonation.
  const bounty = await page.evaluate(() => window.wyndingPerfCatalog!.bounty());
  expect(bounty).toBe(LEFTOVER_BOUNTY_EXACT);

  // The browser-side echoes of the Node oracle's own rows: the FULL 165-tower maze must be
  // standing and the scene must be carrying its sustained population before any frame time
  // means anything. `armTower` + `clickAt` reject a placement as a deterministic no-op, so
  // without the tower-count check a run could report fps for a partly-built board and pass
  // everything else.
  const towerCount = await page.evaluate(() => window.wyndingPerfCatalog!.towerCount());
  expect(towerCount).toBe(CATALOG_TOWER_COUNT);
  const liveCreepsAtSetup = await page.evaluate(() => window.wyndingPerfCatalog!.liveCreepCount());
  expect(liveCreepsAtSetup).toBeGreaterThanOrEqual(LIVE_CREEPS_FLOOR);

  if (TRACE_ENABLED) {
    await cdp.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES },
    });
    await page.waitForTimeout(TRACE_WARMUP_MS);
  }

  const tickAtSampleStart = await page.evaluate(() => window.wyndingPerfCatalog!.tick());
  await page.evaluate((ms) => window.wyndingPerfCatalog!.startSampling(ms), SAMPLE_WINDOW_MS);
  const tickAtSampleEnd = await page.evaluate(() => window.wyndingPerfCatalog!.tick());
  expect(tickAtSampleEnd).toBeGreaterThanOrEqual(tickAtSampleStart + MIN_TICKS_ADVANCED);

  if (TRACE_ENABLED) {
    const traceJson = await collectTrace(cdp);
    const outDir = resolvePath('test-results');
    mkdirSync(outDir, { recursive: true });
    // SCENE + PROFILE. Keyed by profile alone this would overwrite the stress scene's
    // trace for the same project, byte for byte.
    const outPath = resolvePath(outDir, `wy-trace-${SCENE_ID}-${profile.name}.json`);
    writeFileSync(outPath, traceJson);
    console.log(`WY-TRACE: wrote ${String(traceJson.length)} bytes to ${outPath}`);
  }

  const frameDeltas = await page.evaluate(() => window.wyndingPerfCatalog!.frameDeltas);
  const frameTimesMs = frameDeltas.filter((d) => d > 0);
  expect(frameTimesMs.length).toBeGreaterThanOrEqual(MIN_FRAME_SAMPLES);

  const armToggle = page.locator('.wy-card').first();
  for (let i = 0; i < INPUT_LATENCY_SAMPLES; i++) {
    await armToggle.click();
  }
  // Every dispatched click must actually be measured before the percentiles are
  // computed — otherwise a missed live-region mutation silently shrinks the sample
  // and the report still passes (PR #93 CodeRabbit round 1).
  await expect
    .poll(async () => (await page.evaluate(() => window.wyndingPerfCatalog!.inputLatencies)).length)
    .toBe(INPUT_LATENCY_SAMPLES);
  const inputLatencies = await page.evaluate(() => window.wyndingPerfCatalog!.inputLatencies);
  expect(inputLatencies.length).toBe(INPUT_LATENCY_SAMPLES);

  const liveCreepsAtSampleEnd = await page.evaluate(() =>
    window.wyndingPerfCatalog!.liveCreepCount(),
  );
  const towerCountAtSampleEnd = await page.evaluate(() => window.wyndingPerfCatalog!.towerCount());

  // `step()` freezes on a terminal phase, so a match that resolved mid-window would
  // render a finished board and post beautiful, meaningless frame times.
  const endPhase = await page.evaluate(() => window.wyndingPerfCatalog!.phase());
  expect(endPhase).toBe('running');

  const heapBytes = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? null;
  });
  const webglRenderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
  });

  expect(pageErrors.map((e) => e.message)).toEqual([]);
  expect(consoleErrors).toEqual([]);

  const frameTimeMs = {
    p50: percentile(frameTimesMs, 50),
    p95: percentile(frameTimesMs, 95),
    p99: percentile(frameTimesMs, 99),
  };
  const report = {
    scene: SCENE_ID,
    profile: profile.name,
    chromeVersion: page.context().browser()?.version() ?? null,
    webglRenderer,
    cpuThrottleRate: profile.cpuThrottleRate,
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    hasTouch: profile.hasTouch,
    liveCreepsAtSetup,
    liveCreepsAtSampleEnd,
    towerCount,
    towerCountAtSampleEnd,
    bounty,
    setupMs,
    sampleWindowMs: SAMPLE_WINDOW_MS,
    frameSampleCount: frameTimesMs.length,
    tickAtSampleStart,
    tickAtSampleEnd,
    frameTimeMs,
    fpsAtFrameTimePercentile: {
      p50: 1000 / frameTimeMs.p50,
      p95: 1000 / frameTimeMs.p95,
      p99: 1000 / frameTimeMs.p99,
    },
    heapBytes,
    inputLatencySampleCount: inputLatencies.length,
    inputLatencyMs: {
      p50: percentile(inputLatencies, 50),
      max: maxOf(inputLatencies),
    },
  };
  console.log(`PERF-BROWSER-REPORT: ${JSON.stringify(report)}`);
});
