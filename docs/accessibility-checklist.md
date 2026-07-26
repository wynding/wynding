# Accessibility checklist (ADR 0003 §3)

ADR 0003 requires this checklist to land **with the first real UI** (M1 Story 6 — Render,
input & HUD). Each GAG §2 day-one item is either **implemented** in Story 6 or carries an
**explicit, justified waiver**. axe-core runs in CI via the Playwright e2e suite against the
DOM UI and fails the build on any violation; the Phaser canvas (which axe cannot inspect) is
covered by the manual items below. This checklist is re-audited in full at Story 7 (the M1
conformance + contrast sign-off) — Story 6 builds the enforcement mechanisms and ticks what it
introduces. It is re-audited again at Story 10 (Playable UX: app-shell layout, touch-first
placement, player-started runs), which replaces the Story 6-era two-tap touch gesture with
press-adjust-release, introduces the Shell/Rail/Card/Panel/Dock layout and its single modal
owner (results/rotate/settings), and adds the portrait rotate prompt — see the Story 10
conformance audit at the bottom of this file.

Legend: ✅ implemented · 🟡 partial / session-scoped · ⛔ waived (with reason).

## GAG §2 — day-one items

| Item                                                 | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Colourblind-safe palette + dual encoding             | ✅     | Okabe–Ito / Paul Tol hues; every role also has a distinct shape (creep = triangle, tower = rounded square, valid ghost = solid outline, invalid = crossed box). Colour is never the sole signal. `packages/render/src/palette.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Selectable colourblind modes (protan/deutan/tritan)  | ✅     | Settings radio group re-maps the palette off the relevant confusion axis. Session-scoped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Reduced-motion setting                               | ✅     | Damps (shortens + fades) the impact-spark FX; `prefers-reduced-motion` is honoured at boot. CSS also disables transitions/animations under the media query.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Full functionality across touch / mouse / keyboard   | ✅     | Mouse = hover-preview + click-commit; touch/pen = **press-adjust-release** on the **Armed** state (press shows an offset ghost 2 cells above the finger, moving adjusts it, release commits — two-tap is gone, Story 10 deleted it); Card gestures disambiguate tap (arm/disarm) from drag-from-rail (arm + press-adjust-release) by an 8px threshold; keyboard = focusable board cursor (arrows + confirm/sell/start) plus the `armTower1` hotkey (arms from any state) and focusable HUD/Rail/Dock controls. `apps/web/src/input.ts`, `apps/web/src/controller.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Visible focus indicators                             | ✅     | 3px focus ring on the board and every control (`:focus-visible`, `ui.css`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ≥ 44 × 44 CSS-px touch targets                       | ✅     | All `.wy-btn` controls (Dock, Card, Panel actions, settings) have `min-width`/`min-height: 44px`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Remappable / rebindable controls                     | ✅ 🟡  | Every game action — including Story 10's `armTower1` (Card hotkey) and the renamed `start` action — is rebindable via the settings dialog (`keymap.ts`), with a live hotkey badge on the Card. Session-scoped — cross-session persistence is deferred to Phase 2 per ADR 0008.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DOM/HUD text resize to 200% without loss of function | ✅     | HUD/controls are semantic DOM (not canvas text). The page itself never scrolls, but `.wy-hud` (the status chips list), `.wy-rail` (Rail), the Compact column Dock, and the settings dialog each get `overflow-y: auto`, so 200% zoom reflows and scrolls those regions internally instead of clipping — the board viewport is the only fixed-fit element. Story 11 moved the bounded scrollport from `.wy-status` onto `.wy-hud` (the Dock is now a status child, and an absolutely-positioned Standard Dock would be clipped by an ancestor scroll box) and made `.wy-hud` a keyboard-operable scrollable region with its own tab stop in BOTH layouts. `apps/web/e2e/smoke.spec.ts` pins this at the smallest supported landscape viewport (658×320, the Galaxy S9+ landscape profile — Compact after Story 11) and proves reachability per region: focus + arrow-key `scrollTop` change on the chips scrollport, focus + scrollport-visibility for the Rail's, Dock's, and settings' last controls. |
| Pause                                                | ✅     | Full calm-planning pause (build/sell allowed while paused). Story 10 adds player-started runs: a fresh run/Play-again holds at tick 0 (`started = false`) until the player presses **Start** — no hidden countdown — and Space/speed changes never un-hold; the Dock's Pause button is hidden (not disabled) pre-start, since there is nothing yet to pause.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Contrast ≥ 4.5:1                                     | ✅     | Enforced by `packages/render/src/palette.test.ts` (canvas cues ≥ 3:1 vs floor across all four colour modes, measured min 3.17) and `apps/web/src/ui-contrast.test.ts` (DOM text ≥ 4.5:1, measured min 7.17; non-text ≥ 3:1, measured min 5.97), both inside `pnpm run verify`. Sign-off recorded in the Story 7 audit below; Story 10 extends the rendered-contrast e2e spot checks to the Card, Panel, Dock, and the rotate overlay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| No flashing (WCAG 2.3.1)                             | ✅     | No strobing FX; the impact-spark is a single brief fade, well under 3 flashes/sec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Semantic controls / labels for AT                    | ✅     | Real `<button>`s; the HUD is a labelled `role="group"` BY DESIGN (a polite live region would flood AT during combat — `overlay.ts:97-102`); a dedicated polite `aria-live` region (Story 10) announces armed/disarmed, placement success/rejection, and sell + refund; results, settings, and the Story 10 rotate prompt are each a labelled `role="dialog"` behind one modal owner (`modal.ts`) that owns `inert` + focus save/restore across a `results > rotate > settings` priority stack; the board is a labelled `role="application"`. The Panel's "Max level" Upgrade control is a focusable `aria-disabled` element (not a native `disabled` button), so it stays discoverable/reachable by keyboard and AT while its activation is suppressed. The axe audit covers the settings, results, armed-Panel, and selected-Panel states (desktop and, via `chromium-touch`, under touch), plus the inert/Tab-containment/focus-restore modal checks (e2e).                                          |
| All user-facing text is translatable                 | ✅     | Every string resolves through the typed `t()` catalog (ADR 0004); the `no-ui-literals` lint rule bans raw literals in text sinks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
- The armed offset ghost's on-canvas position (2 cells above the finger, flipping below near
  the top edge) — unit-tested in `input.ts`; `apps/web/e2e/touch.spec.ts` additionally proves
  the RENDERED commit lands at the offset anchor (a real screenshot sample), not just the
  DOM-side intent.

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

Deferred to #36 (the real-device playtest that naturally follows Story 10): every item this
checklist can only assess synthetically. The Playwright suite (including `chromium-touch`'s
CDP-driven touch/rotate coverage) proves the LOGIC of press-adjust-release, the tap/drag
threshold, and the rotate prompt is correct; it cannot prove the smallest-phone board is
comfortable to actually build on with a real finger, nor that synthetic touch events fully
match real touchscreen fidelity (PLAN.md's "Risks / open questions"). Both are explicitly
carried forward to #36, not claimed as done here.

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

## Story 10 conformance audit (2026-07-24)

Full re-audit against this checklist for Story 10 (Playable UX: app-shell layout,
touch-first placement, player-started runs). Story 10 is a layout/interaction story with
**zero sim/engine/content changes** (SIM_VERSION stays 5) — this audit covers the new DOM
surface and interaction model it adds on top of the Story 7 sign-off above, which still
holds for the canvas cues and DOM contrast tokens.

**Two-tap is gone — replaced by press-adjust-release + the Armed model.** The Story 6/7 rows
above described touch as "two-tap preview-then-confirm"; that gesture no longer exists.
Touch/pen now presses to show an offset ghost (2 cells above the finger, flipping below near
the top edge so the finger never covers its own footprint), adjusts on move, and commits on
release — one gesture, not two taps on the same cell. **Armed** (defined in PLAN.md's
vocabulary section, extending docs/CONTEXT.md's glossary) is the purely-`apps/web` UI state
"a tower type is chosen for placement" — it never enters the sim or the replay log — and
drives one normative event table (PLAN.md P2) shared by mouse, keyboard, and touch/pen: arm
via Card click/tap/hotkey or `armTower1`; armed placement never re-arms; an
occupied/unaffordable/blocked cell rejects with a persistent invalid ghost (no flash timer)
and stays armed; `Escape`/Close disarm or deselect one layer at a time.

**New layout states recorded:**

- **Shell** (`.wy-shell`, the viewport-filling grid) / **Status bar** (`.wy-status`) /
  **Rail** (`.wy-rail`, one **Card** at M1) / **Panel** (`.wy-panel`, opens inside the Rail
  below the Card) / **Dock** (`.wy-dock`, bottom-left, overlapping the board border) — the
  page itself never scrolls (`body { overflow: hidden }`), but the Status bar, Rail, and
  settings dialog each get `overflow-y: auto` so 200% text zoom reflows/scrolls internally
  instead of clipping (the board viewport is the only fixed-fit element). Verified by
  `apps/web/e2e/smoke.spec.ts`'s 658×320 (smallest supported landscape) zoom pass.
- **Player-started runs**: a fresh run/Play-again holds at tick 0 (no hidden countdown) until
  the player presses **Start**; Space/speed changes never un-hold. Verified end-to-end by the
  new `apps/web/e2e/start-gate.spec.ts` against the board's own `data-run-started`/
  `data-sim-tick`/`data-pending-adds` test-hook attributes, rather than inferred from a wait.

**New modal states recorded:** a single modal owner (`modal.ts`) now owns `inert` on
`.wy-shell` and focus save/restore for a `results > rotate > settings` priority stack — only
the highest-priority open overlay is shown/focused, and `Escape` is consumed by the stack
before any game-level Escape handling. Settings migrated from an inline panel to a bounded,
scrollable dialog with its own labelled Close button.

**New rotate state recorded:** `.wy-rotate` (sibling of the Shell) shows on
`(orientation: portrait)` **and** `(pointer: coarse)` both matching (phones/tablets only — a
narrow desktop window merely squeezes). Entering portrait aborts any in-flight placement
gesture and auto-pauses an active, unpaused run; returning to landscape closes the overlay
but the run **stays paused** until the player explicitly presses Resume — nothing
auto-resumes. Verified by the new `apps/web/e2e/rotate.spec.ts` (`chromium-touch` project,
a real `devices['Galaxy S9+ landscape']` profile), including an axe audit and a rendered-
contrast spot check on the overlay itself.

**New e2e coverage + config landed this story:**

- `apps/web/playwright.config.ts`: a `chromium-touch` project on a real mobile landscape
  device profile (`hasTouch` alone does not guarantee `(pointer: coarse)` matches, which the
  gated behavior below depends on), scoped to `touch.spec.ts`/`rotate.spec.ts`; the default
  `chromium` project's `testIgnore` extended to also skip them (plus `hidpi.spec.ts`, as
  before).
- `apps/web/e2e/start-gate.spec.ts` (new) — the held-at-tick-0 gate, a Pending pre-start
  build, Start, and the Play-again round-trip.
- `apps/web/e2e/touch.spec.ts` (new) — press-adjust-release (with a real rendered-pixel
  proof the commit lands at the offset anchor, not the finger cell, via a small CDP
  `Input.dispatchTouchEvent` driver since Playwright's `Touchscreen` API only supports taps),
  Card tap-vs-drag, chrome/off-board drag cancellation, invalid-tap-keeps-armed, and an axe
  audit of the armed Panel under touch.
- `apps/web/e2e/rotate.spec.ts` (new) — the portrait/coarse gate, auto-pause, the
  stays-paused-until-Resume invariant, and an axe + contrast audit of the overlay.
- `apps/web/e2e/smoke.spec.ts` additions — full-keyboard Card arm + place (the `armTower1`
  hotkey, not just a mouse click), an additional settings focus-restoration angle
  (focus-then-Escape), the `aria-disabled` Upgrade control's keyboard reachability, rendered
  contrast on the Card/Panel/Dock, and the 658×320 200%-zoom reachability pass described above.

**Real-device items explicitly deferred to #36** (this story's natural follow-up playtest,
per PLAN.md's "Risks / open questions"): smallest-phone playability (the always-fit board
gives ~12px cells on the smallest phones — a hypothesis this checklist's synthetic e2e
coverage cannot settle) and synthetic touch fidelity (Playwright/CDP touch events are a good
approximation of a finger, not a replacement for one). Neither is claimed as verified by this
audit.

**Re-audited rows — status confirmed:** every ✅ row in the GAG §2 table above already
reflects Story 10's current behavior (edited in place, not left as stale Story 6/7 prose) —
"Full functionality across touch/mouse/keyboard", "Remappable / rebindable controls",
"DOM/HUD text resize to 200%", "Pause", "Contrast ≥ 4.5:1", and "Semantic controls / labels
for AT" all now describe the Armed/press-adjust-release/Shell/modal-owner/rotate model
directly rather than the pre-Story-10 two-tap/inline-settings/hidden-timer one.

---

## Story 11 conformance audit — Mobile screen estate (Compact layout, install path, fullscreen)

Story 11 reclaims phone screen estate. It adds a **Compact layout** on short viewports, an
honest **install path**, and **fullscreen-on-Start** where the platform supports it. No
sim/engine/content changes. New and changed accessibility-relevant surfaces:

| Surface                                    | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Compact layout** (`(max-height: 500px)`) | ✅     | The status header becomes a full-height left COLUMN: dual-form chips (the complete localized ICU message stays the accessible text in BOTH layouts; the visible glance form — icon + value — is `aria-hidden`, so AT never hears a value twice and no label is ever sentence-split), above an in-column Dock whose buttons keep their localized accessible names with only their VISIBLE text hidden. Column and rail widths are vw-capped so 200% text zoom cannot starve the board; the chips list is a labelled, keyboard-reachable scrollport, and every Dock control stays focusable and in-viewport at 200%. Board floors are pinned numerically against the projected playable grid (`compact.spec.ts`, both the `chromium` and `chromium-touch` projects) rather than eyeballed. The Card's hotkey badge is hidden on Compact — a SPACE decision, not a capability one: touch laptops in a short window keep the keyboard guidance everywhere else, and the binding itself is unchanged and still discoverable in Settings.                                                                                                                                                                                                                                                        |
| **Settings dialog rename**                 | ✅     | The dialog is now "Settings" (it holds more than accessibility); the accessibility controls keep their own "Accessibility" heading, so they remain a named group rather than the dialog's unlabelled remainder. Heading order is h2 → h3 → h3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Install banner**                         | ✅     | A reserved chrome ROW, never an overlay covering the board — it is disjoint from the playable grid, and the board keeps a pinned floor with it visible. Real `<button>`s; the glyph-only dismiss control carries a localized `aria-label` and a ≥44px target. Shown only pre-start, once per session, and never after the first Start. Every visibility change re-homes contained focus (to the Dock's Start button) rather than dropping it on `document.body`, and cancels any in-flight placement gesture — the row resizes the stage. Axe audited with the banner visible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Add-to-Home-Screen instructions dialog** | ✅     | A first-class labelled `role="dialog"` on the same modal owner (`settings` priority), so it inerts the Shell and saves/restores focus like every other modal. Escape dismisses it — Escape behaviour is now per-overlay metadata rather than a hardcoded priority check, which is what let a second dismissable dialog exist at all. Opening it from Settings closes Settings first, so the two never share the stack; closing it returns focus to the Settings opener. Axe audited while open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Dock focus order** (WCAG 2.4.3)          | 🟡     | The Dock is now a child of `header.wy-status` in BOTH layouts (one DOM topology, two layouts), so it is tabbed straight after the status chips and BEFORE the board. Compact matches paint order exactly (left column: chips, then Dock, then board to their right). **Standard does not:** the Dock is painted bottom-left over the Stage, so a Standard keyboard user reaches it one stop before the board it floats over. **Ratified — accepted as-is (product owner, 2026-07-25):** the Dock is a four-control labelled cluster reached immediately after the chips — never a detour past unrelated content — and it keeps the "chrome before content" order the wordmark and chips already establish, which WCAG 2.4.3 permits (meaning and operability preserved, not strict visual correspondence). The contract-amendment alternative was declined: it merely relocates the DOM/paint mismatch to Compact. Gated by `compact.spec.ts`'s "the chips list is a Standard keyboard stop, ahead of the Dock controls" so the order cannot drift unnoticed, and cross-referenced from `shell.ts` (`status.append`) and `ui.css` (`.wy-dock`). Revisit trigger: issue #36's real-device playtest, or if the Dock grows beyond a small cluster or Standard gains a second floating region. |
| **Fullscreen on Start**                    | ✅     | Requested only on the `started` false→true edge, and only when `requestFullscreen` exists ∧ the pointer is coarse ∧ the app is not already standalone ∧ the document is not already fullscreen — capability-based, never UA sniffing. **It never traps:** the app requests fullscreen and then leaves it entirely alone. Nothing here calls `exitFullscreen`, nothing listens to `fullscreenchange`, and no game state depends on it — the platform's own exits (the system back gesture, Escape, swiping down the notification shade) work exactly as the player expects, and leaving fullscreen mid-run changes nothing about the run. A refusal is swallowed: Start behaves identically either way. The rotate overlay keeps working inside fullscreen (it is a DOM sibling, not a browser affordance).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Verification note (fullscreen):** real fullscreen is not CI-exercisable — headless Chromium
either refuses the request or resizes the viewport out from under every geometry assertion in
the suite. Every touch-project spec that presses Start therefore applies a resolving spy
(`apps/web/e2e/fullscreen-stub.ts`), with one dedicated test asserting the request fires
exactly once under the gate and is not repeated mid-run, and a fine-pointer counterpart
asserting it never fires. All eight enumerated gate branches are unit-covered
(`fullscreen.test.ts`, `main.test.ts`).

**Real-device items still deferred to #36:** smallest-phone playability at the pinned floors
(568×320 gets ~10px cells — the supported floor by construction, not a claim that it plays
well), and whether the Compact column's glance chips read as clearly on a real phone as they
do at desktop scale. Neither is claimed as verified by this audit.
