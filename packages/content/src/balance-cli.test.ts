// balance-cli.test.ts — M3 story 1: the CLI exits nonzero when the report can't be trusted.
// The report and the disk loader are mocked; their own behaviour is tested beside them.

import { afterEach, describe, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => ({ text: 'report text', failures: [] as string[] }));
vi.mock('./balance-report', () => ({ balanceReport: () => report }));
vi.mock('./balance-artifacts', () => ({ loadArtifactRuleset: () => undefined }));

describe('the balance CLI', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('prints the report and leaves the exit code alone when nothing failed', async () => {
    report.failures = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('./balance-cli');
    expect(log).toHaveBeenCalledWith('report text');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 and names every failure when the report cannot be trusted', async () => {
    report.failures = ['m3/a: step 4 was rejected by the sim and never ran'];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('./balance-cli');
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'balance: the report cannot be trusted:\n  m3/a: step 4 was rejected by the sim and never ran',
    );
  });
});
