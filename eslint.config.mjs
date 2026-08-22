// Flat ESLint config for the Wynding monorepo.
// Non-type-checked recommended rules only — fast, and independent of each
// package's TS program (type-aware linting can be layered in later).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import wynding from './eslint-rules/no-ui-literals.mjs';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

// The deterministic core's forbidden Node specifiers. Hoisted out of the determinism zone
// below because `no-restricted-imports` is ONE rule slot per file: flat config replaces a
// rule's entire configuration when a later config object sets the same rule, it does not
// merge the two `paths` arrays. The layering zones further down match the same four
// packages, so leaving these in place there and adding a second `no-restricted-imports`
// object here would have silently DELETED the determinism restrictions for
// engine/sim/replay/content — a guard turned off by the arrival of another guard. They are
// merged in one place instead (`layeringZone`, below). BOTH SPELLINGS of each specifier:
// Node resolves the bare `crypto`/`timers` identically to their `node:` twins and
// @types/node (a hoisted root devDependency) declares both, so a rule listing only the
// prefixed form typechecks AND lints clean on the unprefixed one — a guard one autocomplete
// away from useless.
const NONDETERMINISTIC_MODULE_PATHS = [
  {
    name: 'crypto',
    message: 'Use the seeded Rng from @wynding/engine — ambient crypto breaks replay determinism.',
  },
  { name: 'timers', message: 'No wall-clock scheduler in the deterministic core.' },
  { name: 'timers/promises', message: 'No wall-clock scheduler in the deterministic core.' },
  {
    name: 'node:crypto',
    message: 'Use the seeded Rng from @wynding/engine — ambient crypto breaks replay determinism.',
  },
  { name: 'node:timers', message: 'No wall-clock scheduler in the deterministic core.' },
  {
    name: 'node:timers/promises',
    message: 'No wall-clock scheduler in the deterministic core.',
  },
];

// ---------------------------------------------------------------------------------------
// LAYERING ZONES (#112) — ADR 0001's dependency graph, enforced rather than merely stated.
//
// WHY A LINT RULE AT ALL. ADR 0001 used to claim "boundaries are enforced by the package
// dependency graph". pnpm workspace isolation + tsc project references enforce something
// narrower: an UNDECLARED import fails to resolve, and a reference CYCLE fails the build.
// What passes both is any DECLARED, non-cyclic import — and two different violations hide
// there, which this comment used to conflate into one:
//
//   - a true BACK-EDGE, an import of something strictly to the RIGHT in the graph
//     (`packages/sim` reaching `@wynding/content`). The generated zones below catch these.
//   - a declared import of a NEVER-SHIPPED package, which the layering graph positively
//     PERMITS — `apps/web/src` importing `@wynding/perf` is a LEFTWARD edge, since `perf` sits
//     upstream of `apps`, and it is a declared devDependency today for the perf sandbox. It
//     would typecheck, lint and bundle into the shipped app without a murmur. That is the
//     never-ship invariant, not the graph, and the two hand-written app zones at the bottom
//     of this file are what carry it.
//
// An earlier draft called the second one a back-edge, contradicting ADR 0001's own definition
// two sentences after stating it. Both are the kind a hurried refactor or a helpful bot
// produces; only one of them is about the graph.
//
// THE GRAPH IS THE SOURCE, AND IT IS READ, NOT RETYPED. `LAYERS` is ADR 0001's graph
// (restated in AGENTS.md's Hard rules) transcribed once; every zone's forbidden set is
// DERIVED from it, and each package's subpath spellings are read out of that package's own
// `exports` map at config load. So `@wynding/content/catalog` became forbidden the moment
// the subpath was added to `packages/content/package.json` — nobody had to remember to widen
// a list here — with one honest exception: the two APP zones at the bottom are hand-written
// literals, because they carry the never-ship invariant rather than the graph. Their package
// names are spelled out there; their subpaths still go through `importableSpecifiers`, so a
// newly added subpath cannot slip past them either.
// `assertLayersCoverWorkspace` fails the lint outright if a new `packages/*`
// appears that the graph does not place, because a package this table has never heard of
// would otherwise be silently unguarded and importable from anywhere.
//
// WHAT IS FORBIDDEN IS A BACK-EDGE, NOT A SIBLING. Each layer may depend on anything to its
// LEFT; edges within a layer are permitted and do exist (`render`'s and `replay`'s tests
// import `@wynding/content`). A zone therefore forbids the layers strictly to its RIGHT.
//
// WHAT THIS DOES NOT CATCH, stated plainly because two other guards are sized around it:
//   - `no-restricted-imports` does NOT inspect dynamic `import()` expressions at all
//     (ESLint 9, verified against a probe — see the determinism zone's note, which had to
//     match its specifiers a second time at the syntax level for the same reason). So
//     `await import('@wynding/perf')` is not seen here.
//   - It matches SPECIFIERS, so a path-shaped reach at the same module
//     (`../../../packages/content/src/stress`) is not seen here either.
// Both are covered downstream: `packages/perf/src/layering.test.ts` greps shipped source
// context-free for the three never-shipped specifiers in any import syntax, and
// `pnpm run check:build-layering` (#129) asks the BUNDLER — no emitted file of the shipped
// web build may carry those modules' markers, whatever spelling reached them.
//
// A ZONE WHOSE FORBIDDEN SET COMES OUT EMPTY IS SKIPPED, NOT EMITTED. `packages/perf` is the
// live case: nothing is downstream of it and no app is importable by package name, so its
// derived set is empty. Emitting the object anyway would put an empty `no-restricted-imports`
// configuration on `packages/perf/src/**` — harmless in itself, and exactly the
// last-writer-wins hazard this file documents two paragraphs up: it would silently clobber any
// `no-restricted-imports` a later config object sets for those files. `layeringZone` returns
// null in that case and the generator filters it out, so the rule stays UNSET for perf rather
// than set to nothing.

/** ADR 0001's layering graph, left (roots) to right (most-downstream package):
 *  `{types, engine} <- sim <- {render, replay, content} <- perf <- apps`. */
const LAYERS = [
  ['@wynding/types', '@wynding/engine'],
  ['@wynding/sim'],
  ['@wynding/render', '@wynding/replay', '@wynding/content'],
  ['@wynding/perf'],
];

/** `@wynding/x` -> `packages/x`. Every layered package is a `packages/*` member; `apps/*`
 *  are the rightmost layer and are not importable by package name. */
const packageDir = (specifier) => join(REPO_ROOT, 'packages', specifier.slice('@wynding/'.length));

/** A package's importable spellings: the bare name plus every subpath its own `exports` map
 *  offers. Read from disk so the zones cannot rot behind a newly added subpath.
 *
 *  THROWS on an `exports` map keyed by CONDITIONS rather than subpaths
 *  (`{ "import": …, "require": … }`) — legal Node, and silently catastrophic here: every key
 *  would be read as a subpath, so a downstream zone would forbid `@wynding/x/import` and
 *  `@wynding/x/require` while the bare `@wynding/x` — the spelling anyone actually writes —
 *  fell out of every forbidden list. A guard that quietly narrows itself is worse than one
 *  that fails, so this fails, the same way `assertLayersCoverWorkspace` does. */
function importableSpecifiers(specifier) {
  const manifest = JSON.parse(readFileSync(join(packageDir(specifier), 'package.json'), 'utf8'));
  const map = manifest.exports;
  // No map at all, or the string sugar for a single "." entry: the bare name is the only
  // importable spelling either way.
  if (map === undefined || map === null || typeof map === 'string') return [specifier];
  const subpaths = Object.keys(map);
  const conditions = subpaths.filter((key) => !key.startsWith('.'));
  if (conditions.length > 0) {
    throw new Error(
      `eslint.config.mjs: ${specifier}'s exports map is keyed by conditions, not subpaths ` +
        `(${conditions.join(', ')}). The layering zones derive their forbidden specifiers from ` +
        'those keys, so this shape would drop the bare package name from every downstream ' +
        "zone. Teach importableSpecifiers the new shape before shipping it — don't let the " +
        'guard narrow itself in silence.',
    );
  }
  // THE SAME FAILURE, ONE SHAPE ALONG — and the first draft of this function threw on the
  // conditions map while committing exactly the quiet narrowing it objected to. A subpath
  // PATTERN key (for example a "./*" entry mapping into ./src) begins with "." and sails
  // through the filter above, and `no-restricted-imports` matches `paths[].name` as an EXACT
  // STRING — globs belong to its `patterns` option, which is a different matcher entirely. So
  // the derived "@wynding/x/*" entry would match no import ever written, and every real
  // subpath under that wildcard would go unguarded in every downstream zone, silently.
  const wildcards = subpaths.filter((key) => key.includes('*'));
  if (wildcards.length > 0) {
    throw new Error(
      `eslint.config.mjs: ${specifier} exports subpath PATTERNS (${wildcards.join(', ')}). ` +
        'no-restricted-imports matches paths[].name exactly, so a derived wildcard entry ' +
        'would match nothing and leave every subpath under it unguarded. Expand the pattern ' +
        'into a patterns group before shipping it.',
    );
  }
  return subpaths.map((subpath) =>
    subpath === '.' ? specifier : `${specifier}/${subpath.replace(/^\.\//, '')}`,
  );
}

/** Fails the lint if a `packages/*` member is missing from `LAYERS` — an unplaced package is
 *  an unguarded one, and silence is the failure mode this table exists to prevent.
 *
 *  SCOPED TO `packages/*`, and incompletely so: `apps/*` are the rightmost layer, so no zone is
 *  generated for them and none can be missing. `apps/mobile` and `apps/desktop` have no `src/`
 *  today, so nothing is unguarded — but a `src` directory appearing under either one tomorrow
 *  gets neither a zone nor a complaint from this function, which is the same silence one
 *  directory over. */
function assertLayersCoverWorkspace() {
  const placed = new Set(LAYERS.flat());
  const missing = readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `@wynding/${entry.name}`)
    .filter((specifier) => !placed.has(specifier));
  if (missing.length > 0) {
    throw new Error(
      `eslint.config.mjs: ${missing.join(', ')} exists under packages/ but is not placed in ` +
        "ADR 0001's layering graph (the LAYERS table above). Place it — and amend ADR 0001 " +
        'first if the graph itself changed. An unplaced package is an unguarded one.',
    );
  }
}
assertLayersCoverWorkspace();

/** Every importable spelling of `@wynding/perf`, each carrying the same message.
 *
 *  DERIVED rather than hand-typed even though the bare name is all its exports map offers
 *  today, because "today" is exactly the word that rotted the sibling guard: the day a
 *  `./harness` subpath is added, both app zones cover it with nobody remembering to widen a
 *  list. `layering.test.ts` fixed this precise latent gap in its own regex — its comment says
 *  "latent today, since perf's exports map offers only '.', but live the day anyone adds a
 *  subpath export" — and the lesson had not been carried across to these zones. */
const neverShippedPerf = (message) =>
  importableSpecifiers('@wynding/perf').map((name) => ({ name, message }));

/** One flat-config object per layered package: everything strictly downstream of it is an
 *  import error, with the determinism specifiers merged in for the four core packages (see
 *  `NONDETERMINISTIC_MODULE_PATHS`). Returns null when the package has nothing to forbid —
 *  see the skipped-when-empty note above. */
function layeringZone(specifier, layerIndex) {
  const downstream = LAYERS.slice(layerIndex + 1).flat();
  const paths = downstream.flatMap((forbidden) =>
    importableSpecifiers(forbidden).map((name) => ({
      name,
      message: `${forbidden} is downstream of ${specifier} in the ADR 0001 layering graph — this import is a back-edge. Move the shared code upstream, or re-argue the graph in ADR 0001 first.`,
    })),
  );
  const alsoDeterministic = [
    '@wynding/engine',
    '@wynding/sim',
    '@wynding/replay',
    '@wynding/content',
  ].includes(specifier);
  const restricted = [...(alsoDeterministic ? NONDETERMINISTIC_MODULE_PATHS : []), ...paths];
  if (restricted.length === 0) return null;
  return {
    files: [`packages/${specifier.slice('@wynding/'.length)}/src/**`],
    rules: {
      'no-restricted-imports': ['error', { paths: restricted }],
    },
  };
}

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
      // WHERE THIS ZONE'S `no-restricted-imports` LIVES NOW: in the layering zones at the
      // bottom of this file, merged with each package's back-edge list
      // (`NONDETERMINISTIC_MODULE_PATHS` at the top holds the specifiers; `layeringZone`
      // splices them in for engine/sim/replay/content — exactly this zone's four packages).
      // It is not configured here because flat config gives a file ONE configuration per
      // rule name, last writer wins: the layering zones match the same files, so two
      // `no-restricted-imports` objects would mean the determinism specifiers stopped being
      // restricted the moment #112 landed. Merged in one place, both hold.
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
    },
  },
  // ADR 0001's layering graph, one zone per layered package — see the LAYERS block at the
  // top of this file for what these forbid and, just as importantly, what they do not.
  ...LAYERS.flatMap((layer, index) =>
    layer.flatMap((specifier) => layeringZone(specifier, index) ?? []),
  ),
  {
    // THE SHIPPED WEB APP. `apps/web/src/**` is the production graph: `index.html` loads
    // `/src/boot-entry.ts` and Vite follows it from there. `apps/web/perf/**` is deliberately
    // NOT in this zone — it is the perf-only browser entry, built by a separate Vite config
    // into a separate output directory (`vite.perf.config.ts`), and it imports all three of
    // these on purpose.
    //
    // The layering graph PERMITS `apps <- perf`; this is the narrower "never shipped"
    // invariant on top of it (`packages/perf/src/index.ts`'s header, AGENTS.md's Hard rules).
    // `@wynding/perf` is a declared devDependency of this app, so nothing else in the
    // toolchain objects to the import — that is the whole point of #112.
    //
    // TESTS ARE INCLUDED. `apps/web/src/**/*.test.ts` imports none of these today, and a test
    // that did would be the "test-module laundering" reach #129 probes: a shipped module
    // importing a test helper that imports the forbidden module.
    files: ['apps/web/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...neverShippedPerf(
              'Nothing shipped may import @wynding/perf (ADR 0001, AGENTS.md). The perf-only browser entry lives in apps/web/perf/, built by vite.perf.config.ts into dist-perf.',
            ),
            {
              name: '@wynding/content/stress',
              message:
                'The 40x40 stress bundle is a synthetic perf ceiling, deliberately absent from the registry — it must never reach the client build (packages/content/src/stress.ts).',
            },
            {
              name: '@wynding/content/catalog',
              message:
                'The 40x40 catalog bundle is a synthetic perf ceiling, deliberately absent from the registry — it must never reach the client build (packages/content/src/catalog.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    // THE SHIPPED SERVER, part 1 of 2 — the rules that hold EVERYWHERE under `src`, tests
    // included.
    //
    // `apps/server` IS bundled, and an earlier draft of this comment said the opposite
    // ("compiled by `tsc` with no bundler"). `esbuild --bundle` emits a single
    // `dist/handler.mjs`, and the package's tsconfig sets `noEmit` (#109) — tsc is the type
    // checker there and nothing else. What is true is narrower and is
    // `check-build-layering.mjs`'s own doing: that check scans the WEB app's output only, so
    // the server is uncovered by scope, not by impossibility. Its arm of the invariant is
    // therefore this zone plus its `package.json` dependency set, which declares neither
    // `@wynding/render` nor `@wynding/perf`, making both undeclared imports here as well.
    files: ['apps/server/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...neverShippedPerf('Nothing shipped may import @wynding/perf (ADR 0001, AGENTS.md).'),
            ...importableSpecifiers('@wynding/render').map((name) => ({
              name,
              message: 'apps/server is headless — it re-simulates replays and draws nothing.',
            })),
            {
              name: '@wynding/content/stress',
              message: 'The synthetic stress bundle is not shippable content.',
            },
            {
              name: '@wynding/content/catalog',
              message: 'The synthetic catalog bundle is not shippable content.',
            },
          ],
        },
      ],
    },
  },
  {
    // THE SHIPPED SERVER, part 2 of 2 — everything above PLUS the main `@wynding/content`
    // entry, for non-test files only.
    //
    // That last one is NOT a layering question: `handler.ts` reads the artifact from disk via
    // `@wynding/content/artifact` precisely so the bundler-embedded `?raw` ruleset text never
    // enters the server's module graph (see its header, and Codex R3-1 on `defaultBoardId`).
    // `./artifact` stays allowed. `handler.test.ts` and `replay-parity.test.ts` legitimately
    // import the main entry to build fixtures, and nothing they import ships.
    //
    // WHY TWO OBJECTS RATHER THAN ONE WITH `ignores`. A single object carrying
    // `ignores: ['**/*.test.ts']` was the first shape, and its comment claimed tests were
    // excused "only for that last restriction's sake". That is not what `ignores` does — it
    // drops the WHOLE config object for those files, so a server test lost every restriction
    // at once, `@wynding/render` included, which has no second guard the way perf/stress/
    // catalog do (`layering.test.ts` greps for those three by specifier). Verified with
    // `eslint --print-config`: the test file resolved to no `no-restricted-imports` at all.
    // Splitting restores the intent — part 1 covers tests, part 2 adds the content entry for
    // shipped files. The two overlap on non-test files and part 2 is a strict superset, so
    // last-writer-wins is deliberate and harmless here; given this file's history with that
    // rule, it is worth saying so out loud.
    files: ['apps/server/src/**'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...neverShippedPerf('Nothing shipped may import @wynding/perf (ADR 0001, AGENTS.md).'),
            ...importableSpecifiers('@wynding/render').map((name) => ({
              name,
              message: 'apps/server is headless — it re-simulates replays and draws nothing.',
            })),
            {
              name: '@wynding/content',
              message:
                "Import @wynding/content/artifact instead — the main registry entry drags the bundler-embedded ?raw ruleset text into the server's module graph (apps/server/src/handler.ts's header).",
            },
            {
              name: '@wynding/content/stress',
              message: 'The synthetic stress bundle is not shippable content.',
            },
            {
              name: '@wynding/content/catalog',
              message: 'The synthetic catalog bundle is not shippable content.',
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
