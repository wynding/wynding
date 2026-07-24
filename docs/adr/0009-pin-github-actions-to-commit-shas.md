# ADR 0009 — Pin GitHub Actions to commit SHAs

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

CI (`.github/workflows/ci.yml`) references third-party actions (`actions/checkout`,
`actions/setup-node`) by a floating major-version tag (`@v4`). A tag is mutable — its
owner (or an attacker who compromises the owner's account) can repoint it to a different
commit at any time, and the next CI run silently executes whatever that commit contains
with the workflow's ambient permissions and (for the checkout steps that don't already
opt out) a persistable repo token. A tag pin is therefore not actually a pin; it is a
promise the action owner can break at any time, without our knowledge, before we've
reviewed anything.

## Decision

### 1. Pin every third-party action to a full 40-character commit SHA

Each `uses:` reference is pinned to the exact commit its current version tag resolves to,
with the human-readable version kept alongside as a trailing comment for reviewability:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

The SHA is what actually executes; the comment is what a reviewer reads. A version bump
is now a visible, reviewable diff (old SHA/comment → new SHA/comment) instead of a silent
re-resolution of a tag.

### 2. Dependabot keeps the pins from rotting

A pin that's never bumped is a different kind of toil — the repo silently drifts behind
security fixes with no visible signal. `.github/dependabot.yml` enables the
`github-actions` ecosystem on a weekly schedule, so pin bumps arrive as ordinary,
reviewable PRs rather than requiring someone to remember to check.

### 3. Scope: the five existing action refs, plus two `persist-credentials: false` riders

Only `actions/checkout` and `actions/setup-node` are in play today (five `uses:` sites
across the three jobs). While touching these steps, the two checkouts that don't push
back to the repo (the `verify` job and the `determinism-version` job — the latter only
reads already-fetched history) also get `persist-credentials: false`, matching the
`a11y-e2e` job's existing setting. Neither job needs a persisted git credential in its
runner, so leaving one there is unnecessary exposure with no corresponding benefit.

## Consequences

- **Positive:** a compromised or force-moved tag on an action we depend on no longer
  executes in CI automatically; every action version change is a visible SHA diff;
  Dependabot keeps pins from calcifying into an unpatched dependency.
- **Negative:** slightly less readable `uses:` lines (SHA + comment instead of a bare
  tag); Dependabot pin-bump PRs are one more category of automated PR to triage weekly.
- **Neutral:** pin-only (no Dependabot) was considered and rejected — it trades one
  silent-rot problem (mutable tags) for another (stale, unpatched pins) instead of
  actually solving supply-chain trust. Broader CI hardening (npm-ecosystem Dependabot,
  Renovate, additional workflow permissions review) is out of scope for this decision.
