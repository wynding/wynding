# ADR 0012 — A host declares itself to the web build; the web build never infers it

- **Status:** Accepted. The contract is decided here; the mechanism that carries it is
  [#135](https://github.com/wynding/wynding/issues/135)'s work, recorded in
  [ADR 0013](0013-host-build-is-a-separate-artifact.md).
- **Date:** 2026-08-18
- **Relates to:** ADR [0001](0001-monorepo-and-stack.md) §4 (cross-platform via a single web
  core — the decision this serves) · design note
  [`mobile-shell.md`](../design-notes/mobile-shell.md) (Open decision 1, which this closes) ·
  [#134](https://github.com/wynding/wynding/issues/134) and
  [#146](https://github.com/wynding/wynding/issues/146) (the defects that forced it).

## Context

ADR 0001 §4 makes the web build canonical and has every other platform wrap it: `apps/mobile`
(Capacitor) today, `apps/desktop` (Tauri) later. A **host** is that embedding application;
**hosted** is the
web build running inside one ([`CONTEXT.md`](../CONTEXT.md)).

Several behaviours are correct on the open web and wrong when hosted, because the web build
assumes it is a web page: that there is a site to navigate to, that it can be installed, that it
does not already own the screen. #146 enumerates three. They are not independent bugs — they are
one missing fact, consumed in three places.

So the web build has to learn whether it is hosted. There are only two shapes for that, and the
choice is not obvious, which is why it is recorded:

- **Infer it** — test for something a host leaves lying around: `window.Capacitor`, a
  `capacitor:` protocol, a user-agent fragment. Free, needs no cooperation from anyone, works the
  day it is written.
- **Be told it** — the host sets one documented fact; the web build reads it and nothing else.

**The fact that decides it:** inference is already in this codebase, and it is already wrong.
`install.ts` infers "am I installed?" from `matchMedia('(display-mode: standalone)')` and
`navigator.standalone`. Inside a WebView both report false — the app is not merely undetected but
confidently misidentified as an uninstalled web page, which is what produces two of #146's three
defects. The inference was not careless; it was correct for every environment that existed when
it was written. That is the failure mode: inference is a claim about the set of environments,
made by the one component that cannot see the set.

The second consideration is who bears the cost of a new host. An inferred test lives in the
canonical artifact, so `apps/web` ends up holding a registry of its own embedders — a list that
must be edited, from inside a different package, by whoever adds the next one. A host that is not
on the list is not detected, and the platform that would suffer that is the one nobody can test
today because it does not exist yet.

## Decision

**A host announces itself. The web build reads one documented fact and performs no detection of
its own** — no user-agent matching, no protocol test, no probing for a host's globals.

Three constraints define the fact, and each rules out a cheaper thing:

1. **It says "I am hosted", not "I am Capacitor".** The web build never learns which host it is
   in, because no correct behaviour depends on that. A per-host fact would let the two hosts
   diverge silently, and every consumer would then have to enumerate hosts to stay correct.
2. **It is supplied, not discovered.** It reaches consumers the way `install.ts` and `rotate.ts`
   already take `matchMedia`, a navigator shape and a storage adapter — as an injected dependency
   — so it is reachable in jsdom without a device and cannot be read from ambient state at the
   point of use.
3. **Absent means not hosted.** No host, no fact, and the web build behaves exactly as it does
   today. Hosting is the deviation from canonical behaviour, and it is the deviation that must be
   declared.

This closes Open decision 1 in the mobile-shell design note. It does **not** decide the
mechanism — what the fact is called, and how a host sets it before the bundle runs. That
belongs to #135, since that is where both native projects are created, and is decided in
[ADR 0013](0013-host-build-is-a-separate-artifact.md).

## Consequences

**A new host is a one-line obligation on the host, not an edit to the web build.** Tauri sets the
same fact Capacitor sets. `apps/web` never gains a list of platforms and never needs a change
when the third one arrives.

**The three #146 defects become one fix with three consumers**, rather than three fixes that can
drift apart. The scope boundary is an enumeration — every consumer of the fact — instead of a
judgement about which surfaces "feel native", which is the reasoning that missed the third one.

**Testable without a device.** Every consumer can be exercised in jsdom by supplying the fact
both ways. This matters more than it sounds: the existing e2e suite runs desktop Chromium on the
open web, which is precisely the environment in which all three affordances are correct, so it
can never fail on any of them.

**The cost, stated plainly: a host that forgets to declare itself gets the defects back.** This
is a real weakness and not one to paper over — declaration is not fail-safe, it is fail-quiet, in
the same way inference is. What it buys is that the obligation now sits with the component that
knows the answer, is satisfied in one place, and is written down. Inference puts the obligation on
the component that structurally cannot know. Both can be forgotten; only one can be looked up.

**A residual risk this does not remove:** nothing here proves a host's declaration is correct at
runtime, only that it is the host's to make. A host that declares itself and then behaves
unexpectedly is out of scope, and the first real device build is where that gets checked.
