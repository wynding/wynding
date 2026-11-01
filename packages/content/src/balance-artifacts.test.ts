// balance-artifacts.test.ts — M3 story 1: the balance command's on-disk loader reads the
// same bundle the registry embeds.

import { describe, it, expect } from 'vitest';
import { compileRuleset } from '@wynding/sim';
import { getBundledRuleset } from './registry';
import { loadArtifactRuleset } from './balance-artifacts';

describe('the balance command’s ruleset loader', () => {
  it('parses and compiles the bundled ruleset from disk, to the registry’s own digest', () => {
    expect(compileRuleset(loadArtifactRuleset('wynding-core'), 'field-01').digest).toBe(
      compileRuleset(getBundledRuleset('wynding-core'), 'field-01').digest,
    );
    expect(() => loadArtifactRuleset('no-such-ruleset')).toThrow(/no on-disk artifact/);
  });
});
