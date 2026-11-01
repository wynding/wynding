import { describe, it, expect, vi, afterEach } from 'vitest';
import { validate } from '@wynding/replay';
import { getBundledRuleset } from '@wynding/content';
import { createController } from './controller';
import type { VerifyRequest, VerifyWorkerMessage } from './verifier';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('verify-worker — the worker’s side of Verify (M3 story 2)', () => {
  it('says ready as it loads, then answers each posted request with validate()’s result', async () => {
    // The module binds itself to its global scope on import, as it does in a worker.
    const posted: VerifyWorkerMessage[] = [];
    const scope: {
      onmessage: ((event: MessageEvent<VerifyRequest>) => void) | null;
      postMessage: (message: VerifyWorkerMessage) => void;
    } = { onmessage: null, postMessage: (message) => void posted.push(message) };
    vi.stubGlobal('self', scope);
    await import('./verify-worker');
    expect(scope.onmessage).not.toBeNull();
    expect(posted, 'ready before any request').toEqual([{ kind: 'ready' }]);

    const c = createController(7);
    c.start();
    for (let i = 0; i < 20_000 && !c.isTerminal(); i++) c.advance(50);
    const replay = c.buildReplay();
    const bundle = getBundledRuleset();
    scope.onmessage!(new MessageEvent('message', { data: { replay, bundle } }));
    expect(posted[1]).toEqual({ kind: 'result', result: validate(replay, bundle) });
    expect(posted[1]).toMatchObject({ result: { ok: true } });

    // A request the validator refuses is answered too: its refusal IS the answer.
    scope.onmessage!(
      new MessageEvent('message', { data: { replay: { ...replay, simVersion: 0 }, bundle } }),
    );
    const refused = posted[2] as Extract<VerifyWorkerMessage, { kind: 'result' }>;
    expect(refused.kind).toBe('result');
    expect(refused.result.ok).toBe(false);
    expect(refused.result.reason).toContain('sim version mismatch');
    expect(posted).toHaveLength(3);
  });
});
