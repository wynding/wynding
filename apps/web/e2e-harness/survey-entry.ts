// survey-entry.ts — the e2e survey harness's entry (#158). NOT part of the shipped app:
// `e2e-harness/survey.html` is this module's only consumer, built by `vite.e2e.config.ts`
// into `dist-e2e`, a directory nothing that ships reads.
//
// Why a harness at all: ADR 0014's survey is offered only where a transport is injected,
// and production injects none until `wynding-site` has the endpoint. The shipped page
// therefore has no survey to test — by design — so the e2e and axe gates run against the
// REAL `boot()` here, with one difference: a fake transport the spec drives through
// `window.__wySurvey`. Everything else (storage, locks, the dialog, the form) is the
// production path.
//
// `?version=<sha>` stands in for a second deploy without a second build (the ask is per
// `gameVersion`, §3).

import { boot } from '../src/main';
import type { SurveyPayload } from '@wynding/feedback';
import type { SurveySendResult, SurveyTransport } from '../src/survey';

/** How the next send settles: at once with a result, or `hold` until the spec releases it. */
type Mode = SurveySendResult | 'hold';

interface HarnessControl {
  mode: Mode;
  readonly sent: SurveyPayload[];
  /** How many sends were aborted by their operation token (a run start). */
  aborted: number;
  /** Settle the held send. */
  release(result: SurveySendResult): void;
}

let held: ((result: SurveySendResult) => void) | null = null;
const control: HarnessControl = {
  mode: 'accepted',
  sent: [],
  aborted: 0,
  release(result) {
    held?.(result);
    held = null;
  },
};
// Deliberately not a `declare global`: an augmentation would be program-wide, and this is
// the one place that may name the hook (see `tsconfig.json`'s note on test-only globals).
// The name is also `check:build-layering`'s marker for this module: rename it there too.
(window as unknown as { __wySurvey: HarnessControl }).__wySurvey = control;

const transport: SurveyTransport = {
  send(payload, signal) {
    control.sent.push(payload);
    signal.addEventListener('abort', () => void control.aborted++);
    if (control.mode !== 'hold') return Promise.resolve(control.mode);
    return new Promise((resolve) => {
      held = resolve;
    });
  },
};

const version = new URLSearchParams(window.location.search).get('version');
const booting = boot(document, {
  surveyTransport: transport,
  ...(version === null ? {} : { gameVersion: version }),
});
if (booting === null) throw new Error('missing #app root element');
booting.catch((cause: unknown) => {
  setTimeout(() => {
    // This message is also a `check:build-layering` marker for this module: reword it there too.
    throw new Error('survey harness failed to boot', { cause });
  });
});
