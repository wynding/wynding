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
   Gate 2 and not Gate 1.

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
    Gate 2 ONLY — ruling (b) defers "the real low-end Android device pass"
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

**Needs Android only.** ADR 0005 ruling (b) defers "the real low-end Android device pass", and the
budget it exists to test is stated against the low-end Android WebView, which the ADR calls the
binding constraint. So Gate 3 requires Gate 2 — a signed APK that survives a reboot — and nothing
from the iOS side. Measuring iOS too is worth doing and tells us something real, but it is an
extension of this pass, never a prerequisite for it.

That distinction is worth stating precisely rather than leaving implied, because it decides
scheduling. Gate 3 is the outcome that justifies the epic, and any iOS work placed in front of it
serialises the measurement behind something ADR 0005 never asked for. The point held sharply while
Xcode was still absent — it would have parked the whole payoff behind a download — and it still
holds now that both toolchains are provisioned, because the Android and iOS tracks can then run
independently rather than one waiting on the other.

**It also needs a second artifact, which is #148.** The Gate 2 APK cannot perform this
measurement: the shell wraps `apps/web/dist`, and the harness is not there. `vite.perf.config.ts`
builds `perf/index.html` and `perf/catalog.html` to `dist-perf/`, `main-perf.ts` exposes
`window.wyndingPerf` from a graph production never reaches, and the config states the property
deliberately — there being no path from `vite.config.ts` to it, the perf build is _"STRUCTURALLY
incapable of entering the production artifact."_ The play build therefore ships no stress scene, no
measurement surface, and no access to the 40×40 stress ruleset, which is absent from the bundled
registry by design.

So Gate 3 needs a development-only WebView build packaging `dist-perf`, and the fix must not be to
merge the two graphs — doing that would trade the structural guarantee and ADR 0005's < 3 MB
initial-load budget for convenience. Two artifacts, one playable and one measurable. Because it
decides whether the shell has one build target or two, #148 belongs with #135's work rather than
after it.

**Pointing `webDir` at `dist-perf` is not sufficient and would not boot.** The perf config's input
is `perf/index.html`, so the build emits `dist-perf/perf/index.html` and **no** `dist-perf/index.html`
— `playwright.perf.config.ts` records that the origin `/` 404s, which is why its own readiness poll
targets `/perf/index.html` rather than the bare origin. A shell loading its asset root would open on
that 404. #148 has to stage a root entry or route the native entry point explicitly at
`/perf/index.html`.

### What #141 must record

Reproduce [`performance-spike.md`](performance-spike.md) §Methodology so the numbers are comparable
— including the WebGL renderer string, which the spike pins per run because an fps figure whose
rasterizer is unrecorded cannot be interpreted at all.

**Then exceed it, because the spike's methodology is deficient by ADR 0005's own account.** Ruling
(d) records that no thermal or power state is pinned by that pass, and that every figure is a
10-second window on a mains-powered workstation that never got warm — which is exactly why thermal
throttling heads its list of unvalidated properties. Reproducing the spike's method faithfully on a
phone would therefore reproduce its blind spot: a cold 10-second run can pass while saying nothing
about the first thing this pass exists to test. So #141 additionally pins battery and thermal state,
and measures over a sustained run — a full arc played to its terminal, not a snapshot.

## Findings

Three things the survey turned up that the original #135–#142 did not cover. The first two are one
class — **the web build assumes it is running in a browser on the open web**, and that assumption
is false inside a WebView. They are filed together as **#146**. The third sharpens **#136** and is
recorded there.

A note on how that class was scoped, because the first attempt got it wrong. The original sweep
read the candidate modules and judged each on its own logic, which cleared `fullscreen.ts` — its
gate is capability-based, it renders nothing, and it no-ops on iOS. That was the wrong unit of
analysis: the defect is not in the module but in the state its **call site** feeds it, and
`main.ts` passes the same broken `install.state()` pair into it. The scoping that actually holds
is by wrong fact rather than by module — enumerate every consumer of the bad state, which is a
grep with a definite answer, instead of asking module by module whether it looks safe. Doing that
gives `overlay.ts` and `main.ts` and nothing else, which is the boundary claimed below.

### 1. `install.state()` is wrong in a WebView, and two features act on it

`install.ts` decides whether the app is already installed from
`isStandalone() = matchMedia('(display-mode: standalone)').matches || navigator.standalone`.
Inside a Capacitor WebView **both are false** — `display-mode` reports `browser` and
`navigator.standalone` is a Safari-only flag. `installed` is also false, having only ever been set
by an `appinstalled` event that never fires.

That single wrong fact has **two consumers**, and they are the complete set: a grep for
`install.state()` outside the module itself returns `overlay.ts` and `main.ts`, and nothing else.

**Consumer 1 — the install UI** (`overlay.ts:750`, `hidden = state.standalone || state.installed`):

- **iOS** — `branch()` returns `'ios'` on a UA match, and `bannerAudience` is
  `coarse && (branch === 'promptable' || branch === 'ios')`, so the pre-start banner shows and its
  action opens the **"Add to Home Screen" instructions dialog** — inside a native app that is
  already on the home screen.
- **Both platforms** — the settings row is documented as **PERMANENT** (`overlay.ts:381`), so it
  never goes away, telling the player how to install what they are running.

**Consumer 2 — the one-shot fullscreen request on Start** (`main.ts:376`, which passes
`s.standalone || s.installed` as `requestFullscreen`'s `isStandalone` dep). `fullscreen.ts` fires
when `requestFullscreen` exists, the pointer is coarse, and the app is _not_ standalone — so on a
coarse-pointer device whose WebView exposes the API, pressing Start requests fullscreen inside a
native shell that already owns the whole screen.

This one is easy to dismiss on its own and should not be. Read in isolation `fullscreen.ts` looks
safe: its gate is capability-based by design, it renders no affordance, and on iOS it simply
no-ops because WKWebView has no element fullscreen. The defect is not in the module, it is in what
the call site feeds it — which is exactly why an audit of these modules one at a time misses it.
Its own severity is low; its significance is that it is the second consumer of the same wrong
fact, so a fix wired into `overlay.ts` alone leaves the codebase in the worst state of the three:
inconsistent.

Fix at the capability level, not by UA sniffing: the shell knows it is the shell, and that fact
should reach `install.ts` as an injected dep, consistent with how the module already takes
`matchMedia` and its storage adapter. Both consumers then follow from the corrected state without
either of them learning what a WebView is.

One honest caveat on the diagnosis, which the remedy is deliberately insensitive to. What a
Capacitor WebView reports for `(display-mode: standalone)` is reasoned here from the fact that
neither WKWebView nor Android's WebView implements manifest display modes — which is why Capacitor
ships `isNativePlatform()` at all — but it has not been observed on a device, because no device
build exists yet. If some WebView does report `standalone`, the diagnosis narrows and the fix does
not change: injecting shell-presence explicitly is correct regardless of what the media query
answers, and is the reason to prefer it over inferring the environment. Confirm the reported value
while implementing; do not build anything that depends on it.

### 2. The home link ends the run and lands nowhere

`HOME_HREF` is `'/'` (`shell.ts:221`) — deliberately root-absolute so it stays correct under the
production `--base=/play/` rewrite, and used by exactly two call sites that are one declaration
on purpose: the wordmark anchor (`shell.ts:340`) and the confirmed-exit navigation
(`main.ts:471` → `location.assign`).

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

**That fallback count is not the defect, and it is worth saying so before someone spends a day on
it.** A fallback lives _inside_ `env()`, so an engine that cannot parse the function invalidates
the declaration either way — `env(x, 0px)` and `env(x)` fail identically. The fallback only does
work when `env()` _is_ supported and the named variable is unset. Adding sixteen fallbacks would
change nothing.

The real failure mode is the opposite shape. `env()` is supported across every WebView Capacitor 8
targets, so the declarations parse and compute fine — they just compute against **zero insets**,
because under Android's enforced edge-to-edge the system insets are not necessarily propagated
into the web layer. Nothing is dropped; everything resolves as though the display had no notch and
no navigation bar, and content sits underneath the system bars. That is why the ecosystem's
workarounds exist at all — Capacitor's own injected `--safe-area-inset-*` custom properties, and
`@capacitor-community/safe-area`. Both address values that are present and wrong, not a function
that is missing.

Do not treat Capacitor's injection as automatic. It arrives in 8.3.2+, runs through the Android
`SystemBars` path on API 35+ only, is conditional on inset handling being enabled, and checks for
`viewport-fit=cover` (which `index.html` already sets). API 34 and below take a different path,
and it does not speak to iOS. `apps/mobile` has no Capacitor dependency yet, so none of it is
configured. Which mechanism to adopt, and how to configure it, is #136's call — this note records
that the choice exists and what it is conditional on, deliberately without pre-empting the
setting.

The two _with_ fallbacks still matter, for a different reason: they are the **load-bearing** ones.
`--wy-compact-col` and `--wy-rail-w` are track sizes computed from insets, so zeroed insets move
the layout's geometry, not just its padding.

The sharpest consequence is for verification, and it is worth stating exactly rather than
dramatically. `compact.spec.ts` never mentions insets at all. It runs in headless Chromium, where
`env(safe-area-inset-*)` is always 0, so the geometry it pins is zero-inset geometry:
`stage.y <= 1`, `status.y <= 1`, and `status.width <= 96` against a track that computes to 64px at
the 658×320 phone viewport.

Two consequences follow, and only the second is a real blind spot:

- The suite is **not** incapable of noticing an inset — a genuine top inset would push the stage
  down and trip `status.y <= 1`. It simply never encounters one, because the environment cannot
  produce one. The path is unexercised, not unguarded.
- The width assertion carries **32px of slack** over the value it actually computes, so a left
  inset up to that size would pass unremarked even if the harness did produce one.

So a green `compact.spec.ts` is not evidence about #136 either way, and verifying it needs a real
WebView or a harness that injects inset values deliberately.

## Repo hygiene — `cap sync` will break CI

`verify` runs `prettier --check .` across the whole repo, and `.prettierignore` currently excludes
only build output, generated i18n, and the locally-gitignored planning docs. `cap sync` copies
`apps/web/dist` into the native projects:

- `apps/mobile/android/app/src/main/assets/public/**`
- `apps/mobile/ios/App/App/public/**`

Those are HTML, JS, CSS and JSON — all parseable by prettier, none formatted to its taste. The
first `cap sync` therefore turns `format:check` red.

The exact scanned surface, checked with `prettier --file-info` rather than assumed, because it
decides how wide the ignore entries have to be:

| Path                                                       | Prettier                 |
| ---------------------------------------------------------- | ------------------------ |
| `android/app/src/main/assets/public/index.html`            | ✅ scanned (html)        |
| `ios/App/App/public/assets/*.js`                           | ✅ scanned (babel)       |
| `android/app/src/main/assets/capacitor.config.json`        | ✅ scanned (json)        |
| `capacitor.config.ts` (ours, hand-authored)                | ✅ scanned (ts) — wanted |
| `AppDelegate.swift`, `build.gradle`, `*.kt`, `strings.xml` | skipped, no parser       |

So the hazard is **not only the copied `public/` trees**. Generated JSON inside the native
projects — `capacitor.config.json` among it — is scanned too, while Swift, Gradle, Kotlin and XML
are skipped for lack of a parser rather than by any ignore rule. Our own `capacitor.config.ts`
should stay scanned; it is source we author.

**Decided: the generated `ios/` and `android/` projects are committed**, following Capacitor's
convention. They are where native config has to live — permissions, signing, the edge-to-edge
handling of #136 — so generating them on demand would leave that material homeless and make the
build depend on reproducing `cap add` exactly. The cost is accepted: a large, churn-prone tree in
a public repo.

That decision requires `.gitignore` and `.prettierignore` entries **in the same change** as
`cap add`, not as a follow-up. The copied `public/` trees are gitignored outright: they are build
output, reproducible by `cap sync`, and committing them would duplicate the entire web bundle
into the repo on every build. Committing the projects and committing their synced payload are
different things, and only the first is wanted.

Related constraints:

- **CI can build Android; it cannot build iOS.** Every job in `ci.yml` is `ubuntu-latest`. iOS
  needs a macOS runner, so iOS builds stay local for this epic. Android does not: GitHub's Ubuntu
  runner image ships a JDK and the Android SDK, and a Gradle build needs no GUI, so
  `./gradlew assembleDebug` is a viable CI gate once the platform exists. Worth adding rather
  than leaving native Android changes validated only on one machine. Out of scope here, but
  nothing in this note should be read as ruling it out.
- **`apps/mobile` is already a workspace package** (`pnpm-workspace.yaml` globs `apps/*`) with no
  scripts. Whatever scripts it gains must not put a native toolchain on
  `turbo run typecheck lint test`, or `verify` fails on every machine without Xcode.
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

1. **How does the shell announce itself to the web layer?** Finding 1 needs it, #138 and #139
   probably want it. Decide once, in #135, before several call sites each invent their own.

   The fact to inject is **"am I inside a host shell?", not "am I inside Capacitor?"** — and the
   difference is not hypothetical. ADR 0001 §4 has `apps/desktop` (Tauri) wrapping the same
   canonical web build, so a `Capacitor.isNativePlatform()` check would read false there and hand
   the Tauri app exactly the defects Finding 1 describes: an install prompt inside an installed
   desktop app, and every later consumer of this fix silently wrong on that platform. A
   Capacitor-shaped dependency would have to be replaced the day desktop starts, having quietly
   accumulated call sites in the meantime.

   So the seam is a host-shell fact that either wrapper can supply — a build-time flag set by
   whichever shell is building is the obvious candidate, since it needs no runtime API from either.
   The detection mechanism stays behind that boundary and can differ per wrapper.

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
