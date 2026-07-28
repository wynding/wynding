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
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
