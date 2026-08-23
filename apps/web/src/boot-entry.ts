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
// thrown error), never a silent no-op. `boot()` reports that case SYNCHRONOUSLY, as a
// null return, precisely so this stays a thrown error: since #142 the rest of the boot
// is a promise (settings are hydrated through ADR 0008's async `StorageDriver` before
// the first render), and folding the missing-root check into it would have downgraded
// the loudest failure the app has into an unhandled rejection.
const booting = boot(document);
if (booting === null) {
  throw new Error('missing #app root element');
}
// A boot that FAILS must be as loud as a boot that never started. `void` marks a promise
// as deliberately un-awaited; it does not handle a rejection, so an async boot failure
// would have surfaced only as a bare `unhandledrejection` whose message some consoles
// truncate and whose stack points into the microtask queue rather than at the app.
// Rethrowing from a timeout puts it on the global error path instead — the same place the
// missing-root `throw` above lands — with the original cause attached.
booting.catch((cause: unknown) => {
  setTimeout(() => {
    throw new Error('Wynding failed to boot', { cause });
  });
});
