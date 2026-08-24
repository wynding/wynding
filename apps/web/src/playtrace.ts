// playtrace.ts — ADR 0011's local capture and export. Nothing here sends anything
// anywhere, and that is the ADR's own reasoning rather than an omission: "Building a
// playtrace and letting the player export it to a file or clipboard sends nothing
// anywhere, so it needs no notice, no opt-out and no configuration."
//
// WHAT IS IN THE PAYLOAD, and why nothing else is. A playtrace is "the replay envelope
// plus a little UI-layer state" (ADR 0011). The replay envelope reproduces the run
// exactly, because the sim is a pure function of its inputs — so score, stars, outcome
// and wave are DERIVABLE and are deliberately absent rather than duplicated. What cannot
// be derived is the handful of render-layer facts below, and each one is here because a
// binding note put it here (#99's six technical notes, ADR 0014 §4's `runId` rider):
//
//   `ticksCompleted`  a COMPLETED-TICK COUNT, not an index. `createInitialState` starts
//                     at `tick: 0` and `step()` increments AFTER applying that tick's
//                     inputs, so a state reading `tick === N` has applied exactly
//                     `tickInputs[0..N-1]` — N entries. `0` is legal and meaningful (a
//                     capture taken before the first step), which a "last processed
//                     index" framing could not represent.
//   `stateHash`       `hashSimState` at the state after exactly `ticksCompleted` entries
//                     have stepped. NOT comparable to a replay validator's `finalHash`,
//                     which is taken at the TERMINAL state — a different boundary. No
//                     separate algorithm version is needed: it is canonical to
//                     `simVersion`, which the payload carries.
//   `pendingInputs`   the controller's per-tick buffer — commands issued but not yet
//                     committed to a tick. A named key with a declared shape and an
//                     explicit cap (below), because it is `SimInput[]`, not a primitive.
//   `boardId`         one ruleset can hold multiple boards, so seed + `rulesetHash` +
//                     versions do NOT pin which board produced a result.
//   `viewport`        the NAMED layout bucket, never raw dimensions — raw dimensions are
//                     a fingerprinting surface for no diagnostic gain.
//   `runId`           the per-run instance identity ADR 0014 §4 requires of this capture
//                     so a survey submission can be joined to the run it is about.
//
// AND WHAT IS BANNED. No settings and no keybindings — ADR 0011 states that rule and its
// reason (colour-vision mode and motion sensitivity are disability-adjacent data, and
// `tickInputs` records game actions rather than keystrokes so keybindings cannot affect a
// reproduction). No `deviceId` either: that is `persist.ts`'s local write-ordering field
// and it must never ride a payload. No `sessionId` — ADR 0011 defines one for the UPLOAD
// path, which does not exist here; a local export links nothing to anything.
//
// THE ALLOWLIST IS SERIALIZED EXPLICITLY, never by reference, ALL THE WAY DOWN. Every
// field below is named at its assignment, and the `SimInput` commands are re-projected
// per variant with an exhaustiveness guard — so a field added to an upstream type cannot
// reach the payload by inheriting into it, and a new command VARIANT is a compile error
// rather than a silently-dropped command. `playtrace.test.ts` makes that falsifiable.

import type { SimInput } from '@wynding/sim';
import { MAX_INPUTS_PER_TICK, type Replay } from '@wynding/replay';
import type { SaveSlot } from '@wynding/platform';

/** Payload schema version. Distinct from `simVersion` and from `saveVersion`. */
export const PLAYTRACE_VERSION = 1;

/**
 * Recent-runs rotation (#98's shape: the player notices a problem two runs later, and by
 * then the run that caused it is gone). Bounded by BOTH a run count and an elapsed time,
 * whichever bites first — a count alone keeps a stale morning run alive all day, and a
 * time alone keeps nothing at all across a lunch break.
 *
 * Ten runs / six hours are chosen values, recorded here as such. ADR 0011 fixes the
 * *shape* of a bound and leaves the numbers to implementation, exactly as it does for the
 * session id's rotation — see its §3, which says so in as many words. This ring is
 * IN-MEMORY and dies with the page, so nothing here persists an identifier.
 */
export const MAX_RECENT_RUNS = 10;
export const MAX_RECENT_AGE_MS = 6 * 60 * 60 * 1000;

/** The named layout bucket (`layout.ts`'s two-layouts contract), never raw dimensions. */
export type PlaytraceViewport = 'standard' | 'compact';

export interface Playtrace {
  readonly runId: string;
  readonly capturedAt: number;
  readonly seed: number;
  readonly boardId: string;
  readonly rulesetHash: string;
  readonly simVersion: number;
  readonly ticksCompleted: number;
  readonly stateHash: string;
  readonly tickInputs: readonly (readonly SimInput[])[];
  readonly pendingInputs: readonly SimInput[];
  /** True when the pending buffer exceeded {@link MAX_INPUTS_PER_TICK} and was cut.
   *  Carried rather than left implicit: a truncation nobody can see is a silent discard. */
  readonly pendingInputsTruncated: boolean;
  readonly viewport: PlaytraceViewport;
}

export interface PlaytraceExport {
  readonly playtraceVersion: number;
  readonly exportedAt: number;
  readonly runs: readonly Playtrace[];
}

/** Everything `buildPlaytrace` reads. Assembled by the caller from the controller and the
 *  render layer, so this module needs neither. */
export interface PlaytraceSource {
  readonly runId: string;
  readonly capturedAt: number;
  readonly replay: Replay;
  readonly ticksCompleted: number;
  readonly stateHash: string;
  readonly pendingInputs: readonly SimInput[];
  readonly viewport: PlaytraceViewport;
}

/** Re-project one command, field by field, per variant. The `never` fallthrough makes a
 *  new `SimInput` variant a COMPILE error here — which is the point: a variant this
 *  function does not know would otherwise be dropped from the export in silence, and a
 *  dropped command breaks the replay round-trip the payload exists to support. */
function serializeInput(cmd: SimInput): SimInput {
  switch (cmd.kind) {
    case 'placeTower':
      return {
        kind: 'placeTower',
        anchor: { col: cmd.anchor.col, row: cmd.anchor.row },
        towerId: cmd.towerId,
      };
    case 'sellTower':
      return { kind: 'sellTower', tower: cmd.tower };
    case 'callWaveEarly':
      return { kind: 'callWaveEarly' };
    case 'noop':
      return { kind: 'noop' };
    default: {
      const unreachable: never = cmd;
      return unreachable;
    }
  }
}

/** Build the payload. Every field is named at its assignment — no spread, no object
 *  handed over by reference. */
export function buildPlaytrace(source: PlaytraceSource): Playtrace {
  const pending = source.pendingInputs;
  const truncated = pending.length > MAX_INPUTS_PER_TICK;
  return {
    runId: source.runId,
    capturedAt: source.capturedAt,
    seed: source.replay.seed,
    boardId: source.replay.boardId,
    rulesetHash: source.replay.rulesetHash,
    simVersion: source.replay.simVersion,
    ticksCompleted: source.ticksCompleted,
    stateHash: source.stateHash,
    tickInputs: source.replay.tickInputs.map((tick) => tick.map(serializeInput)),
    // Capped against the bound that actually governs this buffer (#99 note 3 asked for
    // an explicit cap; it named the wrong constant). `pendingInputs` is the controller's
    // PER-TICK buffer, which `effectiveCap()` bounds by `MAX_INPUTS_PER_TICK` (64, or 63
    // pre-start with one slot reserved for Start's own wave claim). The run-wide
    // `MAX_TOTAL_TOWER_COMMANDS` (1,000) counts placeTower/sellTower across a whole match
    // and is 15x too loose here — a "cap" that can never bind is not a cap, and it would
    // have let a corrupted buffer through at 999 entries while claiming to be bounded.
    pendingInputs: (truncated ? pending.slice(0, MAX_INPUTS_PER_TICK) : pending).map(
      serializeInput,
    ),
    pendingInputsTruncated: truncated,
    viewport: source.viewport,
  };
}

/** The replay envelope back out of a playtrace, for a validator round-trip. Explicit,
 *  for the same reason the build is. */
export function playtraceReplay(trace: Playtrace): Replay {
  return {
    seed: trace.seed,
    boardId: trace.boardId,
    rulesetHash: trace.rulesetHash,
    simVersion: trace.simVersion,
    tickInputs: trace.tickInputs,
  };
}

// --- The durable opt-out (ADR 0011 §condition 2) -------------------------------------

/** What the opt-out slot stores. */
export interface StoredOptOut {
  readonly optOut: boolean;
}

/** The opt-out slot's bare key. */
export const OPT_OUT_KEY = 'playtrace';

/**
 * Validate a stored opt-out. `undefined` — "not this slot's shape" — for anything whose
 * `optOut` is not an actual boolean.
 *
 * THE COERCION THIS REPLACED WAS A PRIVACY BUG, not a style problem. `optOut: optOut ===
 * true` turned every malformed payload into a valid record reading `false`, so a
 * truncated write, a hand-edited value, or a `{optOut: "true"}` from some future writer
 * all came back as "this player is happy to be uploaded" — corruption silently promoted
 * to consent. Rejecting instead routes those through the slot's `incompatible` branch,
 * which `loadPlaytraceOptOut` fails CLOSED on. Where we cannot know what was chosen, the
 * answer must be the protective one, and an unreadable record is exactly that case.
 */
export function parseStoredOptOut(data: unknown): StoredOptOut | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const { optOut } = data as { optOut?: unknown };
  if (typeof optOut !== 'boolean') return undefined;
  return { optOut };
}

export interface PlaytraceOptOut {
  /** True when this device has opted out of FUTURE automatic upload. */
  optedOut(): boolean;
  setOptedOut(value: boolean): Promise<void>;
}

/**
 * Load the durable opt-out through ADR 0008's seam.
 *
 * WHY NOT `settings.ts`: ADR 0011 names that mistake explicitly — a toggle added there
 * would reset every reload and silently re-enable uploads. This rides the `StorageDriver`
 * slot instead, which is the whole reason #133 was sequenced behind #142.
 *
 * FAIL CLOSED. A store that exists but is unwritable (Safari private mode) cannot record
 * a choice, so the choice is assumed to be the protective one: `optedOut()` reports true
 * and stays true for the session. That gates FUTURE automatic upload only — local capture
 * and export are ungated by the ADR's own reasoning and are not affected by this at all.
 */
export async function loadPlaytraceOptOut(slot: SaveSlot<StoredOptOut>): Promise<PlaytraceOptOut> {
  let optedOut = false;
  let writable = true;
  try {
    const read = await slot.read();
    // `absent` is a device that has never chosen — the ADR's posture is automatic upload
    // under a notice, so the default is opted IN. `incompatible` means the stored choice
    // is unreadable, which is not the same as absent: we cannot know what was chosen, so
    // fail closed.
    if (read.status === 'ok') optedOut = read.data.optOut;
    else if (read.status === 'incompatible') optedOut = true;
  } catch {
    optedOut = true;
    writable = false;
  }
  return {
    optedOut: () => optedOut,
    async setOptedOut(value: boolean): Promise<void> {
      if (!writable) return; // storage already refused — the closed gate stays closed
      try {
        await slot.write({ optOut: value });
        optedOut = value;
      } catch {
        // Could not record the choice. Fail closed rather than reporting a preference the
        // device does not actually hold.
        optedOut = true;
        writable = false;
      }
    },
  };
}

// --- The recorder ---------------------------------------------------------------------

export interface PlaytraceRecorder {
  /** Capture the run described by `source` into the ring, and return it. */
  capture(source: Omit<PlaytraceSource, 'capturedAt'>): Playtrace;
  /** The ring, oldest first, pruned by both bounds. */
  recent(): readonly Playtrace[];
  /** The export payload: every run still inside the rotation window. */
  buildExport(): PlaytraceExport;
  /** ADR 0011's durable opt-out, for the automatic-upload transport that does not exist
   *  yet. NOT consulted by capture or export — those are ungated. */
  uploadOptedOut(): boolean;
}

export interface PlaytraceRecorderOptions {
  /** WALL CLOCK. Used for the exported `capturedAt`/`exportedAt` timestamps and nothing
   *  else — never to decide whether a run has expired. */
  readonly now: () => number;
  /** MONOTONIC elapsed source (`performance.now`), which is what the six-hour bound is
   *  actually measured against. See {@link createPlaytraceRecorder}. */
  readonly monotonicNow?: () => number;
  readonly optOut?: PlaytraceOptOut;
  readonly maxRuns?: number;
  readonly maxAgeMs?: number;
}

/** A ring entry: the exported payload plus the internal monotonic stamp the expiry reads.
 *  `monotonicAt` is deliberately NOT part of `Playtrace` — it never leaves this module and
 *  never reaches an export. */
interface RingEntry {
  readonly trace: Playtrace;
  readonly monotonicAt: number;
}

/**
 * The recent-runs recorder.
 *
 * THE SIX-HOUR BOUND IS MEASURED MONOTONICALLY, and that is a privacy property rather than
 * a tidiness one. ADR 0011 §3 makes bounded linkage the thing the whole posture rests on,
 * so a bound that can be defeated is a promise that can be broken. Measured against
 * `Date.now()` it could be: when the wall clock steps BACKWARD — an NTP correction, a
 * manual change, a device waking with a bad RTC — `now - capturedAt` goes negative, which
 * is smaller than any bound, so every run stays eligible indefinitely. The expiry silently
 * stops expiring, and nothing surfaces it.
 *
 * `performance.now()` is monotonic within a document and cannot regress, which makes it
 * the honest instrument here. The ring is IN-MEMORY and dies with the page (see
 * MAX_RECENT_AGE_MS), so a monotonic origin is available for every entry that exists —
 * there is no cross-session case needing a wall-clock fallback.
 *
 * The wall clock is still checked, as a belt, under an EXPIRED-IF-EITHER rule with
 * negative elapsed clamped to expired. Where the two clocks disagree we cannot know which
 * is right, and the privacy-favouring answer is to drop the run — a lost diagnostic is a
 * cost we can pay, an unbounded linkage window is not.
 */
export function createPlaytraceRecorder(options: PlaytraceRecorderOptions): PlaytraceRecorder {
  const maxRuns = options.maxRuns ?? MAX_RECENT_RUNS;
  const maxAgeMs = options.maxAgeMs ?? MAX_RECENT_AGE_MS;
  // A lazy arrow, not `?? performance.now` — an unbound reference throws "Illegal
  // invocation" in browsers. `NaN` where the global is absent rather than a ReferenceError
  // at first capture: `NaN >= maxAgeMs` is false, so the monotonic branch goes inert and
  // the wall belt governs, which is a degraded ring rather than a crash.
  const monotonicNow =
    options.monotonicNow ??
    ((): number => (typeof performance === 'undefined' ? Number.NaN : performance.now()));
  let ring: RingEntry[] = [];

  /**
   * Has this entry outlived the bound?
   *
   * MONOTONIC IS AUTHORITATIVE WHERE IT IS USABLE. It cannot be moved by a clock
   * correction, so when it says an entry is fresh, the entry IS fresh and a backward wall
   * step tells us nothing new. An earlier revision dropped every entry on any negative
   * wall elapsed, which on Android — where `Date.now()` stepping back a few milliseconds
   * at NTP sync or RTC wake is routine — would have wiped the whole ring in ordinary
   * operation, for no privacy gain. The ratified rule scoped that clamp to entries
   * surviving ACROSS SESSIONS; this ring is in-memory and dies with the page, so every
   * entry has a monotonic origin and the clamp never applies.
   *
   * THE WALL CLOCK STILL EXPIRES, and that is why it is kept: `performance.now()` does not
   * advance across system suspend on Apple platforms or `CLOCK_MONOTONIC`, so a WebView
   * that sleeps eight hours wakes with a monotonic elapsed well under the bound. Wall time
   * is what catches that. It may only ever EXPIRE an entry, never revive one.
   *
   * Where monotonic is unusable — absent global, or a source that regressed — the wall
   * clock is all there is, and a negative elapsed then means we cannot tell how old this
   * is, so it expires. That is the conservative direction, applied where it is the only
   * information available rather than everywhere.
   */
  const expired = (entry: RingEntry, now: number, monotonic: number): boolean => {
    const monotonicElapsed = monotonic - entry.monotonicAt;
    const monotonicUsable = Number.isFinite(monotonicElapsed) && monotonicElapsed >= 0;
    if (monotonicUsable && monotonicElapsed >= maxAgeMs) return true;
    const wallElapsed = now - entry.trace.capturedAt;
    if (wallElapsed >= maxAgeMs) return true;
    if (wallElapsed < 0) return !monotonicUsable;
    return false;
  };

  /** Apply BOTH bounds. Age is evaluated against the caller's clocks, so a ring that sat
   *  untouched for seven hours empties on the next read rather than on a timer. */
  const prune = (now: number, monotonic: number): RingEntry[] => {
    ring = ring.filter((entry) => !expired(entry, now, monotonic));
    if (ring.length > maxRuns) ring = ring.slice(ring.length - maxRuns);
    return ring;
  };

  const traces = (entries: RingEntry[]): Playtrace[] => entries.map((e) => e.trace);

  return {
    capture(source): Playtrace {
      const now = options.now();
      const monotonic = monotonicNow();
      const trace = buildPlaytrace({ ...source, capturedAt: now });
      ring.push({ trace, monotonicAt: monotonic });
      prune(now, monotonic);
      return trace;
    },
    recent: () => traces(prune(options.now(), monotonicNow())),
    buildExport(): PlaytraceExport {
      const now = options.now();
      // Pruned BEFORE the payload is assembled, so an expired run cannot reach an export
      // under either clock — the export path is the one that would carry it off-device.
      const runs = traces(prune(now, monotonicNow()));
      return { playtraceVersion: PLAYTRACE_VERSION, exportedAt: now, runs };
    },
    uploadOptedOut: () => options.optOut?.optedOut() ?? false,
  };
}

/** The serialized form. Compact rather than pretty: the interim delivery is a paste into
 *  an issue form, where fewer lines is kinder than indentation. */
export function formatPlaytraceExport(payload: PlaytraceExport): string {
  return JSON.stringify(payload);
}

/** A filename that sorts and does not collide across two exports in one session. */
export function playtraceFilename(exportedAt: number): string {
  return `wynding-playtrace-${String(exportedAt)}.json`;
}

// --- Delivery -------------------------------------------------------------------------

export interface PlaytraceDelivery {
  copy(text: string): Promise<void>;
  save(filename: string, text: string): void;
}

/** The real browser delivery. Injected everywhere it is used so the unit tests never
 *  depend on a clipboard permission or an object-URL implementation jsdom lacks. */
export function browserDelivery(doc: Document): PlaytraceDelivery {
  return {
    async copy(text: string): Promise<void> {
      const clipboard = doc.defaultView?.navigator.clipboard;
      if (clipboard === undefined) throw new Error('no clipboard API');
      await clipboard.writeText(text);
    },
    save(filename: string, text: string): void {
      const view = doc.defaultView;
      if (view === null) throw new Error('no window to download from');
      // CAPTURED ONCE, not re-read inside the deferred revoke below. An object URL is a
      // handle owned by the `URL` object that minted it, so revoking through a different
      // one is at best a no-op and at worst a leak — and the revoke now runs on a later
      // task, which is exactly the window in which `view.URL` could have been replaced.
      const urlApi = view.URL;
      const url = urlApi.createObjectURL(new view.Blob([text], { type: 'application/json' }));
      const link = doc.createElement('a');
      link.href = url;
      link.download = filename;
      // Not appended to the document: a click on a detached anchor still starts the
      // download in every engine that supports `download`, and appending would put a
      // stray node inside the results dialog's tab order for a frame.
      try {
        link.click();
      } finally {
        // SCHEDULED IN `finally`, so a `click()` that throws — a security policy refusing
        // the navigation, an engine quirk — still frees the blob instead of pinning it for
        // the page's lifetime. And DEFERRED past the click either way, per MDN's own note
        // on `createObjectURL`: revoking synchronously can invalidate the blob before the
        // engine has started fetching it, and the download then silently does nothing.
        view.setTimeout(() => urlApi.revokeObjectURL(url), 0);
      }
    },
  };
}
