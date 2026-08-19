// Ambient module declarations for non-code imports handled by Vite (and stubbed by
// Vitest). CSS is imported for its side effect (style injection) and has no runtime
// shape the app consumes.
declare module '*.css';

// The one Vite env field this app reads (`import.meta.env.DEV`, M2-S2's wave-preview
// unmapped-creep-id dev warning — PLAN.md P3 step 17): declared minimally here rather
// than pulling in the full `vite/client` ambient types (which declare their own asset
// module shims that could drift from the `*.css` one above).
interface ImportMetaEnv {
  readonly DEV: boolean;
  // The hosted declaration of ADR 0012, baked in by the build that produces the artifact
  // (ADR 0013). Supplied by `vite.config.ts`'s `define` for every build — `false` for the
  // open-web build, `true` for the Host build — and by `vitest.config.ts` under jsdom, so
  // it is never absent at the point of use. Read in exactly one place, `boot()`.
  //
  // This declaration is the one copy of the key that cannot be computed from
  // `build-config.ts` (an interface member is not a value), so a rename here that misses
  // the define would typecheck and ship an unhosted Host build. `e2e/hosted.spec.ts` is
  // what catches that, by testing the artifact's BEHAVIOUR rather than this name.
  readonly WYNDING_HOSTED: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
