# Design notes

**Design notes are implementation guidance, not decisions.** Each note elaborates _how_
to build what an ADR decided — schemas, encodings, contracts, concurrency, algorithms.
The ADR is the source of truth for _what_ and _why_; a note refines the _how_ and is
expected to evolve as the code and its tests are written (the tests become the real
specification).

If a note and an ADR ever conflict, the ADR wins — or the ADR is superseded by a new
ADR. A note never overrides a decision, and a gap or nitpick at this level is an
implementation detail, not an amendment to the decision it serves.

Current notes:

- [`replay-and-commands.md`](replay-and-commands.md) — implements ADR 0006 (input-command
  and replay schema).
- [`ruleset-format.md`](ruleset-format.md) — implements ADR 0007 (ruleset data format and
  hashing).
- [`save-format.md`](save-format.md) — implements ADR 0008 (save format and versioning).
