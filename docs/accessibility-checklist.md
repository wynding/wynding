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

| Item                                                 | Status | Notes                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colourblind-safe palette + dual encoding             | ✅     | Okabe–Ito / Paul Tol hues; every role also has a distinct shape (creep = triangle, tower = rounded square, valid ghost = solid outline, invalid = crossed box). Colour is never the sole signal. `packages/render/src/palette.ts`. |
| Selectable colourblind modes (protan/deutan/tritan)  | ✅     | Settings radio group re-maps the palette off the relevant confusion axis. Session-scoped.                                                                                                                                          |
| Reduced-motion setting                               | ✅     | Damps (shortens + fades) the impact-spark FX; `prefers-reduced-motion` is honoured at boot. CSS also disables transitions/animations under the media query.                                                                        |
| Full functionality across touch / mouse / keyboard   | ✅     | Mouse = hover-preview + click-commit; touch = two-tap preview-then-confirm; keyboard = focusable board cursor (arrows + confirm/sell/call) and focusable HUD controls. `apps/web/src/input.ts`.                                    |
| Visible focus indicators                             | ✅     | 3px focus ring on the board and every control (`:focus-visible`, `ui.css`).                                                                                                                                                        |
| ≥ 44 × 44 CSS-px touch targets                       | ✅     | All `.wy-btn` controls have `min-width`/`min-height: 44px`.                                                                                                                                                                        |
| Remappable / rebindable controls                     | ✅ 🟡  | Every game action is rebindable via the settings panel (`keymap.ts`). Session-scoped — cross-session persistence waits for the ADR 0008 `StorageDriver` seam.                                                                      |
| DOM/HUD text resize to 200% without loss of function | ✅     | HUD/controls are semantic DOM (not canvas text); sizing is rem/em and the layout reflows — the rebind rows wrap via `flex-wrap` rather than overflowing.                                                                           |
| Pause                                                | ✅     | Full calm-planning pause (build/sell/call-early allowed while paused).                                                                                                                                                             |
| Contrast ≥ 4.5:1                                     | ✅     | Foreground/accent tokens chosen against the dark surface (`ui.css`); final contrast sign-off is the Story 7 audit.                                                                                                                 |
| No flashing (WCAG 2.3.1)                             | ✅     | No strobing FX; the impact-spark is a single brief fade, well under 3 flashes/sec.                                                                                                                                                 |
| Semantic controls / labels for AT                    | ✅     | Real `<button>`s; HUD is a polite live region; results is a labelled `role="dialog"`; the board is a labelled `role="application"`. Enforced by the axe audit.                                                                     |
| All user-facing text is translatable                 | ✅     | Every string resolves through the typed `t()` catalog (ADR 0004); the `no-ui-literals` lint rule bans raw literals in text sinks.                                                                                                  |

## Waivers

| Item                       | Status | Reason                                                                                                               |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| Selectable difficulty (§3) | ⛔     | M1 ships **Medium only** — a pre-existing PRD/ADR-sanctioned M1 waiver, finalized in Story 7. Not a §2 day-one item. |

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

## Deferred to Story 7

- Final ADR 0003 conformance audit + contrast sign-off across the whole M1 slice.
- Cross-session persistence of accessibility/control settings (ADR 0008 `StorageDriver`).
