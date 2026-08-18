# Mobile shell — the Capacitor wrap, in build order

Implements [ADR 0001](../adr/0001-monorepo-and-stack.md) §4 (_Cross-platform via a single web
core_): the web build is the canonical artifact and `apps/mobile` wraps it. ADR 0001 decided
**that**; this note is the **how** — what has to be built, in what order, and what the repo
already assumes that stops being true inside a WebView.

Tracked as epic [#134](https://github.com/wynding/wynding/issues/134) with sub-issues #135–#142
and #146.

## What this is for

Three capability gates, in priority order:

1. **An iOS device runs a build.** Cable, Xcode, free provisioning.
2. **An Android device runs a build.** A signed APK, sideloaded.
3. **The real-device measurement pass runs** — the one
   [ADR 0005](../adr/0005-performance-budgets.md) ruling (b) deferred to S11 and S11 shipped
   without.

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

```
Gate 1 — an iOS device plays a build
    #139  pause-on-background  ┐
    #140  wake lock            ├─ Track A + C: apps/web only, no native SDK needed
    #146  install + home link  ┘
    #135  iOS half ............... needs Xcode

Gate 2 — an Android device plays a build
    everything in Gate 1
    #135  Android half ........... needs the Android SDK
    #136  edge-to-edge ──► #137  signed APK      (in that order)
    #138  Back button ............ any time after the Android platform exists

Gate 3 — the measurement ADR 0005 deferred
    Gates 1 and 2
    #141  real-device pass

Unscheduled
    #142  settings persistence — blocks nothing, blocked by nothing
```

### Track A — web lifecycle, start now

**#139** (pause when backgrounded) and **#140** (wake lock) are `apps/web` changes. They need no
native toolchain, they are unit-testable at the existing `ensurePaused` seam
(`apps/web/src/main.ts:323`), and they are real gaps in the **web** build too. Landing them first
means the very first device build already behaves — rather than advancing waves in a pocket and
flattening a battery on the first playtest.

They are also the two smallest items in the epic, and the toolchain audit below makes their
position load-bearing rather than merely tidy: neither native SDK is installed yet. Together with
#146 they are the work that can proceed while those downloads run — three issues' worth, all of
it in `apps/web` and all of it unit-testable without a device.

### Track B — the shell (#135)

Split the issue's two halves explicitly, because **the iOS half alone clears Gate 1**. Nothing in
Track D is on the iOS path: signing (#137) and edge-to-edge (#136) are both Android-only. iOS
free provisioning needs a Mac, Xcode, a cable, and a free Apple Account — 7-day rolling expiry, 3
devices per platform, re-signed by replugging.

### Track C — corrections the WebView forces (#146)

See [Findings](#findings). This is **on the critical path for Gate 1**, not cleanup: the two
affordances involved are among the most likely first-minute interactions, and one of them ends a
run. The code is `apps/web` and can be written before either SDK exists; only its verification
waits on #135.

### Track D — Android distribution

Order matters. **#136 before #137**: a signed APK of a broken layout is a wasted
build-install-look cycle, and edge-to-edge is enforced for anything targeting SDK 35+, so the
first Android build hits it immediately. **#138** (Back button) can land any time after the
Android platform exists; it shares the `ensurePaused` seam with #139 and the two may share a PR.

### Track E — measurement (#141)

Needs a build on both platforms and, on Android, a signed APK that survives a reboot. Record what
[`performance-spike.md`](performance-spike.md) §Methodology records, so the numbers are
comparable — including the WebGL renderer string, which the spike pins per run because an fps
figure whose rasterizer is unrecorded cannot be interpreted at all.

## Findings

Three things the survey turned up that the original #135–#142 did not cover. The first two are
one class — **the web build assumes it is running in a browser on the open web**, and that
assumption is false inside a WebView. A sweep of `apps/web/src` for outbound navigation and
browser-context checks found exactly two surfaces where it leaks, so the class is bounded; they
are filed together as **#146**. The third sharpens **#136** and is recorded there.

### 1. The install affordance appears inside the installed app

`install.ts` decides whether to offer installation from
`isStandalone() = matchMedia('(display-mode: standalone)').matches || navigator.standalone`.
Inside a Capacitor WebView **both are false** — `display-mode` reports `browser` and
`navigator.standalone` is a Safari-only flag. `installed` is also false, having only ever been
set by an `appinstalled` event that never fires. So `overlay.ts:750`'s
`hidden = state.standalone || state.installed` is **false**, and:

- **iOS** — `branch()` returns `'ios'` on a UA match, and `bannerAudience` is
  `coarse && (branch === 'promptable' || branch === 'ios')`, so the pre-start banner shows and
  its action opens the **"Add to Home Screen" instructions dialog** — inside a native app that is
  already on the home screen.
- **Both platforms** — the settings row is documented as **PERMANENT** (`overlay.ts:381`), so it
  never goes away, telling the player how to install what they are running.

Neither is subtle and both are on the first screen. Fix at the capability level, not by UA
sniffing: the shell knows it is the shell, and that fact should reach `install.ts` as an injected
dep, consistent with how the module already takes `matchMedia` and its storage adapter.

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
no navigation bar, and content sits underneath the system bars. That is why Capacitor 8.3.2+
injects `--safe-area-inset-*` custom properties and why `@capacitor-community/safe-area` exists —
both are workarounds for values that are present and wrong, not for a function that is missing.

The two _with_ fallbacks still matter, for a different reason: they are the **load-bearing** ones.
`--wy-compact-col` and `--wy-rail-w` are track sizes computed from insets, so zeroed insets move
the layout's geometry, not just its padding.

The sharpest consequence is for verification. `compact.spec.ts` relies on `env()` resolving to 0 in
headless Chromium — which is **exactly the on-device failure state**. The existing suite therefore
pins the broken rendering as the expected one, and a green run is not evidence of anything here.
Whatever verifies #136 needs a real WebView or an injected-inset harness.

## Repo hygiene — `cap sync` will break CI

`verify` runs `prettier --check .` across the whole repo, and `.prettierignore` currently excludes
only build output, generated i18n, and the locally-gitignored planning docs. `cap sync` copies
`apps/web/dist` into the native projects:

- `apps/mobile/android/app/src/main/assets/public/**`
- `apps/mobile/ios/App/App/public/**`

Those are HTML, JS, CSS and JSON — all parseable by prettier, none formatted to its taste. The
first `cap sync` therefore turns `format:check` red. Native sources (Swift, Kotlin, Gradle) are
safe: prettier has no parser for them and skips them.

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

## Toolchain — audited 2026-08-18

Capacitor 8 requires min iOS 15 / Android API 24, compile and target **API 36**, Android Studio
Otter or newer, and uses SPM by default for newly added iOS platforms. Audit of the development
machine against that:

| Component       | State                                             | Verdict                                      |
| --------------- | ------------------------------------------------- | -------------------------------------------- |
| Node            | v26.0.0                                           | ✅ repo needs ≥ 22                           |
| pnpm            | 10.33.0                                           | ✅ exactly the `packageManager` pin          |
| JDK             | OpenJDK 21.0.10 (Homebrew)                        | ✅ what AGP needs for API 36                 |
| Disk free       | ~290 GB                                           | ✅ ample for both SDKs                       |
| **Xcode**       | **absent** — Command Line Tools only              | ❌ **blocks the iOS half of #135**           |
| **Android SDK** | **absent** — no Studio, no `adb`, no `sdkmanager` | ❌ **blocks the Android half of #135**       |
| CocoaPods       | absent                                            | ⚠️ likely unnecessary — Capacitor 8 uses SPM |

`xcode-select -p` resolves to `/Library/Developer/CommandLineTools`, so Swift 6.3.3 and `clang`
are present but `xcodebuild` is not: there is no iOS SDK, no simulator, no device provisioning,
and no way to sign. Full Xcode from the App Store is a hard prerequisite, not a nicety.

Neither install is work in the code sense, but both are large downloads and both gate their
track. Track A (#139, #140) is deliberately positioned to be buildable and testable while they
run, since it needs neither.

## Open decisions

1. **How does the shell announce itself to the web layer?** Finding 1 needs it, #138 and #139
   probably want it, and the honest options are a Capacitor platform check at the boot entry
   (injected down as a dep, matching existing style) or a build-time flag. Decide once, in #135,
   before three call sites each invent their own.
2. **Scope of the `StorageDriver` seam in #142** — settings only, or all four ADR 0008 categories.
   Recorded in the issue; restated here because it is a real trade-off (a narrow seam risks a
   Phase 2 rewrite; a general one is a much larger job this epic does not justify).

## Relationship to M2

None. This track neither blocks nor is blocked by the M2 stories in flight. It touches
`apps/mobile` (empty), the two lifecycle modules, and — for Findings 1 and 2 — `install.ts` and
`shell.ts`, which no M2 story owns. Sequencing is a scheduling choice, not a dependency.
