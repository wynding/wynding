// art-frames-cache.test.ts — the board atlas's frame keys are built once per id (#181, R4 QC):
// counted at the look functions each key is built from, which a key string's value cannot show
// (`art-frames.test.ts` compares keys with `toBe`, and two equal strings are `toBe` whether or
// not they were built twice).

import { describe, it, expect, vi } from 'vitest';

vi.mock('./tower-paint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tower-paint')>();
  return { ...actual, towerLookFor: vi.fn(actual.towerLookFor) };
});
vi.mock('./creep-paint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./creep-paint')>();
  return { ...actual, creepLookFor: vi.fn(actual.creepLookFor) };
});

import {
  creepFrameKey,
  creepShadowFrameKey,
  groundFrameKey,
  headFrameKey,
  pendingFrameKey,
} from './art-frames';
import { creepLookFor } from './creep-paint';
import { towerLookFor } from './tower-paint';

describe('frame keys — built once per id, however often placement asks', () => {
  it('finds a tower id’s look once for its plate, its heads and its pending build', () => {
    for (let i = 0; i < 4; i++) {
      groundFrameKey('cache-probe-tower');
      headFrameKey('cache-probe-tower', false);
      headFrameKey('cache-probe-tower', true);
      pendingFrameKey('cache-probe-tower');
    }
    const asked = vi.mocked(towerLookFor).mock.calls.filter(([id]) => id === 'cache-probe-tower');
    expect(asked).toHaveLength(1);
  });

  it('finds a creep id’s look once per role and domain', () => {
    for (let i = 0; i < 4; i++) {
      for (const boss of [false, true]) {
        for (const air of [false, true]) {
          creepFrameKey('cache-probe-creep', boss, air);
          creepShadowFrameKey('cache-probe-creep', boss, air);
        }
      }
    }
    const asked = vi.mocked(creepLookFor).mock.calls.filter(([id]) => id === 'cache-probe-creep');
    expect(asked).toHaveLength(4);
  });
});
