# ADR 0011 — Uploading playtraces: automatic, under a notice rather than a consent gate

- **Status:** Accepted. Local capture is ungated; automatic **upload** waits on three ship
  gates (below). Distinct from the three privacy _conditions_ the posture rests on.
- **Date:** 2026-08-16
- **Closes:** [#99](https://github.com/wynding/wynding/issues/99) — its ADR, its capture-posture
  decision, and its work split. The end-of-run survey ([#100](https://github.com/wynding/wynding/issues/100))
  stays open: only one constraint here applies to it.
- **Relates to:** ADR [0006](0006-input-command-and-replay-schema.md) (the replay envelope this
  reuses) · ADR [0008](0008-save-format-and-versioning.md) (the storage seam the opt-out waits
  for).

## Context

A **playtrace** is a run captured for diagnosis: the replay envelope (`seed`, `boardId`,
`rulesetHash`, `simVersion`, `tickInputs`) plus a little UI-layer state. Because the sim is a
pure function of its inputs, that reproduces a run exactly while carrying no serialized world
state — kilobytes, not megabytes, which is what makes a no-infrastructure interim possible.

Today feedback arrives as prose: [#98](https://github.com/wynding/wynding/issues/98) cost a
six-scenario browser investigation to localize to one stale UI flag. M3 is the _tuned_
campaign, and tuning without evidence is guessing.

**The fact that decides the posture:** the site already logs `c-ip`, `x-forwarded-for`,
`cs(User-Agent)`, `c-country` and `asn` on **every request** (`wynding-site`'s
`infra/main/cloudfront_logging.tf`), with no privacy notice anywhere. Uploading therefore does
not introduce IP collection — it introduces a new _purpose_ for data already collected. That
is the difference between needing consent and needing to say so.

## Decision

**Playtraces upload automatically, disclosed by a privacy notice rather than gated behind a
consent prompt.** The payload carries **no directly identifying fields** — but it is
pseudonymous, not anonymous: a session id links a few runs together, and the request itself
carries IP and User-Agent. That makes it personal data, which is precisely why the basis is
legitimate interest rather than none at all, and why the notice must cover the session id and
the gameplay record and not merely the access logs. Legitimate interest holds because the
data is minimal, the linkage is bounded, and IP is already collected regardless — provided
three conditions, none optional:

1. **Player-authored free text never rides the automatic path.** Machine-generated fields are
   bounded; free text is not, and someone will type their own name into it. This is why an
   end-of-run survey must be a separate submission rather than a field on a playtrace (#100).
2. **The opt-out is durable, and its absence blocks the feature.** Non-obvious and easy to get
   silently wrong: `apps/web/src/settings.ts` is deliberately session-scoped pending ADR 0008's
   storage seam, so a toggle added there would reset every reload and re-enable uploads. Where
   storage exists but is unwritable (Safari private mode), fail **closed**.
3. **The session id is bounded, and never persisted.** It deliberately groups a few runs — a
   diagnostic thread often spans more than one — but **the bound must not be page lifetime**:
   Wynding installs as a standalone PWA, so a tab can live for days and "one page session"
   would link an unbounded number of runs. It therefore rotates on a run count and an elapsed
   time, whichever comes first, and always dies on reload. The values are implementation
   (#99); _that_ it is bounded is the decision, because the consent argument below rests on
   the linkage being small. Persisting it would store an identifier on the player's device —
   what cookie-consent rules actually govern, and what we otherwise avoid entirely — turning
   bounded diagnostics into open-ended profiling.

**No settings and no keybindings in the payload.** `Settings` is exactly `colourMode` and
`reducedMotion`, so a settings field would upload a player's colour-vision mode and motion
sensitivity — disability-adjacent data attached to a behavioural record. Keybindings fail a
second test too: `tickInputs` records game actions, not keystrokes, so they cannot affect a
reproduction. Recorded because this is the kind of field a future contributor adds back
helpfully, not knowing why it was left out.

**Local capture is ungated; only transmission is gated.** Building a playtrace and letting the
player export it to a file or clipboard sends nothing anywhere, so it needs no notice, no
opt-out and no configuration, in every build including a source one.

**Earn the endpoint.** Clipboard and file export ship first — kilobyte payloads make pasting
into the existing issue form workable today, and it de-risks the payload before any
infrastructure exists. The endpoint itself belongs to `wynding-site` and gets its own ADR
there; this one fixes the payload and the privacy constraints any transport must satisfy.

**Work split (#99):** this repo owns what is captured, the export action, the durable opt-out
and the strings. `wynding-site` owns the privacy notice, the endpoint, storage and retention.

**Three ship gates. Automatic upload waits for all of them; local capture and export wait for
none.** The privacy notice must exist — owed already for the access logs above. The opt-out
must persist. And the receiving system's **retention and deletion must be defined** before we
start sending it data: `wynding-site` decides what they are, but uploading into storage with
no stated lifetime and no way to delete would make the notice promise something nobody is
accountable for.

## Considered options

- **Manual only** (a button or hotkey): zero consent burden, but depends on a confused player
  thinking to press it, which is exactly what #98 shows they do not.
- **Automatic on loss or error only:** the ordinary crash-reporting posture, and the natural
  fallback if the position above is ever challenged — it loses the least diagnostic value per
  byte, but also misses the balance questions M3 needs.
- **Opt-in consent gate:** rejected while the payload carries no directly identifying fields,
  linkage stays bounded by the rotation rule above, and IP is already collected regardless.
  Note
  the premise is that narrow one, not "nothing is correlatable" — see the first Consequence.
  What would reverse it: linking sessions to each other, free text riding the automatic path,
  carrying accessibility settings, or evidence the audience skews young enough for the caveat
  below to bite.

## Consequences

- The first network call the game itself makes — the page and its assets are fetched by the
  browser today, but no code in `apps/web/src` has ever opened a connection — and the first
  dynamic endpoint on the site.
- **"No profiling" is a commitment, not a guarantee.** Two limits, stated so the premise above
  is not read as stronger than it is. Runs sharing a session id _are_ linked, deliberately —
  which is why that id is bounded rather than left to run as long as the tab does. And across sessions, every upload still writes an IP and
  User-Agent access-log record, so a player's requests remain correlatable at the edge
  whatever the id does. The honest claim is that we do not correlate beyond a session — not
  that nothing could.
- The interim is **clipboard and file export only**. A prefilled issue-form deep link was
  considered and is not consent-free: the run would be encoded into a request to GitHub and
  reach URL logs and history before the player submits anything.
- **An age caveat this does not dissolve.** Legitimate-interest balancing weighs differently
  where the subject may be a child, and a public game with no age gate cannot know. Mitigated
  proportionately — no directly identifying fields, linkage bounded by rotation, no
  accessibility data, a plain notice, a durable opt-out — and recorded as a known accepted
  risk. None of this is legal advice; the notice is worth a real review before automatic
  upload ships publicly.
