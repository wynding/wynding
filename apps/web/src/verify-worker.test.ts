import { describe, it, expect, vi, afterEach } from 'vitest';
import { validate, type ValidationResult } from '@wynding/replay';
import { getBundledRuleset } from '@wynding/content';
import { createController } from './controller';
import type { VerifyRequest } from './verifier';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('verify-worker — the worker’s side of Verify (M3 story 2)', () => {
  it('answers each posted request with validate()’s result over that replay and bundle', async () => {
    // The module binds itself to its global scope on import, as it does in a worker.
    const posted: ValidationResult[] = [];
    const scope: {
      onmessage: ((event: MessageEvent<VerifyRequest>) => void) | null;
      postMessage: (result: ValidationResult) => void;
    } = { onmessage: null, postMessage: (result) => void posted.push(result) };
    vi.stubGlobal('self', scope);
    await import('./verify-worker');
    expect(scope.onmessage).not.toBeNull();

    const c = createController(7);
    c.start();
    for (let i = 0; i < 20_000 && !c.isTerminal(); i++) c.advance(50);
    const replay = c.buildReplay();
    const bundle = getBundledRuleset();
    scope.onmessage!(new MessageEvent('message', { data: { replay, bundle } }));
    expect(posted).toEqual([validate(replay, bundle)]);
    expect(posted[0]!.ok).toBe(true);

    // A request the validator refuses is answered too: its refusal IS the answer.
    scope.onmessage!(
      new MessageEvent('message', { data: { replay: { ...replay, simVersion: 0 }, bundle } }),
    );
    expect(posted[1]!.ok).toBe(false);
    expect(posted[1]!.reason).toContain('sim version mismatch');
  });
});
