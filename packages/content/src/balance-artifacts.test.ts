// balance-artifacts.test.ts — M3 story 1: the balance command's on-disk loader reads the
// same bundle the registry embeds — and, since M3 story 4, the frozen M2 bundle the
// calibration set runs on, under its own key, the same bytes `m2-fixture.ts` imports.

import { describe, it, expect } from 'vitest';
import { compileRuleset, rulesetDigest } from '@wynding/sim';
import { getBundledRuleset, defaultBoardId } from './registry';
import { getM2Fixture, M2_BOARD_ID, M2_FIXTURE_KEY } from './m2-fixture';
import { loadArtifactRuleset } from './balance-artifacts';
import { M2_SHOWCASE } from './reference-builds';

describe('the balance command’s ruleset loader', () => {
  it('parses and compiles the bundled ruleset from disk, to the registry’s own digest', () => {
    const shipped = getBundledRuleset('wynding-core');
    expect(
      compileRuleset(loadArtifactRuleset('wynding-core'), defaultBoardId(shipped)).digest,
    ).toBe(compileRuleset(shipped, defaultBoardId(shipped)).digest);
    expect(() => loadArtifactRuleset('no-such-ruleset')).toThrow(/no on-disk artifact/);
  });

  it('reads the frozen M2 bundle from disk under its own key, to the fixture’s own digest', () => {
    const fromDisk = loadArtifactRuleset(M2_FIXTURE_KEY);
    expect(rulesetDigest(fromDisk)).toBe(rulesetDigest(getM2Fixture()));
    expect(compileRuleset(fromDisk, M2_BOARD_ID).digest).toBe(
      compileRuleset(getM2Fixture(), M2_BOARD_ID).digest,
    );
    // Its own key, not the id inside it: that is the shipped bundle's, which is another board.
    expect(fromDisk.rulesetId).toBe('wynding-core');
    expect(() => compileRuleset(loadArtifactRuleset('wynding-core'), M2_BOARD_ID)).toThrow();
    // And it is the one the calibration set names.
    expect(M2_SHOWCASE.rulesetId).toBe(M2_FIXTURE_KEY);
  });
});
