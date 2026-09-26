// build-config.ts — the mode → artifact mapping for this package's two web builds.
//
// ADR 0013: a **Host** is served by its own build of this source, written to its own
// output, carrying the hosted declaration as a build-time constant. That makes the mapping
// from Vite mode to (output directory, declaration) the load-bearing part of the host
// wiring — a build that is written to `dist-host` but does NOT declare itself is exactly
// the silently-wrong artifact ADR 0013 exists to prevent — so the mapping lives here, as a
// pure function, rather than inline in `vite.config.ts`.
//
// Why its own file and not an export from `vite.config.ts`: that file is outside this
// package's tsc program (`tsconfig.json` includes `src`, `perf`, `e2e-perf`), and a Vitest
// import of it would pull Vite's Node-side config types into a DOM-lib program with
// `types: []`. This module imports nothing, so every consumer — `vite.config.ts`,
// `vitest.config.ts`, the tests, and the shipped `src/survey.ts` — can read the same
// values. Keep it that way: an import added here (a Node one especially) would land in the
// client bundle; git access is injected (`readCleanHead`'s `git`) for exactly that reason.
//
// Nothing here knows what a Host *is*. It knows only that one mode declares and the other
// does not, which is the whole of ADR 0012 constraint 1 (the web build never learns *which*
// host it is in).

/** The Vite mode that produces a Host build. `pnpm run build:host` passes it. */
export const HOST_MODE = 'host';

/**
 * The one documented fact of ADR 0012, as a build-time constant.
 *
 * It has to exist in three places or the build does not compile and the tests cannot see
 * it: this `define`, an `ImportMetaEnv` field in `src/env.d.ts`, and Vitest's own `define`.
 * Two of the three read the key from here. The third — the `env.d.ts` declaration — is a
 * TypeScript interface member and cannot be computed from a value, so it is the one place
 * a rename can drift. That gap is closed by `e2e/hosted.spec.ts`, which asserts the
 * SHIPPED artifact behaves hosted rather than asserting anything about this string.
 */
export const HOSTED_DEFINE_KEY = 'import.meta.env.WYNDING_HOSTED';

export interface WebBuildConfig {
  /** Vite `build.outDir`, relative to this package. */
  readonly outDir: string;
  /** Whether this build declares itself **hosted** (ADR 0012). */
  readonly hosted: boolean;
}

/**
 * Map a Vite mode to the artifact it produces.
 *
 * The two outputs are deliberately distinct directories: a Host's packaged directory is one
 * only a Host build writes (ADR 0013 consequence 2), so packaging a plain web build fails
 * as a missing directory at the packaging step instead of shipping an app that boots
 * perfectly and is silently wrong.
 */
export function webBuildConfig(mode: string): WebBuildConfig {
  const hosted = mode === HOST_MODE;
  return { outDir: hosted ? 'dist-host' : 'dist', hosted };
}

/** The `define` entry a build carries for `hosted`. Split out so `vitest.config.ts` can
 *  supply the same key for the mode it runs in without restating the string. */
export function hostedDefine(hosted: boolean): Record<string, string> {
  return { [HOSTED_DEFINE_KEY]: JSON.stringify(hosted) };
}

/**
 * ADR 0014 §4's `gameVersion`, as a build-time constant through the same `define` mechanism
 * as the hosted declaration (ADR 0013). `hostedDefine` is the precedent, not the carrier —
 * this is its own key.
 *
 * THE IDENTITY IS THE FULL COMMIT SHA, never a tag and never an abbreviation: a tag's
 * visibility differs between checkouts of one commit, and a short SHA lengthens as the
 * repository grows colliding prefixes — either would mint a fresh `gameVersion` for a revision
 * that already had one and re-ask a player §3 promised not to. So the boundary is a distinct
 * deployed source revision: a rebuild, redeploy or rollback reuses the revision it came from.
 */
export const GAME_VERSION_DEFINE_KEY = 'import.meta.env.WYNDING_GAME_VERSION';

/** What a build carries when no full SHA can be resolved (a source tarball, no git). It can
 *  never pass the survey payload's `gameVersion` check, so such a build cannot submit one. */
export const UNKNOWN_GAME_VERSION = 'unknown';

/** SHA-1 (40 hex), or a SHA-256 repository's object id (64 hex). */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `value` is a full lowercase commit SHA: the one `gameVersion` identity rule, shared
 *  by what a build embeds and what the survey accepts (`survey.ts`). */
export function isFullCommitSha(value: string): boolean {
  return FULL_SHA_RE.test(value);
}

/**
 * Resolve the build's `gameVersion`. An explicit `WYNDING_GAME_VERSION` wins (a CI that knows
 * the SHA it checked out, and answers for it); otherwise `readHead` supplies HEAD of a clean
 * worktree ({@link readCleanHead}). Anything that is
 * not a full lowercase SHA (40 hex, or 64 in a SHA-256 repository) resolves to {@link UNKNOWN_GAME_VERSION} rather than being
 * trusted. Injected rather than shelling out here, so this module keeps importing nothing.
 */
export function resolveGameVersion(
  envValue: string | undefined,
  readHead: () => string | undefined,
): string {
  const candidate = (envValue ?? readHead() ?? '').trim().toLowerCase();
  return isFullCommitSha(candidate) ? candidate : UNKNOWN_GAME_VERSION;
}

/** The worktree-cleanliness query {@link readCleanHead} runs. */
export const CLEAN_STATUS_ARGS = '--no-optional-locks status --porcelain --untracked-files=normal';

/**
 * `git rev-parse HEAD`, but only for a CLEAN worktree: a build of uncommitted source is not
 * the revision HEAD names, so claiming HEAD would give distinct game code that revision's
 * survey identity and ask history (Codex, PR #175 — reachable through the local mobile
 * `sync:*` / `release:android*` scripts, which build without a cleanliness check). Any
 * tracked change or untracked, non-ignored file makes it undefined, as does git failing.
 * `git` runs one git command (its arguments) and returns stdout, throwing on failure;
 * injected so this module keeps importing nothing.
 */
export function readCleanHead(git: (args: string) => string): string | undefined {
  try {
    // Untracked files counted whatever the user's `status.showUntrackedFiles`; no optional
    // index lock, so a build never collides with a git command running beside it.
    if (git(CLEAN_STATUS_ARGS).trim() !== '') return undefined;
    return git('rev-parse HEAD');
  } catch {
    return undefined;
  }
}

/** The `define` entry a build carries for `gameVersion`. */
export function gameVersionDefine(gameVersion: string): Record<string, string> {
  return { [GAME_VERSION_DEFINE_KEY]: JSON.stringify(gameVersion) };
}
