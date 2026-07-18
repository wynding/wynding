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
content and must meet **WCAG 2.1 AA**: sufficient contrast, keyboard operability
and visible focus order, scalable text, and labelled controls. Automated checks
(e.g. axe) run against the DOM UI where feasible.

### 2. Gameplay → Game Accessibility Guidelines: meet all "Basic," target "Intermediate"

Committed day-one requirements that shape art, UX, and sim-facing input:

- **Never convey essential information by colour alone.** Creeps/towers are
  distinguishable by shape/icon/label as well as colour; provide a colourblind-safe
  palette and optional colourblind modes.
- **Reduced-motion setting** (dampen screen shake, particles, parallax). **No
  content flashing more than 3×/second** (photosensitivity).
- **Legible, scalable text** and a high-contrast HUD; sensible minimum font sizes.
- **Remappable controls** and full functionality across input methods (touch /
  mouse / keyboard); **touch targets ≥ 44px**.
- **No essential information by sound alone** — every audio cue has a visual
  equivalent.
- **Pause**, and **selectable difficulty** (dovetails with the difficulty-tier
  question in the Core Gameplay PRD); the base experience never _requires_
  twitch/time-pressure to succeed (aligns with the "strategic, not twitch" vision).

### 3. Enforcement

An accessibility checklist is part of PR review for player-facing changes;
automated tooling covers the DOM UI. Gameplay-canvas items are manual-checklist
items (they can't be linted).

## Consequences

- **Positive:** inclusive by design; widens the audience; reinforces the
  "approachable, strategic-not-twitch" vision; avoids costly late retrofits of
  palette/motion/control decisions.
- **Negative:** a real, ongoing constraint on art and UX (dual-encoding beyond
  colour, motion budgets, remappable input); the canvas can't be auto-audited, so
  it leans on review discipline.
- **Neutral:** we target GAG "Intermediate," not "Advanced," for now; revisit as
  features (audio, online) land.
