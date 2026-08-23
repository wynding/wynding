// envelope.ts — the versioned, cloud-ready save envelope (ADR 0008 §2, design note
// "The envelope"). `{ saveVersion, deviceId, revision, updatedAt, data }`, nothing more.

/** Schema-migration gate. DISTINCT from `simVersion` / `rulesetHash` (ADR 0008 §2) — it
 *  versions the persistence format, not the simulation and not the content. */
export const SAVE_VERSION = 1;

export interface SaveEnvelope {
  readonly saveVersion: number;
  /** Identifies the writing device. With `revision` it orders writes to ONE SLOT from
   *  this device — see `revision`, which is where the scope is spelled out. */
  readonly deviceId: string;
  /**
   * A **monotonic counter per (device, slot)**, bumped on every write to that slot. The
   * local write-ordering primitive — preferred over the wall-clock `updatedAt`, which
   * drifts, moves backward and ties on concurrent offline writes. A failed write does not
   * advance it.
   *
   * PER SLOT IS THE POINT, not an accident of the implementation, and the contract used
   * to say "per-device" and over-claim. Each slot derives its next revision from its own
   * stored envelope, so the first `settings` write and the first `playtrace` write are
   * both `(deviceId, 1)` — which would be an ambiguous *device-wide* order if anything
   * ever compared them. Nothing does, and nothing should: conflict resolution is per
   * slot, because a settings envelope and a playtrace envelope describe different data
   * and can never be in conflict. Comparing revisions across slots is a category error,
   * and `platform.test.ts` pins that the independence is deliberate.
   *
   * A shared per-device counter was the alternative and is rejected on the same evidence:
   * it would introduce one mutable value every slot must read-modify-write, i.e. exactly
   * the cross-context shared state whose atomicity `slot.ts` can only guarantee where Web
   * Locks exists — buying a device-wide order no consumer wants at the price of a new
   * lost-update surface on every write.
   *
   * It does NOT by itself establish causal order *across devices*; that scheme is
   * designed when sync is built (design note).
   */
  readonly revision: number;
  /** Wall-clock ms. **Informational only** — never the ordering input. */
  readonly updatedAt: number;
  readonly data: unknown;
}

/** What a stored payload turned out to be. The three non-`ok` shapes exist because ADR
 *  0008 §5 forbids the easy answer (overwrite and move on) for every one of them. */
export type DecodedSave =
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly envelope: SaveEnvelope }
  /** Written by a NEWER build (an app rollback, a staggered multi-device deploy).
   *  Preserved read-only and surfaced — never overwritten, so the newer device's valid
   *  save survives (ADR 0008 §5). */
  | { readonly status: 'future'; readonly saveVersion: number }
  /** Unparseable or not envelope-shaped. Quarantined, never silently discarded. */
  | { readonly status: 'corrupt' };

export function encodeEnvelope(envelope: SaveEnvelope): string {
  return JSON.stringify(envelope);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read a stored payload back into an envelope, classifying anything that is not one.
 *
 * Migration is forward-only (ADR 0008 §5): a `saveVersion` BELOW the current one is
 * migrated up and returned as `ok`. `SAVE_VERSION` is 1 — the first — so there is no
 * older version in existence and therefore no migration to write; the chain goes in the
 * marked branch below the moment a second version exists. Writing an empty migration
 * framework now would be a shape guessed against zero real migrations.
 */
export function decodeEnvelope(raw: string | undefined): DecodedSave {
  if (raw === undefined) return { status: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt' };
  }
  if (!isRecord(parsed)) return { status: 'corrupt' };
  const { saveVersion, deviceId, revision, updatedAt } = parsed;
  if (typeof saveVersion !== 'number' || !Number.isInteger(saveVersion) || saveVersion < 1) {
    return { status: 'corrupt' };
  }
  if (saveVersion > SAVE_VERSION) return { status: 'future', saveVersion };
  if (typeof deviceId !== 'string' || deviceId === '') return { status: 'corrupt' };
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    return { status: 'corrupt' };
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return { status: 'corrupt' };
  // ← MIGRATION CHAIN GOES HERE when `SAVE_VERSION` reaches 2: step `parsed` up from
  //   `saveVersion` to `SAVE_VERSION` before returning, and return `corrupt` for a step
  //   that cannot be made (ADR 0008 §5 quarantines unmigratable data rather than resetting).
  return {
    status: 'ok',
    envelope: { saveVersion, deviceId, revision, updatedAt, data: parsed.data },
  };
}
