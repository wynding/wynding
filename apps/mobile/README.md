# @wynding/mobile

Capacitor wrapper that ships the Wynding web build to **iOS, iPadOS, and
Android** app stores.

## Status

Placeholder. This package will wrap the compiled `apps/web` build in a Capacitor
shell. Nothing to build yet.

## Plan

1. Build the PWA: `pnpm --filter @wynding/web build` → `apps/web/dist`.
2. Add Capacitor (`@capacitor/core`, `@capacitor/cli`, platform packages) and
   point `webDir` at the web build output.
3. `npx cap add ios` / `npx cap add android`, then `npx cap sync` to copy the web
   assets into each native project.
4. Store distribution is covered by the AGPL §7 App Store Exception (see
   [LICENSE-EXCEPTIONS.md](../../LICENSE-EXCEPTIONS.md)).

The persistence seam (async `StorageDriver`) is DESIGNED (ADR 0008), but no shared
platform implementation exists yet — saves working identically across web, mobile,
and desktop is a future consumer of that seam, not something wired up today.
