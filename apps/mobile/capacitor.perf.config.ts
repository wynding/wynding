import type { CapacitorConfig } from '@capacitor/cli';

// capacitor.perf.config.ts — the PERF variant's config (#148, the instrument #141 measures
// with). A second artifact beside the play one, never a merge of the two.
//
// WHAT THIS IS NOT: a way to build the shipped app differently. `capacitor.config.ts` is
// the play identity and its `webDir` is a constant for a stated reason — a freely
// overridable one could be pointed back at `dist/` and would then package an undeclared
// build *successfully*. Nothing here overrides that file; this is a separate value beside
// it, which is exactly what that file's own comment says #148 gets.
//
// THE CAPACITOR CLI HAS NO `--config` FLAG (verified against `cap sync --help` /
// `cap copy --help` on Capacitor 8.5), so this config is not consumed by `cap sync`. It is
// consumed by `scripts/sync-perf.mjs`, which does the same two things `cap copy` does —
// stage the web payload, write `capacitor.config.json` into the Android assets — reading
// its values from HERE so there is one declaration of the perf variant rather than two.
// Keeping it a typed `CapacitorConfig` is what makes `pnpm run typecheck` catch a malformed
// one, the same way it does for the play config.
//
// HOW THE TWO STAY APART ON DEVICE: the `.perf` suffix is a Gradle BUILD TYPE
// (`android/app/build.gradle`), not an `appId` change here — `cap add` bakes `appId` into
// the native project once and editing it afterwards re-stamps nothing, which is why the
// play config's own comment says this variant needs product flavors or build types rather
// than a config override. `appId` below therefore states the BASE identity the suffix is
// applied to, and `net.wynding.game.perf` is what actually installs.
const config: CapacitorConfig = {
  appId: 'net.wynding.game',
  appName: 'Wynding perf',

  // The perf artifact — `apps/web/dist-perf`, produced by
  // `pnpm --filter @wynding/web run build:perf`. Its root `index.html` is the launcher
  // linking both scenes (`vite.perf.config.ts` emits it): a Capacitor WebView loads the
  // asset ROOT, and before that entry existed a packaged perf build booted to a 404 and a
  // white screen.
  webDir: '../web/dist-perf',

  android: {
    // The whole point of the variant. The harness is driven from desktop Chrome at
    // chrome://inspect against `window.wyndingPerf` / `window.wyndingPerfCatalog`, and
    // without this the WebView is not inspectable. Set EXPLICITLY rather than left to
    // Capacitor's debuggable-build default, so the capability does not depend on which
    // build type someone happens to assemble.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
