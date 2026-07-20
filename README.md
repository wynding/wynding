# Wynding

An open-field, maze-building tower defense game: your towers _are_ the maze, and
creeps always take the shortest remaining path to the exit. Web-first (PWA), with
mobile (Capacitor) and desktop/Steam (Tauri) wrappers planned.

## Status

Early scaffold — a pnpm + Turborepo TypeScript monorepo with the deterministic
simulation core in place. Not yet playable.

## Layout

```
packages/
  engine   determinism toolkit — seeded RNG, fixed-point math, fixed-timestep loop, world-hash
  sim      headless deterministic simulation: step(state, inputs)
  render   Phaser 3 presentation layer (reads sim state)
  content  board / wave data
  replay   replay format + re-simulation validator
  types    shared types
apps/
  web      Vite PWA
  server   AWS Lambda score-validation handler (re-sims a replay)
  mobile   Capacitor wrapper (planned)
  desktop  Tauri wrapper (planned)
docs/      prd/  adr/  CONTEXT.md
```

## Determinism

The simulation is a pure function of `(seed, ruleset, inputs)`: fixed 20 Hz tick,
integer fixed-point math, a seeded RNG, and no wall-clock or `Math.random` in the
sim path. That's what lets the server re-simulate a submitted replay and derive a
trusted score. See [`docs/adr/0001-monorepo-and-stack.md`](docs/adr/0001-monorepo-and-stack.md).

## Getting started

```bash
corepack enable        # provisions the pinned pnpm
pnpm install
pnpm run verify        # format:check + typecheck + lint + test, across the workspace
```

## License

**Everything** — code, art, audio, content data, and docs — is
[AGPL-3.0-or-later](LICENSE), plus a public
[App Store Exception](LICENSE-EXCEPTIONS.md) granted to everyone under AGPL §7, so
anyone can ship store builds while the project stays fully open source. For assets,
the AGPL "source" is the editable master (see
[ADR 0002](docs/adr/0002-asset-and-content-licensing.md)). Inbound contributions are
under the same terms — no CLA. See [CONTRIBUTING.md](CONTRIBUTING.md).
