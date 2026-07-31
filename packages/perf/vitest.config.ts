import { defineConfig } from 'vitest/config';

// Coverage gate for the perf package, at the repo's standard 90% bar — with two
// exclusions beyond the usual `*.test.ts`: `src/generate.ts` and `src/run.ts`. Both are
// CLI entry points whose behaviour is exercised by actually RUNNING them, not by unit
// tests. `generate.ts`'s only job is to write the two committed replay files under
// `src/scenarios/`; its correctness is asserted by `scenario.test.ts`'s "committed JSON
// matches the builder" check. `run.ts` drives a multi-second sustained stress run
// (Definition of Done: `pnpm run perf`, i.e. `pnpm -C packages/perf run perf` —
// never `pnpm --filter @wynding/perf …`, which prints "No projects matched the
// filters" and exits 0 on a package rename/move, per `ci.yml`'s `perf` job
// comment) and is a thin
// composition of `harness.ts`/`oracle.ts`/`gate.ts`/`stats.ts`, all of which ARE
// unit-tested directly. Coverage-gating either CLI file would just force a dead
// `it('runs the CLI')` test that adds no signal beyond "did not throw".
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/generate.ts', 'src/run.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
