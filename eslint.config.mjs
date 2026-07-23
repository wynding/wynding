// Flat ESLint config for the Wynding monorepo.
// Non-type-checked recommended rules only — fast, and independent of each
// package's TS program (type-aware linting can be layered in later).
import js from '@eslint/js';
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
    files: ['packages/engine/src/**', 'packages/sim/src/**', 'packages/replay/src/**'],
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
    files: ['scripts/**/*.mjs', 'eslint-rules/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
