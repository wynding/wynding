# ADR 0014 — The end-of-run survey: a second non-primary action, asked once per version

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

Feedback reaches us today as prose, or not at all. Two structured channels exist, and both are
somewhere else. The player-feedback issue form
([#57](https://github.com/wynding/wynding/pull/57)) requires leaving the game and holding a
GitHub account; that form's own intro routes anyone who would "rather not use GitHub" to the
site's feedback form at `wynding.net/#feedback`, which drops the account requirement but is
free-form and carries no run identity, so nothing it collects can be joined to the run it is
about. The moment a player has an opinion is the moment the run resolves, and at that moment we
collect nothing.

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
Give feedback, which stays present and live on this dialog (§3) so the focus target is real and
a misclick is recoverable; **an accepted Send** retires Give feedback along with the form, so
focus goes to **Play again** instead; a **rejected or offline** Send leaves focus exactly where
it is, because **Try again is the Send control relabelled in place** — the same node, so nothing
moves. The survey's other controls re-enable on a rejection, with the player's text preserved.
Escape stays exactly as it is: results is state-driven, carries no
`dismissOnEscape`, and consumes Escape without dismissing. The survey does not change that, and
does not claim Escape for a collapse — a dialog that swallowed Escape twice with two different
meanings would be worse than one that swallows it once.

**A run started mid-survey cancels any in-flight submission.** `hideResults()` is the single
choke point every run-start path already passes through, and it already clears the transient
live-region text. Cancellation hangs there: the request is aborted, the expansion collapses, and
the survey releases the shared live region back to Verify (§6) — releasing it **clears** the
region on this path, because an aborted send has no result worth announcing. Nothing is queued,
nothing is
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

That announcement is a **deliberate divergence** from the Dock convention §6 otherwise adopts,
and it is called out here because an implementer copying the cited code would build the opposite.
`main.ts` states the Dock's rule as "a disabled control must not announce a rejection (or
dispatch at all)", and `overlay.ts`'s click suppression is a bare early return. That silence is
right for the Dock, whose primary control sits under movement keys and absorbs presses the player
never meant. It is wrong here: pressing Send is an explicit submit attempt, and an explicit
attempt deserves an answer. So the suppressed press still writes the live region — and it must do
so **identically on the click and keymap routes**, or keyboard users get exactly the
silence-on-press asymmetry the shared-gate citation exists to prevent.

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
`gameVersion` until an explicit player response consumes that version's ask. A button the player
never touches consumes nothing and is there again on the next run within the same version —
which is exactly what makes it an affordance rather than a prompt to keep batting away.

Two responses consume the ask, and they differ in scope:

- **Send** retires the button on this dialog, with a thank-you in its place.
- **Not now** collapses the survey but **leaves Give feedback present and live on the current
  dialog** — reopening is allowed, because a misclick should be recoverable and §1 sends focus
  back to that button, which must therefore be real. What it consumes is the ask on
  **subsequent** results dialogs this version.
- **Don't ask again** is a **checkbox modifier, not an action.** Checking it arms
  forever-dismissal; the next collapse-committing action — Not now or Send — commits the durable
  write; unchecking before that disarms it. It never writes storage on its own, which keeps the
  rule below true and keeps a check from being a trap the player cannot back out of. Because Not
  now leaves the button live on the current dialog, a player who commits and immediately regrets
  it can reopen the survey there and uncheck — though a second collapse then re-commits whatever
  the checkbox says at that moment. That is the whole rule; it is deliberately not smarter.

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
Where storage exists but cannot be written, fail toward **not asking** — and that means exactly
one thing: **an unpersistable dismissal is honoured in memory for the rest of the session**, the
same posture `install.ts` already takes, so a player who said "don't ask again" is not asked
again in the session where they said it. Across sessions, a dismissal that could not be recorded
is a dismissal we do not know about, so the button returns. The feature is never withheld
wholesale: hiding Give feedback because storage is unwritable would punish Safari private-mode
players with the loss of a channel they never declined.

Durable storage is written **only on an explicit player action** — never on mere display. Showing
the button records nothing, which keeps §5's "pressing Send is the act" true of the whole surface,
and means a player who simply ignores the button leaves no trace of having been offered it.

### 4. Envelope: run identity, and no sim changes

The survey submission carries the answers plus the run's identity: **`runId`** — a render-layer
UUID minted at run start — plus `sessionId`, `gameVersion`, `simVersion`, `rulesetHash`,
`boardId`, `seed`, outcome, `score`, `stars`, wave reached (`waveCursor`), the final tick,
**`finalHash`** — the sim's content-hash of the terminal world state — and **`replayDigest`**, a
collision-resistant digest of the run's input log.

**`runId` is the instance identity, and it is the one field this ADR asks of the playtrace
capture.** It is minted at each run start in the render layer, exactly like `sessionId` and under
the same non-persistence rules — no sim change, since the sim neither reads nor produces it. It
must also be carried by the playtrace, which is a requirement this ADR places on
[#133](https://github.com/wynding/wynding/issues/133)'s capture: that work's ratified plan already
requires its allowlist to be serialized **explicitly** (never an object by reference, with a
snapshot test proving an upstream field cannot leak in unlisted), and already puts `boardId` "in
anything identifying a run" — a per-run id is squarely that family. No ADR 0011 text needs
amending, because 0011 delegated the capture payload to #133, and #133 is being built in this
same campaign, so the requirement lands with work already in flight rather than waiting on a
future amendment.

`finalHash` is not a new quantity and nothing about it is minted here. `hashSimState` is already
exported from `packages/sim`, the app layer already calls it at run end
(`apps/web/src/controller.ts`), and it is the same value the determinism golden pins
(`packages/content/src/m2-golden.test.ts`, guarded by `scripts/check-determinism-version.mjs`).
The survey reads it exactly as it reads every other field above. What it is **not** is an
identity: `packages/engine/src/hash.ts` implements it as FNV-1a over the serialized state and
labels itself in its own comment — "fast, deterministic 8-hex-char digest (not crypto)". Eight
hex digits is 32 bits. It is a **cheap, human-legible discriminator** — excellent for spotting
that two runs differ, useless as a claim that two runs are the same.

`replayDigest` carries the weight `finalHash` cannot. It is a **SHA-256 over the recorder's
canonical serialized input log**, computed by the **app layer at send time** — and it too
requires no sim change and no change to ADR 0011. The recorder already holds the log:
`apps/web/src/controller.ts` accumulates `tickInputs` and exposes the whole envelope through
`buildReplay()`. The digest comes from Web Crypto's `crypto.subtle.digest`, available in the
secure contexts this PWA already requires. Nothing new is captured — the digest is a function of
data the app already has, and §7's privacy posture is untouched because **the digest reveals
nothing the playtrace does not already carry**; it is a fingerprint of the log, not an addition
to it.

**No sim changes, and no new sim outputs.** The replay identity (`seed`, `boardId`,
`rulesetHash`, `simVersion`) is already the shape `@wynding/replay` uses; outcome, score, stars,
wave cursor and tick are already sim state the HUD reads every frame. Three fields are honestly
render-layer facts that **do not exist in the source today** and are minted by the
implementation, not extracted from the sim: `sessionId`, the render-layer UUID ADR 0011 defines
and bounds; `runId`, minted per run start under the same rules; and `gameVersion`. Naming them
now is cheaper than a reviewer discovering it later and reading "already in app state" as a
promise the tree does not keep.

**`gameVersion` is a build-time release identifier derived from git**, and it needs to be pinned
here rather than left to the implementation, because §3's whole frequency rule rests on it. It is
minted at build time as the tag if the build sits on one and the short commit sha otherwise
(`git describe`-style), and carried through the **same build-time define mechanism ADR 0013
established** — `apps/web/build-config.ts` grows a version define alongside the hosted one.
`hostedDefine` is the **precedent** for that mechanism, not the carrier: it defines a single
boolean and is not where a version belongs. `apps/web/package.json` is deliberately not the
source either — it is pinned at `0.0.0` and never bumped, so reading a version from it would make
every release look identical. **Its bump boundary: every deployed build is a new
`gameVersion`.** That is the honest reading of "once per version", and its cost is equally
honest — **"Not now" lasts until the next deployed build**, which on an actively deployed game
can be days rather than weeks.

**The analysis grouping keys are `simVersion` + `rulesetHash`, not `gameVersion`.** A deploy that
changes only a stylesheet mints a new `gameVersion` while the game plays identically, so grouping
answers by it would split one balance question across builds that share a ruleset. The envelope
already carries both keys for exactly this reason: `gameVersion` governs how often we ask,
`simVersion` and `rulesetHash` govern what the answers can be compared against.

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

The join is therefore **the run identity the envelope carries — anchored by `runId` and verified
by the rest — not an attachment**. A consent checkbox offering to attach the run is not the right
shape here, because under ADR 0011 the run is already on its way under its own notice — the
checkbox would be asking permission for something already decided, and would imply the survey is
what carries the run.

**`sessionId` alone is not enough to name a run, and saying so is the point.** ADR 0011's
rotation is deliberate: an id bounded by a run count and an elapsed time is _designed_ to span
more than one run, because a diagnostic thread often does. So a player who finishes several runs
before it rotates produces several playtraces sharing one id, and a survey joined on that field
alone has multiple candidate runs — which would attribute a rating or a difficulty answer to the
wrong outcome, in exactly the analysis §2 spent a question on.

**The join is therefore layered, and the layers answer different questions.** `runId` **selects
the instance** — carried by both records, exact, and the only field that can tell two runs apart
when everything about their content agrees. The composite (`sessionId`, the replay identity, the
outcome fields, `finalHash`) and `replayDigest` remain as the **verification layer**: they
establish that the selected playtrace really is the run the survey describes, rather than
something mislabelled. They are also the **fallback** for any record that predates the id.

That fallback exists for robustness, not migration: **neither record exists in production yet**,
so adoption is clean and there is no legacy-data gap to bridge — the survey endpoint has never
run, and #133's capture is still being built.

**`finalHash` is what makes that composite bite, and it is why the aggregate fields alone were
not enough.** Two runs in one session can reuse a seed and finish with identical outcome, score,
stars, wave and tick while differing in their input logs, their tower layouts and how they
failed — which is precisely the difference a "something broke" report needs joined to the right
playtrace. This repo already learned that lesson elsewhere: `outcomesMatch` in
`apps/web/src/controller.ts` gates replay verification on `finalHash` and says why in its own
comment — "a different tower layout reaching the same score" makes score and stars agree while
the world diverged. A join on aggregates alone was repeating that mistake.

The terminal state includes the final tower layout, so two runs matching across the envelope
including `finalHash` share their end state byte for byte. But that is a filter, not an identity,
and an earlier revision of this ADR overclaimed by treating it as one: **distinct mid-run paths
can converge on an identical terminal state**, and when they do, inspecting the candidate logs
reproduces both paths without revealing which one the player was talking about. A mid-run
"something broke" report could still be attached to the wrong playtrace.

**`replayDigest` settles content identity, and it does so without the playtrace storing it: the
digest is carried in one record and _derivable_ from the other**, because **the playtrace _is_
the input log**, so a candidate's digest can always be recomputed. What that proves is that two
records describe the same run _content_ — same seed, same inputs, same everything.

**What it cannot do is distinguish two instances of that content, and that is the limit of every
content-derived key.** Two runs that reuse a seed and repeat the same inputs — an automated
re-run, or a player deliberately replaying the same opening — produce byte-identical logs and
therefore identical digests. Every narrowing field agrees too. An earlier revision of this ADR
claimed at most one candidate could match; that was false for exactly this case, and it is why
`runId` is the identity rather than an optimisation. Content-derived keys answer "is this the
same run?"; only a minted id answers "which occurrence?".

Deletion is unaffected: §7 deletes by `sessionId`, which sweeps every submission in that session,
and that coarser grain is the right one for a privacy operation anyway.

Two questions this shape invites, answered here so nobody has to re-derive them:

- **Why not `runId` alone?** Because a bare identifier proves nothing about content. It says two
  records claim to be the same run; it cannot say they agree on the seed, the inputs or the
  outcome. A mislabelled or truncated capture would join cleanly and silently. The layers answer
  different questions — **which instance** (`runId`), and **whether the content matches**
  (composite + `replayDigest`) — so keeping both is what makes a bad join detectable instead of
  merely unlikely.
- **UUID collision?** A v4 UUID's collision probability is negligible at any volume this game
  will ever produce, and the verification layer would catch the only interesting case anyway: a
  collision across _different_ content shows up immediately as a digest mismatch.

**Privacy: `runId` is narrower than `sessionId`, not wider.** It is ephemeral to a single run and
deliberately links nothing — where `sessionId` is bounded precisely because it groups a few runs
together (ADR 0011), a per-run id groups none. It falls under the same non-persistence rules, is
never stored on the device, and reveals nothing about the player: it distinguishes one run from
another and does no other work.

One consequence must be stated rather than left to be inferred: **the survey is player-initiated,
so pressing Send is the act, and the playtrace opt-out does not govern it.** The opt-out governs
automatic upload of runs. A player who has opted out of that and then deliberately types feedback
and presses Send has sent feedback. The reverse must also hold — opting out must not silently
remove the Give feedback button — or the opt-out becomes a mute button nobody asked for.

The endpoint does not exist. Per ADR 0011 it belongs to `wynding-site` and gets its own ADR
there; this one fixes what the payload is and what any transport must satisfy. Two requirements
beyond §7's server-side length cap are named here for the same reason that one is — they are the
contract's business even though the mechanism is the endpoint ADR's: **server-side volume
bounding** (rate limiting and abuse controls) and **dedup**.

Dedup here means **retry idempotency**, and it needs a stated key or the endpoint ADR inherits
something that sounds impossible. There are no accounts and ADR 0011 makes the `sessionId`
rotate and die on reload, so nothing can be deduplicated "per player" — the coherent target is
the case §1 and the Consequences themselves create: a send that was aborted client-side but
delivered anyway, followed by a re-send. The client therefore mints a **per-submission
idempotency key**, and the scoping matters: the key belongs to _one logical submission_, not to
the session. It is **stable
across an unchanged retry** and **refreshed whenever the payload changes**. Deriving it from the
payload is the natural implementation and is named as such — an unchanged retry reproduces the
same key mechanically, while an edit produces a different one without the client having to track
anything.

That distinction closes a case a session-scoped key would get wrong. Because a rejected send
re-enables the form with the player's text preserved (§1), the player may edit their answers
before retrying. If the server had in fact stored the first attempt and only the response was
lost, a key scoped to the session would dedup the _edited_ attempt against the _stored earlier_
payload and report success — while the revisions were never stored at all. A key that refreshes
on edit cannot do that: an edited retry is a new logical submission and lands as one.

`(sessionId, gameVersion)` still travels, but as **politeness and join context, not the dedup
key**. The rotation limit stands and is worth stating rather than discovering: if the session id
rotated between two attempts, the re-send is **un-joinable to the earlier one**. That is
tolerated, because the client's own once-per-version politeness bounds how often it can happen,
and because the alternative — an identifier stable enough to join across rotation — is precisely
the persistent identifier ADR 0011 refuses to create. Volume bounding stays a separate
requirement: idempotency deduplicates an honest client's retries, and does nothing about a
dishonest one. The mechanism — how the key is carried and enforced — belongs to the endpoint ADR.

§3's once-per-`gameVersion` rule is
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
**single-owner handoff**: a feature takes the region when it has something to say, and holds it
until its outcome is final. **Releasing is handing the region back, which is not the same as
wiping it.** On the accepted path the final message — the thank-you and the reference — **stands
after the survey collapses**, and is cleared only by the next owner taking the region (a Verify
press) or by `hideResults()` on the next run start. Collapsing on every _other_ path clears,
because a cancelled or abandoned send has no result worth announcing. This distinction is the
whole point: a polite live region announces asynchronously, so clearing the node in the same turn
that wrote the confirmation would race the announcement and could leave a screen-reader user with
no confirmation at all — the accepted send would be the one outcome that announced nothing.
**The handoff is enforced by control state, not by politeness.** Verify is a sibling action that
writes this same node, and it stays pressable throughout a send unless something stops it — so a
press mid-flight would overwrite "Sending…", and the survey's own callback would then overwrite
the Verify result, leaving both features lying to the player and the single-owner rule true only
on paper. Therefore **Verify is `aria-disabled` while the survey owns the region** (the same
shared gate and the same announcement convention as every other suppressed control here), and is
re-enabled the moment the region is released.

The other direction needs no symmetric lock, which is worth saying so nobody adds one: opening
the survey while a Verify result is displayed simply **takes** the region under the existing
handoff, and taking clears. That is safe because Verify's write is synchronous and final at press
time — there is no pending outcome of its own to lose, unlike a send in flight.

**Success, failure and offline each get a player-visible, non-blocking result.** None of them
ever blocks Play again. Silence on
failure is the specific defect to avoid — a player who pressed Send and heard nothing has to
guess, and will guess that it worked.

Controls that are momentarily unavailable — Send before a rating exists, and the survey's controls
while a submission is in flight — use **`aria-disabled` with activation suppressed at the click
site, never the native `disabled` attribute**. That is the house convention and `overlay.ts`
states its reason: dynamically disabling a control that currently holds focus drops it from the
tab order and strands focus, and hides it from assistive technology entirely. `main.ts`'s
`primaryAction` shows the other half — the keyboard path shares the same gate, so a press arriving
through the keymap can never activate what the button itself refuses.

**In flight, that is not enough on its own, and the difference is worth spelling out because the
convention above is button-shaped.** `aria-disabled` is an announcement, not an enforcement, and
click suppression only covers pointer _activation_ — neither stops a focused textarea accepting
typing, and neither stops a radio or a checkbox changing under the keyboard. Left there, the
answers on screen could drift away from the payload already in flight, and the player would be
looking at something we never sent. So the in-flight state guards **every edit, not just
activation** — and the level it guards at is load-bearing, because the obvious choice does not
work:

- **Free text goes `readonly`** — which, unlike `disabled`, keeps the control focusable and
  readable, so the player can still see and select what they wrote.
- **Choice controls suppress the interaction's default action at its source**: `keydown` (Arrow
  and Space) and `click`. **Not `input`/`change`.** Those fire _after_ the state has already
  flipped and are **not cancelable**, so a handler there cannot prevent anything — a focused
  radio's Arrow-key default action checks the new option before `input` is dispatched, and
  listening for it would leave the lock announcing a change it was supposed to stop.
- **Fallback where a default action cannot be suppressed** on some surface: **restore the prior
  state** immediately. Weaker, because it corrects rather than prevents, but it keeps the
  displayed answers equal to the payload, which is the property that actually matters.

All of it runs through the **same shared-gate discipline** §6 already applies to activation, so
the pointer and keyboard routes are guarded by one rule rather than two that can drift apart.
When the send resolves as rejected or offline the guards lift, with the text preserved exactly as
§1 specifies.

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
  enough that the promise stays cheap to keep and is not quietly broken later. ADR 0011 delegates
  "storage and retention" to `wynding-site`, so to be explicit rather than quietly contradictory:
  **90 days is this contract's requirement on the receiving system, narrowing that delegation for
  survey data specifically.** The receiving system still owns the mechanism; what it does not own
  is whether free text may sit around longer than this.
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
URL**. It measures whether the appetite is real before anyone builds a Lambda for it — but it
**works with a small form change, not as-is**, and that dependency is named here rather than
discovered by whoever picks it up. A GitHub issue form is prefilled **by field id**, and only for
fields the form actually defines; `.github/ISSUE_TEMPLATE/feedback.yml` defines `kind`, `what`,
`steps`, `build` and `env`, none of which is a machine-identity field. So shipping this means
either **adding a run-identity field to `feedback.yml`** (after which it prefills cleanly by id)
or **accepting the identity prefilled into one of the existing prose fields**, where the player
is also typing. The first is a real, small change to this repo; the second is free and uglier.

**The site's own feedback form (`wynding.net/#feedback`) is the other candidate, and it loses
today.** It would dodge the GitHub account requirement outright, and plausibly the URL-log
objection below along with it, since the request would go to our own origin. But it is
unstructured and carries no run identity, so a submission through it cannot be joined to the run
it describes — which is the entire reason this ADR exists. Giving it structured fields and a
run-identity parameter would make it a serious option; at that point it has become the endpoint,
and the interim question is moot.

It is **named here as the pre-endpoint option and is not built by this ADR**, and it does not
arrive cost-free. ADR 0011 considered the same deep link for playtraces and declined it: the run
is encoded into a request to GitHub and reaches URL logs and history before the player submits
anything. That objection survives here and is not answered by this ADR. One narrowing is
available and should be recorded — a deep link that prefills **only the machine-generated run
fields** (which presupposes the form change above), leaving the player to type their own words
into GitHub's form, means no player-authored text ever rides our URL. That reduces the objection
to the run fields alone; it does not dissolve it. Whoever ships this owes that argument, and this
ADR does not pre-approve it.

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
                                       └─ a MODIFIER, not an action: arms
                                          forever-dismissal, committed by the
                                          next Not now / Send · unchecking
                                          before that disarms it
            │
            ├─ [Send] with no rating ─► aria-disabled · press announces "choose a rating"
            │                           (click and keymap routes alike) · nothing sent
            │                           focus stays put
            ├─ [Not now] ─────────────► collapses (+ don't-ask-again if armed)
            │                           nothing sent · focus ──► [Give feedback]
            │                           the button stays LIVE on this dialog — reopening
            │                           allowed; offered again only on the next gameVersion
            └─ [Send] ────────────────► controls aria-disabled (never `disabled`, so focus
                 │                      is never dropped) · live region: "Sending…"
                 │                      EDITS guarded too, not just activation: free text
                 │                      readonly; choices suppress the DEFAULT ACTION at
                 │                      keydown/click (NOT input/change — those fire after
                 │                      the flip and cannot be cancelled) · fallback where
                 │                      that is impossible: restore the prior state
                 │                      [Verify this run] goes aria-disabled — it writes
                 │                      this same region, so ownership is enforced, not
                 │                      merely agreed; re-enabled when the region releases
                 ├─ accepted ─────────► "Thanks. Reference <sessionId>."
                 │                       collapses (+ don't-ask-again if armed)
                 │                       Give feedback retired · focus ──► [Play again]
                 │                       the message STANDS through the collapse — cleared
                 │                       only by the next owner (Verify) or hideResults()
                 ├─ rejected ─────────► "Couldn't send." · text preserved · guards lift,
                 │                       controls re-enable · editing before a retry mints
                 │                       a NEW idempotency key, so the edit cannot be
                 │                       deduped away against the earlier attempt
                 │                       [Send] is relabelled [Try again] IN PLACE, so focus
                 │                       never moved — it is already there
                 └─ offline ──────────► said as offline · otherwise exactly as rejected
                                         nothing queued, nothing retried in the background

── at ANY point above ──────────────────────────────────────────────────────────────────
a run starts (Play again, or any other path through `hideResults()`)
  └─► in-flight submission ABORTED · expansion collapses · live region released AND cleared
      (an aborted send has no result to announce — unlike the accepted path above, whose
      message hideResults() is precisely the thing that clears)
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
  `role="status"` node under a single-owner handoff, where releasing hands the region back rather
  than wiping it, and an accepted send's confirmation deliberately outlives the collapse that
  follows it. The cost is a protocol two features must both keep, rather than a second live region
  to maintain — a trade taken deliberately, because two regions announcing over each other is the
  worse failure and the harder one to notice.
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
