// check-artifact-parity.ts — M2-S11 P6 leg 1: built-artifact parity between the
// client bundle and the packaged server ruleset, and (#109) EXECUTION of the built
// server artifact under plain `node`.
//
// Ruling 7: written the obvious way, client/server parity is structurally incapable
// of failing — both sides import the SAME `@wynding/sim` in one process. What
// actually breaks is the BUNDLED copy drifting from the on-disk copy: the client
// embeds the ruleset as bundler-inlined `?raw` text (`packages/content/src/registry.ts`),
// the server reads it from disk at cold start via `BUNDLED_ARTIFACT_URL`
// (`packages/content/src/artifact.ts` + `apps/server/src/handler.ts:23`). That drift
// has bitten before — Codex PR #66 P1: a dist-deployed server ENOENT'd at cold start
// because `packages/content`'s `tsc` build emits no assets; the fix was the `build`
// script's `cp src/rulesets/*.json dist/rulesets/` step. This script re-proves that
// fix holds by comparing REAL BUILT ARTIFACTS — never a second read of the same
// source file, which would pass vacuously.
//
// Turbo's `test` task depends only on `^typecheck` (see root `turbo.json`), so a
// Vitest here would inspect stale or absent build output and pass loudest exactly
// when the build is missing. Hence this is a standalone root command
// (`pnpm run check:artifact-parity`), invoked separately, that BUILDS first.
//
// The same reasoning is why leg 1f EXECUTES the artifact instead of asserting it
// exists. `existsSync` passed for months over a `dist/handler.js` that could not be
// imported at all (#109): the workspace's `exports` maps point at `./src/*.ts`, so
// Node followed `@wynding/sim` into TypeScript source and failed on its extensionless
// relative specifiers. `apps/server` therefore builds with esbuild `--bundle` — one
// mechanism that closes both failure modes and yields the single self-contained file a
// Lambda package wants — and this script runs the result. (The alternative considered
// and rejected: repointing each package's `exports` at its `dist/` via `publishConfig`.
// That fixes deployment only, keeps the artifact spread across the workspace, and adds
// a second export shape to keep in sync with the src-first one everything else here
// depends on.)
//
// Lives under `apps/server/scripts/` (not `src/`) so that its imports resolve
// `@wynding/sim` the normal workspace way: pnpm links `@wynding/*` into
// `apps/server/node_modules`, not into the repo root's. Nothing here reaches the
// artifact either way — esbuild bundles from `src/handler.ts` alone.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRulesetJson, rulesetDigest, SIM_VERSION } from '@wynding/sim';
import { validate, type Replay } from '@wynding/replay';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// The one ruleset this repo ships (`packages/content/src/registry.ts`'s
// `DEFAULT_RULESET_ID`, and the filename of `packages/content/src/rulesets/*.json`).
// Not imported from the registry: the registry's main entry pulls in the
// bundler-only `?raw` import, which this plain `tsx`-run script (no bundler) cannot
// resolve — the exact same reason `@wynding/content/artifact` exists as a separate,
// `?raw`-free subpath for non-bundler consumers.
const RULESET_ID = 'wynding-core';

function fail(message: string): never {
  console.error(`\ncheck:artifact-parity — FAIL\n${message}\n`);
  process.exit(1);
}

function run(cmd: string, args: readonly string[]): void {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    fail(
      `build step failed (exit ${String(result.status)}): ${cmd} ${args.join(' ')}\n` +
        'A failed build here means this check cannot compare anything — fix the build first.',
    );
  }
}

/** Locates the ONE `?raw`-embedded ruleset template literal in a built JS chunk and
 *  returns its exact text. Vite's `?raw` transform inlines the file's bytes verbatim
 *  inside a template literal (the content's real newlines force backtick quoting —
 *  ordinary `'`/`"` strings can't hold them unescaped); since JSON never contains a
 *  backtick, the template literal's extent is exactly [opening backtick, next
 *  backtick). */
function extractEmbeddedRuleset(jsText: string): string | undefined {
  const marker = `"rulesetId": "${RULESET_ID}"`;
  const markerIdx = jsText.indexOf(marker);
  if (markerIdx === -1) return undefined;
  const openIdx = jsText.lastIndexOf('`', markerIdx);
  if (openIdx === -1) return undefined;
  const closeIdx = jsText.indexOf('`', openIdx + 1);
  if (closeIdx === -1) return undefined;
  // Vite embeds `?raw` content as a template literal, escaping exactly the characters
  // that are special inside one: backslash, backtick, and `$`. Today's ruleset contains
  // none of them, so the raw slice happens to be byte-identical — but a future ruleset
  // string carrying a `\` would false-fail the byte compare without any real drift
  // (PR #93 CodeRabbit round 1). Reverse the encoding before comparing.
  return jsText.slice(openIdx + 1, closeIdx).replace(/\\([`$\\])/g, '$1');
}

// --- Leg 1a: build the client (real production Vite build) and package the server
// (its real dist/packaging path) --------------------------------------------------
// A single `turbo run build` targeting both packages: turbo's `dependsOn: ["^build"]`
// (root `turbo.json`) walks the dependency graph first, so `@wynding/server`'s build
// pulls in `@wynding/content`'s — whose `build` script is the actual packaging step
// under test (`tsc -b && mkdir -p dist/rulesets && cp src/rulesets/*.json dist/rulesets/`).
run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@wynding/web', '--filter=@wynding/server']);

// --- Leg 1b: extract the client bundle's embedded ruleset bytes -------------------
const webDistAssets = path.join(REPO_ROOT, 'apps/web/dist/assets');
if (!existsSync(webDistAssets)) {
  fail(`missing client build output: ${webDistAssets} does not exist (did the Vite build run?)`);
}
const jsFiles = readdirSync(webDistAssets).filter((f) => f.endsWith('.js'));
if (jsFiles.length === 0) {
  fail(`missing client build output: no .js chunks in ${webDistAssets}`);
}

let clientBundlePath: string | undefined;
let clientText: string | undefined;
for (const file of jsFiles) {
  const fullPath = path.join(webDistAssets, file);
  const extracted = extractEmbeddedRuleset(readFileSync(fullPath, 'utf8'));
  if (extracted !== undefined) {
    clientBundlePath = fullPath;
    clientText = extracted;
    break;
  }
}
if (clientBundlePath === undefined || clientText === undefined) {
  fail(
    `could not find the embedded '${RULESET_ID}' ruleset in any client build chunk under ` +
      `${webDistAssets} (searched: ${jsFiles.join(', ')}) — the \`?raw\` embedding may have ` +
      'changed shape; update the extraction to match.',
  );
}

// --- Leg 1c: locate the built server artifact and its packaged rulesets -----------
// TWO packaged copies, because the ruleset reaches the deployed artifact through two
// hops and either can break: `packages/content`'s build copies `src/rulesets/*.json`
// into its own `dist/rulesets/` (the Codex PR #66 P1 fix), and `apps/server`'s build
// stages THAT copy beside its bundle (#109). The second is the one the artifact
// actually opens at cold start — `@wynding/content/artifact`'s `BUNDLED_ARTIFACT_URL`
// is `new URL('./rulesets/…', import.meta.url)`, and esbuild inlines that expression
// into `dist/handler.js`, so `import.meta.url` resolves beside the BUNDLE.
const serverHandlerPath = path.join(REPO_ROOT, 'apps/server/dist/handler.js');
if (!existsSync(serverHandlerPath)) {
  fail(`missing server build output: ${serverHandlerPath} does not exist`);
}

/** A packaged copy of the shipped ruleset, with the failure text that names the
 *  packaging step whose absence produced it. */
interface PackagedCopy {
  readonly label: string;
  readonly filePath: string;
  readonly missingHint: string;
}

const packagedCopies: readonly PackagedCopy[] = [
  {
    label: 'content package',
    filePath: path.join(REPO_ROOT, 'packages/content/dist/rulesets', `${RULESET_ID}.json`),
    missingHint:
      "packages/content's build script did not copy dist/rulesets/ (the Codex PR #66 P1 regression).",
  },
  {
    label: 'server artifact',
    filePath: path.join(REPO_ROOT, 'apps/server/dist/rulesets', `${RULESET_ID}.json`),
    missingHint:
      "apps/server's build script did not stage dist/rulesets/ beside the bundle — the deployed " +
      'artifact would ENOENT at cold start, which is exactly the #109 failure this leg exists to catch.',
  },
];

// --- Leg 1d: compare BYTES ---------------------------------------------------------
for (const copy of packagedCopies) {
  if (!existsSync(copy.filePath)) {
    fail(
      `missing packaged ruleset (${copy.label}): ${copy.filePath} does not exist — ${copy.missingHint}`,
    );
  }
  const packagedText = readFileSync(copy.filePath, 'utf8');
  if (clientText !== packagedText) {
    let firstDiff = 0;
    const minLen = Math.min(clientText.length, packagedText.length);
    while (firstDiff < minLen && clientText[firstDiff] === packagedText[firstDiff]) firstDiff++;
    fail(
      `byte mismatch between the client-bundled ruleset and the packaged ruleset (${copy.label}):\n` +
        `  client bundle (${clientBundlePath}): ${String(clientText.length)} bytes\n` +
        `  server package (${copy.filePath}): ${String(packagedText.length)} bytes\n` +
        `  first differing offset: ${String(firstDiff)}`,
    );
  }
}

// The copy the executed artifact reads — the one leg 1f grades a replay against.
const serverRulesetPath = packagedCopies[1]!.filePath;
const serverText = readFileSync(serverRulesetPath, 'utf8');

// --- Leg 1e: compare rulesetHash ---------------------------------------------------
const clientHash = rulesetDigest(parseRulesetJson(clientText));
const serverHash = rulesetDigest(parseRulesetJson(serverText));
if (clientHash !== serverHash) {
  fail(`rulesetHash mismatch: client=${clientHash} server=${serverHash}`);
}

// --- Leg 1f: EXECUTE the built artifact under plain `node` --------------------------
// `existsSync(dist/handler.js)` proved only that a file was written. It was written, and
// it could not run: the workspace packages export `./src/index.ts`, so Node's ESM
// resolver followed `@wynding/sim` to TypeScript source and then died on ITS
// extensionless relative specifiers (#109 — `ERR_MODULE_NOT_FOUND … /engine/src/rng`).
// Bundling (esbuild `--bundle`) is the fix; THIS leg is what makes the fix checkable, by
// turning "the artifact exists" into "the artifact runs and grades".
//
// Under plain `node`, deliberately — this script runs under `tsx`, whose resolver
// happily loads `.ts` and fills in missing extensions, i.e. papers over the exact defect
// being guarded. `spawnSync` does not inherit `execArgv` (that is `fork`), so tsx's
// loader flags do not reach the child; `NODE_OPTIONS` WOULD travel through the
// environment, so it is dropped below rather than trusted to be unset.
//
// ADR 0007 §2 (two independent loaders), re-asserted by EXECUTION: the client's loader
// is the bundler-embedded `?raw` text (legs 1b/1d/1e above), the server's is
// `readFileSync(BUNDLED_ARTIFACT_URL)` + `parseRulesetJson` at cold start. This leg
// makes the running artifact report the digest ITS loader arrived at, and requires it to
// equal the one derived here from the CLIENT bundle's bytes. Two loaders, two processes,
// one digest — or this check fails.
const serverBundle = parseRulesetJson(serverText);
const goodReplay: Replay = {
  // A minimal terminal run: launch wave 1 into an undefended field and let it leak out.
  // Cheap (446 ticks) but not trivial to fake — the comparison below pins the sim's final
  // state hash and tick count, not just "a number came back".
  seed: 12345,
  boardId: serverBundle.boards[0]!.id,
  rulesetHash: serverHash,
  simVersion: SIM_VERSION,
  tickInputs: [[{ kind: 'callWaveEarly' }]],
};
// Known-bad: structurally valid, correct sim version, foreign ruleset digest. Rejection
// therefore proves the artifact really loaded and digested its packaged ruleset — a stub
// that returned 200 for everything, or one whose ruleset never loaded, both fail here.
const badReplay: Replay = { ...goodReplay, rulesetHash: '0'.repeat(64) };

const expectedGood = validate(goodReplay, serverBundle);
if (!expectedGood.ok) {
  fail(
    `the known-good replay does not validate in-process (reason: ${expectedGood.reason ?? 'unknown'}) — ` +
      'this leg cannot grade the artifact against an expectation it cannot compute; fix the fixture.',
  );
}
const expectedBad = validate(badReplay, serverBundle);
if (expectedBad.ok) {
  fail('the known-bad replay validated in-process — the fixture no longer proves anything.');
}

// Plain JS, executed by the child. Kept as source here (rather than a checked-in `.mjs`)
// so the whole "build it, then run it" story reads in one file; a syntax error in it
// fails this check on the very next run.
const SMOKE_SOURCE = `
const input = JSON.parse(process.env.WYNDING_SMOKE_INPUT);
const { handler } = await import(input.bundleUrl);
const results = [];
for (const smokeCase of input.cases) {
  const res = await handler({ body: smokeCase.body });
  results.push({ name: smokeCase.name, statusCode: res.statusCode, body: res.body });
}
process.stdout.write(JSON.stringify(results));
`;

const smokeCases = [
  { name: 'known-good', body: JSON.stringify(goodReplay) },
  { name: 'known-bad', body: JSON.stringify(badReplay) },
] as const;

const smokeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  WYNDING_SMOKE_INPUT: JSON.stringify({
    bundleUrl: pathToFileURL(serverHandlerPath).href,
    cases: smokeCases,
  }),
};
delete smokeEnv.NODE_OPTIONS;

console.log(`+ ${process.execPath} --input-type=module -e <smoke> ${serverHandlerPath}`);
const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', SMOKE_SOURCE], {
  cwd: REPO_ROOT,
  env: smokeEnv,
  encoding: 'utf8',
});
if (smoke.error) {
  fail(`could not spawn node to execute the built artifact: ${smoke.error.message}`);
}
if (smoke.status !== 0) {
  fail(
    `the built server artifact does not RUN under plain node (exit ${String(smoke.status)}):\n` +
      `  artifact: ${serverHandlerPath}\n` +
      `${(smoke.stderr || '(no stderr)').trimEnd()}\n\n` +
      'A resolver error here means the artifact is not self-contained — check the esbuild ' +
      "`--bundle` step in apps/server's build script.",
  );
}

interface SmokeResult {
  readonly name: string;
  readonly statusCode: number;
  readonly body: string;
}

let smokeResults: readonly SmokeResult[];
try {
  smokeResults = JSON.parse(smoke.stdout) as readonly SmokeResult[];
} catch {
  fail(`the smoke run produced unreadable output:\n${smoke.stdout}`);
}
const byName = new Map(smokeResults.map((r) => [r.name, r]));

function smokeResult(name: string): SmokeResult {
  const result = byName.get(name);
  if (result === undefined) fail(`the smoke run returned no result for the ${name} replay.`);
  return result;
}

const mismatches: string[] = [];
function expectField(field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    mismatches.push(
      `  ${field}: artifact=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
}

const goodRun = smokeResult('known-good');
expectField('known-good statusCode', goodRun.statusCode, 200);
const goodPayload = JSON.parse(goodRun.body) as Record<string, unknown>;
expectField('known-good ok', goodPayload.ok, true);
expectField('known-good score', goodPayload.score, expectedGood.score);
expectField('known-good stars', goodPayload.stars, expectedGood.stars);
expectField('known-good finalHash', goodPayload.finalHash, expectedGood.finalHash);
expectField('known-good ticks', goodPayload.ticks, expectedGood.ticks);
// The two-loaders assertion: the digest the RUNNING artifact computed from its own
// on-disk copy, against the one derived here from the CLIENT bundle's embedded bytes.
expectField('known-good rulesetHash', goodPayload.rulesetHash, clientHash);

const badRun = smokeResult('known-bad');
expectField('known-bad statusCode', badRun.statusCode, 422);
const badPayload = JSON.parse(badRun.body) as Record<string, unknown>;
expectField('known-bad ok', badPayload.ok, false);
expectField('known-bad error', badPayload.error, expectedBad.reason);

if (mismatches.length > 0) {
  fail(
    'the built server artifact ran, but graded differently than the in-process validator:\n' +
      `  artifact: ${serverHandlerPath}\n${mismatches.join('\n')}`,
  );
}

console.log('\ncheck:artifact-parity — PASS');
console.log(`  client bundle:   ${clientBundlePath} (${String(clientText.length)} bytes)`);
console.log(`  server package:  ${serverRulesetPath} (${String(serverText.length)} bytes)`);
console.log(`  rulesetHash:     ${clientHash}`);
console.log(`  executed:        ${serverHandlerPath} under ${process.execPath}`);
console.log(
  `    known-good → ${String(goodRun.statusCode)} score=${String(expectedGood.score)} ` +
    `stars=${String(expectedGood.stars)} finalHash=${String(expectedGood.finalHash)} ` +
    `ticks=${String(expectedGood.ticks)}`,
);
console.log(`    known-bad  → ${String(badRun.statusCode)} ${String(expectedBad.reason)}\n`);
