import { describe, expect, it } from 'vitest';
import {
  CLEAN_STATUS_ARGS,
  GAME_VERSION_DEFINE_KEY,
  HOST_MODE,
  HOSTED_DEFINE_KEY,
  UNKNOWN_GAME_VERSION,
  gameVersionDefine,
  hostedDefine,
  readCleanHead,
  resolveGameVersion,
  webBuildConfig,
} from '../build-config';

// The mode → artifact mapping, pinned directly (ADR 0013). Both halves are asserted: where a
// build is WRITTEN and what it DECLARES, for both modes — a suite that checked only one of
// them would stay green while CI produced a Host build with no declaration in it, which is
// the exact failure ADR 0013 exists to make loud.
//
// What is NOT covered here, deliberately and unavoidably: that `boot()` reads this constant.
// `define` inlines the value at transform time, so under Vitest it is already a literal with
// no seam to stub. `e2e/hosted.spec.ts` is the only check that can see it — which is exactly
// why that spec exists, against a built artifact rather than in this suite.
//
// The module under test sits at the package root rather than in `src/` because
// `vite.config.ts` and `vitest.config.ts` both import it (see its header); the test lives
// here because `vitest.config.ts`'s `include` is `src/**/*.test.ts`.
describe('build-config — the mode → artifact mapping', () => {
  it('maps the default modes to the open-web build: dist, not hosted', () => {
    // Vite's own two defaults, plus the mode Vitest itself runs in. None of them is the
    // host mode, so all three must produce the canonical artifact.
    for (const mode of ['production', 'development', 'test']) {
      expect(webBuildConfig(mode)).toEqual({ outDir: 'dist', hosted: false });
    }
  });

  it('maps the host mode to the Host build: dist-host, hosted', () => {
    expect(webBuildConfig(HOST_MODE)).toEqual({ outDir: 'dist-host', hosted: true });
  });

  it('never writes a Host build into the open-web output', () => {
    // ADR 0013 consequence 2: a Host packages a directory only a Host build writes, so
    // packaging a plain web build is a missing-directory failure rather than an app that
    // ships and misbehaves. That property is exactly "these two paths are not equal".
    expect(webBuildConfig(HOST_MODE).outDir).not.toBe(webBuildConfig('production').outDir);
  });

  it('emits the declaration as a JSON-encoded literal under the documented key', () => {
    // Vite substitutes a `define` value as raw source text, so the value must be the
    // EXPRESSION `true`/`false`, not the booleans themselves — `{ key: false }` would
    // splice the string "false" into the bundle and read truthy at every consumer.
    expect(hostedDefine(true)).toEqual({ [HOSTED_DEFINE_KEY]: 'true' });
    expect(hostedDefine(false)).toEqual({ [HOSTED_DEFINE_KEY]: 'false' });
    expect(HOSTED_DEFINE_KEY).toBe('import.meta.env.WYNDING_HOSTED');
  });

  it('declares in the build that is written to the host output, and only there', () => {
    // The two halves restated as one invariant: declaring, and writing to `dist-host`, are
    // the same condition. Scoped honestly — the mode list is literal, so this cannot see a
    // mode nobody added to it. What it guards is the EXISTING modes against an edit that
    // changes one half without the other, not the arrival of a new one.
    for (const mode of [HOST_MODE, 'production', 'development', 'test']) {
      const { outDir, hosted } = webBuildConfig(mode);
      expect(hosted).toBe(outDir === 'dist-host');
    }
  });
});

// ADR 0014 §4's `gameVersion`: the full commit SHA is the identity — never a tag, never an
// abbreviation — because §3's once-per-version ask rests on one revision being spelled one way.
describe('build-config — gameVersion (ADR 0014 §4)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it('takes the full SHA from git HEAD, trimmed and lower-cased', () => {
    expect(resolveGameVersion(undefined, () => `${SHA.toUpperCase()}\n`)).toBe(SHA);
  });

  it('lets an explicit WYNDING_GAME_VERSION win over git', () => {
    const other = 'fedcba9876543210fedcba9876543210fedcba98';
    expect(resolveGameVersion(other, () => SHA)).toBe(other);
  });

  it('never trusts a tag, a short SHA or nothing at all — those read as unknown', () => {
    for (const value of ['v1.2.0', SHA.slice(0, 12), '', 'not a sha']) {
      expect(resolveGameVersion(value, () => SHA)).toBe(UNKNOWN_GAME_VERSION);
    }
    expect(resolveGameVersion(undefined, () => undefined)).toBe(UNKNOWN_GAME_VERSION);
  });

  it('claims HEAD only for a clean worktree — uncommitted source is not that revision', () => {
    const repo =
      (status: string) =>
      (args: string): string => {
        if (args === CLEAN_STATUS_ARGS) return status;
        if (args === 'rev-parse HEAD') return `${SHA}\n`;
        throw new Error(`unexpected git ${args}`);
      };
    expect(readCleanHead(repo(''))).toBe(`${SHA}\n`);
    expect(readCleanHead(repo(' M apps/web/src/main.ts\n'))).toBeUndefined(); // tracked edit
    expect(readCleanHead(repo('?? apps/web/src/new.ts\n'))).toBeUndefined(); // untracked file
    expect(
      readCleanHead(() => {
        throw new Error('not a git repository');
      }),
    ).toBeUndefined();
    // End to end: a dirty build resolves to unknown, so it can never submit a survey.
    expect(resolveGameVersion(undefined, () => readCleanHead(repo(' M x\n')))).toBe(
      UNKNOWN_GAME_VERSION,
    );
  });

  it('emits the version as a JSON-encoded string literal under its own key', () => {
    expect(gameVersionDefine(SHA)).toEqual({ [GAME_VERSION_DEFINE_KEY]: `"${SHA}"` });
    expect(GAME_VERSION_DEFINE_KEY).not.toBe(HOSTED_DEFINE_KEY);
  });

  it('reaches the unit-test build through vitest.config.ts', () => {
    expect(import.meta.env.WYNDING_GAME_VERSION).toBe(SHA);
  });
});
