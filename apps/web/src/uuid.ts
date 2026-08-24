// uuid.ts — the app's one v4-UUID mint.
//
// Two callers, both render-layer and both deliberately outside the sim: the save
// envelope's `deviceId` (ADR 0008 §2's per-device write-ordering half) and the per-run
// `runId` (ADR 0014 §4). The sim never sees either — it is a pure function of seed and
// inputs, and nothing here is ever fed into it.

/** The `crypto` surface this needs, narrowed so a test can hand over a stub and so the
 *  absence of `randomUUID` is a typed branch rather than a runtime surprise. */
export interface UuidCrypto {
  randomUUID?: () => string;
}

/**
 * Mint a v4 UUID.
 *
 * `crypto.randomUUID` is the real source. It is absent in two live cases, not just
 * exotic ones: a non-secure context (`http://` on a LAN address, which is how a phone
 * reaches a dev server) and older WebViews. The fallback below is a `Math.random`-shaped
 * v4 — weaker entropy, correct shape — which is the right trade for both consumers:
 * `deviceId` disambiguates writers on ONE device's storage, and `runId` joins two records
 * from one run. Neither is a security token, and neither may ever become one without
 * replacing this.
 */
export function mintUuid(source?: UuidCrypto | null): string {
  const native = source?.randomUUID;
  if (typeof native === 'function') return native.call(source);
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** The ambient `crypto`, or null where the host has none (jsdom without one, a Node
 *  context). Read at the call site rather than at import so nothing is captured at
 *  module scope. */
export function ambientCrypto(view: Window | null | undefined): UuidCrypto | null {
  const c = (view as unknown as { crypto?: UuidCrypto } | null | undefined)?.crypto;
  return c ?? null;
}
