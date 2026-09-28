// The one `gameVersion` identity rule, on its own subpath (`@wynding/feedback/sha`) and importing
// nothing, because `apps/web/build-config.ts` needs it too, and that module is loaded by the Vite
// and Vitest configs, where pulling in the rest of the contract (and its hashing) is unwanted.

/** SHA-1 (40 hex), or a SHA-256 repository's object id (64 hex). */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `value` is a full lowercase commit SHA: shared by what a build embeds as its
 *  `gameVersion` (`apps/web/build-config.ts`) and what a survey submission may carry. */
export function isFullCommitSha(value: string): boolean {
  return FULL_SHA_RE.test(value);
}
