# ADR 0002 — Asset and content licensing

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Code is AGPL-3.0-or-later with a public §7 App Store Exception (ADR 0001 §5). We
must license the non-code material too — art, audio, fonts, and authored level /
wave / balance data — and `packages/content` already holds sample data, so this
can't wait.

The obvious choice for creative works — a Creative Commons license like CC-BY-SA
4.0 — **does not work for this project.** CC-BY-SA 4.0 (§2(a)(5)(C)) forbids
applying DRM / "Effective Technological Measures" to the licensed material, and app
stores (notably Apple) apply DRM. The §7 App Store Exception resolves this **for the
code**, but it cannot extend to CC-licensed assets, and CC has no §7-style
additional-permission mechanism. The anti-DRM clause binds the _licensee_: for
assets we author ourselves we're the copyright holder and unbound, but a
**contributor's** CC-BY-SA asset reaches an app store in the project's hands — and
the project is a licensee — so it could not be shipped through a DRM store. The
usual escape (a CLA that assigns copyright to one owner, as Bitwarden does) is
**exactly what we ruled out** (no CLA, inbound=outbound). Without a CLA, the only
lever is what the inbound license itself says — so the store permission must live
_inside_ that license.

## Decision

### One license for the whole work: AGPL-3.0-or-later + the §7 App Store Exception

**All original material — code, art, audio, level / wave / balance data, and
repository documentation — is licensed AGPL-3.0-or-later with the same public §7
App Store Exception** (see [LICENSE-EXCEPTIONS.md](../../LICENSE-EXCEPTIONS.md)). The
GPL family can license any copyrightable work, not just code (per the FSF), so
licensing the assets this way means the §7 store permission is carried to every
contribution automatically by inbound=outbound — the **no-CLA equivalent** of
concentrating ownership. The result is fully open, strong copyleft on everything,
shippable to DRM app stores, and a **single license** with no CC-vs-GPL boundary to
reason about.

### "Source" for assets = the editable master

AGPL requires conveying the "source" — the _preferred form for making
modifications_. For an asset that is the **editable master** (`.psd` / `.kra` /
`.xcf` / `.blend` / `.svg`, DAW project files / lossless masters), **not** the
exported `.png` / `.ogg`. Editable masters are committed to the repository — the
unrestricted AGPL channel the §7 exception's proviso requires — while shipped builds
carry the exports.

### Third-party material

Any incorporated third-party asset must be under an **AGPL-compatible license**
(public domain / CC0, or a GPL-compatible license), attribution recorded, and must
not re-impose restrictions the §7 exception exists to lift. **No `NC` / `ND`**
material. **Bundled fonts and third-party libraries** keep their own licenses,
carved out of this rule and recorded separately.

### Contribution license (inbound = outbound)

All contributions — code, documentation, art, audio, content data — are
AGPL-3.0-or-later + the §7 exception. Contributors certify they have the right to
license the work that way, provide the editable source for assets, and record any
third-party attribution. **No CLA.** See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Consequences

- **Positive:** fully open with strong copyleft on _everything_; store-shippable
  with **no CLA**; and a single unified license — simpler for the `content` package,
  `CONTRIBUTING.md`, and every contributor than a code/asset license split.
- **Negative:** AGPL is an unusual label for art (though FSF-valid), and the
  "source = editable master" duty is a real discipline — contributors must supply
  editable files and we host them; the pool of CC-`NC` free assets is off-limits.
- **Neutral:** only sample content data exists today; this governs assets from
  creation.

## Precedent

**Battle for Wesnoth** licenses its game art under the GPL at scale; the **§7
app-store-exception** wording originates in real copyleft mobile apps (KDE, wger).
This combines both established practices.
