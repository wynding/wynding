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
  simulation), `render` (Phaser presentation), `content` (boards/waves), `replay`
  (format + validator), `types` (shared types), `perf` (the ADR 0005 perf gate +
  stress scenes — most-downstream and never shipped: nothing shipped may import it).
- `apps/`: `web` (Vite PWA), `server` (AWS Lambda re-sim validator), `mobile`
  (Capacitor), `desktop` (Tauri).

The decisive reason for a monorepo over separate repos: `apps/server` re-simulates
replays using the **same `packages/sim`** the client runs. Sharing one versioned
package — rather than syncing two repos — is what keeps client and server
simulations identical. The boundary is the package dependency graph:
`{types, engine} <- sim <- {render, replay, content} <- perf <- apps` — read as
layering shorthand: each layer MAY depend on anything to its left, not that every
drawn edge exists (`perf`, for instance, does not import `render`). Edges WITHIN a
layer are permitted and do exist — `render`'s and `replay`'s tests import
`@wynding/content`. What the graph forbids is a **back-edge**: an import of anything
strictly to the right. _(Corrected 2026-08-12: `types` and `engine` are both roots —
`engine` declares no dependency on `@wynding/types` (its only dependency is
`@noble/hashes`) — and `perf` was missing from the graph entirely.)_

**This graph is enforced by a lint rule generated from it** — `eslint.config.mjs`'s
layering zones, which derive each zone's forbidden set from the layer table above, and
each package's subpath spellings from that package's own `exports` map. (Generated is
exact, and its limit is worth stating: the two zones guarding the shipped **apps** are
hand-written, because they carry the never-ship invariant rather than the graph.)

Until 2026-08-22 this ADR said instead that "boundaries are enforced by the package
dependency graph", which overstated what pnpm and tsc give you. What they actually catch
is narrower: an _undeclared_ import fails to resolve, and a reference _cycle_ fails the
build. **Any declared, non-cyclic import passes both** — and two different violations
hide in that gap:

- a true **back-edge**, an import of something strictly to the right (`packages/sim`
  reaching `@wynding/content`);
- a declared import of a **never-shipped** package, which this graph positively permits:
  `apps/web/src` importing `@wynding/perf` is a _leftward_ edge, since `perf` is upstream
  of `apps`, and it is already a declared devDependency for the perf sandbox. It would
  have typechecked, linted and bundled into the shipped app without a murmur (#112).

The concession is worth recording either way: pnpm and tsc do genuinely catch cycles and
undeclared imports; what the tooling adds is protection against _declared_ violations,
which is exactly the kind a hurried refactor or a helpful bot produces. **Three** guards
now hold it — no one of them sufficient, and the third is not a formality:

1. **At the source:** the per-zone `no-restricted-imports` above, in `verify`'s lint. It
   reads specifiers, and does not inspect dynamic `import()` at all.
2. **At the artifact:** `pnpm run check:build-layering` (#129), which asks the bundler
   rather than the source text — no file the shipped **web** build emits may carry the
   never-shipped modules' markers, so a reach spelled as a relative path, a re-export, a
   root-relative specifier or a template literal is caught, Vite having already resolved
   it. Two limits, both real: it covers the web app only (`apps/server` ships too, and is
   bundled by esbuild, but this check does not read its output), and it matches
   **string-shaped markers**, so a reach that drags in no marker-bearing string — Rollup
   tree-shakes per module — can still pass. Vite resolving the specifier is necessary,
   not sufficient.
3. **At the source, cheaply:** `packages/perf/src/layering.test.ts`, the context-free grep
   over every shipped `src` tree. It is the only one of the three that covers
   `apps/server` and dynamic or comment-interrupted `import()` of the three never-shipped
   specifiers.

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
built only on these. A replay is
`{ seed, rulesetHash, simVersion, boardId, tickInputs }` (the `boardId` field is
added by ADR 0006); identical inputs must reproduce an identical world-hash. This is
a hard CI gate.

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
