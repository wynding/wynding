# ADR 0004 — Localization and internationalization

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Hardcoded user-facing strings are brutal to retrofit for translation — every one
becomes a later migration. Externalizing strings from day one is cheap. We will
not _ship_ translations at launch, but nothing should block adding them later.

## Decision

### 1. Externalize all user-facing text from day one

Every user-facing string lives in a **message catalog**, referenced by a key.
**No hardcoded user-facing strings** in code. Adding a supported locale becomes a
content task, not a code change. This includes **authored content display strings**
(e.g. board names): content stores a **localization key/descriptor**, resolved to
text at the UI layer — never a baked literal. (The exact content representation is
finalized in the board/content-data-format ADR. An earlier parenthetical here about a
`Board.name` sample string is moot as of 2026-08-12: v2 bundles carry no
presentation-name field at all — board `name` was deleted from the schema entirely
(see `normalizeForHash`'s header in `packages/sim/src/ruleset.ts`). Tower and creep
display names live in the `en` catalog (`tower.<id>.name` / `creep.<id>.name`); a
board display name currently has NO representation anywhere — the single shipped
board's shell renders the game's own name — so a `board.<id>.name` contract is
deferred until a second board first needs one.)

### 2. Catalog contract (so the above is enforceable)

- **Format:** one catalog file per locale (`en.json`, …), keyed by **namespaced,
  dotted keys** (e.g. `hud.wave.counter`), values in **ICU MessageFormat**.
- **Lookup:** a single typed `t(key, params)` accessor at the render/UI layer; keys
  **and per-key ICU parameter types** are generated from the `en` catalog, so both
  unknown keys and wrong/missing parameters fail at compile time.
- **Missing-key fallback:** fall back to the **`en`** value; if that too is missing,
  render the **key itself** and warn (dev) — never a blank or a crash.
- **Enforcement:** a **lint rule bans user-facing string literals across all render
  surfaces** — the DOM UI (JSX and non-JSX), canvas/HUD text drawn by the renderer,
  and accessibility names/labels; non-user-facing strings (IDs, keys, log/dev
  messages) are out of scope. An **extraction + cross-locale check in CI** fails if a
  used key is absent from `en`, an `en` key is unused, or **any non-`en` catalog is
  missing a key or has a mismatched ICU placeholder signature** vs `en`. The exact
  library (e.g. FormatJS / `intl-messageformat`) is an implementation choice, not
  fixed here.

### 3. Ship English-only (`en`) at launch

One locale to start, so that a **supported** second locale is later drop-in.

> **Status (updated 2026-08-12):** this contract is **implemented and CI-enforced**,
> and has been since the first real UI (M1 Story 6, `755e3f2`): the `en` catalog
> (`apps/web/src/i18n/en.json`) with its generated typed accessor
> (`i18n/t.ts` / `i18n/catalog.gen.ts`), the string-literal lint rule
> (`wynding/no-ui-literals`, `eslint.config.mjs`), and the extraction +
> cross-locale check (`scripts/i18n-check.mjs`, run inside `verify`) all ship. The
> previous revision of this callout — written five days before `t.ts` landed — said
> none of it existed yet and named `apps/web/src/main.ts` /
> `packages/render/src/index.ts` as still holding placeholder literals; both are
> literal-free and lint-covered today, and the callout was simply never revisited.

### 4. Design for i18n from the start

- **ICU MessageFormat** for plurals, gender, number, and date — never
  sentence-building by string concatenation. _(Shipped subset, noted 2026-08-12: the
  live formatter substitutes ICU `{name}` placeholders only — no plural/select
  branches yet, per `t.ts`'s own header. The catalog values stay ICU-compatible, so
  adopting a full formatter when a branching message first appears is a drop-in;
  this ADR's commitment is unchanged.)_
- No essential text baked into images.
- UI must reflow for longer translations (no fixed-width text assumptions).
- Locale-aware number/time formatting.
- **Scope of the "drop-in" promise:** it holds for **LTR locales**. **RTL** and any
  locale needing different shaping/mirroring are a **future consideration** — they
  require mirroring, bidi handling, and layout reflow that are _not_ built or tested
  day-one, so such a locale is **not** content-only until those invariants exist.

### 5. Localization stays out of the simulation and replay

Not just display text — **no localization metadata of any kind** enters
`packages/sim` or the replay/determinism contract. `SimState`, `SimInput`, replay
headers, and world-hash inputs contain **only stable gameplay data and IDs**;
locale IDs, message keys, catalog versions, and any render metadata live purely at
the render/UI layer. This keeps determinism and re-sim fully language-agnostic.

## Consequences

- **Positive:** any **supported (LTR)** locale can be added later with zero code
  changes; forces a clean separation of display text from logic; determinism stays
  language-agnostic.
- **Negative:** slightly more ceremony up front (keys + catalog + lint/extraction
  instead of inline strings); ICU tooling to set up.
- **Neutral:** no translations yet; RTL and locale-specific layout are deferred
  until a locale that needs them is actually added, at which point the mirroring/
  bidi invariants get built and tested.
