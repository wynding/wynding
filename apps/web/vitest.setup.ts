import { afterEach } from 'vitest';

// vitest.setup.ts — shared by every apps/web unit file: jsdom accommodations, and the
// between-tests yield at the end.
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

// Between tests, let the event loop turn once. Vitest moves from one test to the next without
// yielding, so a stretch of long synchronous tests (a run played to its end, a full buffer of
// placement checks) holds the worker past the 60 s its replies to the main process may take,
// and the file fails with `Timeout calling "onTaskUpdate"` though every test in it passed.
// One macrotask between tests lets the replies through; each test must still finish inside
// 60 s on its own. The real `setTimeout` is captured here, at load, so a test that installs
// fake timers and leaves them installed cannot stall this hook.
const realSetTimeout = globalThis.setTimeout;
afterEach(() => new Promise<void>((resolve) => void realSetTimeout(resolve, 0)));
