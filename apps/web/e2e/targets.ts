// Shared interactive-target floor for the e2e suite.
//
// Lives in a non-spec module because Playwright registers tests at import time: importing
// `home.spec.ts` to reuse this constant would re-register that whole spec's tests inside the
// importing file. Redeclaring it per spec is the other obvious option and is worse — two
// copies drift, and the one that drifts is the one nobody is looking at.

/** ADR 0003's interactive-target floor, in CSS px. */
export const TARGET_MIN_PX = 44;
