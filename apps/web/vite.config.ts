import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import {
  gameVersionDefine,
  hostedDefine,
  resolveGameVersion,
  webBuildConfig,
} from './build-config';

/** `git rev-parse HEAD`, or undefined where there is no repository to ask. */
function readGitHead(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

// The web app is a thin PWA shell. Workspace packages resolve to their TS source
// (see each package's `exports`), so Vite transpiles them directly — no prebuild.
//
// Two artifacts from one source (ADR 0013): the default mode builds the open-web app to
// `dist`; `--mode host` builds the **Host build** to `dist-host` with the hosted
// declaration compiled in. This file is a function of `mode` purely so that mapping is
// reachable — it was a static object before, so a mode-dependent `outDir` was not
// expressible. The mapping itself lives in `build-config.ts` so it can be asserted
// directly (`src/build-config.test.ts`).
export default defineConfig(({ mode }) => {
  const { outDir, hosted } = webBuildConfig(mode);
  return {
    define: {
      ...hostedDefine(hosted),
      // ADR 0014 §4: the survey's `gameVersion` — the full commit SHA of this build's source.
      ...gameVersionDefine(resolveGameVersion(process.env['WYNDING_GAME_VERSION'], readGitHead)),
    },
    build: {
      target: 'es2022',
      outDir,
    },
  };
});
