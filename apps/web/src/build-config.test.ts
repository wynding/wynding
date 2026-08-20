import { describe, expect, it } from 'vitest';
import { HOST_MODE, HOSTED_DEFINE_KEY, hostedDefine, webBuildConfig } from '../build-config';

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
