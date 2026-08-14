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
          // Node-only, and @types/node is auto-included for these packages, so it is
          // callable here even though no browser has it.
          name: 'setImmediate',
          message: 'No wall-clock scheduler in the deterministic core.',
        },
        {
          name: 'crypto',
          message:
            'Use the seeded Rng from @wynding/engine — ambient crypto breaks replay determinism.',
        },
      ],
      // WHAT THIS ZONE IS, AND IS NOT. It raises the cost of ACCIDENTALLY reaching a
      // nondeterministic API from the deterministic core — a habit import, an autocomplete,
      // a copied snippet. It is NOT a sandbox and cannot become one: the set of spellings
      // is open (bare and `node:` imports, dynamic `import()`, the bare global, the same
      // global through `globalThis`/`window`/`global`/`self`, one level deeper through
      // `globalThis.Math`, Node's `process` surface, and `Reflect.get` or a computed
      // member access would evade all of the above). Successive review rounds on #111 each
      // named another; that enumeration does not terminate, and a rule claiming to be
      // exhaustive would be lying.
      //
      // The real backstop is elsewhere and is structural: any nondeterminism that actually
      // reaches the sim moves the determinism golden, which CI pairs with a SIM_VERSION
      // bump (#107), and replay byte-identity fails on divergence. This zone catches the
      // accident early and cheaply; those catch the consequence, always.
      //
      // So: ADD spellings here freely as they are noticed, and do not treat a newly-named
      // one as a defect in this rule.
      //
      // `no-restricted-globals` alone doesn't close it: `import { randomBytes } from
      // 'node:crypto'` (or `node:timers`) typechecks the same way the ambient globals
      // above do (@types/node is auto-included — no `types` option is set for these
      // packages) and dodges the globals rule entirely by never referencing the global.
      //
      // BOTH SPELLINGS. Node resolves the bare `crypto`/`timers` specifiers identically to
      // their `node:` twins, and @types/node (a hoisted root devDependency) declares both —
      // so a rule listing only the prefixed form typechecks AND lints clean on the
      // unprefixed one, which is a guard one autocomplete away from useless.
      //
      // `no-restricted-imports` does not inspect dynamic `import()` expressions AT ALL
      // (ESLint 9 — verified against a probe: the static forms error, the dynamic one
      // passed clean), so the same specifiers are matched a second time at the syntax level
      // below. Without that, `await import('node:crypto')` is a one-line bypass of the
      // whole determinism zone.
      //
      // A `patterns` group does NOT help with the dynamic form, and one used to sit beside
      // `paths` here on the theory that it did. It cost two real defects and bought nothing
      // (Codex/CodeRabbit, #111's PR): it duplicated all six specifiers, so every static
      // violation reported TWICE, and ESLint 9 matches `group` entries with GITIGNORE
      // semantics — a bare `timers` matches that path segment anywhere — so a relative
      // `./timers` or `./crypto/thing` was rejected with a message simply wrong about what
      // the import did. `paths` matches whole specifiers and has neither problem.
      'no-restricted-syntax': [
        'error',
        {
          // `Math` reached through a global object needs the NONDETERMINISTIC member named,
          // not the namespace: matching `globalThis.Math` wholesale rejected
          // `globalThis.Math.floor(3 / 2)`, which is perfectly deterministic (Codex,
          // #111's PR — the fourth false positive this zone produced, and the same lesson
          // as the type-only check's: a guard matching one level too high reds correct
          // code, which is worse than the gap it was widened to close).
          //
          // `Date` is NOT here, and the difference is the point. `Math` has deterministic
          // members worth keeping; `Date` has none this zone allows, and the bare global is
          // already restricted whole (`no-restricted-globals` above). So it belongs in the
          // namespace-level selector below — where naming only `.now` left `new
          // globalThis.Date()` and `globalThis.Date.parse(...)` linting clean (Codex,
          // #111's PR). Keeping it in one selector is also what stops a single
          // `globalThis.Date.now()` reporting twice.
          selector:
            "MemberExpression[object.object.name=/^(globalThis|window|global|self)$/][object.property.name='Math'][property.name='random']",
          message:
            'No ambient randomness in the deterministic core — use the seeded Rng from @wynding/engine.',
        },
        {
          // Node's `process` timing/scheduling surface: `process.nextTick(...)` schedules
          // work outside the initiating step, `process.hrtime.bigint()` is ambient timing.
          // Both typecheck here because @types/node is auto-included.
          selector:
            "MemberExpression[object.name='process'][property.name=/^(nextTick|hrtime|uptime)$/]",
          message:
            'No wall-clock scheduler or ambient timing in the deterministic core — use the tick counter.',
        },
        {
          selector:
            'ImportExpression[source.value=/^(node:)?(crypto|timers|timers\\u002Fpromises)$/]',
          message:
            'No ambient crypto or wall-clock scheduler in the deterministic core — use the seeded Rng from @wynding/engine.',
        },
        {
          // Global-OBJECT access is a third spelling `no-restricted-globals` cannot see:
          // `globalThis.crypto.getRandomValues(...)` and `globalThis.setTimeout(...)` contain
          // no bare identifier for that rule to match, so both typecheck AND lint clean
          // without this. `window`/`global`/`self` are covered for the same reason — none of
          // them exists in these packages today, which is exactly the point: the guard should
          // still hold the day someone adds a DOM-ish or Node-ish shim, not depend on their
          // absence. `Date` is in the property list for the same reason `performance` is —
          // both are restricted as bare globals above, and the object form is the spelling
          // that dodges that rule — and it covers `new globalThis.Date()` and
          // `globalThis.Date.parse(...)` too, which naming `.now` alone did not.
          selector:
            'MemberExpression[object.name=/^(globalThis|window|global|self)$/][property.name=/^(crypto|setTimeout|setInterval|setImmediate|queueMicrotask|performance|process|Date)$/]',
          message:
            'No ambient crypto, wall-clock or scheduler access in the deterministic core — use the seeded Rng from @wynding/engine and the tick counter.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
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
