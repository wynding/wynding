// layering-lint.test.ts — the lint half of the layering invariant, exercised against the REAL
// `eslint.config.mjs` rather than trusted from its comments (#168).
//
// The zones in that file are generated, and a generated guard fails quietly: a selector that
// matches nothing looks exactly like a selector with nothing to match. #168 found two such
// holes by hand — a template-literal `import()` specifier the selectors never compared, and an
// engine zone that forbade workspace packages but let any third-party one through — so each
// closed hole is pinned here as a fixture, linted through ESLint's own API at a virtual path
// inside the zone it targets. Nothing is written to disk; `lintText` takes the path only to
// pick the config objects that apply.
//
// It lives beside `layering.test.ts` because this package is where the layering guards are
// tested, and it may import anything: nothing is downstream of `@wynding/perf`, so its own zone
// is empty (see A ZONE WHOSE FORBIDDEN SET COMES OUT EMPTY in the config).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const RESTRICTION_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

/** Loading the config pulls in typescript-eslint and reads every package manifest the zones
 *  derive from — under a parallel `turbo run test` that ran past vitest's 5 s default on the
 *  first fixture (measured, in this change's own verify run). So the load is paid once, up
 *  front, with its own budget, and each fixture gets a generous one too: a timeout here would
 *  be load, never a verdict. */
const CONFIG_LOAD_MS = 60_000;
const FIXTURE_MS = 30_000;

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT });
  await eslint.lintText('export {};\n', {
    filePath: join(REPO_ROOT, 'packages/engine/src/warm-up.ts'),
  });
}, CONFIG_LOAD_MS);

/** The layering-restriction messages `code` draws at `file` (repo-relative). Other rules are
 *  filtered out, so a fixture is judged only on what these zones say about it. */
async function restrictions(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, file) });
  // A parse error or an ignored-file warning carries a null ruleId and would filter to `[]`,
  // letting a `toEqual([])` fixture pass without anything having been linted.
  expect(result, `no lint result for ${file}`).toBeDefined();
  expect(result!.messages.filter((message) => message.ruleId === null)).toEqual([]);
  return result!.messages
    .filter((message) => message.ruleId !== null && RESTRICTION_RULES.has(message.ruleId))
    .map((message) => message.message);
}

describe(
  'call-shaped specifiers: template literals are judged, non-constants rejected (#168 §1)',
  { timeout: FIXTURE_MS },
  () => {
    it('a no-substitution template is judged exactly like the string literal it equals', async () => {
      const messages = await restrictions(
        'apps/server/src/lint-fixture.ts',
        'export const probe = import(`@wynding/perf`);\n',
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('Nothing shipped may import @wynding/perf');
    });

    it('require() is a specifier site too', async () => {
      const messages = await restrictions(
        'apps/web/src/lint-fixture.ts',
        "export const probe = require('@wynding/content/stress');\n",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('synthetic perf ceiling');
    });

    it('a template WITH substitutions cannot be checked, so it is rejected', async () => {
      const messages = await restrictions(
        'apps/server/src/lint-fixture.ts',
        "export const probe = import(`@wynding/${'perf'}`);\n",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('not a constant');
    });

    it('so are concatenations and bare identifiers, in the deterministic core as well', async () => {
      const messages = await restrictions(
        'packages/sim/src/lint-fixture.ts',
        "const name = 'perf';\nexport const a = import('@wynding/' + name);\nexport const b = import(name);\n",
      );
      expect(messages).toHaveLength(2);
      for (const message of messages) expect(message).toContain('not a constant');
    });

    it('a relative template is the one carve-out', async () => {
      const messages = await restrictions(
        'apps/web/src/lint-fixture.ts',
        "const lang = 'en';\nexport const probe = import(`./locales/${lang}.json`);\n",
      );
      expect(messages).toEqual([]);
    });

    it('a template back-edge between roots reports once, with the root message', async () => {
      const messages = await restrictions(
        'packages/engine/src/lint-fixture.ts',
        'export const probe = import(`@wynding/types`);\n',
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('is a ROOT of the ADR 0001 layering graph');
    });

    it('the determinism specifiers learned the template spelling too, still reporting once', async () => {
      const messages = await restrictions(
        'packages/engine/src/lint-fixture.ts',
        'export const probe = import(`node:crypto`);\n',
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('No ambient crypto');
    });
  },
);

describe(
  "engine's third-party allowlist: relative paths and @noble/hashes only (#168 §2)",
  { timeout: FIXTURE_MS },
  () => {
    const ENGINE = 'packages/engine/src/lint-fixture.ts';
    const ENGINE_TEST = 'packages/engine/src/lint-fixture.test.ts';

    it.each([
      ['static', "import { parse } from 'yaml';\nexport { parse };\n"],
      ['re-export', "export * from 'yaml';\n"],
      ['dynamic', "export const probe = import('yaml');\n"],
      ['template', 'export const probe = import(`yaml`);\n'],
      ['node built-in', "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n"],
    ])('rejects a third-party or node specifier (%s form)', async (_form, code) => {
      const messages = await restrictions(ENGINE, code);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('@wynding/engine may import only relative paths');
    });

    it('allows relative paths and @noble/hashes subpaths, statically and dynamically', async () => {
      const messages = await restrictions(
        ENGINE,
        [
          "import { sha256 } from '@noble/hashes/sha2.js';",
          "import { fpMul } from './fixed';",
          "export const utils = import('@noble/hashes/utils.js');",
          'export { sha256, fpMul };',
          '',
        ].join('\n'),
      );
      expect(messages).toEqual([]);
    });

    it('does not let a look-alike scope through the @noble/hashes allowance', async () => {
      const messages = await restrictions(
        ENGINE,
        "import x from '@noble/hashes-extra';\nexport { x };\n",
      );
      expect(messages).toHaveLength(1);
    });

    it('the test runner is allowed in tests only', async () => {
      const code = "import { it } from 'vitest';\nexport { it };\n";
      expect(await restrictions(ENGINE_TEST, code)).toEqual([]);
      const shipped = await restrictions(ENGINE, code);
      expect(shipped).toHaveLength(1);
      expect(shipped[0]).toContain('@wynding/engine may import only relative paths');
    });

    it('tests keep every OTHER engine restriction (the test object is not an ignores)', async () => {
      const messages = await restrictions(
        ENGINE_TEST,
        "import { parse } from 'yaml';\nimport { t } from '@wynding/types';\nexport { parse, t };\n",
      );
      expect(messages).toHaveLength(2);
    });

    it('a back-edge still reports once, with its specific message, not also as off-allowlist', async () => {
      const messages = await restrictions(
        ENGINE,
        "import { randomBytes } from 'node:crypto';\nexport { randomBytes };\n",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('ambient crypto');
    });
  },
);
