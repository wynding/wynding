# ADR 0015 — A creep's destination is a set of exits, assigned by the board

- **Status:** Accepted
- **Date:** 2026-10-31
- **Decided in:** the M3 grill (Rob, 2026-10-31) · built by [M3](../milestones/m3.md) story 3,
  `formatVersion` 3
- **Relates to:** [PRD 0001](../prd/0001-core-gameplay.md) §1, §3, §4, §5, §7 (amended alongside
  this ADR) · ADR [0006](0006-input-command-and-replay-schema.md) (the replay identity this lands in)
  · ADR [0007](0007-board-and-content-data-format.md) (the board section it extends)

## Context

PRD 0001 defined the board as "one or more creep entrances and a single exit". Every creep
walked to that exit, the maze invariant protected it, and targeting measured "first" against it.

M3's board breaks the single exit. Rob ruled for **two crossing entrance → exit pairs**: north
creeps leak only at the south exit, west creeps only at the east exit. So a creep can no longer
just head for "the exit"; it needs to know which exit is its own.

Rob also named a later wish: custom boards where a designer picks each entrance's exit — two
entrances that both drain east, say — or simply lets creeps take the nearest exit. Custom boards
are outside Phase 1, but how a creep's exit is expressed lands in the board format, the content
hash and every replay now. Changing that shape later means another format bump and a migration
of every board's data, while M3 is already paying for one (`formatVersion` 2 → 3 and a
`simVersion` bump).

## Decision

**A creep's destination is a non-empty set of exits, and the board assigns one to each
entrance.**

- A creep takes its entrance's destination at spawn and keeps it for life.
- **A ground creep follows the shortest path to the nearest exit in its destination.** Its
  flow-field is built outward from every exit in the set at once, which is the same calculation
  as today's single-exit field with more starting cells. The board keeps one flow-field per
  distinct destination, rebuilt on every maze change as today.
- **A creep leaks only at an exit in its own destination;** to every other creep an exit cell is
  an ordinary walkable cell.
- **The maze invariant is per destination:** every entrance must reach an exit in its own
  destination, and every live ground creep must reach one from its current cell.
- **Targeting and AoE lead measure against the creep's own destination.**
- **Air is allowed only where an entrance's destination is a single exit in line with it.** How a
  flyer would choose between several exits is left for the first board that needs it.

M3 ships only one-exit destinations (`west → {east}`, `north → {south}`). "Pick any exit" is a
different one-exit set — content alone (an entrance whose exit is out of line with it carries no
air; letting it fly would widen the air rule, which is sim work). "Nearest exit" is the set of all the board's exits: the
format already holds it, but enabling it takes one small sim story that decides the two open
questions below and widens the capability profile, and that story bumps `simVersion`. What the set
shape saves is a second format change and a migration of every board's data.

## Considered options

- **Keep one exit per board.** Rejected by Rob's crossing-pairs ruling: every creep would drain to
  the same exit, which is not the board he chose.
- **Exactly one exit per entrance** (a single exit id, not a set). Simpler today and enough for
  M3. Rejected because "nearest exit" — the wish Rob named — would then need a second format
  change and a data migration on top of its sim story; a one-element set costs nothing extra
  now.
- **A destination per wave entry.** The most flexible: each stream picks its own exit. Rejected for
  now: nothing asks for it, it would add a field to every wave entry, and it can be added later as
  an override on top of the entrance's default without changing this shape.

## Consequences

- PRD 0001 §1, §3, §4, §5 and §7 replace "the exit" with the creep's destination, and the
  glossary gains **Entrance**, **Exit** and **Destination**.
- `formatVersion` 3's board section carries entrance and exit lists and a destination per
  entrance; the destination becomes part of the content hash and so of every replay's identity.
- Per-tick cost is unchanged: creeps read a flow-field as before. A maze change rebuilds one
  flow-field per distinct destination instead of one — two on M3's board.
- Two questions stay open until a board needs them, and are named so nobody pins them by
  accident: **which exit wins when two in a destination are equally near**, and **how a flyer
  picks among several exits**. Both are decided by the first story whose board has a multi-exit
  destination. Until then the capability profile accepts only one-exit destinations, so neither
  can be answered by accident.
- Custom boards (Phase 4) inherit "pick any exit" as data, and "nearest exit" as data once its
  sim story (above) lands. Their editor, the
  exit-picking interface and the rules for what makes a player-made board valid get their own
  spec when that phase comes.
