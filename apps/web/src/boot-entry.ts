// boot-entry.ts — the production app's side-effect-only browser entry point.
//
// QC: this side effect used to live at the top of `main.ts`, guarded by
// `isTestRunner()` (a `globalThis.process?.env?.VITEST` sniff). That guard only ever
// worked under Vitest — neither `vite.config.ts` nor `vite.perf.config.ts` `define`s
// `process`, so in a REAL browser `process` is undefined, the guard was false, and
// merely IMPORTING `main.ts` booted the production app. `apps/web/perf/main-perf.ts`
// imports `createApp` from `../src/main` and `Controller` from `../src/controller`
// (it needs the real app, wired against the stress bundle instead of the shipped
// ruleset) — so loading the perf harness silently booted a SECOND, production app
// into `#app` first, and every perf-recorded number (fps, input latency, DOM queries
// for `.wy-card`/the live region) was actually measuring both apps at once, with the
// input-latency probe finding the PRODUCTION Shell rather than the stress one.
//
// The fix is to make `main.ts` side-effect-free on import (it only exports
// `createApp`/`boot` now) and move the auto-boot here, into a module `main-perf.ts`
// never imports. `index.html` is this module's ONLY consumer.
//
// No `isTestRunner()` guard needed here — this module is never imported under Vitest
// (the unit tests import `boot`/`createApp` from `./main` directly), so the browser
// auto-boot below always applies.
import { boot } from './main';

// A missing/mis-IDed #app mount point is a hard, visible failure (a blank page with a
// thrown error), never a silent no-op.
if (boot(document) === null) {
  throw new Error('missing #app root element');
}
