import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { test, expect, type CDPSession } from '@playwright/test';
import {
  percentile,
  max as maxOf,
  CAMPAIGN_AT_START,
  CAMPAIGN_SAMPLE_START_TICK,
  CAMPAIGN_SAMPLE_TICKS,
} from '@wynding/perf';
import { MS_PER_TICK } from '@wynding/sim';
import { PROFILES } from './profiles';

// campaign.perf.spec.ts — the CAMPAIGN scene's browser frame-time recording (M3 story 8;
// m3.md, "What tuned means", B).
//
// The shipped game's own load on both pinned profiles: the strongest reference build, the
// serpentine, playing the crossing board's thirty-wave arc through the real controller, timed
// over the densest stretch of its run (`@wynding/perf`'s `campaign.ts`: the 10 s window with
// the most creeps alive, wave 28's armored creeps winding the finished maze). Keyed by SCENE +
// PROFILE, as the catalog spec's records are.
//
// RECORDED-ONLY, exactly like the stress and catalog specs: ADR 0005's stress scene and its
// gate are unchanged, and the only HARD assertions prove the scene is the run it declares
// before any number is believed — never a budget. The board at hand-over must be the Node
// oracle's (`campaign.test.ts`) at the same tick: every tower standing, the same bounty, the
// same creeps alive; the sim must advance through the window; the run must still be going.

/** This spec's SCENE id — trace filenames and report records are keyed by scene + profile. */
const SCENE_ID = 'campaign';

/** ~10 s of sustained rAF sampling — the other scenes' window, and the Node oracle's
 *  `CAMPAIGN_SAMPLE_TICKS` at the sim's 20 Hz. */
const SAMPLE_WINDOW_MS = CAMPAIGN_SAMPLE_TICKS * MS_PER_TICK;

/** Real pointer interactions dispatched at the arm-toggle Card. */
const INPUT_LATENCY_SAMPLES = 20;

/** Floor on collected frame samples — catches a stalled sampling loop, never a budget. */
const MIN_FRAME_SAMPLES = 10;

/** The sim must advance through most of the window, or a profile whose loop falls far
 *  behind 20 Hz would time a thinner stretch than the Node oracle measured. */
const MIN_TICKS_ADVANCED = CAMPAIGN_SAMPLE_TICKS / 2;

/** How far past the densest stretch's first tick the window may open: the hand-over's
 *  frames, the evaluate round trips and the optional trace warm-up all run the sim on. */
const MAX_WINDOW_DRIFT_TICKS = CAMPAIGN_SAMPLE_TICKS / 4;

/** Opt-in DevTools trace capture, the other specs' switch. */
const TRACE_ENABLED = process.env.WY_TRACE === '1';
const TRACE_WARMUP_MS = 1_500;
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'blink.user_timing',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-v8.cpu_profiler',
];

/** Collects a started trace as one JSON string, rejecting a LOSSY one — the catalog spec's
 *  reader, duplicated for the reason it gives. */
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

// The `window.wyndingPerfCampaign` shape `apps/web/perf/main-perf-campaign.ts` installs IN THE
// BROWSER — declared locally for the reason the other specs give (importing the module as a
// value would execute its top-level `main()` under Node).
declare global {
  interface Window {
    wyndingPerfCampaign?: {
      ready: boolean;
      atStart: {
        readonly tick: number;
        readonly towers: number;
        readonly bounty: number;
        readonly liveCreeps: number;
      } | null;
      placed: number;
      planLength: number;
      tick(): number;
      phase(): string;
      liveCreepCount(): number;
      towerCount(): number;
      bounty(): number;
      startSampling(ms: number): Promise<void>;
      frameDeltas: number[];
      inputLatencies: number[];
    };
    wyndingPerfCampaignError?: string;
  }
}

test('campaign scene: fps / heap / input latency', async ({ page }, testInfo) => {
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

  await page.goto('/perf/campaign.html');

  const setupStart = Date.now();
  // Ready, or failed: the entry records a throw from its setup, so a broken scene fails
  // here with its reason rather than at the end of the timeout.
  await page.waitForFunction(
    () =>
      window.wyndingPerfCampaign?.ready === true || window.wyndingPerfCampaignError !== undefined,
    undefined,
    { timeout: 240_000 },
  );
  const setupMs = Date.now() - setupStart;
  expect(await page.evaluate(() => window.wyndingPerfCampaignError ?? null)).toBeNull();

  // The run the scene declares, before any frame time means anything: every placement of the
  // plan accepted, and the board at hand-over exactly the Node oracle's at the same tick.
  const handover = await page.evaluate(() => {
    const p = window.wyndingPerfCampaign!;
    return { placed: p.placed, planLength: p.planLength, atStart: p.atStart };
  });
  expect(handover.placed).toBe(handover.planLength);
  expect(handover.atStart).toEqual({ tick: CAMPAIGN_SAMPLE_START_TICK, ...CAMPAIGN_AT_START });
  const towerCount = await page.evaluate(() => window.wyndingPerfCampaign!.towerCount());
  expect(towerCount).toBe(CAMPAIGN_AT_START.towers);

  if (TRACE_ENABLED) {
    await cdp.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES },
    });
    await page.waitForTimeout(TRACE_WARMUP_MS);
  }

  const tickAtSampleStart = await page.evaluate(() => window.wyndingPerfCampaign!.tick());
  expect(
    tickAtSampleStart - CAMPAIGN_SAMPLE_START_TICK,
    'the window opens at the densest stretch',
  ).toBeLessThanOrEqual(MAX_WINDOW_DRIFT_TICKS);
  const liveCreepsAtSampleStart = await page.evaluate(() =>
    window.wyndingPerfCampaign!.liveCreepCount(),
  );
  await page.evaluate((ms) => window.wyndingPerfCampaign!.startSampling(ms), SAMPLE_WINDOW_MS);
  const tickAtSampleEnd = await page.evaluate(() => window.wyndingPerfCampaign!.tick());
  expect(tickAtSampleEnd).toBeGreaterThanOrEqual(tickAtSampleStart + MIN_TICKS_ADVANCED);

  if (TRACE_ENABLED) {
    const traceJson = await collectTrace(cdp);
    const outDir = resolvePath('test-results');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolvePath(outDir, `wy-trace-${SCENE_ID}-${profile.name}.json`);
    writeFileSync(outPath, traceJson);
    console.log(`WY-TRACE: wrote ${String(traceJson.length)} bytes to ${outPath}`);
  }

  const frameDeltas = await page.evaluate(() => window.wyndingPerfCampaign!.frameDeltas);
  const frameTimesMs = frameDeltas.filter((d) => d > 0);
  expect(frameTimesMs.length).toBeGreaterThanOrEqual(MIN_FRAME_SAMPLES);

  const armToggle = page.locator('.wy-card').first();
  for (let i = 0; i < INPUT_LATENCY_SAMPLES; i++) {
    await armToggle.click();
  }
  // Every dispatched click must be measured before the percentiles are computed, or a missed
  // live-region mutation silently shrinks the sample (PR #93 CodeRabbit round 1).
  await expect
    .poll(
      async () => (await page.evaluate(() => window.wyndingPerfCampaign!.inputLatencies)).length,
    )
    .toBe(INPUT_LATENCY_SAMPLES);
  const inputLatencies = await page.evaluate(() => window.wyndingPerfCampaign!.inputLatencies);
  expect(inputLatencies.length).toBe(INPUT_LATENCY_SAMPLES);

  const liveCreepsAtSampleEnd = await page.evaluate(() =>
    window.wyndingPerfCampaign!.liveCreepCount(),
  );
  // `step()` freezes on a terminal phase, so a run that resolved mid-window would render a
  // finished board and post meaningless frame times.
  const endPhase = await page.evaluate(() => window.wyndingPerfCampaign!.phase());
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
    atStart: handover.atStart,
    liveCreepsAtSampleStart,
    liveCreepsAtSampleEnd,
    towerCount,
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
