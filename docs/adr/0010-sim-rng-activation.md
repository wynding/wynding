# ADR 0010 — Activating the sim RNG: keep Mulberry32, freeze the mapping

- **Status:** Accepted
- **Date:** 2026-08-04
- **Story:** M2-S6 (stun + immune counterplay), `simVersion` 10

## Context

`SimState.rngState` has been part of the hash-serialized world state since M1, and
`packages/engine/src/rng.ts` has carried a Mulberry32 `Rng` class, but **nothing has ever
drawn from it** — `sim.test.ts` pins that `step()` leaves `rngState` byte-identical across
a full run (#45). M2-S6's chance-based stun is the first consumer.

That makes this the last cheap moment to change generators. `rng.ts`'s own header says so:
changing the generator or the `nextU32 → [0, max)` mapping alters the output stream, which
is a determinism change requiring a `simVersion` bump — and it notes the cost is currently
zero because "`Rng` has no production consumer to migrate anyway." From S6 on, that clause
expires: every stored replay's validity depends on reproducing the exact draw sequence.

The concern worth taking seriously is that `rng.ts` documents two known weaknesses in its
own doc comments — Mulberry32 is approximately uniform but **not equidistributed** over
uint32 (32 bits of state), and `nextInt(max)` adds **modulo bias** whenever `max` does not
divide 2³². m2.md pins stun's threshold as `64/256`, so the mapping in question is
`nextInt(256)`.

## Decision

**Wire `Rng` exactly as its header describes, and do not change the generator or the
mapping.** One `Rng` is constructed from `state.rngState` at the top of `step()`, threaded
into the combat phase, and snapshotted back with `getState()` at tick end. Stun draws
`rng.nextInt(256)` and applies on `draw < chanceNum`.

Both documented weaknesses were measured against this specific use rather than reasoned
about:

- **Modulo bias is exactly zero here.** 256 divides 2³², so `nextInt(256)` maps 2²⁴ source
  values onto each of the 256 outcomes with no remainder.
- **Low-byte quality is fine.** Mulberry32's final step is `t ^ (t >>> 14)`, so output bits
  0–7 are folded with bits 14–21 of an already twice-multiplied-and-xored word — the low
  byte is not raw state, which is where the "low bits of a PRNG are weak" folklore comes
  from (that is an LCG property). Over **20M draws for each of seeds 12345, 1, 0 and
  0xdeadbeef** the 64/256 threshold fires on 24.983%, 24.999%, 24.991% and 24.989% of draws
  (target 25%), and seed 12345's low byte gives **χ² = 248.6 on 255 df** — indistinguishable
  from uniform.
  The seeds are named because the figures are seed-specific and otherwise not reproducible:
  a different set lands on slightly different numbers (an independent check on seeds 0–3
  measured 24.983%–25.006% and per-seed χ² between 223 and 289). The conclusion is
  insensitive to the choice; the exact percentages are not.

## Considered options

- **Replace the generator (PCG32, SplitMix32) while migration is free.** Rejected: the
  measurement above shows nothing to fix at this use. `rng.ts` is normative, tested, and
  already load-bearing for world-hash identity; swapping it would trade a documented,
  measured primitive for an unmeasured one to buy a property no consumer needs.
- **Keep Mulberry32 but draw the high byte (`nextU32() >>> 24`).** Rejected on the
  measurement alone: the high byte measures no better than the low byte (24.996%–25.015%
  on the same sweep), so the change would buy nothing while altering the output stream.
  (An earlier draft also argued this would grow an API whose header forbids growth. That
  reason was wrong and is deleted rather than repaired: `nextU32()` already exists and
  `>>> 24` is applied at the call site, so this option needs no new method at all.)

## Consequences

- The generator, the `nextInt` mapping, and the **draw sequence** are now frozen for the
  alpha line. m2.md §Combat already pins the sequence: draws occur only inside the combat
  traversal, in creep-id-then-authored-effect order, and an **immune target consumes no
  draw**. Changing any of those is a `simVersion` bump, not a refactor.
- `rngState` now advances, so its "inert" anchor test is replaced by two: it stays
  byte-identical under a stun-free ruleset, and it advances by exactly one draw per
  non-immune stun application attempt.
- `Rng`'s constructor coerces with `>>> 0`, so a forged or partially-restored `rngState`
  self-heals to a uint32 on the first tick it is read — for any NUMBER. A non-number or
  non-finite `rngState` (a BigInt or Symbol on a hand-built state) makes `>>>` THROW
  rather than coerce, so `coerceSoa` type-repairs that case to 0 first; the two together
  are what keep the activation total. Consistent with `coerceSoa`'s
  posture elsewhere in the sim, and pinned by its own test.
- The modulo-bias caveat in `nextInt`'s doc comment remains true in general and stays
  written down; this ADR records only that it does not bite at `max = 256`. A future
  consumer picking a non-power-of-two `max` inherits the caveat, not this clearance.
