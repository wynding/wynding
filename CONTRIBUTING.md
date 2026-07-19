# Contributing to Wynding

Thanks for your interest! Wynding is an open-field, maze-building tower defense
game — your towers form the maze and creeps take the shortest remaining path to
the exit — built in the open. This guide explains how to get set up, find work,
and submit changes.

## License & Inbound=Outbound

Everything — **code, documentation, art, audio, and content data** — is
**AGPL-3.0-or-later** plus the **Wynding App Store Exception** (v1.0 or, at your
option, any later version the project publishes — see
[LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md)), so anyone can ship store builds.
Inbound = outbound and **no CLA** — your copyright stays yours; we just need the
AGPL license plus the exception. For assets, "source" means the **editable master**
(`.psd`/`.kra`/`.blend`/`.svg`, DAW project files) — commit that, not just the
export. See [ADR 0002](docs/adr/0002-asset-and-content-licensing.md).

By submitting a contribution you agree it is licensed under those terms, and you
certify that you have the right to license it that way — it's your own work, or you
have permission, with any required attribution recorded. Don't paste in material
from another project unless its license is **AGPL-compatible** (for assets, prefer
public domain / CC0 or a GPL-compatible license; no `NC`/`ND`) and, for code,
carries an equivalent app-store permission. Bundled **fonts and third-party
libraries** are exempt — they keep their own licenses (per ADR 0002); record the
applicable license and any required attribution.

If you can't accept AGPL terms for your employer or other reason, please don't
submit code, documentation, or asset changes (all are AGPL); issue reports are
still welcome.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). By
participating you agree to uphold it. Reports go through the private channel
described in [SECURITY.md](SECURITY.md).

## Getting Started

```bash
git clone https://github.com/wynding/wynding.git
cd wynding
corepack enable          # provisions the pinned pnpm from package.json
pnpm install
pnpm run verify          # format:check + typecheck + lint + test, across the workspace
```

Requirements:

- Node.js 22 LTS or newer.
- pnpm (pinned via the `packageManager` field; `corepack enable` provisions it).

This is a **pnpm + Turborepo** monorepo. Useful scripts (all run through Turbo,
cached per package):

- `pnpm run build` — build every package/app.
- `pnpm run typecheck` — `tsc -b` across the project graph.
- `pnpm run lint` — ESLint (flat config).
- `pnpm test` — Vitest unit/integration suites.
- `pnpm run format` / `pnpm run format:check` — Prettier (write / check).
- `pnpm run verify` — the full local gate CI also runs (see `.github/workflows/ci.yml`).

You can scope any task to one package with Turbo's filter, e.g.
`pnpm turbo run test --filter @wynding/engine`.

## Repository Layout

- `packages/engine` — the determinism toolkit (seeded RNG, fixed-point math,
  fixed-timestep loop, world-hash). The byte-identity core.
- `packages/sim` — the headless, deterministic simulation (`step(state, inputs)`).
- `packages/render` — the Phaser 3 presentation layer (reads sim state).
- `packages/content` — level and wave data.
- `packages/replay` — the replay format and its re-simulation validator.
- `packages/types` — shared types.
- `apps/web` — the PWA (Vite). `apps/server` — the score-validation Lambda.
  `apps/mobile` (Capacitor) and `apps/desktop` (Tauri) wrap the web build.
- `docs/` — PRDs, ADRs, and the living `CONTEXT.md` glossary.

## Architectural Rules (Read Before Coding)

- `packages/sim` and `packages/engine` are **pure, deterministic, integer-math**
  code. **No Phaser, no DOM, no `Math.random`, no `Date`, no floats** — ever. Draw
  randomness from the seeded RNG; do fractional math in fixed-point.
- Render and input layers read simulation state; they never mutate it.
- Fixed 20 Hz tick. No variable timestep.
- Every simulation change needs unit tests; the deterministic-replay / world-hash
  tests must still pass. **Determinism is a hard gate** — the server re-simulates
  submitted replays to derive scores, so a byte-level divergence is a real bug.

## Finding Something to Work On

1. **GitHub Issues** — filter for `good first issue` or `help wanted`.
2. **Small fixes welcome unannounced** — typos, doc improvements, failing-test
   reproductions, boundary-rule enforcement.
3. **For anything larger, talk first.** Open a discussion or issue before you start
   a significant gameplay, systems, or design change so we can align on scope.

## Development Workflow

1. **Fork & branch.** Branch off `main` with a short descriptive name:
   `fix/path-tiebreak`, `feat/splash-tower`.
2. **Write tests first where practical.** Simulation bugs almost always have a
   minimal reproducer — prefer a failing test in `packages/sim` over a console log.
3. **Keep commits small and focused.** One logical change per commit. We use
   Conventional Commits: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.
4. **Run `pnpm run verify` before pushing.** CI runs the same gate on every PR.
5. **Open a PR** against `main` and fill out the template (summary + test plan).

## Working with AI Agents

Wynding is built **AI-first** — most code is written by AI coding agents (Claude Code,
Codex, Cursor, …) with human direction and review; human-written code is welcome too. The
full, tool-agnostic playbook — plan (grill-me → PRD) → build (TDD) → verify → review
(Codex + CodeRabbit + owner) → ship — and how to set up your agent's tooling live in
**[docs/ai-workflow.md](docs/ai-workflow.md)**.

Agent tooling (`.claude/`, `.cursor/`, …) is **gitignored** — we don't commit skills;
install them locally per that guide (Pocock's skills are pulled from upstream, not
vendored). Whatever tool you use, **you own what you submit**, and please disclose heavy AI
involvement in the PR.

## Reporting Bugs

Open an issue with what you did (steps, **seed** if relevant), what you expected,
what actually happened, and your browser + OS. For deterministic reproducers, the
seed is gold — include it.

## Security Issues

Please do **not** open a public issue for security-sensitive bugs. See
[SECURITY.md](SECURITY.md) for the private reporting process.

Welcome aboard — we're glad you're here.
