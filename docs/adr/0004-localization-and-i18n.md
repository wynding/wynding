# ADR 0004 — Localization and internationalization

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Hardcoded user-facing strings are brutal to retrofit for translation — every one
becomes a later migration. Externalizing strings from day one is cheap. We will
not _ship_ translations at launch, but nothing should block adding them later.

## Decision

### 1. Externalize all user-facing text from day one

Every user-facing string lives in a **message catalog**, referenced by key. **No
hardcoded user-facing strings** in code (enforced by lint/review where feasible).
Adding a language becomes a content task, not a code change.

### 2. Ship English-only (`en`) at launch

One locale to start. The catalog and tooling exist from the beginning so a second
locale is drop-in.

### 3. Design for i18n from the start

- Use interpolation / **ICU MessageFormat** for plurals, gender, number, and date —
  never sentence-building by string concatenation.
- No essential text baked into images.
- UI must reflow for longer translations (no fixed-width text assumptions).
- Locale-aware number/time formatting.
- **RTL** (right-to-left) layout is noted as a future consideration, not a day-one
  commitment.

### 4. Localization is a render/UI concern only

Display text must **never enter `packages/sim`** or affect replay / world-hash.
The simulation deals in stable IDs; humans see localized strings only at the
render layer. This keeps determinism independent of language.

## Consequences

- **Positive:** any language can be added later with zero code changes; forces a
  clean separation of display text from logic; determinism stays language-agnostic.
- **Negative:** slightly more ceremony up front (keys + catalog instead of inline
  strings); ICU tooling to set up.
- **Neutral:** no translations yet; RTL and locale-specific layout deferred until a
  locale that needs them is actually added.
