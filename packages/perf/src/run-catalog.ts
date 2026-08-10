#!/usr/bin/env -S tsx
// run-catalog.ts — the catalog scene's own oracle process (M2-S11 P7).
//
// A SEPARATE PROCESS from `run.ts`, by design and not by convenience. `run.ts` runs the
// control and stress scenarios in ONE process precisely so V8's JIT is warm on `step()`
// before the gated stress run times anything; the catalog scene emits no `R` and feeds no
// gate, and must never share a process with the ratio harness, or it would warm (or be
// warmed by) the very measurement the gate reads. Hence its own entry point, its own
// pnpm script (`perf:catalog`), and its own oracle module (`oracle-catalog.ts`).
//
// Like `run.ts` and `generate.ts` this is a CLI entry point, excluded from the coverage
// gate: its correctness is exercised by actually running it. The DECISIONS it prints live
// in `oracle-catalog.ts`'s pure `catalogAssertions`, and the placement table's positional
// constraints live in `layout-catalog.test.ts` — this file only loads, runs, prints and
// sets an exit code.
//
// Nothing here reads a clock. The catalog scene's timing measurement is the BROWSER
// frame-time spike (`apps/web/e2e-perf/catalog.perf.spec.ts`); this process proves the
// scene is the workload it declares.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRulesetJson, MAX_MATCH_TICKS, DIAG_LEN } from '@wynding/sim';
import { validate, type Replay } from '@wynding/replay';
import { CATALOG_RULESET_URL } from '@wynding/content/catalog';
import {
  runCatalogScene,
  catalogAssertions,
  CATALOG_SAMPLE_START_TICK,
  CATALOG_SAMPLE_END_TICK,
  CATALOG_SAMPLE_TICKS,
  CATALOG_WARMUP_AFTER_BUILD_TICKS,
} from './oracle-catalog';
import { CATALOG_DETONATOR_LOWER_BOUND_TICKS } from './layout';

const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');

// 1) The bundle, through the genuine `readFileSync` + `parseRulesetJson` path.
const bundleText = readFileSync(CATALOG_RULESET_URL, 'utf8');
const bundle = parseRulesetJson(bundleText);

// 2) The committed catalog replay — the exact bytes the real replay path consumes.
const replay = JSON.parse(
  readFileSync(join(scenariosDir, 'catalog-40x40.replay.json'), 'utf8'),
) as Replay;

console.log('Running the catalog scene (catalog-40x40) — untimed oracle pass...');
const result = runCatalogScene(replay, bundle);

// 3) The compile-time termination gate's arithmetic, PINNED here as well as in
//    `catalog.test.ts`, so a schedule edit that trips it is visible in this report too.
const spawns = result.compiled.waves[0]!.spawns;
const latestSpawnTick =
  result.compiled.waves[0]!.countdownTicks + spawns[spawns.length - 1]!.offsetTicks;
const cells = result.compiled.board.grid.width * result.compiled.board.grid.height;
// ⌈23 × 3/4⌉ = 18 at the bundle's own ¾ slow floor; the shipped ¼ floor would give 11
// and a bound of ~52,700, which `compileRuleset` rejects.
const minEffSpeedFp = Math.ceil(
  (23 * result.compiled.balance.slowFloorNum) / result.compiled.balance.slowFloorDen,
);
const maxTraversalTicks = Math.ceil((cells * DIAG_LEN) / minEffSpeedFp);

// 4) The real replay validator must ACCEPT the committed replay — the same
//    independent verdict `run.ts` takes on the stress pair.
const verdict = validate(replay, bundle);

const rows = catalogAssertions(result);
rows.push({
  name: 'compile gate: latestSpawnTick + maxTraversalTicks',
  measured: `${latestSpawnTick} + ${maxTraversalTicks} = ${latestSpawnTick + maxTraversalTicks}`,
  bound: `<= ${MAX_MATCH_TICKS}`,
  pass: latestSpawnTick + maxTraversalTicks <= MAX_MATCH_TICKS,
});
rows.push({
  name: 'replay validator accepts catalog-40x40.replay.json',
  measured: verdict.ok ? 'accepted' : `rejected: ${JSON.stringify(verdict)}`,
  bound: 'accepted',
  pass: verdict.ok,
});

console.log('');
console.log(
  'Catalog scene — window ticks ' +
    CATALOG_SAMPLE_START_TICK +
    '..' +
    CATALOG_SAMPLE_END_TICK +
    ` (${CATALOG_SAMPLE_TICKS} samples), warm-up-after-build ${CATALOG_WARMUP_AFTER_BUILD_TICKS}`,
);
console.log('');
const width = rows.reduce((m, r) => Math.max(m, r.name.length), 0);
for (const row of rows) {
  console.log(
    `${row.pass ? 'PASS' : 'FAIL'}  ${row.name.padEnd(width)}  ${String(row.measured)}  [${row.bound}]`,
  );
}

console.log('');
console.log('Burst probe — detonation ticks observed vs their route-cost lower bounds:');
{
  const observed = [...result.detonationTicks].sort((a, b) => a - b);
  const bounds = [...CATALOG_DETONATOR_LOWER_BOUND_TICKS].sort((a, b) => a - b);
  for (let i = 0; i < Math.max(observed.length, bounds.length); i++) {
    const o = observed[i];
    const b = bounds[i];
    console.log(
      `  #${String(i + 1).padStart(2)}  observed=${o === undefined ? '—' : String(o).padStart(4)}  lowerBound=${b === undefined ? '—' : String(b).padStart(4)}  ${o === undefined || b === undefined ? 'MISSING' : o >= b ? 'ok' : 'EARLY'}`,
    );
  }
}
console.log('');
console.log('Diagnostics:');
console.log(`  live towers at end of pass   : ${result.finalTowers}`);
console.log(`  min towers inside window     : ${result.minTowersInWindow}`);
console.log(`  survivor mines standing      : ${result.survivorsAliveAtEnd}`);
console.log(`  as-built route length        : ${result.asBuiltRoute.length}`);
console.log(`  post-detonation route length : ${result.postDetonationRoute.length}`);
console.log('  distinct towers that ever fired, by kind (fired / placed):');
for (const [kind, placed] of Object.entries(result.placedTowersByKind)) {
  console.log(
    `    ${kind.padEnd(13)} ${String(result.firingTowersByKind[kind] ?? 0).padStart(3)} / ${placed}`,
  );
}
// The ground family spawns across ticks 100..399 only, so at 23 fp/tick it travels the
// route as a convoy ~299 x 23 = 6,877 fp wide — about 27 cells of 329. Printed because it
// is the mechanism behind any status-floor miss: only towers covering that moving band
// can engage at all.
console.log(
  `  ground convoy width          : ${(399 - 100) * 23} fp (~${Math.round(((399 - 100) * 23) / 256)} cells of ${result.asBuiltRoute.length})`,
);

if (result.leak !== null) {
  const byKind: Record<string, number> = {};
  for (const l of result.leak.leaked) byKind[l.creepId] = (byKind[l.creepId] ?? 0) + 1;
  console.log('');
  console.log(`Leak probe — first cat-heavy leak at tick ${result.leak.tick}`);
  console.log(`  leaked ids by kind : ${JSON.stringify(byKind)}`);
  console.log(
    `  leaked ids         : ${result.leak.leaked.map((l) => `${l.id}:${l.creepId}`).join(', ')}`,
  );
  console.log(`  lives delta        : ${result.leak.livesDelta}`);
  console.log(`  sum of leakCost    : ${result.leak.expectedDelta}`);
  console.log(
    `  cat-heavy summand  : ${result.leak.heavySummand} (over ${result.leak.heavyCount} heavy leaks)`,
  );
}

const failed = rows.filter((r) => !r.pass);
console.log('');
console.log(`${rows.length - failed.length}/${rows.length} oracle rows pass.`);
console.log(
  'CATALOG-REPORT: ' +
    JSON.stringify({
      scene: 'catalog-40x40',
      window: [CATALOG_SAMPLE_START_TICK, CATALOG_SAMPLE_END_TICK],
      rows,
      leak: result.leak,
    }),
);
if (failed.length > 0) {
  console.log('');
  console.log(
    'A missed floor or broken equality is a RECORDED FINDING escalated to the owner — never a re-declared schedule.',
  );
  process.exitCode = 1;
}
