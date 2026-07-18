# ADR 0002 — Asset and content licensing

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Code is licensed **AGPL-3.0-or-later** with a public §7 App Store Exception (ADR
0001 §5). But AGPL is written for program source and fits creative works
awkwardly, and Wynding will accumulate non-code material — art, audio, fonts, and
authored **level / wave / balance data** — that needs its own clearly-stated
license. `packages/content` already holds sample authored data, so this can't
wait: contributors need to know the terms up front, and retrofitting a license
onto already-contributed assets (whose authors may be unreachable) is painful.

The convention in open-source games is to license code under a GPL-family license
and creative assets under a Creative Commons license designed for such works.

## Decision

### 1. Code stays AGPL-3.0-or-later (+ the §7 App Store Exception)

Unchanged. Program source — including the type definitions and the code that
_loads and validates_ content data — remains AGPL.

### 2. Art, audio, and other creative assets → CC-BY-SA 4.0

All original visual, audio, and font assets we create are licensed
**Creative Commons Attribution-ShareAlike 4.0**. Its share-alike copyleft mirrors
AGPL's spirit (derivatives stay open), attribution is required, and it is built
for creative works.

### 3. Level / wave / balance **data** → CC-BY-SA 4.0

Authored content data (level layouts, wave scripts, balance numbers) is design
content, not program logic, so it carries the same **CC-BY-SA 4.0** as assets. In
`packages/content`, the **type definitions and loaders stay AGPL** (they're code)
while the **authored data values are CC-BY-SA 4.0**; the two are kept in separate
files so the boundary is file-clean (data in `src/levels.ts`, code in
`src/index.ts`), and the package declares the combined
`AGPL-3.0-or-later AND CC-BY-SA-4.0`.

### 4. Third-party assets — a repository sourcing policy

Any incorporated third-party asset must be under **CC-BY-SA 4.0 or a more
permissive/compatible license** (CC-BY, CC0, public domain) with attribution
recorded. As a **repository policy** (not a limitation of any license), we accept
**no `NC` (non-commercial) or `ND` (no-derivatives) assets** — they'd break the
"anyone can build and ship" and remix/mod ethos. **Bundled fonts and third-party
libraries keep their own licenses**, carved out of this rule and recorded
separately; this ADR governs the assets and content data _we_ author or adopt as
project assets.

### 5. Contribution license (inbound = outbound)

Contributions carry the license of what they are: **code contributions** are
AGPL-3.0-or-later + the §7 exception; **asset and content-data contributions** are
CC-BY-SA 4.0. Either way, contributors certify they have the right to license the
work that way (own work, or permission) and provide required attribution. No CLA.
See [CONTRIBUTING.md](../../CONTRIBUTING.md).

### 6. Mechanics

Asset and content directories declare CC-BY-SA 4.0 (a directory `LICENSE` and/or
per-file headers); the repo root README documents the split.

## Known risk — CC-BY-SA and app-store DRM (open; needs counsel + owner decision)

CC-BY-SA 4.0 forbids applying **Effective Technological Measures** (DRM) to the
licensed material — the same conflict app-store DRM creates for the code, which the
AGPL **§7 exception resolves for the _code only_**, not for CC assets. Implications:

- For assets **we own**, we are the copyright holder and can distribute through any
  channel regardless of the CC terms we _also_ offer them under — no conflict for
  our own store builds.
- For **third-party or contributed** CC-BY-SA assets (where we are a licensee), and
  for **downstream forkers** shipping our CC-BY-SA assets to a DRM store, the
  anti-DRM clause is a real question, and CC-BY-SA has no clean §7-style
  additional-permission mechanism.

This is **not settled here.** Options to weigh (owner decision, with counsel,
before any app-store launch — consistent with the project's standing "not legal
advice" posture): (a) prefer assets we own, or third-party assets under **CC0 /
public domain**, where store distribution matters; (b) grant an explicit asset
app-store additional permission on our own works and carry it inbound=outbound;
(c) accept the asymmetry (code is store-shippable by anyone; CC-BY-SA assets are
not) as a known limitation. Tracked in the decisions log as an open legal item.

## Consequences

- **Positive:** the whole project stays fully open — no proprietary anything;
  assets get a license actually designed for them; remix/mod-friendly, which
  directly serves the moddability vision.
- **Negative:** attribution discipline and a compatible-sourcing rule for
  third-party assets; a mixed-license `content` package needs file-clean
  separation; the large pool of `NC`-licensed free game assets is off-limits; the
  CC/app-store-DRM question above must be resolved before an app-store launch.
- **Neutral:** only sample content data exists today; this governs assets from
  creation. Fonts and third-party libraries retain their own (carved-out) licenses.
