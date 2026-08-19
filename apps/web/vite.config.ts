import { defineConfig } from 'vite';
import { hostedDefine, webBuildConfig } from './build-config';

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
    define: hostedDefine(hosted),
    build: {
      target: 'es2022',
      outDir,
    },
  };
});
