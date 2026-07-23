# Accessibility checklist (ADR 0003 §3)

ADR 0003 requires this checklist to land **with the first real UI** (M1 Story 6 — Render,
input & HUD). Each GAG §2 day-one item is either **implemented** in Story 6 or carries an
**explicit, justified waiver**. axe-core runs in CI via the Playwright e2e suite against the
DOM UI and fails the build on any violation; the Phaser canvas (which axe cannot inspect) is
covered by the manual items below. This checklist is re-audited in full at Story 7 (the M1
conformance + contrast sign-off) — Story 6 builds the enforcement mechanisms and ticks what it
introduces.

Legend: ✅ implemented · 🟡 partial / session-scoped · ⛔ waived (with reason).

## GAG §2 — day-one items

| Item                                                 | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colourblind-safe palette + dual encoding             | ✅     | Okabe–Ito / Paul Tol hues; every role also has a distinct shape (creep = triangle, tower = rounded square, valid ghost = solid outline, invalid = crossed box). Colour is never the sole signal. `packages/render/src/palette.ts`.                                                                                                                                                                                                                                          |
| Selectable colourblind modes (protan/deutan/tritan)  | ✅     | Settings radio group re-maps the palette off the relevant confusion axis. Session-scoped.                                                                                                                                                                                                                                                                                                                                                                                   |
| Reduced-motion setting                               | ✅     | Damps (shortens + fades) the impact-spark FX; `prefers-reduced-motion` is honoured at boot. CSS also disables transitions/animations under the media query.                                                                                                                                                                                                                                                                                                                 |
| Full functionality across touch / mouse / keyboard   | ✅     | Mouse = hover-preview + click-commit; touch = two-tap preview-then-confirm; keyboard = focusable board cursor (arrows + confirm/sell/call) and focusable HUD controls. `apps/web/src/input.ts`.                                                                                                                                                                                                                                                                             |
| Visible focus indicators                             | ✅     | 3px focus ring on the board and every control (`:focus-visible`, `ui.css`).                                                                                                                                                                                                                                                                                                                                                                                                 |
| ≥ 44 × 44 CSS-px touch targets                       | ✅     | All `.wy-btn` controls have `min-width`/`min-height: 44px`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Remappable / rebindable controls                     | ✅ 🟡  | Every game action is rebindable via the settings panel (`keymap.ts`). Session-scoped — cross-session persistence is deferred to Phase 2 per ADR 0008.                                                                                                                                                                                                                                                                                                                       |
| DOM/HUD text resize to 200% without loss of function | ✅     | HUD/controls are semantic DOM (not canvas text); sizing is rem/em and the layout reflows — the rebind rows wrap via `flex-wrap` rather than overflowing.                                                                                                                                                                                                                                                                                                                    |
| Pause                                                | ✅     | Full calm-planning pause (build/sell/call-early allowed while paused).                                                                                                                                                                                                                                                                                                                                                                                                      |
| Contrast ≥ 4.5:1                                     | ✅     | Enforced by `packages/render/src/palette.test.ts` (canvas cues ≥ 3:1 vs floor across all four colour modes, measured min 3.17) and `apps/web/src/ui-contrast.test.ts` (DOM text ≥ 4.5:1, measured min 7.17; non-text ≥ 3:1, measured min 5.97), both inside `pnpm run verify`. Sign-off recorded in the Story 7 audit below.                                                                                                                                                |
| No flashing (WCAG 2.3.1)                             | ✅     | No strobing FX; the impact-spark is a single brief fade, well under 3 flashes/sec.                                                                                                                                                                                                                                                                                                                                                                                          |
| Semantic controls / labels for AT                    | ✅     | Real `<button>`s; the HUD is a labelled `role="group"` BY DESIGN (a polite live region would flood AT during combat — `overlay.ts:97-102`); the polite live element is the verify `role="status"` message, and results is a labelled `role="dialog"` that announces the outcome; the board is a labelled `role="application"`. The axe audit now covers both the settings-panel and results-dialog states, plus the inert/Tab-containment/focus-restore modal checks (e2e). |
| All user-facing text is translatable                 | ✅     | Every string resolves through the typed `t()` catalog (ADR 0004); the `no-ui-literals` lint rule bans raw literals in text sinks.                                                                                                                                                                                                                                                                                                                                           |

## Waivers

| Item                       | Status | Reason                                                                                                                                                                                 |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selectable difficulty (§3) | ⛔     | M1 ships **Medium only** — a pre-existing PRD/ADR-sanctioned M1 waiver, **finalized in Story 7** (also recorded in the Story 7 PR description per ADR 0003 §3). Not a §2 day-one item. |

No §2 day-one items are waived (Rob ratified full §2 compliance in Story 6).

## Canvas-covered items (not visible to axe — verified manually / by unit tests)

- Dual-encoding of every board entity (shape + colour) — unit-tested palette distinctness;
  visual check of creep/tower/ghost silhouettes.
- Reduced-motion damping of the impact-spark — visual check with the setting on/off.
- Keyboard board cursor movement + build/select/sell — driven by `input.ts` unit tests and
  the e2e smoke.

## Enforcement mechanisms landed in Story 6

- **axe-core in CI** via the Playwright e2e (`apps/web/e2e/smoke.spec.ts`) — fails on any
  violation against the DOM UI.
- **i18n**: typed `t()` catalog, the `no-ui-literals` ESLint rule, and the extraction +
  cross-locale check (`scripts/i18n-check.mjs`), all wired into `pnpm run verify`.

## Deferred to Story 7 (delivered)

- Final ADR 0003 conformance audit + contrast sign-off across the whole M1 slice — done;
  see the Story 7 conformance audit section below.

Deferred to Phase 2 (ADR 0008): cross-session persistence of accessibility/control settings
(colour mode, reduced motion, rebinds). Alpha players re-apply their preferences per visit —
accepted for M1; ADR 0008's `StorageDriver` seam lands the persistence in Phase 2.

## Story 7 conformance audit (2026-07-23)

Full re-audit against this checklist, landing the permanent contrast gate and finalizing the
§3 waiver. Figures below are **as-measured on the audit date, re-derivable by running
`packages/render/src/palette.test.ts`** (which always prints the per-mode minima on every
run) — dated evidence backed by a reproducible source, not a hand-maintained number.

**Canvas cues vs the board floor (WCAG 1.4.11 non-text, ≥ 3:1), per colour mode:**

| Mode    | Measured minimum | Binding cue(s)                      |
| ------- | ---------------- | ----------------------------------- |
| default | 3.32             | `range` composited @ 0.7 alpha      |
| protan  | 3.17             | `tower` / `ghostValid` (`0x0072b2`) |
| deutan  | 3.17             | `tower` / `ghostValid` (`0x0072b2`) |
| tritan  | 4.18             | `range` composited @ 0.7 alpha      |

**DOM tokens (`ui.css`):** text pairs (WCAG ≥ 4.5:1) measured minimum **7.17** (`#04121f` on
`--wy-accent`); non-text pairs (≥ 3:1) measured minimum **5.97** (`--wy-accent` on
`--wy-surface`).

**Exemptions:**

- `spark` — exempt from the gate: transient fading FX (alpha → 0 by design), non-essential
  (the kill outcome is carried by the creep/HP-pip state), and reduced-motion governed.
- `border` (1.66:1) — excluded: a deliberate quiet structural fill whose identity is carried
  by geometry (the outer ring), not colour; the openings (entrance/exit) it borders carry
  ≥ 4.26:1 glyphs.

**Re-audited rows — status confirmed:**

- Colourblind-safe palette + dual encoding — ✅, now backed by a permanent automated gate
  (`palette.test.ts`) in addition to the prior unit-tested distinctness check.
- Contrast ≥ 4.5:1 — ✅, gated at the correct WCAG bar (3:1 non-text / 4.5:1 text) rather
  than the palette header's prior aspirational (and incorrect) "≥ 4.5:1 everywhere" claim;
  `palette.ts`'s header comment is corrected to match.
- Remappable / rebindable controls — ✅ 🟡, persistence line corrected to cite Phase 2 (ADR
  0008), not "deferred to Story 7" — that line was in error.
- Semantic controls / labels for AT — ✅, the false "HUD is a polite live region" claim is
  corrected (it is `role="group"` by design); the axe audit now also covers the results
  dialog and the inert/Tab-containment/focus-restore modal behaviour (e2e).
- Selectable difficulty (§3 waiver) — ⛔, finalized this story; recorded in the PR
  description per ADR 0003 §3.
- i18n copy conformance — the `hud.bounty` copy violation (#33, "Gold:" → "Bounty:") and the
  non-canonical "wynd" loss line (→ "The creeps broke through.") are both corrected.
- Input edge cases (#34) — key-repeat no longer oscillates discrete actions (pause/sell/
  call-wave/speed edge-triggered; movement still auto-repeats), and the touch two-tap gesture
  now uses a uniform confirm/arm/clear rule with per-pointer press-origin tracking and a
  concurrent-multi-touch void, closing the tower-select-then-retap instant-build bug and the
  cross-finger press/release defeat.
