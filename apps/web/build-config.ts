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
// `types: []`. This module imports nothing, so all three consumers — `vite.config.ts`,
// `vitest.config.ts` and `src/build-config.test.ts` — can read the same values.
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
