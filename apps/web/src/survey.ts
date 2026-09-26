// survey.ts — ADR 0014's end-of-run survey, as a model with no DOM in it (#158).
//
// The results dialog (`overlay.ts`) renders this and `main.ts` wires it; everything the ADR
// decides that is not a pixel lives here, so each rule is asserted directly rather than
// through a rendered dialog. The ADR is the contract. What this module owns, by section:
//
//   §3 ask semantics  `loadSurveyAsk` — once per `gameVersion`, a durable "don't ask again",
//                     and the in-memory fallback when storage cannot be written.
//   §1/§3/§5 flow     `createSurvey` — which responses consume the ask (Not now, an ACCEPTED
//                     Send) and which consume nothing (a rejected, offline or cancelled send;
//                     a run start); the operation token a run start aborts; the opaque
//                     idempotency key, reused for retries and rotated on an edit event.
//   §4 envelope       `buildSurveyPayload` — the answers plus the run identity, serialized
//                     through an explicit allowlist, with `replayDigest` pinned to
//                     `sha256Hex(canonicalJson(tickInputs))`.
//   §5 validation     `validateSurveyPayload` — the full server-side check the ADR requires,
//                     unknown fields rejected. The endpoint (`wynding-site`'s own ADR) owns
//                     enforcement; this is the reference it can be checked against, and it is
//                     what proves the client never builds a payload that check would refuse.
//   ADR 0011 §3       `createSessionIdentity` — the bounded, never-persisted `sessionId`.
//
// NOTHING HERE SENDS ANYTHING ON ITS OWN. A `SurveyTransport` is injected, and the survey is
// only offered where one exists: until `wynding-site` has the endpoint and the privacy notice
// the ADR makes a ship gate (§7), production passes none and the results dialog shows no Give
// feedback button at all. That injection IS the feature switch — there is no second flag that
// could disagree with it.

import { canonicalJson, sha256Hex } from '@wynding/engine';
import type { SaveSlot } from '@wynding/platform';
import type { Replay } from '@wynding/replay';

/** Payload schema version. Distinct from `simVersion` and from `PLAYTRACE_VERSION`. */
export const SURVEY_VERSION = 1;

/** §2's free-text cap, in UTF-16 code units — the unit `maxlength` counts, so the client and
 *  the server agree about text the player was allowed to type. */
export const SURVEY_TEXT_MAX = 2000;

/** A 1–5 choice (rating, difficulty). */
export type SurveyScale = 1 | 2 | 3 | 4 | 5;

function isScale(value: unknown): value is SurveyScale {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

// --- §4: the envelope ----------------------------------------------------------------------

/**
 * `replayDigest`, exactly as §4 pins it: `sha256Hex(canonicalJson(tickInputs))` through the
 * shared `@wynding/engine` helpers, over the `tickInputs` array ALONE — never a wrapper
 * carrying the identity fields, which travel and are checked separately. Synchronous
 * (`@noble/hashes`), which is why §1's cancellation has no pre-request window to cover.
 */
export function replayDigest(tickInputs: Replay['tickInputs']): string {
  return sha256Hex(canonicalJson(tickInputs));
}

/** The player's answers as the form holds them. Only `rating` is required to send. */
export interface SurveyAnswers {
  readonly rating: SurveyScale | null;
  readonly difficulty: SurveyScale | null;
  readonly somethingBroke: boolean;
  readonly text: string;
}

/** The run a submission is about (§4). Every field is read from state the app already
 *  holds; `runId`, `sessionId` and `gameVersion` are the three render-layer facts. */
export interface SurveyRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly gameVersion: string;
  readonly simVersion: number;
  readonly rulesetHash: string;
  readonly boardId: string;
  readonly seed: number;
  readonly outcome: 'won' | 'lost';
  readonly score: number;
  readonly stars: number;
  readonly waveCursor: number;
  readonly finalTick: number;
  readonly finalHash: string;
  readonly replayDigest: string;
}

/** What one submission carries. `difficulty` is ABSENT, not null, when unanswered. */
export interface SurveyPayload {
  readonly surveyVersion: number;
  readonly idempotencyKey: string;
  readonly answers: {
    readonly rating: SurveyScale;
    readonly difficulty?: SurveyScale;
    readonly somethingBroke: boolean;
    readonly text: string;
  };
  readonly run: SurveyRunIdentity;
}

/**
 * Assemble a submission. THE ALLOWLIST IS SERIALIZED EXPLICITLY — every field named at its
 * assignment, never an object spread or a reference — so a field added to an upstream type
 * cannot ride into a payload, and `survey.test.ts` holds the key set to exactly this list.
 * Nothing about the player, the device or their settings (§4, and ADR 0011 for the reason).
 *
 * Throws on answers the UI should never have allowed (no rating, a value outside 1–5, text
 * over the cap): those are programming errors, and a payload the server must reject is
 * better refused here than sent.
 */
export function buildSurveyPayload(input: {
  readonly answers: SurveyAnswers;
  readonly run: SurveyRunIdentity;
  readonly idempotencyKey: string;
}): SurveyPayload {
  const { answers, run } = input;
  if (!isScale(answers.rating)) throw new RangeError('survey: a rating is required to send');
  if (answers.difficulty !== null && !isScale(answers.difficulty)) {
    throw new RangeError('survey: difficulty must be 1–5 when present');
  }
  if (answers.text.length > SURVEY_TEXT_MAX) {
    throw new RangeError(`survey: text exceeds ${String(SURVEY_TEXT_MAX)} code units`);
  }
  const base = {
    rating: answers.rating,
    somethingBroke: answers.somethingBroke,
    text: answers.text,
  };
  return {
    surveyVersion: SURVEY_VERSION,
    idempotencyKey: input.idempotencyKey,
    answers: answers.difficulty === null ? base : { ...base, difficulty: answers.difficulty },
    run: {
      runId: run.runId,
      sessionId: run.sessionId,
      gameVersion: run.gameVersion,
      simVersion: run.simVersion,
      rulesetHash: run.rulesetHash,
      boardId: run.boardId,
      seed: run.seed,
      outcome: run.outcome,
      score: run.score,
      stars: run.stars,
      waveCursor: run.waveCursor,
      finalTick: run.finalTick,
      finalHash: run.finalHash,
      replayDigest: run.replayDigest,
    },
  };
}

// --- §5: the server-side validation the endpoint must enforce -------------------------------

/** `deriveStars` grades 0–3 (`packages/sim`). */
const MAX_STARS = 3;

/**
 * Whether `gameVersion` is a real revision identity — a full commit SHA (§4). A build that
 * could not resolve one carries `'unknown'` (`build-config.ts`): every such build would share
 * one version, so one Not now would silence all of them, and every send would fail
 * validation. The survey is therefore not offered at all in such a build.
 */
export function isSubmittableGameVersion(gameVersion: string): boolean {
  return FULL_SHA_RE.test(gameVersion);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A full commit SHA — SHA-1 (40 hex) or a SHA-256 repository's object id (64 hex). */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const WORLD_HASH_RE = /^[0-9a-f]{8}$/;
/** `RulesetBoard.id`'s own pattern (`packages/sim/src/ruleset-schema.ts`). */
const BOARD_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type SurveyValidation =
  | { readonly ok: true; readonly payload: SurveyPayload }
  | { readonly ok: false; readonly reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) return key;
  return null;
}

const TOP_KEYS = ['surveyVersion', 'idempotencyKey', 'answers', 'run'] as const;
const ANSWER_KEYS = ['rating', 'difficulty', 'somethingBroke', 'text'] as const;
const RUN_KEYS = [
  'runId',
  'sessionId',
  'gameVersion',
  'simVersion',
  'rulesetHash',
  'boardId',
  'seed',
  'outcome',
  'score',
  'stars',
  'waveCursor',
  'finalTick',
  'finalHash',
  'replayDigest',
] as const;

/**
 * §5's server-side validation, as a reference implementation: `rating` required and an
 * integer 1–5; `difficulty` optional and an integer 1–5 when present; `somethingBroke` a
 * boolean; the free text within the cap (never stricter than the client's); every envelope
 * field checked against its declared format; and **unknown fields rejected outright**, at
 * every level. The endpoint owns enforcement — this is what it can be checked against, and
 * the unit tests prove every payload `buildSurveyPayload` makes passes it.
 */
export function validateSurveyPayload(data: unknown): SurveyValidation {
  const fail = (reason: string): SurveyValidation => ({ ok: false, reason });
  if (!isRecord(data)) return fail('payload must be an object');
  const extraTop = unknownKey(data, TOP_KEYS);
  if (extraTop !== null) return fail(`unknown field: ${extraTop}`);
  if (data['surveyVersion'] !== SURVEY_VERSION) return fail('unsupported surveyVersion');
  const key = data['idempotencyKey'];
  if (typeof key !== 'string' || !UUID_RE.test(key)) return fail('idempotencyKey malformed');

  const answers = data['answers'];
  if (!isRecord(answers)) return fail('answers must be an object');
  const extraAnswer = unknownKey(answers, ANSWER_KEYS);
  if (extraAnswer !== null) return fail(`unknown field: answers.${extraAnswer}`);
  if (!isScale(answers['rating'])) return fail('rating must be an integer 1–5');
  if ('difficulty' in answers && !isScale(answers['difficulty'])) {
    return fail('difficulty must be an integer 1–5 when present');
  }
  if (typeof answers['somethingBroke'] !== 'boolean')
    return fail('somethingBroke must be a boolean');
  const text = answers['text'];
  if (typeof text !== 'string') return fail('text must be a string');
  if (text.length > SURVEY_TEXT_MAX) return fail('text exceeds the cap');

  const run = data['run'];
  if (!isRecord(run)) return fail('run must be an object');
  const extraRun = unknownKey(run, RUN_KEYS);
  if (extraRun !== null) return fail(`unknown field: run.${extraRun}`);
  for (const field of ['runId', 'sessionId'] as const) {
    const v = run[field];
    if (typeof v !== 'string' || !UUID_RE.test(v)) return fail(`${field} malformed`);
  }
  if (typeof run['gameVersion'] !== 'string' || !isSubmittableGameVersion(run['gameVersion'])) {
    return fail('gameVersion must be a full commit SHA');
  }
  if (!isNonNegInt(run['simVersion']) || run['simVersion'] === 0)
    return fail('simVersion malformed');
  for (const field of ['rulesetHash', 'replayDigest'] as const) {
    const v = run[field];
    if (typeof v !== 'string' || !SHA256_HEX_RE.test(v)) return fail(`${field} malformed`);
  }
  if (typeof run['boardId'] !== 'string' || !BOARD_ID_RE.test(run['boardId'])) {
    return fail('boardId malformed');
  }
  const seed = run['seed'];
  if (!isNonNegInt(seed) || seed > 0xffffffff) return fail('seed must be a uint32');
  if (run['outcome'] !== 'won' && run['outcome'] !== 'lost') return fail('outcome malformed');
  for (const field of ['score', 'stars', 'waveCursor', 'finalTick'] as const) {
    if (!isNonNegInt(run[field])) return fail(`${field} must be a non-negative integer`);
  }
  if ((run['stars'] as number) > MAX_STARS) return fail('stars out of range');
  if (typeof run['finalHash'] !== 'string' || !WORLD_HASH_RE.test(run['finalHash'])) {
    return fail('finalHash malformed');
  }
  return { ok: true, payload: data as unknown as SurveyPayload };
}

// --- ADR 0011 §3: the bounded, never-persisted session id -----------------------------------

/**
 * Session-id rotation bounds. ADR 0011 §3 fixes the SHAPE — a run count and an elapsed time,
 * whichever bites first, and always dead on reload — and leaves the numbers to
 * implementation. Ten runs / six hours are chosen to match the playtrace ring's bounds
 * (`playtrace.ts`), so one diagnostic window means the same thing on both sides of a join.
 */
export const SESSION_MAX_RUNS = 10;
export const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface SessionIdentity {
  /** Mark a run start, and bind that run to a session id — rotating first if this run would
   *  exceed either bound. Call once per run, at the edge the run's `runId` is minted. */
  beginRun(): void;
  /** The session id the CURRENT run was bound to at its start. Stable for the whole run, so a
   *  survey sent late in a run carries the same id as that run's playtrace. */
  current(): string;
}

/**
 * The `sessionId` ADR 0011 defines and ADR 0014 §4 carries. IN MEMORY ONLY: nothing here
 * touches storage, so it dies on reload by construction.
 *
 * THE AGE BOUND READS BOTH CLOCKS, for the reasons `playtrace.ts`'s ring records and in the
 * same arrangement. The monotonic clock (`performance.now`) cannot be moved by a correction,
 * but it does not advance across system suspend on Apple platforms — so a PWA that sleeps for
 * days would wake inside the bound and keep linking runs. The wall clock catches that. Either
 * one reaching the bound rotates; neither can ever un-rotate. Where the monotonic reading is
 * unusable (not finite, or regressed) and the wall clock has also stepped backwards or is not
 * finite, we cannot tell how old the id is, so it rotates — the direction that keeps linkage
 * bounded.
 */
export function createSessionIdentity(options: {
  readonly mint: () => string;
  /** Wall clock (`Date.now`). */
  readonly now: () => number;
  /** Monotonic clock (`performance.now`). */
  readonly monotonicNow: () => number;
  readonly maxRuns?: number;
  readonly maxAgeMs?: number;
}): SessionIdentity {
  const maxRuns = options.maxRuns ?? SESSION_MAX_RUNS;
  const maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS;
  let id: string | null = null;
  let mintedAt = 0;
  let mintedAtMonotonic = 0;
  let runs = 0;
  const aged = (now: number, monotonic: number): boolean => {
    const monotonicElapsed = monotonic - mintedAtMonotonic;
    const monotonicUsable = Number.isFinite(monotonicElapsed) && monotonicElapsed >= 0;
    if (monotonicUsable && monotonicElapsed >= maxAgeMs) return true;
    const wallElapsed = now - mintedAt;
    if (!Number.isFinite(wallElapsed)) return !monotonicUsable;
    if (wallElapsed >= maxAgeMs) return true;
    return wallElapsed < 0 && !monotonicUsable;
  };
  return {
    beginRun(): void {
      const now = options.now();
      const monotonic = options.monotonicNow();
      if (id === null || runs >= maxRuns || aged(now, monotonic)) {
        id = options.mint();
        mintedAt = now;
        mintedAtMonotonic = monotonic;
        runs = 0;
      }
      runs++;
    },
    current(): string {
      if (id === null) throw new Error('sessionId read before any run began');
      return id;
    },
  };
}

// --- §3: once per gameVersion, and a dismissal that sticks ----------------------------------

/** What the survey slot stores: whether "don't ask again" is committed, and every
 *  `gameVersion` whose ask a Not now or an accepted Send has consumed — most recent last. */
export interface StoredSurveyAsk {
  readonly dismissed: boolean;
  readonly answeredVersions: readonly string[];
}

/**
 * How many answered versions the slot remembers. Not one, because §4's rollback rule needs
 * history: rolling back to a prior revision must restore THAT version's consumed ask, so
 * answering A, then B, then rolling back to A must not ask again. Not unbounded either, since
 * one entry per answered deployment would grow forever. A rollback past this many newer
 * answered revisions re-asks once, which is the benign direction.
 */
export const MAX_ANSWERED_VERSIONS = 32;

/** The survey slot's bare key — its own slot beside `settings` and `playtrace`. */
export const SURVEY_ASK_KEY = 'survey';

export function parseStoredSurveyAsk(data: unknown): StoredSurveyAsk | undefined {
  if (!isRecord(data)) return undefined;
  const { dismissed, answeredVersions } = data as {
    dismissed?: unknown;
    answeredVersions?: unknown;
  };
  if (typeof dismissed !== 'boolean') return undefined;
  if (!Array.isArray(answeredVersions)) return undefined;
  if (!answeredVersions.every((v): v is string => typeof v === 'string')) return undefined;
  // Over-long history is TRIMMED, not rejected: rejecting would also lose a stored
  // `dismissed: true` if the cap is ever lowered, and the oldest entries are the ones to go.
  return { dismissed, answeredVersions: answeredVersions.slice(-MAX_ANSWERED_VERSIONS) };
}

export interface SurveyAsk {
  /** Whether Give feedback belongs on a results dialog opening now. Presence consumes
   *  nothing — reading this records nothing (§3: "never on mere display"). */
  offered(): boolean;
  /**
   * Re-read the stored ask state, so a dialog opening after it settles sees what OTHER tabs
   * committed since this one loaded (Codex, PR #175: two tabs loaded before either answered,
   * and the second kept offering after the first said "don't ask again"). Await it before
   * `beginDialog` decides presence. Never rejects: an unreadable store keeps the last state
   * known; an absent or unusable record reads as never-answered, as at load. A refresh that
   * a newer one overtook is discarded, and none can undo this instance's own commit.
   */
  refresh(): Promise<void>;
  /**
   * The committing write, from exactly two actions: Not now and an ACCEPTED Send. Consumes
   * this `gameVersion`'s ask and writes the "don't ask again" checkbox's CURRENT state —
   * including clearing a dismissal already stored, so unchecking and committing is a real
   * way back (§3). Never rejects: a failed write is honoured in memory for the session.
   */
  commit(dontAskAgain: boolean): Promise<void>;
}

/**
 * Load the ask state through ADR 0008's seam (#142's `StorageDriver`), the same way the
 * playtrace opt-out loads — and NOT through `settings.ts`, which ADR 0011 names as the trap.
 *
 * FAIL TOWARD NOT ASKING, and exactly that (§3): a commit that cannot be written is honoured
 * IN MEMORY for the rest of the session, so a player who said "don't ask again" is not asked
 * again where they said it. Across sessions an unrecorded dismissal is one we do not know
 * about, so the button returns — and the feature is never withheld wholesale: an unreadable
 * store still offers Give feedback, because hiding it would punish Safari private-mode
 * players with the loss of a channel they never declined. An `incompatible` record reads as
 * never-answered for the same reason.
 */
export async function loadSurveyAsk(
  slot: SaveSlot<StoredSurveyAsk>,
  gameVersion: string,
): Promise<SurveyAsk> {
  // No revision identity, no survey: see `isSubmittableGameVersion`. Nothing is read or
  // written for such a build, so it cannot disturb the ask state of a real one.
  if (!isSubmittableGameVersion(gameVersion)) {
    return { offered: () => false, refresh: async () => {}, commit: async () => {} };
  }
  /** The durable state as last read. */
  let stored: StoredSurveyAsk = { dismissed: false, answeredVersions: [] };
  /** Whether THIS instance committed. Every commit consumes this version's ask, so it is
   *  honoured in memory whatever the write or a later read says (§3). */
  let committed = false;
  /** Identifies the latest refresh, so an overtaken read cannot land after a newer one. */
  let reads = 0;
  async function refresh(): Promise<void> {
    const mine = ++reads;
    try {
      const read = await slot.read();
      if (mine !== reads) return;
      stored = read.status === 'ok' ? read.data : { dismissed: false, answeredVersions: [] };
    } catch {
      // Unreadable: keep the last state known. At load that is never-answered, so the
      // feature is offered, and a commit still tries the write.
    }
  }
  await refresh();
  return {
    offered: () =>
      !committed && !stored.dismissed && !stored.answeredVersions.includes(gameVersion),
    refresh,
    async commit(dontAskAgain: boolean): Promise<void> {
      /** The history to keep: `base` in its own order (oldest first) with THIS version moved
       *  to the most-recent end, capped. Only this version is added — this instance commits
       *  nothing else — so a stale snapshot never outranks what `base` says is recent (Codex,
       *  PR #175: merging a long-lived tab's whole loaded list resurrected evicted versions
       *  and evicted genuinely newer ones). */
      const merged = (base: readonly string[]): StoredSurveyAsk => ({
        dismissed: dontAskAgain,
        answeredVersions: [...base.filter((v) => v !== gameVersion), gameVersion].slice(
          -MAX_ANSWERED_VERSIONS,
        ),
      });
      // In memory first, so the session honours it whatever the write does (§3).
      committed = true;
      try {
        // Merged against what is stored NOW, inside the slot's write lock (Codex, PR #175):
        // two tabs straddling a deploy each loaded the same old snapshot, and a plain write
        // from the later one would erase the version the earlier one recorded — so a later
        // rollback to it would ask again. `dismissed` is still this commit's checkbox state:
        // it is the player's latest explicit answer.
        //
        // The written value is deliberately NOT adopted back into memory: an earlier commit's
        // write resolving after a newer one (the same-dialog undo, pressed quickly) would put
        // the superseded answer back. Memory already records this commit, and what the
        // other tabs wrote reaches this instance through `refresh`.
        await slot.update((current) => merged(current?.answeredVersions ?? []));
      } catch {
        // Honoured in memory for the session; nothing more is promised (§3).
      }
    },
  };
}

// --- §1/§3/§5: the flow ---------------------------------------------------------------------

/** How one attempt ended, from the transport's side. */
export type SurveySendResult = 'accepted' | 'rejected' | 'offline';

/** Where a submission goes. The mechanism is the endpoint ADR's (`wynding-site`); this is the
 *  shape the client needs from it. `signal` is the operation token (§1) — a run start aborts
 *  it, and a transport must stop waiting when it does. A thrown error reads as `rejected`. */
export interface SurveyTransport {
  send(payload: SurveyPayload, signal: AbortSignal): Promise<SurveySendResult>;
}

/**
 * Where the survey is on the current results dialog.
 *
 * - `absent`    no Give feedback button: this version's ask is consumed or dismissed.
 * - `collapsed` the button is present and live; the form is not showing.
 * - `open`      the form is expanded (§1).
 * - `sending`   a submission is in flight; every edit and action but Play again is refused.
 * - `retired`   an accepted Send retired the button with a thank-you in its place.
 */
export type SurveyPhase = 'absent' | 'collapsed' | 'open' | 'sending' | 'retired';

export interface SurveyState {
  readonly phase: SurveyPhase;
  readonly answers: SurveyAnswers;
  /** The "don't ask again" MODIFIER — armed or not. Never written on its own (§3). */
  readonly dontAskAgain: boolean;
  /** The last attempt's failure, while the form is open for a retry: Send reads as Try
   *  again. Null before any attempt; cleared by the next attempt, not by an edit. */
  readonly failure: 'rejected' | 'offline' | null;
}

/** What pressing Send did. */
export type SurveySendAttempt =
  /** No rating yet: nothing sent, nothing changed — the UI announces what is missing. */
  | { readonly kind: 'needsRating' }
  /** Not a state Send can act from (collapsed, already sending, retired, absent). */
  | { readonly kind: 'refused' }
  /** In flight. `done` settles with the outcome, or `'cancelled'` if a run start (or a
   *  newer dialog) invalidated the operation first — a cancelled result is never applied. */
  | {
      readonly kind: 'sending';
      readonly done: Promise<SurveySendResult | 'cancelled'>;
    };

export interface Survey {
  state(): SurveyState;
  /** A results dialog opened: start a fresh survey for it. Presence is decided here, from the
   *  ask state, and recorded nowhere. The caller awaits `ask.refresh()` first, so another
   *  tab's answer counts. */
  beginDialog(): void;
  /** `hideResults()` — every run-start path. Cancels the whole in-flight operation, collapses,
   *  and COMMITS NOTHING, not even an armed "don't ask again" (§3). */
  endDialog(): void;
  /** Give feedback. `collapsed` → `open`. Returns false when refused. */
  open(): boolean;
  /** Edits. Each returns false when refused (not `open`, or in flight). A real change is an
   *  EDIT EVENT: it starts a new logical submission, so the next Send mints a new key. */
  setRating(value: SurveyScale | null): boolean;
  setDifficulty(value: SurveyScale | null): boolean;
  setSomethingBroke(value: boolean): boolean;
  setText(value: string): boolean;
  /** Arm or disarm "don't ask again". Not an answer, so it never rotates the key. */
  setDontAskAgain(value: boolean): boolean;
  /** Not now: collapse, keep the button live on this dialog, and commit the ask. */
  notNow(): Promise<void>;
  /** Send (or Try again). `compose` builds the payload for the given key — synchronously, so
   *  there is no window between the press and the request for a run start to fall into. */
  send(compose: (idempotencyKey: string) => SurveyPayload): SurveySendAttempt;
}

const EMPTY_ANSWERS: SurveyAnswers = {
  rating: null,
  difficulty: null,
  somethingBroke: false,
  text: '',
};

export function createSurvey(options: {
  readonly ask: SurveyAsk;
  readonly transport: SurveyTransport;
  /** The idempotency-key mint — an opaque value (§5), never derived from the payload. Must
   *  mint a v4 UUID (`uuid.ts`'s `mintUuid`): that is the format the payload check accepts. */
  readonly mintKey: () => string;
}): Survey {
  const { ask, transport, mintKey } = options;
  let phase: SurveyPhase = 'absent';
  let answers: SurveyAnswers = EMPTY_ANSWERS;
  let dontAskAgain = false;
  let failure: 'rejected' | 'offline' | null = null;
  /** The current logical submission's key: minted when first composed, reused by retries,
   *  dropped by an edit event so the next compose mints afresh. */
  let key: string | null = null;
  /** The in-flight operation (§1's token), or null. Compared by identity on completion, so a
   *  settlement from an operation that is no longer current can never apply. */
  let operation: AbortController | null = null;

  function editable(): boolean {
    return phase === 'open';
  }

  function edit(next: SurveyAnswers): boolean {
    if (!editable()) return false;
    const changed =
      next.rating !== answers.rating ||
      next.difficulty !== answers.difficulty ||
      next.somethingBroke !== answers.somethingBroke ||
      next.text !== answers.text;
    if (changed) {
      answers = next;
      key = null; // an edit event: a new logical submission (§5)
      // `failure` is deliberately KEPT: Try again is the Send control relabelled in place
      // (§1), and flipping the focused control's name back while the player types would be
      // noise. The next attempt clears it either way.
    }
    return true;
  }

  function cancelOperation(): void {
    operation?.abort();
    operation = null;
  }

  return {
    state: () => ({ phase, answers, dontAskAgain, failure }),

    beginDialog(): void {
      cancelOperation();
      answers = EMPTY_ANSWERS;
      dontAskAgain = false;
      failure = null;
      key = null;
      phase = ask.offered() ? 'collapsed' : 'absent';
    },

    endDialog(): void {
      cancelOperation();
      if (phase !== 'absent' && phase !== 'retired') phase = 'collapsed';
      // The dialog is gone: nothing of this draft may be reopened into the next one, even by
      // a caller that forgets `beginDialog`.
      answers = EMPTY_ANSWERS;
      dontAskAgain = false;
      failure = null;
      key = null;
    },

    open(): boolean {
      if (phase !== 'collapsed') return false;
      phase = 'open';
      return true;
    },

    setRating: (value) => edit({ ...answers, rating: value }),
    setDifficulty: (value) => edit({ ...answers, difficulty: value }),
    setSomethingBroke: (value) => edit({ ...answers, somethingBroke: value }),
    setText(value: string): boolean {
      if (value.length > SURVEY_TEXT_MAX) return false;
      return edit({ ...answers, text: value });
    },

    setDontAskAgain(value: boolean): boolean {
      if (!editable()) return false;
      dontAskAgain = value;
      return true;
    },

    async notNow(): Promise<void> {
      if (phase !== 'open') return;
      phase = 'collapsed';
      failure = null;
      await ask.commit(dontAskAgain);
    },

    send(compose): SurveySendAttempt {
      if (phase !== 'open') return { kind: 'refused' };
      if (answers.rating === null) return { kind: 'needsRating' };
      key ??= mintKey();
      // Synchronous by construction (the digest is `@noble/hashes`): the payload exists
      // before anything could cancel, so the fetch below is the only async boundary.
      const payload = compose(key);
      const op = new AbortController();
      operation = op;
      phase = 'sending';
      failure = null;
      const settle = (raw: unknown): SurveySendResult | 'cancelled' => {
        if (operation !== op || op.signal.aborted) return 'cancelled';
        operation = null;
        // Anything outside the declared union is a transport bug, and a failure.
        const result: SurveySendResult = raw === 'accepted' || raw === 'offline' ? raw : 'rejected';
        if (result === 'accepted') {
          phase = 'retired';
          // The commit is started here, not awaited: the outcome is known now, and the
          // thank-you must not wait on (or be lost to) a slow or hung storage write (§6).
          // `loadSurveyAsk`'s commit never rejects; the catch keeps an injected one that does
          // from surfacing as an unhandled rejection.
          ask.commit(dontAskAgain).catch(() => {});
        } else {
          phase = 'open';
          failure = result;
        }
        return result;
      };
      // Wrapped in a promise so a transport that throws SYNCHRONOUSLY still settles as
      // `rejected` rather than leaving the form stuck in `sending` with nothing announced.
      const done = new Promise<SurveySendResult>((resolve) => {
        resolve(transport.send(payload, op.signal));
      }).then(settle, () => settle('rejected'));
      return { kind: 'sending', done };
    },
  };
}
