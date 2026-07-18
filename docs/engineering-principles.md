# Engineering Principles

How Wynding is built. These are **values, not rules to lawyer** — they describe the bar we
hold and the culture we're inviting contributors into. They lean on the Lean / DevOps
tradition (Gene Kim's "Three Ways," Toyota Kata); if you know that lineage, you'll recognize
them. They're an invitation, not a mandate — work the way that suits you, but know this is
the grain of the project.

## Automate the toil

If a task recurs, automate it — as a rule of thumb, if automating costs no more than ~10×
doing it once, it's worth it. Genuinely one-off work is the exception. A manual step that
_could_ be a script is technical debt we just haven't paid yet.

## Improve the work, not just the output

"Improving daily work is even more important than doing daily work." Time spent making the
build faster, the tests clearer, or the workflow smoother compounds. Leaving the campsite
cleaner than you found it — tooling, docs, CI — is real work, not a distraction from it.

## Build it right the first time

We don't cut corners silently. Do the thing properly — or, if there's a good reason to cut a
corner (a time box, a deliberate spike, a scoped-down first pass), **say so explicitly in the
PR** so it's a decision on the record, not a surprise someone finds later. A tracked shortcut
is fine; a hidden one is a bug waiting to happen.

## Continuous improvement

Set a goal and iterate toward it — shipping a rough-but-honest first pass and refining beats
waiting for perfect. Always look for the improvement, both in _what_ we build and in _how_ we
build it. Retrospection is part of the loop, not an afterthought.

---

These principles set the bar; the mechanics that enforce it (the `verify` gate, review,
coverage) live in [ai-workflow.md](ai-workflow.md) and [../AGENTS.md](../AGENTS.md). Who
decides what is in [working-agreement.md](working-agreement.md).
