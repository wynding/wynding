# Product Requirements (PRDs)

This directory holds Wynding's product requirement documents — one per feature or
system. PRDs state **our** requirements and rationale in our own terms; they are
public and versioned with the code.

## How PRDs are authored

PRDs come out of a **grill-me → PRD** flow: an interviewer (human or agent) grills
the author one question at a time — challenging fuzzy terms against
[`../CONTEXT.md`](../CONTEXT.md), stress-testing with concrete scenarios, and
resolving every branch of the decision tree — until the design is pinned down.
The converged decisions are then written up here as a PRD.

A good PRD captures:

- **Problem & goals** — what player/product need this serves, and how we'll know
  it worked.
- **Scope** — what's in, what's explicitly out, and why.
- **Design** — the mechanics/systems, stated as our own numbers and rules (never
  by reference to another game).
- **Determinism impact** — whether it touches `packages/sim` / `packages/engine`,
  and how replay/world-hash stability is preserved.
- **Open questions** — anything still unresolved, so reviewers know the edges.

## Conventions

- One file per PRD, named `NNNN-short-title.md` (e.g. `0001-mvp-campaign.md`).
- Keep terminology consistent with [`../CONTEXT.md`](../CONTEXT.md); if a PRD needs
  a new term, add it to the glossary in the same change.
- Architecture decisions that are hard to reverse graduate into an
  [ADR](../adr/); PRDs describe _what/why for the product_, ADRs record
  _structural technical decisions_.

_No PRDs are authored yet — this is the scaffold._
