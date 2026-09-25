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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const RESTRICTION_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

/** The engine zone's off-allowlist message, by its leading text. */
const OFF_ALLOWLIST = '@wynding/engine may import only same-directory relative paths';
const ALIASED = 'An aliased or indirect `require`';

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
      expect(messages[0]).toContain(OFF_ALLOWLIST);
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
      expect(messages[0]).toContain(OFF_ALLOWLIST);
    });

    it('the test runner is allowed in tests only', async () => {
      const code = "import { it } from 'vitest';\nexport { it };\n";
      expect(await restrictions(ENGINE_TEST, code)).toEqual([]);
      const shipped = await restrictions(ENGINE, code);
      expect(shipped).toHaveLength(1);
      expect(shipped[0]).toContain(OFF_ALLOWLIST);
    });

    it('tests keep every OTHER engine restriction (the test object is not an ignores)', async () => {
      const messages = await restrictions(
        ENGINE_TEST,
        "import { parse } from 'yaml';\nimport { t } from '@wynding/types';\nexport { parse, t };\n",
      );
      // Pinned by TEXT, not just by count: two reports of any kind would satisfy a bare
      // `toHaveLength(2)`, so a test object that lost the `@wynding/types` back-edge restriction
      // could hide behind a duplicated off-allowlist report. Exactly one of each is required.
      expect(messages).toHaveLength(2);
      expect(messages.filter((message) => message.includes(OFF_ALLOWLIST))).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes('is a ROOT of the ADR 0001 layering graph')),
      ).toHaveLength(1);
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

describe(
  'aliased require: every way to reach the loader without a checkable specifier (#171 §1)',
  {
    timeout: FIXTURE_MS,
  },
  () => {
    const SERVER = 'apps/server/src/lint-fixture.ts';

    it.each([
      ['a comma-expression callee', "export const a = (0, require)('@wynding/perf');\n"],
      [
        'a require value in a variable',
        "const r = require;\nexport const a = r('@wynding/perf');\n",
      ],
      ['globalThis.require', "export const a = globalThis.require('@wynding/perf');\n"],
      ['module.require', "export const a = module.require('@wynding/perf');\n"],
      [
        'a destructured require',
        'const { require: r } = globalThis as never;\nexport const a = r;\n',
      ],
      [
        'a string-named createRequire import',
        "import { 'createRequire' as cr } from 'node:module';\nexport const a = cr;\n",
      ],
      [
        'a namespace createRequire',
        "import * as m from 'node:module';\nexport const a = m.createRequire(import.meta.url);\n",
      ],
    ])('rejects %s, once', async (_form, code) => {
      const messages = await restrictions(SERVER, code);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(ALIASED);
    });

    it('rejects createRequire at its import and at its call, renamed or not', async () => {
      for (const code of [
        "import { createRequire } from 'node:module';\nexport const a = createRequire(import.meta.url)('@wynding/perf');\n",
        "import { createRequire as cr } from 'node:module';\nexport const a = cr;\n",
      ]) {
        const messages = await restrictions(SERVER, code);
        expect(messages.length).toBeGreaterThan(0);
        for (const message of messages) expect(message).toContain(ALIASED);
      }
    });

    it('leaves a plain require() call and names that are not references alone', async () => {
      expect(
        await restrictions(
          SERVER,
          "export const a = require('./ok');\nexport const b = { require: 1 };\n" +
            'export class C { require(): void {} }\nexport interface I { require: number }\n',
        ),
      ).toEqual([]);
    });

    it('applies in the deterministic core too', async () => {
      const messages = await restrictions(
        'packages/sim/src/lint-fixture.ts',
        "export const a = globalThis.require('@wynding/perf');\n",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(ALIASED);
    });
  },
);

describe(
  'engine relative specifiers stay inside its src (#171 §2)',
  { timeout: FIXTURE_MS },
  () => {
    const ENGINE = 'packages/engine/src/lint-fixture.ts';

    it.each([
      [
        'a path into node_modules',
        "import { parse } from '../../../node_modules/yaml/dist/index.js';\nexport { parse };\n",
      ],
      ['a sibling root by path', "import { t } from '../../types/src/index';\nexport { t };\n"],
      [
        'a ./ path that climbs back out',
        "import { t } from './x/../../../types/src/index';\nexport { t };\n",
      ],
      ['a node_modules under ./', "import { t } from './node_modules/yaml';\nexport { t };\n"],
      ['the dynamic form', "export const a = import('../../types/src/index');\n"],
    ])('rejects %s', async (_form, code) => {
      const messages = await restrictions(ENGINE, code);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(OFF_ALLOWLIST);
    });

    it('allows a same-directory relative import', async () => {
      expect(
        await restrictions(ENGINE, "import { fpMul } from './fixed';\nexport { fpMul };\n"),
      ).toEqual([]);
    });
  },
);

describe('the config-load assertions (#171 §3)', () => {
  type Allowlists = Record<string, { runtime: string[]; testOnly: string[] }>;
  type Violation = { specifier: string; outside: string[] };
  let violations: (
    readManifest: (specifier: string) => Record<string, Record<string, string> | undefined>,
    allowlists?: Allowlists,
  ) => Violation[];

  beforeAll(async () => {
    // A non-literal specifier: the config is plain .mjs and this package's tsconfig does not
    // type it, so it is loaded as an untyped module and narrowed here.
    const url = pathToFileURL(join(REPO_ROOT, 'eslint.config.mjs')).href;
    ({ thirdPartyAllowlistViolations: violations } = (await import(url)) as {
      thirdPartyAllowlistViolations: typeof violations;
    });
  }, CONFIG_LOAD_MS);

  const TABLE: Allowlists = {
    '@wynding/engine': { runtime: ['@noble/hashes'], testOnly: ['vitest'] },
  };

  it('finds a runtime dependency outside the list, and a test-only one in a runtime field', () => {
    const found = violations(
      () => ({ dependencies: { '@noble/hashes': '1', yaml: '2', vitest: '3' } }),
      TABLE,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.specifier).toBe('@wynding/engine');
    expect(found[0]!.outside).toEqual(['dependencies.yaml', 'dependencies.vitest']);
  });

  it('allows the test runner in devDependencies only, and nothing else there', () => {
    expect(violations(() => ({ devDependencies: { vitest: '3' } }), TABLE)).toEqual([]);
    expect(violations(() => ({ devDependencies: { yaml: '2' } }), TABLE)[0]!.outside).toEqual([
      'devDependencies.yaml',
    ]);
    expect(
      violations(
        () => ({ peerDependencies: { yaml: '2' }, optionalDependencies: { x: '1' } }),
        TABLE,
      )[0]!.outside,
    ).toEqual(['peerDependencies.yaml', 'optionalDependencies.x']);
  });

  it('the real manifests are clean', () => {
    expect(violations(undefined as never)).toEqual([]);
  });

  // The checker above proves it FINDS a violation; these prove the config still RUNS it. Deleting
  // a top-level call left every test green before (#171), because the real manifests are clean.
  it.each([
    'assertLayersCoverWorkspace',
    'assertThirdPartyAllowlists',
    'assertAllowlistedSrcIsFlat',
  ])('eslint.config.mjs calls %s at load', (name) => {
    const source = readFileSync(join(REPO_ROOT, 'eslint.config.mjs'), 'utf8');
    expect(source).toMatch(new RegExp(`^${name}\\(\\);$`, 'm'));
  });
});
