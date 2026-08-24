// @wynding/platform — the shared platform package ADR 0008 §1 names, in its decided
// graph position: `{types, engine} <- sim <- {render, replay, content} <- perf <- apps`,
// with THIS package a sibling leaf the apps depend on and **the sim never imports**.
// It has no workspace dependencies at all, which is what makes that rule structural
// rather than remembered.
//
// Scope today is narrow on purpose (#142's ratified haircut): **settings is the only
// consumer**. Campaign progress and best scores + seeds — the other two MVP consumers
// ADR 0008 §3 lists — are Phase 2. The CONTRACT below is the ADR's and the design note's
// in full, so narrow does not mean throwaway: the second consumer wires up, it does not
// redesign.

export {
  createWebStorageDriver,
  StorageError,
  STORAGE_NAMESPACE,
  type StorageDriver,
  type WebStorageLike,
} from './driver';
export {
  decodeEnvelope,
  encodeEnvelope,
  SAVE_VERSION,
  type DecodedSave,
  type SaveEnvelope,
} from './envelope';
export {
  createSaveSlot,
  quarantineKey,
  webLockFn,
  type LockFn,
  type LockManagerLike,
  type SaveSlot,
  type SaveSlotOptions,
  type SlotRead,
} from './slot';
