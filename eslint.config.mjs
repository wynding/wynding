// Flat ESLint config for the Wynding monorepo.
// Non-type-checked recommended rules only — fast, and independent of each
// package's TS program (type-aware linting can be layered in later).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import wynding from './eslint-rules/no-ui-literals.mjs';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.turbo/**', '**/coverage/**', '**/node_modules/**', '**/*.gen.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Determinism boundary guard — the replay-verified core must never read
    // wall-clock time or ambient randomness. Same inputs, byte-identical state.
    files: [
      'packages/engine/src/**',
      'packages/sim/src/**',
      'packages/replay/src/**',
      'packages/content/src/**',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Use the seeded Rng from @wynding/engine — Math.random breaks replay determinism.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'No wall-clock in the deterministic core.',
        },
        {
          object: 'performance',
          property: 'now',
          message: 'No wall-clock in the deterministic core.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'No wall-clock in the deterministic core.' },
        { name: 'performance', message: 'No wall-clock in the deterministic core.' },
        {
          name: 'setTimeout',
          message: 'No wall-clock scheduler in the deterministic core.',
        },
        {
          name: 'setInterval',
          message: 'No wall-clock scheduler in the deterministic core.',
        },
        {
          name: 'queueMicrotask',
          message: 'No ambient scheduler in the deterministic core.',
        },
        {
          name: 'crypto',
          message:
            'Use the seeded Rng from @wynding/engine — ambient crypto breaks replay determinism.',
        },
      ],
      // `no-restricted-globals` alone doesn't close this: `import { randomBytes } from
      // 'node:crypto'` (or `node:timers`) typechecks the same way the ambient globals
      // above do (@types/node is auto-included — no `types` option is set for these
      // packages) and dodges the globals rule entirely by never referencing the global.
      //
      // BOTH SPELLINGS, and a pattern for the dynamic form. Node resolves the bare
      // `crypto`/`timers` specifiers identically to their `node:` twins, and @types/node
      // (a hoisted root devDependency) declares both — so a rule listing only the prefixed
      // form typechecks AND lints clean on the unprefixed one, which is a guard one
      // autocomplete away from useless. `paths` does not match `await import(...)`, so the
      // dynamic form needs `patterns` alongside it.
      // `no-restricted-imports` does not inspect dynamic `import()` expressions at all
      // (ESLint 9 — verified against a probe: the static forms below error, the dynamic
      // one passed clean), so the same specifiers are matched a second time at the syntax
      // level. Without this, `await import('node:crypto')` is a one-line bypass of the
      // whole determinism zone.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(node:)?(crypto|timers|timers\\u002Fpromises)$/]',
          message:
            'No ambient crypto or wall-clock scheduler in the deterministic core — use the seeded Rng from @wynding/engine.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'crypto',
                'node:crypto',
                'timers',
                'node:timers',
                'timers/promises',
                'node:timers/promises',
              ],
              message:
                'No ambient crypto or wall-clock scheduler in the deterministic core — use the seeded Rng from @wynding/engine.',
            },
          ],
          paths: [
            {
              name: 'crypto',
              message:
                'Use the seeded Rng from @wynding/engine — ambient crypto breaks replay determinism.',
            },
            {
              name: 'timers',
              message: 'No wall-clock scheduler in the deterministic core.',
            },
            {
              name: 'timers/promises',
              message: 'No wall-clock scheduler in the deterministic core.',
            },
            {
              name: 'node:crypto',
              message:
                'Use the seeded Rng from @wynding/engine — ambient crypto breaks replay determinism.',
            },
            {
              name: 'node:timers',
              message: 'No wall-clock scheduler in the deterministic core.',
            },
            {
              name: 'node:timers/promises',
              message: 'No wall-clock scheduler in the deterministic core.',
            },
          ],
        },
      ],
    },
  },
  {
    // The first real UI (Story 6): every user-facing string must come from the typed
    // `t()` catalog, never a raw literal in a DOM/aria/text sink (ADR 0004). The Phaser
    // scene draws no text (HUD is a DOM overlay), so this covers the render surfaces.
    files: ['apps/web/src/**/*.ts', 'packages/render/src/**/*.ts'],
    plugins: { wynding },
    rules: {
      'wynding/no-ui-literals': 'error',
    },
  },
  {
    // Test files legitimately assert on literal DOM text — exempt them from the
    // no-ui-literals rule (they verify what `t()` produced, they don't author copy).
    files: ['**/*.test.ts'],
    rules: {
      'wynding/no-ui-literals': 'off',
    },
  },
  {
    // Node CI/tooling scripts run under the Node runtime, not the browser — allow
    // the Node globals they legitimately use.
    // `**/scripts/` (not `scripts/`): flat-config globs are repo-root-relative, so the
    // bare form matched ONLY the root `scripts/` directory and silently skipped
    // package-local ones like `apps/web/scripts/` (CodeRabbit, PR #92 — the M2-S10 trace
    // post-processor landed there and was linted by nobody).
    files: ['**/scripts/**/*.mjs', 'eslint-rules/**/*.mjs'],
    languageOptions: {
      // The full ESM-shaped Node set, not a hand-curated list: `lint:scripts` gates
      // every verify run, and a missing entry would fail CI on an ordinary Node global.
      // nodeBuiltin (not node) so CJS-only names like `require` stay flagged in .mjs.
      globals: globals.nodeBuiltin,
    },
  },
);
