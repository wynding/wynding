// Ambient module declarations for non-code imports handled by Vite (and stubbed by
// Vitest) — mirrors `apps/web/src/env.d.ts`'s `*.css` precedent. `?raw` resolves at
// build time to the file's UTF-8 text content as a plain string.
declare module '*.json?raw' {
  const content: string;
  export default content;
}
