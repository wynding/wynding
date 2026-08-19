# ADR 0013 — The host build is a separate artifact, and the declaration is baked into it

- **Status:** Accepted. This is the mechanism [ADR 0012](0012-host-declaration.md) deferred to
  [#135](https://github.com/wynding/wynding/issues/135).
- **Date:** 2026-08-19
- **Relates to:** ADR [0012](0012-host-declaration.md) (the contract this carries) · ADR
  [0001](0001-monorepo-and-stack.md) §4 (one web core, many hosts) · design note
  [`mobile-shell.md`](../design-notes/mobile-shell.md) · [#148](https://github.com/wynding/wynding/issues/148)
  (the second artifact this shape has to leave room for).

## Context

ADR 0012 decided that a **host** declares itself and the web build never infers. It deliberately
stopped short of the mechanism — what the fact is called, and how a host sets it before the bundle
runs — because that belongs where the native projects are created.

Two shapes were available:

- **Announced when the page loads.** The host arranges for the fact to be set before the app's
  module script runs. One artifact serves both the open web and every host.
- **Baked into the build.** A host is served by its own build of the same source, with the fact
  compiled in. Hosts package that build and nothing else.

ADR 0012 named the weakness that decides between them, in its own words: _"a host that forgets to
declare itself gets the defects back... declaration is not fail-safe, it is fail-quiet."_ The
mechanism is the only place left where that quietness can be narrowed, so the choice should be
made on which shape fails louder — not on artifact count.

They fail very differently. An announcement has to be inserted into the one file the build
generates, alongside asset references the build names by content hash; when that insertion misses,
the app boots perfectly and is silently wrong, which is precisely the failure ADR 0012 warned
about and precisely the failure no test in this repo can see — the e2e suite runs desktop
Chromium on the open web, where all three affordances are correct. A bake cannot be half-applied:
the artifact either carries the fact or was never produced.

## Decision

**A host is served by its own build of the web source, written to its own output, carrying the
hosted declaration as a build-time constant. A host packages that output and nothing else.**

Three consequences of that sentence are load-bearing, so they are stated as part of the decision
rather than left to be inferred:

1. **The declaration is set by the build that produces the artifact**, not by anything a host does
   afterwards. Tauri will produce its own host build the same way; neither host needs a runtime API
   from the other, which is what keeps the fact host-agnostic per ADR 0012 constraint 1.
2. **A host's packaged directory is one only a host build writes.** Packaging a plain web build is
   then a missing-directory failure at the packaging step, not an app that ships and misbehaves.
   This is the whole point of the choice.
3. **Producing a host build needs no native SDK.** It is a web build with a flag, so it belongs to
   the web package and is buildable on any machine and in CI. Only synchronising and compiling the
   native projects need a toolchain. The pipeline splits at that boundary, which is what keeps the
   second artifact from rotting unobserved.

## Consequences

**The artifact a player runs inside a host is not byte-identical to the one on the open web.** This
is the real cost and it should not be softened: they are separate builds of one source, so a defect
can in principle exist in one and not the other. What bounds it is that the difference is a single
compiled-in boolean whose every consumer is enumerable and unit-tested both ways in jsdom — which
ADR 0012 already required for its own reasons.

**A third build output joins `dist` and `dist-perf`.** Accepted deliberately. The alternative was
one artifact and a silent failure mode, and #148 already establishes that this repo has more than
one artifact for good reasons.

**The shape leaves room for #148's second host build without re-opening the host wiring.** A measurement
build is the same mechanism pointed at different web output; nothing about this decision assumes
exactly one host build exists.

**It does not remove ADR 0012's residual risk, only narrows it.** A host that packages the wrong
directory now fails loudly, but nothing here proves a host build's declaration is _correct_ on a
real device. The first device build is still where that gets checked.
