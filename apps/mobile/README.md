# @wynding/mobile

The Capacitor **Host** that ships Wynding to **iOS, iPadOS and Android**. It is a wrapper: all
the game is in `apps/web`, and this package's job is to package a build of it and get out of
the way.

## What it packages

The **Host build** — `apps/web/dist-host`, not `apps/web/dist`.

Those are two builds of the same source. The Host build carries a compiled-in declaration that
it is running inside a host, which the web build then reads to correct three behaviours that
are right on the open web and wrong in a WebView: no install banner, no permanent install row,
and a wordmark that is not a link to a site there is no way to reach. The web build never
infers any of this ([ADR 0012](../../docs/adr/0012-host-declaration.md)); it is told, by being
built as a Host build ([ADR 0013](../../docs/adr/0013-host-build-is-a-separate-artifact.md)).

`capacitor.config.ts` points `webDir` at that directory and nothing else. That is deliberate:
if nobody produced a Host build, `cap sync` fails on a missing directory — loudly, at the
packaging step — instead of quietly packaging the open-web build into an app that boots
perfectly and is silently wrong.

## Prerequisites

| Platform | Needs                                                                 |
| -------- | --------------------------------------------------------------------- |
| iOS      | macOS + Xcode. No CocoaPods — Capacitor 8 uses Swift Package Manager. |
| Android  | Android Studio (or a standalone SDK) with API 36 installed.           |

You only need the toolchain for the half you are working on. Every command below is
per-platform for exactly that reason.

## Commands

Run from this directory (or with `pnpm --filter @wynding/mobile run <script>`).

| Script                    | What it does                                                 |
| ------------------------- | ------------------------------------------------------------ |
| `pnpm run sync:ios`       | Build the Host build, then copy it into the iOS project.     |
| `pnpm run sync:android`   | Build the Host build, then copy it into the Android project. |
| `pnpm run sync:all`       | Both. Needs both toolchains — prefer the per-platform ones.  |
| `pnpm run open:ios`       | Open the Xcode workspace.                                    |
| `pnpm run open:android`   | Open the project in Android Studio.                          |
| `pnpm run assets:ios`     | Regenerate the source artwork, then the iOS icon/splash set. |
| `pnpm run assets:android` | Same, for the Android resource set.                          |

**There is no `build` task here, on purpose.** `build`, `typecheck`, `lint` and `test` are the
names the root Turbo pipeline selects, and compiling a native app needs an SDK that CI does not
have and that most contributors have only one of. The native commands sit under names Turbo
never touches, so `pnpm run build` at the root stays a pure web build on any machine. The one
thing this package does expose to Turbo is `typecheck`, over `capacitor.config.ts` — that
shells out to nothing and is the only thing that would catch a malformed config before a device
did.

## Icons and splash screens

`apps/web/scripts/gen-icons.mjs` is the single place the mark is authored, for the web and for
both native platforms. It renders the source artwork into `apps/web/assets/native/`, and
`@capacitor/assets` derives the full native matrix from there — adaptive layers, legacy density
buckets, round icons, asset catalogs, and the Android 12+ splash. Both stages run from the
`assets:*` scripts above. The generated native resources are committed.

One wrinkle worth knowing when you regenerate: on iOS, `@capacitor/assets` writes splash files
under its OWN names and rewrites `Contents.json` to match, but does not delete the ones
Capacitor's template shipped. Those leftovers are unreferenced, so nothing shows them and
nothing fails — they are simply the default white artwork, sitting in the repo. Check
`ios/App/App/Assets.xcassets/Splash.imageset/` for files `Contents.json` does not list and
delete them. (Android is unaffected: its resource names are fixed, so regeneration overwrites
in place.)

## After a Capacitor dependency bump, re-sync Android

`android/capacitor.settings.gradle` is generated with paths into the pnpm store that embed the
resolved versions. Bumping `@capacitor/android`, `@capacitor/core` or `@capacitor/app` moves
that directory and leaves the committed path dangling, which Gradle reports as a missing project
directory with no hint about the cause. `pnpm run check:native` catches it in `verify` first;
the fix is one command:

```shell
pnpm --filter @wynding/mobile run sync:android
```

## iOS signing — read this before opening Xcode

**Never set the development team in Xcode's UI.** Xcode writes `DEVELOPMENT_TEAM` straight into
the tracked `project.pbxproj`, and this repository is public. A team ID is a durable identifier
tied to a real person.

Instead, create `ios/LocalSigning.xcconfig` — untracked and gitignored:

```ini
DEVELOPMENT_TEAM = YOURTEAMID
```

Both committed xcconfigs (`ios/debug.xcconfig` and `ios/release.xcconfig`) pull it in with an
optional `#include?`, so a fresh clone without the file still builds; it simply cannot sign for
a device until you make one. `pnpm run check:native` at the root enforces all of this and runs
as part of `pnpm run verify`.

### Free Apple Account terms

Development builds today use a free Apple Account and a cable, not a paid membership. That
carries real limits, and they are limits on playtesting rather than on the build:

- **Provisioning expires after 7 days.** The app stops launching until you rebuild and
  reinstall it — so a playtest device goes cold within a week of being set up.
- **Three registered devices per platform**, not three in total.
- **No over-the-air distribution.** Re-signing means deploying from Xcode again; a cable is
  needed for the first pairing, after which Xcode can deploy over Wi-Fi. TestFlight and paid
  signing are deferred with the rest of distribution.

## Orientation

Wynding is a landscape game, and both projects lock to landscape. Two settings make the lock
actually apply on a large screen and are easy to lose in a regeneration:
`UIRequiresFullScreen` on iOS (without it iPad honours no restriction at all), and
`android:appCategory="game"` on Android (API 36 ignores `screenOrientation` on tablet-class
displays without it). Where an OS declines to lock anyway, the web build's portrait-rotate
prompt is the fallback — that path is live, not dead code.

## Licensing

Store distribution is covered by the AGPL §7 App Store Exception (see
[LICENSE-EXCEPTIONS.md](../../LICENSE-EXCEPTIONS.md)), so anyone can ship store builds.

## The hardware Back button

`@capacitor/app` is installed here, in the package that builds the native projects, because
installing it is what REGISTERS the plugin on both platforms. The handler is not here: it lives
in `apps/web/src/back.ts`, with the rest of the input translation, and reaches the plugin through
the bridge Capacitor puts on `window` rather than by importing the package. That keeps Capacitor
code out of the open-web bundle, which ADR 0013 keeps as a separate artifact — the web build has
no Back button to serve.

What Back does, per state: a dismissable overlay (settings, the install instructions, the leave
confirm) closes; the results dialog and the rotate prompt CONSUME it without closing; a live run
pauses; and with nothing open and nothing running, the app exits. That last one is an explicit
`exitApp()` call, because registering a `backButton` listener at all turns Capacitor's own
handling off — without it, Back would be a dead key.

The same module takes `appStateChange`, so backgrounding the app pauses a live run on the one
platform where the web's `visibilitychange`/`pagehide` have historically been least reliable.
Nothing resumes on return; the player resumes deliberately from the Dock.

## Persistence

The async `StorageDriver` seam (ADR 0008) now exists, in `packages/platform`, and the app's
accessibility settings ride it — so a colour-vision mode or a reduced-motion choice made inside
this Host survives a relaunch. The baseline adapter is `localStorage`-backed, which the
Capacitor WebView provides; swapping in a Capacitor-Preferences adapter is a change to
`createBrowserStorageDriver` in `apps/web/src/persist.ts` and to nothing else, which is what the
seam is for.

Campaign progress and best scores are the seam's other two ADR 0008 §3 consumers and are Phase 2
— they land as new slots, not as a redesign.
