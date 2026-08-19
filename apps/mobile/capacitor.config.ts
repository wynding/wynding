import type { CapacitorConfig } from '@capacitor/cli';

// The Capacitor host's one hand-written config file (#135).
//
// This is the file `cap add` reads to stamp identity into each native project, and the file
// `cap sync` reads to find the web assets to copy. It is deliberately small: everything a
// Host needs to know about the game is either baked into the web build it packages (ADR
// 0013) or lives in the native projects themselves.
const config: CapacitorConfig = {
  // Reverse-DNS of a domain we own. Effectively PERMANENT once anything is distributed —
  // an app's identity on both stores and the key every install, save file and signing
  // identity is filed under. `cap add` bakes it into `android/app/build.gradle`
  // (`applicationId`) and the Xcode project (`PRODUCT_BUNDLE_IDENTIFIER`); editing it here
  // afterwards does NOT re-stamp either, which is why #148's side-by-side measurement
  // variant needs product flavors and a scheme rather than a config override.
  appId: 'net.wynding.game',
  appName: 'Wynding',

  // The **Host build** and nothing else (ADR 0013). Two properties of this line are
  // load-bearing, so neither is left implied:
  //
  //  1. It points at `dist-host`, an output only `pnpm --filter @wynding/web build:host`
  //     writes. If someone syncs without producing one, `cap sync` fails on a missing
  //     directory — loudly, at the packaging step — instead of quietly packaging the
  //     open-web build into an app that boots perfectly and is silently wrong (ADR 0012's
  //     "fail-quiet" weakness, which choosing a separate artifact is what narrows).
  //  2. It is a CONSTANT, not a value read from the environment. A freely overridable
  //     `webDir` could be pointed back at `dist/` and would then package an undeclared
  //     build *successfully* — reintroducing exactly the failure this shape buys out. What
  //     #148 gets is not an override but a second named value beside this one.
  //
  // Relative to this package, per Capacitor's own resolution.
  webDir: '../web/dist-host',
};

export default config;
