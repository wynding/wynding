# Mobile shell — the Capacitor wrap, in build order

Implements [ADR 0001](../adr/0001-monorepo-and-stack.md) §4 (_Cross-platform via a single web
core_): the web build is the canonical artifact and `apps/mobile` wraps it. ADR 0001 decided
**that**; this note is the **how** — what has to be built, in what order, and what the repo
already assumes that stops being true inside a WebView.

Tracked as epic [#134](https://github.com/wynding/wynding/issues/134) with sub-issues #135–#142,
#146 and #148.

## What this is for

Three capability gates, in priority order:

1. **An iOS device runs a build.** Cable, Xcode, free provisioning.
2. **An Android device runs a build.** A signed APK, sideloaded.
3. **The real-device measurement pass runs** — the one
   [ADR 0005](../adr/0005-performance-budgets.md) ruling (b) deferred to S11 and S11 shipped
   without. Ruling (b) names it "the real low-end **Android** device pass", so this gate needs
   part of the Android track and nothing from Gate 1 — see the build order for which part, since
   it is narrower than Gate 2.

Gate 3 is the one that pays for the other two. ADR 0005 pins **≥ 30 fps on a low-end Android
WebView** and calls that device the binding constraint; the S4b spike measured **66.8 ms** p95
low-end and **25.6 ms** mid-range — both breached — but through DevTools emulation on a
workstation. Ruling (d) lists what emulation cannot see, and every item is a property of real
hardware. The ADR's own words: _"cheap to act on now, catastrophic to discover after the game is
built."_

## What this is not

Not Phase 5. No store accounts, no listings, no store review, no public release. These are
development and playtest builds installed over a cable. Distribution to the public is a separate
decision at a later phase, and nothing here presumes it.

## Build order

```text
Shared prerequisites — Tracks A and C, apps/web only, no native SDK needed
    #139  pause-on-background
    #140  wake lock
    #146  install + home link

Gate 1 — an iOS device plays a build
    the shared prerequisites
    #135  iOS half ............... needs Xcode

Gate 2 — an Android device plays a build
    the shared prerequisites
    #135  Android half ........... needs the Android SDK
    #136  edge-to-edge ──► #137  signed APK      (in that order)
    #138  Back button ............ any time after the Android platform exists

Gate 3 — the measurement ADR 0005 ruling (b) deferred
    #135 Android half + #148 — not #137 or #138
    #136 too, unless #148 isolates the perf layout (ui.css is in that build)
    #148  perf-harness device build ──► #141  real-device pass
    the play APK cannot measure; it ships none of the harness
    an iOS pass is a useful extension, never a prerequisite

Unscheduled
    #142  settings persistence — blocks nothing, blocked by nothing
```

The two device gates are siblings, not a chain: Gate 2 does not wait on Gate 1. Neither half of
#135 blocks the other, and the shared prerequisites are the only thing both need.

### Track A — web lifecycle, start now

**#139** (pause when backgrounded) and **#140** (wake lock) are `apps/web` changes. They need no
native toolchain, they are unit-testable at the existing `ensurePaused` seam
(`apps/web/src/main.ts:323`), and they are real gaps in the **web** build too. Landing them first
means the very first device build already behaves — rather than advancing waves in a pocket and
flattening a battery on the first playtest.

They are also the two smallest items in the epic. With #146 they form the shared prerequisite
block: three issues, all in `apps/web`, all unit-testable with no device and no native build. That
made them the only available work while the SDKs were still downloading, and it keeps them the
cheapest place to start now that both are in — nothing about them can be blocked by a toolchain
problem.

### Track B — the shell (#135)

Split the issue's two halves explicitly, because **the iOS half alone clears Gate 1**. Nothing in
Track D is on the iOS path: signing (#137) and edge-to-edge (#136) are both Android-only. iOS
free provisioning needs a Mac, Xcode, a cable, and a free Apple Account — 7-day rolling expiry, 3
devices per platform, re-signed by replugging.

### Track C — corrections the WebView forces (#146)

See [Findings](#findings). This is **on the critical path for Gate 1**, not cleanup: the
affordances involved are among the most likely first-minute interactions, and one of them ends a
run. The code is `apps/web` and can be written before either SDK exists; only its verification
waits on #135.

### Track D — Android distribution

Order matters. **#136 before #137**: a signed APK of a broken layout is a wasted
build-install-look cycle. **#138** (Back button) can land any time after the Android platform
exists; it shares the `ensurePaused` seam with #139 and the two may share a PR.

Be precise about when #136 actually bites, because it decides which device can witness it.
Edge-to-edge is enforced when an app **targeting SDK 35+ runs on Android 15+** — both halves are
required. Capacitor 8 compiles and targets API 36, so our side of the condition is always met, and
the trigger is therefore the **first run on an Android 15 or newer device**. On Android 14 and
below the same APK will not reproduce it. Worth confirming the test device's OS version before
concluding from a clean run that the issue is absent.

### Track E — measurement (#141)

**Needs Android only, and not all of Gate 2.** ADR 0005 ruling (b) defers "the real low-end Android
device pass", and the budget it exists to test is stated against the low-end Android WebView, which
the ADR calls the binding constraint. Nothing from the iOS side is required; measuring iOS is a
worthwhile extension, never a prerequisite.

The Android prerequisite is narrower than the playable gate: this pass runs #148's separate
artifact, so it needs the **Android half of #135 plus #148** and an installable build — not
release signing (#137, which gates the distributable play APK) and not the Back button (#138).
Gate 3 is therefore reachable before Gate 2 closes, which matters given that it is the outcome
justifying the epic.

**But the perf artifact must render under the same conditions as the play build**, or its numbers
describe something we do not ship. That is not automatic today — the perf entries inherit the app's
stylesheet and set no viewport metadata — and until it holds, **#136 is a prerequisite on Android
15+ devices** rather than exempt. #148 owns making the two artifacts comparable and records what
that takes.

That distinction is worth stating precisely rather than leaving implied, because it decides
scheduling. Gate 3 is the outcome that justifies the epic, and any iOS work placed in front of it
serialises the measurement behind something ADR 0005 never asked for. The point held sharply while
Xcode was still absent — it would have parked the whole payoff behind a download — and it still
holds now that both toolchains are provisioned, because the Android and iOS tracks can then run
independently rather than one waiting on the other.

**It also needs a second artifact, which is #148.** The Gate 2 APK cannot perform this measurement.
The shell wraps the **Host build** (`apps/web/dist-host` — ADR 0013), and the perf harness is
deliberately not in it — `vite.perf.config.ts`
builds to `dist-perf/` from entries production never references, and states the guarantee itself:
the perf build is _"STRUCTURALLY incapable of entering the production artifact."_ So the play build
ships no stress scene, no measurement surface, and no stress ruleset.

Gate 3 therefore needs a development-only build packaging `dist-perf`, and **must not** be solved
by merging the two graphs — that would trade the structural guarantee and ADR 0005's < 3 MB
initial-load budget for convenience. Two artifacts: one playable, one measurable. Since it decides
whether the shell has one build target or two, #148 belongs with #135's work rather than after it.
The packaging is less obvious than it looks — #148 records why, and what the entry point has to do.

### What #141 must record

Reproduce [`performance-spike.md`](performance-spike.md) §Methodology so the numbers are comparable
— including the WebGL renderer string, which the spike pins per run because an fps figure whose
rasterizer is unrecorded cannot be interpreted at all.

**Then exceed it, because the spike's methodology is deficient by ADR 0005's own account.** Ruling
(d) records that no thermal or power state is pinned by that pass, and that every figure is a
10-second window on a mains-powered workstation that never got warm — which is exactly why thermal
throttling heads its list of unvalidated properties. Reproducing the spike's method faithfully on a
phone would therefore reproduce its blind spot: a cold 10-second run can pass while saying nothing
about the first thing this pass exists to test. So #141 additionally pins battery and thermal state.

**And the thermal load has to coincide with the peak workload, which does not happen by itself.**
The stress scenario's creep population peaks just past the last spawn and drains from there, so a
device playing one arc from cold is hottest only after most of the workload has gone — yielding
acceptable percentiles that never sampled the full scene under throttling. That is a false pass,
and the most expensive kind, because it reads as validation of the budget. The run must soak before
sampling, or hold or repeat the peak and sample there. #141 carries the specifics.

## Findings

Three things the survey turned up that the original #135–#142 did not cover. The first two are one
class — **the web build assumes it is running in a browser on the open web**, and that assumption
is false inside a WebView. They are filed together as **#146**. The third sharpens **#136** and is
recorded there.

The class is bounded by enumeration rather than judgement: every consumer of the bad state, which
is `overlay.ts` and `main.ts` and nothing else. Scoping it by reading each module instead misses
the second one, because that module is correct on its own terms and only its **call site** is
wrong.

### 1. `install.state()` is wrong in a WebView, and two features act on it

`install.ts` decides whether the app is already installed from
`isStandalone() = matchMedia('(display-mode: standalone)').matches || navigator.standalone`.
Inside a Capacitor WebView **both are false** — `display-mode` reports `browser` and
`navigator.standalone` is a Safari-only flag. `installed` is also false, having only ever been set
by an `appinstalled` event that never fires.

That single wrong fact has **two consumers**, and they are the complete set: a grep for
`install.state()` outside the module itself returns `overlay.ts` and `main.ts`, and nothing else.

**Consumer 1 — the install UI** (`overlay.ts:759`, now
`hidden = state.standalone || state.installed || state.hosted` — the `hosted` term is the fix):

- **iOS** — `branch()` returns `'ios'` on a UA match, and `bannerAudience` is
  `coarse && (branch === 'promptable' || branch === 'ios')`, so the pre-start banner shows and its
  action opens the **"Add to Home Screen" instructions dialog** — inside a native app that is
  already on the home screen.
- **Both platforms** — the settings row is documented as **PERMANENT** (`overlay.ts:386`), so it
  never goes away, telling the player how to install what they are running.

**Consumer 2 — the one-shot fullscreen request on Start** (`main.ts:449`, which passes
`s.standalone || s.installed` as `requestFullscreen`'s `isStandalone` dep; the fix added a
separate `hosted` gate inside `fullscreen.ts` rather than folding it in here). `fullscreen.ts` fires
when `requestFullscreen` exists, the pointer is coarse, and the app is _not_ standalone — so on a
coarse-pointer device whose WebView exposes the API, pressing Start requests fullscreen inside a
native shell that already owns the whole screen.

Its own severity is low — it no-ops on iOS. It is in scope because it is the **second consumer of
the same wrong fact**, so fixing `overlay.ts` alone leaves the two call sites disagreeing about
whether the app is installed, which is worse than fixing neither.

Fix at the capability level, not by UA sniffing: the shell knows it is the shell, and that fact
reaches `install.ts` as an injected dep, consistent with how the module already takes `matchMedia`
and its storage adapter. Both consumers then follow from the corrected state.

The diagnosis is reasoned, not observed — no device build exists yet. The remedy is deliberately
insensitive to that: injecting shell-presence is correct whatever the media query reports, which
is the argument for injection over inference. Confirm the real values while implementing; depend
on none of them.

### 2. The home link ends the run and lands nowhere

`HOME_HREF` is `'/'` (`shell.ts:229`) — deliberately root-absolute so it stays correct under the
production `--base=/play/` rewrite, and used by exactly two call sites that are one declaration
on purpose: the wordmark anchor (`shell.ts:379`, now built as an anchor only when NOT hosted) and
the confirmed-exit navigation (`main.ts:554` → `location.assign`).

Inside Capacitor, `/` resolves against `capacitor://localhost` (iOS) or `https://localhost`
(Android) — **the app's own root**. So the flow is: tap the mark, confirm the "leave" dialog,
lose the run, and arrive at a reload or a blank view. There is no website at the other end.

`shell.ts` already flags the PWA version of this as a KNOWN CONSEQUENCE (out-of-scope navigation
drops an installed player out of the standalone window). The WebView case is worse, because there
is nowhere to be dropped to.

Severity note, since it would be easy to assume a phone is spared: in Compact
(`@media (max-height: 500px)`) only `.wy-wordmark` — the **text** — is set to `display: none`.
`.wy-home` itself is restyled as a mark-only in-flow item and explicitly keeps the ADR 0003
**44px touch floor**. It is a first-class tap target on exactly the devices this epic targets.

### 3. The safe-area surface is 18 declarations, and CI pins the broken state as correct

Sharpens **#136**, whose title said "19 places" and has been corrected. `ui.css` uses
`env(safe-area-inset-*)` on 20 lines, but two of those are inside comments — **18 live
declarations**, of which two pass a fallback (`--wy-compact-col` at line 54, `--wy-rail-w` at
line 1211) and sixteen do not.

**The fallback count is not the defect** — worth stating so nobody spends a day adding sixteen
fallbacks for nothing. A fallback only applies where `env()` is supported and the variable is
unset, so it cannot rescue a declaration from an engine that cannot parse the function.

The real failure is the opposite shape: `env()` **is** supported in these WebViews, so the
declarations compute normally — against **zero insets**, because enforced edge-to-edge does not
necessarily propagate the system insets into the web layer. Content ends up under the system bars.
That is what the ecosystem's workarounds address (Capacitor's injected `--safe-area-inset-*`
properties, `@capacitor-community/safe-area`) — values present and wrong, not a missing function.
Neither is automatic; both are conditional, and which to adopt is #136's call.

The two declarations _with_ fallbacks are the **load-bearing** ones: `--wy-compact-col` and
`--wy-rail-w` are track sizes computed from insets, so zeroed insets move the layout's geometry
rather than only its spacing.

**The consequence that changes the estimate:** the existing e2e suite cannot verify this. It runs
where insets are always zero, and for the top axis the inset lands in internal padding inside a
grid row whose edge does not move — so bounding-box assertions cannot see it at any inset value.
#136 needs a harness that injects inset values and asserts padding or descendant position, which
is a more invasive assertion than the suite currently makes. The traced analysis is on #136.

## Repo hygiene — `cap sync` will break CI

`verify` runs `prettier --check .` repo-wide, and `cap sync` copies the web bundle into the native
projects as HTML, JS, CSS and JSON — all of which prettier parses. **The first `cap sync` turns
`format:check` red**, and generated config inside the projects is caught too, not only the copied
`public/` trees. Native sources are unaffected; prettier has no parser for them. The verified path
list is on #135, where the work happens.

**Decided: the generated `ios/` and `android/` projects are committed**, following Capacitor's
convention. They are where native config has to live — permissions, signing, the edge-to-edge
handling of #136 — so generating on demand would leave that material homeless. The cost is
accepted: a large, churn-prone tree in a public repo.

That decision requires `.gitignore` and `.prettierignore` entries **in the same change** as
`cap add`, not as a follow-up. The copied `public/` trees are gitignored outright — they are build
output, and committing them would duplicate the whole web bundle on every build. Committing the
projects and committing their synced payload are different things; only the first is wanted.

Related constraints:

- **CI can build Android; it cannot build iOS.** Every job in `ci.yml` is `ubuntu-latest`. iOS
  needs a macOS runner, so iOS builds stay local for this epic. Android does not: GitHub's Ubuntu
  runner image ships a JDK and the Android SDK, and a Gradle build needs no GUI, so
  `./gradlew assembleDebug` is a viable CI gate once the platform exists. Worth adding rather
  than leaving native Android changes validated only on one machine. Out of scope here, but
  nothing in this note should be read as ruling it out.
- **`apps/mobile` is already a workspace package** (`pnpm-workspace.yaml` globs `apps/*`) with no
  scripts, and Turbo will pick up whatever it gains. The exposure is wider than `verify`: the CI
  job runs `pnpm run build` — `turbo run build` — immediately afterwards as a build smoke gate
  compiling every package (`ci.yml:43`). So an `apps/mobile#build` that shells out to Capacitor or
  either native SDK is selected automatically and breaks the Ubuntu runner, and breaks local
  builds on any machine without both toolchains. **`build` is the dangerous name**, alongside
  `typecheck`, `lint` and `test`. Native sync and build belong under explicitly named scripts that
  no root Turbo task selects — or the root `build` task must exclude this package deliberately.
- **The mobile build must not use `--base=/play/`.** Capacitor serves from the WebView root, so
  the default base is the correct one — plain `pnpm --filter @wynding/web build`. Worth stating
  because the deploy path uses the rewrite and reusing that invocation is the obvious mistake.
- **There is no service worker** anywhere in `apps/web`, which removes the usual Capacitor
  stale-asset hazard. `viewport-fit=cover` is already set in `index.html`.

## Toolchain — provisioned 2026-08-18

Capacitor 8 requires min iOS 15 / Android API 24, compile and target **API 36**, Android Studio
Otter or newer, and uses SPM by default for newly added iOS platforms. The development machine now
meets all of it. Both native SDKs were absent when this note was first written and were installed
the same day; the table records the provisioned state.

| Component      | State                                                        | Verdict                                    |
| -------------- | ------------------------------------------------------------ | ------------------------------------------ |
| Node           | v26.0.0                                                      | ✅ repo needs ≥ 22                         |
| pnpm           | 10.33.0                                                      | ✅ exactly the `packageManager` pin        |
| JDK            | OpenJDK 21.0.10 (Homebrew)                                   | ✅ what AGP needs for API 36               |
| Xcode          | 26.6 (17F113), iOS SDK 26.5                                  | ✅ first-launch components in, licence in  |
| Android SDK    | platform 36, build-tools 36.0.0, platform-tools 37.0.1 (adb) | ✅ the API 36 target Capacitor 8 wants     |
| Android Studio | 2026.1                                                       | ✅ past the Otter floor                    |
| CocoaPods      | absent                                                       | ⚠️ expected — Capacitor 8 uses SPM instead |

Two details worth keeping, because both cost time to rediscover. `xcode-select` retargeted itself
to `/Applications/Xcode.app/Contents/Developer` when Xcode first launched, so no `sudo xcode-select
-s` was needed. And the iOS **SDK** arrives with Xcode itself, ahead of the simulator runtimes that
continue downloading afterwards — device deployment does not wait on those.

The Android SDK lives at `/opt/homebrew/share/android-commandlinetools` (Homebrew cask), with
`ANDROID_HOME` and `platform-tools` exported from `~/.zshrc`.

## Open decisions

1. ~~**How does the shell announce itself to the web layer?**~~ **CLOSED by
   [ADR 0012](../adr/0012-host-declaration.md).** The **host** declares one documented fact and
   the web build performs no detection of its own. Its three consumers have since shipped, so a
   reader should no longer schedule around this as open.

   (Terminology: this note predates `CONTEXT.md`'s glossary and says "shell" throughout for what
   is now ratified as a **Host** — the application that embeds the web build. `Shell` is reserved
   there for the web build's own outer structure, so the closing text below uses **host**.)

   The fact to inject is **"am I hosted?", not "am I inside Capacitor?"** ADR 0001 §4 has
   `apps/desktop` (Tauri) wrapping the same web build, so a Capacitor-specific check reads false
   there and hands the desktop app the same defects — silently, on a platform that does not exist
   yet, after the dependency has accumulated call sites. Either host must be able to supply it.

   What remains with #135 is the MECHANISM alone — what the fact is called on the wire, and how a
   host sets it before the bundle runs — since that is where both native projects are created.

2. **Scope of the `StorageDriver` seam in #142** — settings only, or all four ADR 0008 categories.
   Recorded in the issue; restated here because it is a real trade-off (a narrow seam risks a
   Phase 2 rewrite; a general one is a much larger job this epic does not justify).

## Relationship to M2

**No scheduling dependency, but one inherited obligation.** Those are different things and the
distinction matters, so both are stated.

Nothing here blocks or is blocked by the M2 stories in flight. This track touches `apps/mobile`
(empty), the two lifecycle modules, and — for Finding 1 — `install.ts`, `overlay.ts`, `main.ts`
and `shell.ts`, none of which an M2 story owns. Ordering the two tracks against each other is a
scheduling choice.

What #141 **does** inherit is a deferral M2 recorded rather than closed, so it should not be read
as new work invented by this epic:

- `m2.md` logs the ruling of 2026-07-31 that the over-budget ADR 0005 spike gets a real-device
  pass at S11. S11 shipped without it. #141 is where that pass now lives.
- `m2.md` ruling 6 (2026-08-08) records that **#36** cannot close at S12, its absence re-accepted
  at the S11 close-out on 2026-08-09. #141 closes as much of that backlog as real hardware allows.

Keep the two kinds of evidence apart when #141 reports. The **performance** result is measured
against ADR 0005's pinned budgets and either validates the provisional numbers or triggers the
spike's Finding 1 escalation. The **accessibility** result is #36's checklist evidence, judged
against its own items. They come from the same device session and answer different questions;
merging them would let a pass on one imply a pass on the other.
