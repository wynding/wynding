# ADR 0002 — Asset and content licensing

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Code is licensed **AGPL-3.0-or-later** with a public §7 App Store Exception (ADR
0001 §5). But AGPL is written for program source and fits creative works
awkwardly, and Wynding will accumulate non-code material — art, audio, fonts, and
authored **level / wave / balance data** — that needs its own clearly-stated
license. This must be decided _before_ any assets exist: retrofitting a license
onto already-contributed assets (whose authors may be unreachable) is painful, and
contributors need to know the terms up front.

The convention in open-source games is to license code under a GPL-family license
and creative assets under a Creative Commons license designed for such works.

## Decision

### 1. Code stays AGPL-3.0-or-later (+ the §7 App Store Exception)

Unchanged. Program source — including the code that _loads and validates_ content
data — remains AGPL.

### 2. Art, audio, and other creative assets → CC-BY-SA 4.0

All original visual, audio, and font assets we create are licensed
**Creative Commons Attribution-ShareAlike 4.0**. Its share-alike copyleft mirrors
AGPL's spirit (derivatives stay open), attribution is required, and it is built
for creative works.

### 3. Level / wave / balance **data** → CC-BY-SA 4.0

Authored content data (level layouts, wave scripts, balance numbers in
`packages/content`) is design content, not program logic, so it carries the same
**CC-BY-SA 4.0** as assets. The AGPL code that consumes it is unaffected; data
files simply declare their own license.

### 4. Third-party assets must be compatible

Any incorporated third-party asset must be under **CC-BY-SA 4.0 or a more
permissive/compatible license** (CC-BY, CC0, public domain) with attribution
recorded. **No `NC` (non-commercial) or `ND` (no-derivatives) assets** — they would
break both the public §7 "anyone can ship store builds" grant and the remixable /
moddable ethos. Bundled fonts and third-party libraries keep their own licenses,
carved out and recorded.

### 5. Mechanics

Assets and content data declare CC-BY-SA 4.0 (a `LICENSE` in the asset/content
directories and/or per-file headers where practical); the repo root documents the
split. Inbound=outbound applies: contributed assets are under CC-BY-SA 4.0.

## Consequences

- **Positive:** the whole project stays fully open — no proprietary anything;
  assets get a license actually designed for them; remix/mod-friendly, which
  directly serves the moddability vision; store distribution stays clear.
- **Negative:** attribution discipline and a compatible-sourcing rule for
  third-party assets; two licenses in one repo require clear per-directory marking;
  the large pool of `NC`-licensed free game assets is off-limits.
- **Neutral:** no assets exist yet — this governs them from creation. Fonts and
  third-party libraries retain their own (carved-out) licenses.
