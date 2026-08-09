// analyze-trace.mjs — M2-S10 P8: the ADR 0005 frame-time attribution post-processor.
//
// Usage: node scripts/analyze-trace.mjs test-results/wy-trace-mid-range.json
//
// Consumes a DevTools trace recorded by `e2e-perf/stress.perf.spec.ts` under
// `WY_TRACE=1` and prints a frame-time attribution report. Every rule here is the
// 2026-08-08 empirical pilot's OBSERVED method, reproduced:
//   - attribution is CLIPPED to the `wy:window:start`/`wy:window:end` marked interval;
//   - `wy:*` measures are `ph:'b'`/`'e'` ASYNC PAIRS, FIFO-matched per name — never
//     `X` events with `dur`;
//   - bucketing is on SELF (exclusive) time, by event name;
//   - each `FireAnimationFrame` is classified by whether a `wy:draw` span nests inside
//     it (app rAF vs Phaser-internal rAF vs the sampler chain) — this split is what
//     keeps the unclassified bucket from swallowing the whole answer;
//   - reconciliation is buckets-vs-MAIN-THREAD-BUSY-TIME, stated as a SIGNED residual
//     (tolerance ±2%), never against `frameDeltas` (wall-clock rAF intervals — a
//     category error);
//   - `RunTask` zero-duration `ph:'I'` variants are skipped and a trailing unmatched
//     `ph:'B'` is closed at trace end (counted and reported), or the sum will not close.
//
// Output is shares of main-thread busy time — never traced absolute times against
// untraced budgets (a traced run is perturbed by definition).

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node scripts/analyze-trace.mjs <trace.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(path, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;
if (!Array.isArray(events)) throw new Error('no traceEvents array in trace');

// ---- 1) Renderer process + main thread identification (observed recipe) ----
// `TracingStartedInBrowser` carries args.data.frames[] = {frame, processId, url, ...};
// match url to /perf/index.html. `process_labels` was NOT present in pilot traces —
// do not rely on it. `ph:'M'` metadata then gives thread names.
let rendererPid = null;
for (const e of events) {
  if (e.name === 'TracingStartedInBrowser') {
    const frames = e.args?.data?.frames ?? [];
    for (const f of frames) {
      if (typeof f.url === 'string' && f.url.includes('/perf/index.html')) {
        rendererPid = f.processId;
      }
    }
  }
}
if (rendererPid === null) throw new Error('renderer pid not found via TracingStartedInBrowser');

const threadNames = new Map(); // `${pid}:${tid}` -> name
const processNames = new Map(); // pid -> name
for (const e of events) {
  if (e.ph === 'M' && e.name === 'thread_name') {
    threadNames.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  if (e.ph === 'M' && e.name === 'process_name') {
    processNames.set(e.pid, e.args.name);
  }
}
let mainTid = null;
for (const [key, name] of threadNames) {
  const [pid, tid] = key.split(':').map(Number);
  if (pid === rendererPid && name === 'CrRendererMain') mainTid = tid;
}
if (mainTid === null) throw new Error('CrRendererMain tid not found for renderer pid');
let gpuPid = null;
for (const [pid, name] of processNames) {
  if (name === 'GPU Process') gpuPid = pid;
}

// Cross-check (free, per the recipe): wy:* user-timing events land on renderer main.
const wyOffMain = events.filter(
  (e) => typeof e.name === 'string' && e.name.startsWith('wy:') && e.pid !== rendererPid,
).length;

// ---- 2) The attribution window ----
const windowStart = events.find((e) => e.name === 'wy:window:start')?.ts;
const windowEnd = events.find((e) => e.name === 'wy:window:end')?.ts;
if (windowStart === undefined || windowEnd === undefined || windowEnd <= windowStart) {
  throw new Error('wy:window:start / wy:window:end marks not found or inverted');
}
const windowUs = windowEnd - windowStart;
const overlap = (s, e) => Math.max(0, Math.min(e, windowEnd) - Math.max(s, windowStart));

// ---- 3) wy:* async measure synthesis (b/e FIFO per name) ----
const wySpans = []; // {name, start, end}
{
  const open = new Map(); // name -> [ts,...] FIFO
  let unmatchedE = 0;
  for (const e of events) {
    if (e.pid !== rendererPid || typeof e.name !== 'string' || !e.name.startsWith('wy:')) continue;
    if (e.ph === 'b') {
      if (!open.has(e.name)) open.set(e.name, []);
      open.get(e.name).push(e.ts);
    } else if (e.ph === 'e') {
      const q = open.get(e.name);
      const start = q?.shift();
      if (start === undefined) unmatchedE++;
      else wySpans.push({ name: e.name, start, end: e.ts });
    }
  }
  let unmatchedB = 0;
  for (const q of open.values()) unmatchedB += q.length;
  wySpans.unmatched = { b: unmatchedB, e: unmatchedE };
}
wySpans.sort((a, b) => a.start - b.start);

// ---- 4) Main-thread sync span tree (X + B/E), self time, window-clipped ----
const traceEndTs = events.reduce((m, e) => Math.max(m, (e.ts ?? 0) + (e.dur ?? 0)), 0);
const spans = []; // {name, cat, start, end}
{
  const bStack = [];
  let trailingUnmatchedB = 0;
  const mainEvents = events
    .filter((e) => e.pid === rendererPid && e.tid === mainTid)
    .sort((a, b) => a.ts - b.ts);
  for (const e of mainEvents) {
    if (e.ph === 'X' && typeof e.dur === 'number') {
      spans.push({ name: e.name, cat: e.cat, start: e.ts, end: e.ts + e.dur });
    } else if (e.ph === 'B') {
      bStack.push(e);
    } else if (e.ph === 'E') {
      const b = bStack.pop();
      if (b !== undefined) spans.push({ name: b.name, cat: b.cat, start: b.ts, end: e.ts });
    }
    // ph:'I' zero-duration variants (RunTask instants): skipped by construction.
  }
  for (const b of bStack) {
    spans.push({ name: b.name, cat: b.cat, start: b.ts, end: traceEndTs });
    trailingUnmatchedB++;
  }
  spans.trailingUnmatchedB = trailingUnmatchedB;
}
spans.sort((a, b) => a.start - b.start || b.end - a.end);

// Nesting pass: direct-children duration subtraction gives SELF time. Exact-boundary
// rule: a span starting exactly at its enclosing span's end is a SIBLING (pop on <=).
const stack = [];
for (const s of spans) {
  while (stack.length > 0 && stack[stack.length - 1].end <= s.start) stack.pop();
  const parent = stack.length > 0 ? stack[stack.length - 1] : null;
  s.parent = parent;
  s.childOverlap = 0;
  if (parent !== null) parent.childOverlap += overlap(s.start, s.end);
  stack.push(s);
}
for (const s of spans) s.self = overlap(s.start, s.end) - s.childOverlap;

// Main-thread BUSY time: union of top-level spans, window-clipped.
const topIntervals = spans
  .filter((s) => s.parent === null)
  .map((s) => [Math.max(s.start, windowStart), Math.min(s.end, windowEnd)])
  .filter(([a, b]) => b > a)
  .sort((a, b) => a[0] - b[0]);
let busyUs = 0;
{
  let curS = null;
  let curE = null;
  for (const [a, b] of topIntervals) {
    if (curE === null || a > curE) {
      if (curE !== null) busyUs += curE - curS;
      curS = a;
      curE = b;
    } else curE = Math.max(curE, b);
  }
  if (curE !== null) busyUs += curE - curS;
}

// ---- 5) Name -> bucket table (the reproducibility record; also printed) ----
const BUCKETS = {
  RunTask: 'task-overhead (RunTask self)',
  FireAnimationFrame: 'script',
  FunctionCall: 'script',
  RunMicrotasks: 'script',
  EvaluateScript: 'script',
  'v8.callFunction': 'script',
  TimerFire: 'script',
  EventDispatch: 'script',
  Layout: 'layout',
  UpdateLayoutTree: 'layout',
  PrePaint: 'layout',
  Layerize: 'layout',
  HitTest: 'layout',
  Paint: 'paint',
  UpdateLayer: 'paint',
  Commit: 'compositing',
  BeginCommitCompositorFrame: 'compositing',
  BeginMainThreadFrame: 'compositing',
  MinorGC: 'gc',
  MajorGC: 'gc',
  // The performance.measure CALL cost (the ~µs X event, not the span) — observed to
  // carry cat `devtools.timeline`, NOT `blink.user_timing`, so it is named here
  // explicitly rather than caught by the category fallback below.
  'UserTiming::Measure': 'instrumentation (UserTiming calls)',
  'UserTiming::Mark': 'instrumentation (UserTiming calls)',
};
const bucketOf = (s) => {
  if (BUCKETS[s.name] !== undefined) return BUCKETS[s.name];
  if (s.name.startsWith('V8.GC_')) return 'gc';
  if (typeof s.cat === 'string' && s.cat.includes('blink.user_timing'))
    return 'instrumentation (UserTiming calls)';
  return 'unclassified';
};
const bucketSelf = new Map();
const unclassifiedNames = new Map();
for (const s of spans) {
  const b = bucketOf(s);
  bucketSelf.set(b, (bucketSelf.get(b) ?? 0) + s.self);
  if (b === 'unclassified' && s.self > 0) {
    unclassifiedNames.set(s.name, (unclassifiedNames.get(s.name) ?? 0) + s.self);
  }
}
const bucketSumUs = [...bucketSelf.values()].reduce((a, b) => a + b, 0);
const residual = (bucketSumUs - busyUs) / busyUs;

// ---- 6) FireAnimationFrame classification by nested wy:draw (mandatory) ----
const drawSpans = wySpans.filter((s) => s.name === 'wy:draw');
const fafClasses = {
  'app rAF (contains wy:draw)': { count: 0, us: 0 },
  'Phaser-internal rAF (no wy:draw, >= 2ms)': { count: 0, us: 0 },
  'sampler/other rAF (no wy:draw, < 2ms)': { count: 0, us: 0 },
};
let di = 0;
for (const s of spans
  .filter((x) => x.name === 'FireAnimationFrame' && overlap(x.start, x.end) > 0)
  .sort((a, b) => a.start - b.start)) {
  while (di < drawSpans.length && drawSpans[di].start < s.start) di++;
  const hasDraw = di < drawSpans.length && drawSpans[di].start < s.end;
  const key = hasDraw
    ? 'app rAF (contains wy:draw)'
    : s.end - s.start >= 2000
      ? 'Phaser-internal rAF (no wy:draw, >= 2ms)'
      : 'sampler/other rAF (no wy:draw, < 2ms)';
  fafClasses[key].count++;
  fafClasses[key].us += overlap(s.start, s.end); // INCLUSIVE — this is a chain view, not the bucket table
}

// ---- 7) wy:* span shares + p50s ----
const wyStats = {};
for (const name of ['wy:step', 'wy:derive', 'wy:draw']) {
  const durs = wySpans
    .filter((s) => s.name === name && overlap(s.start, s.end) > 0)
    .map((s) => overlap(s.start, s.end));
  durs.sort((a, b) => a - b);
  const sum = durs.reduce((a, b) => a + b, 0);
  wyStats[name] = {
    count: durs.length,
    pctOfBusy: ((100 * sum) / busyUs).toFixed(2),
    p50Ms: durs.length > 0 ? (durs[Math.floor(durs.length / 2)] / 1000).toFixed(3) : null,
  };
}

// ---- 8) Other threads: observed-and-excluded / non-additive ----
// UNION of that thread's X intervals, window-clipped — a plain sum would double-count
// nested events (first observed on CrGpuMain, whose gpu-category events nest deeply).
function threadBusyPct(pid, threadName) {
  const ivs = [];
  for (const e of events) {
    if (e.pid !== pid || e.ph !== 'X' || typeof e.dur !== 'number') continue;
    if (threadNames.get(`${e.pid}:${e.tid}`) !== threadName) continue;
    const a = Math.max(e.ts, windowStart);
    const b = Math.min(e.ts + e.dur, windowEnd);
    if (b > a) ivs.push([a, b]);
  }
  ivs.sort((x, y) => x[0] - y[0]);
  let us = 0;
  let curS = null;
  let curE = null;
  for (const [a, b] of ivs) {
    if (curE === null || a > curE) {
      if (curE !== null) us += curE - curS;
      curS = a;
      curE = b;
    } else curE = Math.max(curE, b);
  }
  if (curE !== null) us += curE - curS;
  return ((100 * us) / windowUs).toFixed(2);
}

// ---- 9) cpu_profiler: name the functions (ruling 7) ----
const profileNodes = new Map(); // nodeId -> functionName
const selfByNode = new Map();
{
  // Profiles for the renderer main thread only.
  const profileIds = new Set(
    events
      .filter((e) => e.name === 'Profile' && e.pid === rendererPid && e.tid === mainTid)
      .map((e) => e.id),
  );
  const startTimes = new Map();
  for (const e of events) {
    if (e.name === 'Profile' && profileIds.has(e.id)) {
      startTimes.set(e.id, e.args?.data?.startTime ?? e.ts);
    }
  }
  const chunks = events
    .filter((e) => e.name === 'ProfileChunk' && profileIds.has(e.id))
    .sort((a, b) => a.ts - b.ts);
  const cursor = new Map(); // profileId -> running timestamp
  for (const c of chunks) {
    const d = c.args?.data;
    const cp = d?.cpuProfile;
    for (const n of cp?.nodes ?? []) {
      profileNodes.set(n.id, n.callFrame?.functionName || '(anonymous)');
    }
    const samples = cp?.samples ?? [];
    const deltas = d?.timeDeltas ?? [];
    let t = cursor.get(c.id) ?? startTimes.get(c.id) ?? c.ts;
    for (let i = 0; i < samples.length; i++) {
      t += deltas[i] ?? 0;
      if (t >= windowStart && t <= windowEnd) {
        selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + (deltas[i] ?? 0));
      }
    }
    cursor.set(c.id, t);
  }
}
const selfByFn = new Map();
for (const [nodeId, us] of selfByNode) {
  const fn = profileNodes.get(nodeId) ?? '(unknown)';
  if (fn === '(idle)') continue;
  selfByFn.set(fn, (selfByFn.get(fn) ?? 0) + us);
}
const topFns = [...selfByFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

// ---- Report ----
const pct = (us) => ((100 * us) / busyUs).toFixed(2);
const report = {
  trace: path,
  windowMs: (windowUs / 1000).toFixed(1),
  mainThreadBusyMs: (busyUs / 1000).toFixed(1),
  mainThreadBusyPctOfWindow: ((100 * busyUs) / windowUs).toFixed(2),
  buckets: Object.fromEntries(
    [...bucketSelf.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${pct(v)}%`]),
  ),
  bucketSumPctOfBusy: ((100 * bucketSumUs) / busyUs).toFixed(2),
  signedResidualPct: ((100 * (bucketSumUs - busyUs)) / busyUs).toFixed(3),
  residualWithinTolerance: Math.abs(residual) <= 0.02,
  fafChains: Object.fromEntries(
    Object.entries(fafClasses).map(([k, v]) => [
      k,
      { count: v.count, inclusivePctOfBusy: pct(v.us) },
    ]),
  ),
  wySpans: wyStats,
  wyUnmatched: wySpans.unmatched,
  trailingUnmatchedB: spans.trailingUnmatchedB,
  wyEventsOffMainThread: wyOffMain,
  unclassifiedTopNames: Object.fromEntries(
    [...unclassifiedNames.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => [k, `${pct(v)}%`]),
  ),
  nonAdditiveSideMeasures: {
    rendererCompositorBusyPctOfWindow: threadBusyPct(rendererPid, 'Compositor'),
    gpuMainBusyPctOfWindow: gpuPid === null ? null : threadBusyPct(gpuPid, 'CrGpuMain'),
    idleOrOffMainPctOfWindow: (100 - (100 * busyUs) / windowUs).toFixed(2),
  },
  topSelfFunctions: topFns.map(([fn, us]) => ({
    fn,
    selfMs: (us / 1000).toFixed(1),
    pctOfBusy: pct(us),
  })),
};
console.log(JSON.stringify(report, null, 2));
