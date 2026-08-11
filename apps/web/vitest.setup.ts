// vitest.setup.ts — jsdom accommodations shared by every apps/web unit file.
//
// Canvas: jsdom implements `HTMLCanvasElement.prototype.getContext` as a not-implemented
// stub that RETURNS NULL — the app's guard already worked — but it also emits a
// jsdomError stack to the virtual console per call: 360 stacks per run once every Card
// carries a glyph swatch (`swatch.ts`). The app's contract treats a null context as "no
// paint", so answer null QUIETLY instead: unit output stays readable, and the
// null-context branch the production code must handle anyway (a lost context) is exactly
// the branch the unit environment exercises.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => null,
  configurable: true,
  writable: true,
});
