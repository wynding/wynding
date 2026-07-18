## Summary

<!-- What changed and why. Link the issue (e.g. "Closes #123"). -->

## Test plan

<!-- How you verified: commands run, cases covered. -->

- [ ] `pnpm run verify` passes (format:check + typecheck + lint + test)
- [ ] Sim/engine changes: added/updated Vitest unit tests
- [ ] Determinism preserved: world-hash / replay tests still pass (no float or
      `Math.random` introduced into `packages/sim` or `packages/engine`)
