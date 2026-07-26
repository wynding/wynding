// fullscreen.test.ts — the fullscreen-on-Start gate (PLAN.md Story 11 P4). jsdom implements
// none of the Fullscreen API and real fullscreen is not exercisable in CI, so the module
// takes its document surface and both capability probes as dependencies. All EIGHT branches
// PLAN.md P4 enumerates are covered: the first six are the gate itself, and the last two —
// repeated presses mid-run, and Play-again then re-Start — are the `started` false→true EDGE
// that `main.ts` owns, asserted in `main.test.ts` against the real wiring.

import { describe, it, expect, vi } from 'vitest';
import { requestFullscreen, type FullscreenDeps } from './fullscreen';

function deps(
  overrides: Partial<FullscreenDeps> = {},
  { supported = true }: { supported?: boolean } = {},
): {
  deps: FullscreenDeps;
  request: ReturnType<typeof vi.fn>;
} {
  // The `request` spy is the SAME function the doc exposes (when `supported`) — so an
  // assertion about it is load-bearing. `supported: false` OMITS it from the spy-bearing doc
  // (rather than the caller replacing `doc` wholesale, which would orphan the returned spy and
  // make `not.toHaveBeenCalled()` pass vacuously).
  const request = vi.fn(() => Promise.resolve());
  return {
    request,
    deps: {
      doc: {
        fullscreenElement: null,
        documentElement: supported ? { requestFullscreen: request } : {},
      },
      matchesCoarsePointer: () => true,
      isStandalone: () => false,
      ...overrides,
    },
  };
}

describe('fullscreen — the capability gate (PLAN.md P4)', () => {
  it('1. supported + coarse pointer: requests once, asking to hide navigation UI', () => {
    const { deps: d, request } = deps();
    expect(requestFullscreen(d)).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ navigationUI: 'hide' });
  });

  it('2. unsupported (no requestFullscreen — e.g. Safari on iPhone): never called', () => {
    const { deps: d, request } = deps({}, { supported: false });
    expect(requestFullscreen(d)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('3. fine pointer (a desktop browser): never called — taking the screen would be presumptuous', () => {
    const { deps: d, request } = deps({ matchesCoarsePointer: () => false });
    expect(requestFullscreen(d)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('4. already standalone (an installed PWA): never called — it already owns the screen', () => {
    const { deps: d, request } = deps({ isStandalone: () => true });
    expect(requestFullscreen(d)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('5. already fullscreen: never re-requested', () => {
    const request = vi.fn(() => Promise.resolve());
    const element = { nodeType: 1 } as unknown as Element;
    const d: FullscreenDeps = {
      doc: { fullscreenElement: element, documentElement: { requestFullscreen: request } },
      matchesCoarsePointer: () => true,
      isStandalone: () => false,
    };
    expect(requestFullscreen(d)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('6. a rejection is swallowed — Start is unaffected, nothing is thrown or left unhandled', async () => {
    const rejection = Promise.reject(new Error('permissions policy'));
    const request = vi.fn(() => rejection);
    const d: FullscreenDeps = {
      doc: { fullscreenElement: null, documentElement: { requestFullscreen: request } },
      matchesCoarsePointer: () => true,
      isStandalone: () => false,
    };
    // The call itself must not throw synchronously...
    expect(() => requestFullscreen(d)).not.toThrow();
    expect(request).toHaveBeenCalledOnce();
    // ...and the rejection must already be handled, so no unhandled-rejection escapes.
    await expect(rejection.catch(() => 'handled')).resolves.toBe('handled');
  });

  it('a synchronously-throwing requestFullscreen is swallowed — Start must never break', () => {
    // Partial/legacy WebKit element-fullscreen implementations (and some permissions-policy
    // refusals) raise instead of returning a rejected promise. Start runs between
    // controller.start() and the rest of the transition, so an escaping throw would strand
    // the run half-started — absorb it and report "no request made".
    const request = vi.fn(() => {
      throw new Error('boom');
    });
    const d: FullscreenDeps = {
      doc: {
        fullscreenElement: null,
        documentElement: { requestFullscreen: request as unknown as () => Promise<void> },
      },
      matchesCoarsePointer: () => true,
      isStandalone: () => false,
    };
    expect(requestFullscreen(d)).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it('the pointer probe is read at REQUEST time, not captured at construction', () => {
    let coarse = false;
    const { deps: d, request } = deps({ matchesCoarsePointer: () => coarse });
    expect(requestFullscreen(d)).toBe(false);
    coarse = true; // a tablet docked/undocked between load and Start
    expect(requestFullscreen(d)).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });
});
