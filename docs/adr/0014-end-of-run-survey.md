# ADR 0014 — The end-of-run survey: a second action on the results dialog, asked once per version

- **Status:** Accepted. The surface, the question set and the constraints are decided here.
  Nothing is built by this ADR — implementation is the follow-up issue its acceptance files.
  Two positions wait on work elsewhere, named below: the durable dismissal and the endpoint.
- **Date:** 2026-08-22
- **Closes:** [#100](https://github.com/wynding/wynding/issues/100) — its ADR, its flow sketch,
  and the eight questions it asks.
- **Relates to:** ADR [0011](0011-playtrace-capture-and-privacy.md) (the companion contract,
  and the one constraint it places on this one) · ADR
  [0004](0004-localization-and-i18n.md) (the typed catalog every string goes through) · ADR
  [0008](0008-save-format-and-versioning.md) (the `StorageDriver` seam the dismissal waits for,
  [#142](https://github.com/wynding/wynding/issues/142)) · ADR
  [0003](0003-accessibility-standard.md) (the bar every overlay already meets).

## Context

Feedback reaches us today as prose, or not at all. The one structured channel is the
player-feedback issue form ([#57](https://github.com/wynding/wynding/pull/57)), which requires
leaving the game and holding a GitHub account. The moment a player has an opinion is the moment
the run resolves, and at that moment we collect nothing.

ADR 0011 settled how a **run** gets to us: playtraces upload automatically under a notice, and
local capture is ungated. It deliberately did not settle how a **player's words** get to us, and
it handed this ADR the only constraint it placed on #100, in its own words: _"Player-authored
free text never rides the automatic path... This is why an end-of-run survey must be a separate
submission rather than a field on a playtrace."_ Everything below is built on that split.

The surface already exists and is more capable than it looks. `apps/web/src/overlay.ts` builds
the results dialog as a `role="dialog"` `aria-modal="true"` sibling of the Shell, named per-open
by its own heading, holding a title, a summary, **Play again** (`wy-primary`) and a **second,
non-primary action** — Verify this run — whose outcome is announced through a
`role="status"` `aria-live="polite"` paragraph that `showResults` and `hideResults` both clear.
A secondary action on this dialog that reports its result to a live region is therefore not a
new pattern to invent; it is the pattern already shipping beside Play again.

Containment is worth stating precisely, because it constrains the shape below. `modal.ts` is the
single authority: `.wy-shell` is the **only** node ever made `inert`, overlays are siblings of
it, focus is saved before the first modal opens and restored after the last closes, and only the
**highest-priority open overlay** is shown. There is no tab-cycle focus trap anywhere in the app
— containment is `inert` plus sibling structure, and Tab simply walks the dialog's own controls.

## Decision

### 1. Surface: an inline expansion of the results dialog, never a gate

**"Give feedback" is a second non-primary action on the results dialog, beside Verify this run.
Pressing it expands the survey in place, inside `.wy-results`. Play again is untouched: it keeps
its primary styling, it keeps initial focus, and it is never disabled, deferred or moved.**

Inline rather than a stacked dialog, and the reason is mechanical rather than aesthetic. Results
registers at `results` priority, which outranks everything (`results` 0 > `rotate` 1 >
`settings` 2), and the modal owner shows only the highest-priority open entry. A survey dialog
opened at `settings` or `rotate` priority would be recorded on the stack and stay invisible while
results is open — and then **surface at the worst possible moment**: `close()` calls
`applyActive()`, which shows the highest-priority _remaining_ entry, so the survey would appear
exactly as Play again drove `hideResults()`, in front of the run the player had just started. One
opened at `results` priority would win the last-opened tie-break and **hide the results dialog
underneath it** — replacing the results screen rather than adding to it. Neither is "an optional
secondary action on the results screen", and both require changing `modal.ts`. An inline
expansion requires nothing new: the Shell is already inert, the dialog already owns focus, and
the new controls simply join its tab order after Play again.

Focus follows the patterns already in the file. `resultsOverlay.show()` focuses Play again and
**keeps doing so** — opening the survey must never be what a player lands on. Activating Give
feedback moves focus to the first question. Every exit from the survey names its destination,
because a collapse that leaves focus on a removed node strands it: **Not now** returns focus to
Give feedback, the control that opened it; **an accepted Send** retires Give feedback along with
the form, so focus goes to **Play again** instead; a **rejected or offline** Send keeps focus
inside the survey, with Try again reachable. Escape stays exactly as it is: results is
state-driven, carries no
`dismissOnEscape`, and consumes Escape without dismissing. The survey does not change that, and
does not claim Escape for a collapse — a dialog that swallowed Escape twice with two different
meanings would be worse than one that swallows it once.

**A run started mid-survey cancels any in-flight submission.** `hideResults()` is the single
choke point every run-start path already passes through, and it already clears the transient
live-region text. Cancellation hangs there: the request is aborted, the expansion collapses, and
the survey releases the shared live region back to Verify (§6). Nothing is queued, nothing is
retried, and no result from a previous run is ever allowed to land on the next run's results
dialog. What an abort cannot do is un-send — see the Consequences.

### 2. Question set: four questions, and a standing burden on the fifth

**Rating 1–5. Difficulty 1–5. A "something broke" flag. Free text, capped at 2000 UTF-16 code
units.**

Three of those are the irreducible minimum: how was it, did it break, and a place to say the
thing we did not think to ask. Difficulty earns the fourth slot on the strength of what M2 is
actually doing — a balance pass — for which "it felt too hard" correlated with the run's real
outcome, score, stars and wave reached is the difference between an anecdote and evidence. Every
question after the first costs completion rate, so **any addition must argue against that cost
explicitly**, and this ADR is where that argument gets made. Everything except the rating is
optional; a player may send a rating alone. The rating is what makes a submission mean anything,
so **Send is `aria-disabled` until a rating is chosen** — §6's convention, never the native
`disabled` attribute — and a press while it is disabled announces what is missing rather than
doing nothing and leaving the player to work out why.

The cap is ours and is chosen twice over: long enough that a real bug report fits without the
player editing themselves down, short enough that a single request stays bounded and a moderation
queue stays affordable. It is stated in **UTF-16 code units, as the client's `maxlength` counts
them** — the unit the platform actually enforces. "Characters" would leave the emoji case
undecided, where one astral character costs two code units and a client and a server counting
differently would reject text the player was allowed to type. So the server-side cap **must not
be stricter than what the client permitted**.

### 3. Frequency: once per game version, plus a dismissal that sticks

**Ask once per `gameVersion`, and offer a persistent "don't ask again" that is honoured forever.**

"Ask" here means an **interaction-demanding solicitation** — something that takes the player's
attention and needs a response to clear. The definition is load-bearing, because the Give feedback
button is not one: a passive secondary control demands nothing. So the rejection that follows
targets **prompts, not presence**. Asking every run trains the reflex-dismiss that destroys the
channel; asking once ever under-samples a game that changes weekly. A version boundary is the
natural unit because it is the thing whose answers differ.

**The button's presence is an affordance, not an ask.** It appears on every results dialog of a
`gameVersion` until an explicit player response consumes that version's ask: **Send** retires it
with a thank-you, **Not now** retires it for this version, **Don't ask again** retires it forever.
A button the player never touches consumes nothing and is there again on the next run within the
same version — which is exactly what makes it an affordance rather than a prompt to keep batting
away.

Both halves need durable storage, and this is where the implementation gets it wrong if nobody
says so. ADR 0011 already named the trap: `apps/web/src/settings.ts` is deliberately
session-scoped pending ADR 0008's async `StorageDriver` seam, which does not exist yet, so a
flag added there resets on every reload —
which here means asking a player who already said no. `apps/web/src/install.ts` shows the other
shape available today, a localStorage-backed one-bit UI acknowledgement classified in its own
comment as deliberately outside that seam. Which of the two the dismissal rides is an
implementation choice against [#142](https://github.com/wynding/wynding/issues/142)'s progress.
**This is a dependency of the implementation, not of accepting this ADR** — the decision that the
dismissal must be durable stands on its own, and the ADR does not wait on the seam to be true.
Where storage exists but cannot be written, fail toward **not asking**.

Durable storage is written **only on an explicit player action** — never on mere display. Showing
the button records nothing, which keeps §5's "pressing Send is the act" true of the whole surface,
and means a player who simply ignores the button leaves no trace of having been offered it.

### 4. Envelope: run identity, and no sim changes

The survey submission carries the answers plus the run's identity: `sessionId`, `gameVersion`,
`simVersion`, `rulesetHash`, `boardId`, `seed`, outcome, `score`, `stars`, wave reached
(`waveCursor`) and the final tick.

**No sim changes, and no new sim outputs.** The replay identity (`seed`, `boardId`,
`rulesetHash`, `simVersion`) is already the shape `@wynding/replay` uses; outcome, score, stars,
wave cursor and tick are already sim state the HUD reads every frame. Two fields are honestly
render-layer facts that **do not exist in the source today** and are minted by the
implementation, not extracted from the sim: `sessionId`, the render-layer UUID ADR 0011 defines
and bounds, and `gameVersion`, for which ADR 0013's build-time constant (`hostedDefine` in
`apps/web/build-config.ts`) is the established mechanism. Naming that now is cheaper than a
reviewer discovering it later and reading "already in app state" as a promise the tree does not
keep.

Nothing about the player, the device, or their settings. ADR 0011's exclusion applies unchanged
and for the same reason: `Settings` is `colourMode` and `reducedMotion`, and shipping those with
a behavioural record would attach disability-adjacent data to it.

### 5. Transport: one contract with the playtrace endpoint family, two submissions

**The survey uses the same endpoint family, the same versioned envelope and the same privacy
constraints as the playtrace pipeline — as a separate submission, stored separately.** #100 asked
for this argued either way, so both halves are argued.

One contract, because the alternative is two schemas, two version ladders and two sets of
retention rules for one system, and because the analysis that makes any of this worth doing joins
a player's words to their run. Two submissions, because ADR 0011's first condition is not
negotiable: free text must never ride the automatic path. Merging them would put player-authored
prose into an automatic upload, which is precisely the thing that condition exists to prevent.

The join is therefore **the `sessionId`, not an attachment**. A consent checkbox offering to
attach the run is not the right shape here, because under ADR 0011 the run is already on its way
under its own notice — the checkbox would be asking permission for something already decided, and
would imply the survey is what carries the run.

One consequence must be stated rather than left to be inferred: **the survey is player-initiated,
so pressing Send is the act, and the playtrace opt-out does not govern it.** The opt-out governs
automatic upload of runs. A player who has opted out of that and then deliberately types feedback
and presses Send has sent feedback. The reverse must also hold — opting out must not silently
remove the Give feedback button — or the opt-out becomes a mute button nobody asked for.

The endpoint does not exist. Per ADR 0011 it belongs to `wynding-site` and gets its own ADR
there; this one fixes what the payload is and what any transport must satisfy. Two requirements
beyond §7's server-side length cap are named here for the same reason that one is — they are the
contract's business even though the mechanism is the endpoint ADR's: **server-side volume
bounding** (rate limiting and abuse controls) and **dedup**. §3's once-per-`gameVersion` rule is
client-side, and therefore bounds politeness rather than load: anyone willing to POST directly
bypasses it entirely. §2's argument that a moderation queue "stays affordable" depends on volume
being bounded somewhere the client cannot lie about, and an unauthenticated endpoint that accepts
free text on a client-side promise has no such bound.

### 6. Strings and announcements

Every string goes through the typed catalog (ADR 0004) — the question set is then a content
decision under the unused-key and cross-locale gates, not a scatter of literals the
`wynding/no-ui-literals` rule would reject anyway. The form is axe-clean in the e2e suite like
every other overlay (ADR 0003), with real labels on every control rather than placeholder text.

Submit outcomes are announced in a live region — specifically, **the survey writes to the
existing `role="status"` `aria-live="polite"` node that Verify already uses**, rather than adding
a second one. Two live regions in one dialog would let two features announce over each other with
no way for a screen reader to tell which message was current. Sharing one node instead requires a
**single-owner handoff**: a feature takes the region when it has something to say, holds it until
its outcome is final, and releases it — clearing the text, exactly as `showResults` and
`hideResults` already do — when it collapses or is cancelled. **Success, failure and offline each
get a player-visible, non-blocking result.** None of them ever blocks Play again. Silence on
failure is the specific defect to avoid — a player who pressed Send and heard nothing has to
guess, and will guess that it worked.

Controls that are momentarily unavailable — Send before a rating exists, and the survey's controls
while a submission is in flight — use **`aria-disabled` with activation suppressed at the click
site, never the native `disabled` attribute**. That is the house convention and `overlay.ts`
states its reason: dynamically disabling a control that currently holds focus drops it from the
tab order and strands focus, and hides it from assistive technology entirely. `main.ts`'s
`primaryAction` shows the other half — the keyboard path shares the same gate, so a press arriving
through the keymap can never activate what the button itself refuses.

### 7. Free text: caps, moderation before aggregation, retention and deletion

- **Capped on both sides.** 2000 UTF-16 code units client-side, as `maxlength` counts them, so
  the player sees the limit while typing; and again server-side, because a client-side cap is a
  courtesy and not a control. The server's cap must not be stricter than the client's (§2).
- **Disclosure follows ADR 0011's mechanism rather than inventing one.** That ADR discloses
  request-log capture — IP and User-Agent, logged on every request to the site — through a
  **privacy notice owned by `wynding-site`**, and makes the notice's existence a ship gate. The
  survey adopts the same mechanism: the same notice, extended to cover survey submissions (the
  free text, and §4's run identity), under the same gate — nothing is sent before it exists.
  Because Send is a discrete, player-initiated act rather than an automatic upload, the Send
  control also references that notice at the point of submission, which is the one moment a
  player is actually deciding.
- **Moderation before aggregation.** No free text reaches a dashboard, a digest, or any surface
  someone reads in bulk until it has passed a moderation step. Recorded as a requirement of the
  contract; the tooling is explicitly out of scope and is not built here.
- **Retention: 90 days**, chosen as ours — long enough to cover a balance pass end to end, short
  enough that the promise stays cheap to keep and is not quietly broken later.
- **Deletion by `sessionId`**, as a defined manual process, owned by the receiving system
  alongside the retention window. ADR 0011's third ship gate applies here in full: retention and
  deletion must be defined before we start sending anything.
- **The `sessionId` is shown in the survey at or before Send** — not only in the message that
  follows an accepted one. It is client-generated and needs no acknowledgment from anyone, so
  there is nothing to wait for. This is not decoration: ADR 0011 requires that id to be bounded
  and **never persisted**, so a player who does not capture it cannot recover it afterwards, and
  showing it only on success would lose it in precisely the case that needs it most — a send that
  raced a run start, where the request may have been delivered and stored while the client
  stopped waiting for the answer.

### 8. Before an endpoint exists: named, not built

The zero-infrastructure interim is a **"Give feedback" button that deep-links the existing issue
form ([#57](https://github.com/wynding/wynding/pull/57)) with the run's identity prefilled in the
URL**. It works today, costs nothing, and measures whether the appetite is real before anyone
builds a Lambda for it.

It is **named here as the pre-endpoint option and is not built by this ADR**, and it does not
arrive cost-free. ADR 0011 considered the same deep link for playtraces and declined it: the run
is encoded into a request to GitHub and reaches URL logs and history before the player submits
anything. That objection survives here and is not answered by this ADR. One narrowing is
available and should be recorded — a deep link that prefills **only the machine-generated run
fields**, leaving the player to type their own words into GitHub's form, means no player-authored
text ever rides our URL. That reduces the objection to the run fields alone; it does not dissolve
it. Whoever ships this owes that argument, and this ADR does not pre-approve it.

## The flow

```text
run resolves
  └─► results dialog opens          Shell inert · `results` priority · Escape consumed, never a
      │                             dismissal
      focus ──► [Play again]        always first, never moved, never gated, never disabled
      │
      ├─ [Play again] ─────────────────────────────────────────────────► new run
      ├─ [Verify this run] ──► wy-verify live region                     (exists today)
      └─ [Give feedback] ──► the survey expands IN PLACE, below the summary
                             focus ──► first question
          ┌───────────────────────────────────────────────────────────┐
          │  How was it?          ( 1  2  3  4  5 )   ← required      │
          │  How hard was it?     ( 1  2  3  4  5 )                   │
          │  [ ] Something broke                                      │
          │  Anything else?       [ free text, ≤ 2000 code units ]    │
          │                                                           │
          │  Reference <sessionId> · what a deletion request quotes   │
          │  Sending also means the site privacy notice applies       │
          │                                                           │
          │  [Send]   [Not now]        [ ] Don't ask again            │
          └───────────────────────────────────────────────────────────┘
            │
            ├─ [Send] with no rating ─► aria-disabled · press announces "choose a rating"
            │                           focus stays put · nothing sent
            ├─ [Not now] ─────────────► collapses · nothing sent · focus ──► [Give feedback]
            │                           asked again only on the next gameVersion
            ├─ [Don't ask again] ─────► durable dismissal ──► never asked again
            └─ [Send] ────────────────► controls aria-disabled (never `disabled`, so focus
                 │                      is never dropped) · live region: "Sending…"
                 ├─ accepted ─────────► "Thanks. Reference <sessionId>."
                 │                       collapses · Give feedback retired
                 │                       focus ──► [Play again]
                 ├─ rejected ─────────► "Couldn't send." · [Try again] · text preserved
                 │                       focus stays in the survey, on [Try again]
                 └─ offline ──────────► said as offline · [Try again] · text preserved
                                         focus stays in the survey, on [Try again]
                                         nothing queued, nothing retried in the background

── at ANY point above ──────────────────────────────────────────────────────────────────
a run starts (Play again, or any other path through `hideResults()`)
  └─► in-flight submission ABORTED · expansion collapses · live region released
      no retry, no queue, and no result from this run ever lands on the next one's dialog
      the abort stops the CLIENT waiting — a delivered request may still have been stored,
      which is why the reference above is shown at Send and not only on success
```

Play again is reachable from every state in that sketch, including while a submission is in
flight. That is the property the whole surface is arranged around.

## Considered options

- **A stacked survey dialog over the results dialog.** Rejected on mechanism, not taste: the
  modal owner shows only the highest-priority open overlay, and results already holds the top
  priority. Stacked _below_ it the survey stays invisible while results is open — and then
  appears at the worst moment, because `close()` calls `applyActive()`, which promotes the
  highest-priority remaining entry: the survey would pop up over the run the player had just
  started. Stacked at _equal_ priority it hides the results screen it is supposed to accompany.
  Both need `modal.ts` changed to support a shape inline expansion gets for free.
- **Ask every run, or once per session.** Every run trains reflex-dismissal and poisons the
  channel within a sitting. Once per session under-samples badly, and "session" is a slippery
  unit in an app that installs as a standalone PWA and can hold a tab open for days — the same
  reason ADR 0011 refused to bound its session id by page lifetime.
- **One merged payload with the playtrace.** Rejected by ADR 0011's first condition. It is the
  simplest thing to build and would put player-authored free text on the automatic path.
- **An opt-in checkbox to attach the run to the survey.** Redundant under ADR 0011, where the run
  travels under its own notice; the `sessionId` joins them without asking a question whose honest
  answer is "we already did".
- **Ship the deep-link interim now instead of an ADR.** Rejected as the ordering, not the idea:
  §8 keeps it available, and deciding the question set and the retention rules first is what
  stops the interim from setting them by default.

## Consequences

- **The first player-authored text this project transmits anywhere.** Every constraint in §7
  exists because free text is unbounded by construction and someone will type their own name into
  it.
- **A client-side abort stops the client waiting; it does not un-send.** §1's cancellation aborts
  the request, but a request already delivered may still be durably stored at the far end. This is
  exactly why §7 shows the `sessionId` at Send rather than on success: without it, the one
  submission a player most plausibly wants deleted — the one whose outcome they never saw — would
  be the one whose reference they never got.
- **The results dialog gains a third action and stops being trivially simple.** Its contrast
  spot-check, its axe coverage and its focus behaviour all now have more surface to hold, and the
  live region is now genuinely shared: §6 decides that the survey writes to Verify's existing
  `role="status"` node under a single-owner handoff. The cost is a protocol two features must both
  keep, rather than a second live region to maintain — a trade taken deliberately, because two
  regions announcing over each other is the worse failure and the harder one to notice.
- **The once-per-version promise is only as durable as the storage under it**, and the storage
  under it does not exist yet. Until [#142](https://github.com/wynding/wynding/issues/142) or the
  `install.ts` pattern carries it, a naive implementation silently degrades to "every reload",
  which is the failure mode most likely to ship unnoticed because it looks fine to whoever wrote
  it.
- **Deletion depends on the player having written down a number.** Honest rather than
  comfortable: bounded, never-persisted session ids and durable per-player deletion are in real
  tension, and this ADR resolves it toward the id staying bounded. A player who loses the
  reference has no route to their submission, and no promise is made that they do.
- **Completion rate is now a number worth watching.** Four questions is a judgement, not a
  measurement; if the surface gets used and the free-text field is where players stop, that is
  evidence to cut a question, and §2's standing burden is what makes that a decision rather than
  a drift.
