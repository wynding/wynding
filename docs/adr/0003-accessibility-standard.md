# ADR 0003 — Accessibility standard

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Accessibility is expensive to retrofit: colour choices, motion, audio cues, and
control schemes bake themselves into gameplay and art early. We commit to a
_formal_ standard before gameplay code — not a vague aspiration.

A game is not plain web content, so WCAG alone is insufficient for the gameplay
surface (a WebGL canvas). The recognised framework for games is the **Game
Accessibility Guidelines (GAG)**. We hold the DOM UI to WCAG and the gameplay to
GAG.

## Decision

### 1. Non-game UI → WCAG 2.1 Level AA

Menus, settings, HUD text, and the (later) store/leaderboard pages are real web
content and must meet **WCAG 2.1 AA**, including its measurable success criteria:
text contrast **≥ 4.5:1** (≥ 3:1 for large text and for UI-component/graphical
boundaries), text resizable to **200%** without loss of function, keyboard
operability with visible focus order, and labelled controls.

### 2. Gameplay → Game Accessibility Guidelines: meet all "Basic," target "Intermediate"

Committed day-one requirements that shape art, UX, and sim-facing input. Where a
number is given it is the testable bar:

- **Never convey essential information by colour alone.** Creeps/towers are
  distinguishable by shape/icon/label as well as colour; ship a colourblind-safe
  palette and optional colourblind modes (protan/deutan/tritan).
- **Reduced-motion setting** (dampen screen shake, particles, parallax).
  **Photosensitivity:** no flashing that violates **WCAG 2.3.1 (Three Flashes or
  Below Threshold)** — no more than **3 general or red flashes per second**, except
  where the flashing area is below the small-safe-area / low-luminance thresholds.
- **Legible, scalable text:** HUD/game text contrast ≥ 4.5:1 against its
  background; text scalable and never below a legible floor at default zoom.
- **Remappable controls** and full functionality across input methods (touch /
  mouse / keyboard); **touch targets ≥ 44×44 CSS (logical) px** — measured in CSS
  pixels, not raw canvas render pixels.
- **No essential information by sound alone** — every audio cue has a visual
  equivalent.
- **Pause**, and **selectable difficulty** (dovetails with the difficulty-tier
  question in the Core Gameplay PRD); the base experience never _requires_
  twitch/time-pressure to succeed (aligns with the "strategic, not twitch" vision).

The full palette test cases and the per-action input matrix live in the checklist
(below), not this ADR.

### 3. Enforcement — a release gate

- **DOM UI:** **axe-core runs in CI** against the rendered DOM UI (via the
  Playwright e2e suite) and **CI fails on any violation**. This wiring lands with
  the first real UI and is a required check thereafter.
- **Gameplay canvas** (can't be auto-audited): every **player-facing PR** completes
  the accessibility checklist at **`docs/accessibility-checklist.md`** (created with
  the first UI; owner: the maintainer) — the relevant items are ticked in the PR, or
  an **explicit, justified waiver** is recorded in the PR description. Unwaived,
  unchecked items block merge.

## Consequences

- **Positive:** inclusive by design; widens the audience; reinforces the
  "approachable, strategic-not-twitch" vision; avoids costly late retrofits of
  palette/motion/control decisions.
- **Negative:** a real, ongoing constraint on art and UX (dual-encoding beyond
  colour, motion budgets, remappable input); the canvas can't be auto-audited, so
  it leans on the checklist + waiver discipline.
- **Neutral:** we target GAG "Intermediate," not "Advanced," for now; the axe-CI
  wiring and the checklist doc are created with the first UI (no UI exists yet to
  gate).
