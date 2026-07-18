# ADR 0001 — Monorepo structure and core technology stack

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Wynding is an open-field, maze-building tower defense game: the player's towers
form the maze and creeps take the shortest remaining path to the exit. It targets
the web first (PWA) and later mobile (Capacitor) and desktop/Steam (Tauri), with a
roadmap that adds competitive leaderboards and, eventually, multiplayer.

The leaderboard design requires the **server to re-simulate a submitted replay**
to derive a trusted score. That means the client and server must run the _exact
same_ simulation code and reach byte-identical results. This single requirement
drives most of the decisions below.

## Decision

### 1. One public monorepo (pnpm workspaces + Turborepo)

All code and planning live in a single public repository, split into `packages/*`
(libraries) and `apps/*` (deployables), orchestrated by Turborepo with per-package
caching.

- `packages/`: `engine` (determinism toolkit), `sim` (headless deterministic
  simulation), `render` (Phaser presentation), `content` (levels/waves), `replay`
  (format + validator), `types` (shared types).
- `apps/`: `web` (Vite PWA), `server` (AWS Lambda re-sim validator), `mobile`
  (Capacitor), `desktop` (Tauri).

The decisive reason for a monorepo over separate repos: `apps/server` re-simulates
replays using the **same `packages/sim`** the client runs. Sharing one versioned
package — rather than syncing two repos — is what keeps client and server
simulations identical. Boundaries are enforced by the package dependency graph:
`types <- engine <- sim <- {render, replay, content} <- apps`.

Planning docs (PRDs, ADRs, `CONTEXT.md`) live **in** the repo under `docs/`, public
and versioned with the code.

### 2. TypeScript + Phaser 3

TypeScript everywhere. Phaser 3 (WebGL2) for rendering. Vite for the web build and
dev server; Vitest for unit/integration tests. Strict, Pocock-style compiler
settings (`strict`, `noUncheckedIndexedAccess`, `isolatedModules`,
`verbatimModuleSyntax`) via a shared `tsconfig.base.json` and TypeScript project
references.

### 3. Determinism as a first-class, tested property

`packages/engine` provides the determinism primitives — a seeded **Mulberry32**
RNG (sim randomness kept separate from cosmetic randomness), **fixed-point**
integer math (floats banned in the sim), a **fixed 20 Hz timestep** loop, and a
per-tick **world-hash**. `packages/sim` is a pure `step(state, inputs)` function
built only on these. A replay is `{ seed, rulesetHash, simVersion, tickInputs }`;
identical inputs must reproduce an identical world-hash. This is a hard CI gate.

### 4. Cross-platform via a single web core

The web build is the canonical artifact; `apps/mobile` (Capacitor) and
`apps/desktop` (Tauri) wrap it. This avoids maintaining parallel native codebases
and keeps the deterministic sim identical on every platform.

### 5. AGPL-3.0-or-later + a public §7 App Store Exception, no CLA

Licensed **AGPL-3.0-or-later** with a public **App Store Exception** granted to
everyone under AGPL §7 (see `LICENSE-EXCEPTIONS.md`), so anyone can ship store
builds while the project stays fully open source. Inbound=outbound carries the
exception to contributions automatically, so **no CLA** is required.

## Consequences

- **Positive:** one shared, versioned sim guarantees client/server parity;
  determinism is designed in, not retrofitted; Turbo caching keeps the gate fast;
  contributors face no CLA friction; store distribution is legally clear.
- **Negative:** a monorepo needs workspace tooling discipline (project references,
  the dependency graph). Determinism imposes real constraints on sim code (no
  floats, no `Math.random`, no `Date`) that every contributor must internalize.
- **Neutral:** mobile/desktop remain thin wrappers, deferred until after the web
  MVP.
