# @wynding/desktop

Tauri wrapper that ships the Wynding web build as a **desktop** application
(Windows / macOS / Linux, and Steam).

## Status

Placeholder. This package will wrap the compiled `apps/web` build in a Tauri
shell. Nothing to build yet.

## Plan

1. Build the PWA: `pnpm --filter @wynding/web build` → `apps/web/dist`.
2. Add Tauri (`@tauri-apps/cli`, `@tauri-apps/api`) and point `frontendDist` at the
   web build output; `devUrl` at the Vite dev server for `tauri dev`.
3. `pnpm tauri build` produces platform installers; ship DRM-free (Steamworks DRM
   optional).
4. Store/binary distribution is covered by the AGPL §7 App Store Exception (see
   [LICENSE-EXCEPTIONS.md](../../LICENSE-EXCEPTIONS.md)).
