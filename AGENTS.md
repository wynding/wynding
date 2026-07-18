# AGENTS.md — Operating Guide for AI Coding Agents

This file orients coding agents (Claude Code, Codex, Cursor, etc.) working in the
Wynding monorepo. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/CONTEXT.md](docs/CONTEXT.md) too.

## Clean-room reminder (read first)

Keep references to any existing game out of tracked files — no existing-game
titles, abbreviations, or verbatim asset/flavor text in code, comments, docs,
tests, or commit messages. Describe Wynding on its own terms: an open-field,
maze-building tower defense game where your towers form the maze and creeps take
the shortest remaining path to the exit. Competitive research lives in the
gitignored `research/` directory and must never be copied into tracked files.

## What Wynding is

A deterministic, replay-verifiable tower defense game. The simulation is a pure
function of `(seed, ruleset, inputs)`; the server re-simulates submitted replays
to derive scores. That property is the backbone of the whole project — protect it.

## Repository map

```
packages/
  engine   determinism toolkit — seeded RNG, fixed-point math, fixed-timestep loop, world-hash
  sim      headless deterministic simulation: step(state, inputs)
  render   Phaser 3 presentation layer (reads sim state, never mutates it)
  content  level / wave data
  replay   replay format + re-simulation validator
  types    shared types
apps/
  web      Vite PWA
  server   AWS Lambda score-validation handler (re-sims replays)
  mobile   Capacitor wrapper (wraps the web build)
  desktop  Tauri wrapper (wraps the web build)
docs/      prd/  adr/  CONTEXT.md
```

## Hard rules (a reviewer will block on these)

- **Determinism.** `packages/sim` and `packages/engine` are pure integer-math
  code. No `Math.random` (use the seeded `Rng`), no `Date`/`performance.now`, no
  floats (use fixed-point), no Phaser, no DOM. Same inputs → byte-identical state.
- **Layering.** Render/input read sim state; they never mutate it. The dependency
  graph flows one way: `types <- engine <- sim <- {render, replay, content} <- apps`.
- **Fixed tick.** 20 Hz (`50 ms`) fixed timestep. No variable-dt simulation.
- **Tests.** Every simulation change ships with Vitest coverage, and the
  world-hash / replay-determinism tests must stay green. The deterministic core
  (`engine`, `sim`, `replay`) enforces **>= 90% line+branch coverage** via each
  package's `vitest.config.ts`; render/apps are held to a lighter, e2e-led bar.

## Workflow

1. Make the change in the smallest package that owns the concern.
2. `pnpm run verify` (format:check + typecheck + lint + test) before committing.
3. Conventional Commits (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`).
4. Open a PR against `main` with a summary + test plan.

> **Full methodology + tooling setup:** the plan → build → verify → review → ship loop and
> how to install your agent's skills (gitignored, not committed) are in
> [docs/ai-workflow.md](docs/ai-workflow.md).

## Planning docs

- `docs/prd/` — product requirements, authored via a grill-me → PRD flow.
- `docs/adr/` — architecture decision records; high bar, only genuinely
  hard-to-reverse decisions.
- `docs/CONTEXT.md` — the living domain glossary; keep terminology consistent with it.
