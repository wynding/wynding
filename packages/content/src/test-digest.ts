// test-digest.ts — package-local test support (NOT exported from the package index),
// on the `showcase-builds.ts` precedent.
//
// FNV-1a over a string — an 8-line INLINE duplicate of `@wynding/engine`'s `fnv1a`,
// kept because `@wynding/sim` does not re-export it and importing `@wynding/engine`
// directly would add a runtime dependency edge this package doesn't otherwise need.
// Fast, deterministic, NOT cryptographic — identical algorithm, identical output to
// the engine original. ONE copy for the whole package: `parity.test.ts` and
// `m2-golden.test.ts` both digest their tick traces through THIS function, so the two
// files can never drift onto different digests for the same trace while each still
// passes its own pinned literal (PR #93 CodeRabbit round 1).
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * `state` as the sim knew it before M3 story 3's `destination` creep column (ADR 0015):
 * every field, minus that column. It is appended LAST on the creep SoA, so spreading it
 * out leaves exactly the earlier state's JSON — same keys, same order — and
 * `hashSimState` of the result is byte-comparable with a hash pinned before the column
 * existed. Every re-pin that column caused asserts its previous pin under this
 * projection, which is what makes "only the new column moved the hash" a test rather
 * than a comment. `@wynding/sim`'s `test-support.ts` carries the same projection for the
 * sim's own suite (a package boundary; neither exports test support).
 */
export function withoutDestination<S extends { readonly creeps: object }>(state: S): S {
  const { destination: _destination, ...creeps } = state.creeps as { destination?: unknown };
  return { ...state, creeps } as S;
}
