# @wynding/content

Level and wave data for Wynding.

## Licensing (dual — see [ADR 0002](../../docs/adr/0002-asset-and-content-licensing.md))

This package deliberately holds two kinds of thing under two licenses, split by
file so the boundary is clean:

- **`src/index.ts` — code.** Type definitions and loaders. **AGPL-3.0-or-later**
  (with the project's §7 App Store Exception), like the rest of the codebase.
- **`src/levels.ts` — content.** Authored level geometry, economy, wave scripts,
  and balance numbers — a creative work. **CC-BY-SA 4.0** (marked with an
  `SPDX-License-Identifier` header).

New authored content data goes in `src/levels.ts` (or sibling data files with the
CC-BY-SA header), not in `src/index.ts`. The package's `license` field is the
combined SPDX expression `AGPL-3.0-or-later AND CC-BY-SA-4.0`.

> **Store distribution:** the project's §7 App Store Exception covers the AGPL
> **code only**. Shipping contributed or third-party **CC-BY-SA content** through a
> DRM app store is an **unresolved question requiring owner/counsel approval** — see
> the "Known risk" section of
> [ADR 0002](../../docs/adr/0002-asset-and-content-licensing.md).
