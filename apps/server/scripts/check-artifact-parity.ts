// check-artifact-parity.ts — M2-S11 P6 leg 1: built-artifact parity between the
// client bundle and the packaged server ruleset.
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
// Lives under `apps/server/scripts/` (not `src/`, so `tsc -p tsconfig.json` — the
// server's own build — never compiles or ships it) so that its imports resolve
// `@wynding/sim` the normal workspace way: pnpm links `@wynding/*` into
// `apps/server/node_modules`, not into the repo root's.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRulesetJson, rulesetDigest } from '@wynding/sim';

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
  return jsText.slice(openIdx + 1, closeIdx);
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

// --- Leg 1c: locate the packaged server ruleset -----------------------------------
const serverHandlerPath = path.join(REPO_ROOT, 'apps/server/dist/handler.js');
if (!existsSync(serverHandlerPath)) {
  fail(`missing server build output: ${serverHandlerPath} does not exist`);
}
const serverRulesetPath = path.join(
  REPO_ROOT,
  'packages/content/dist/rulesets',
  `${RULESET_ID}.json`,
);
if (!existsSync(serverRulesetPath)) {
  fail(
    `missing packaged server ruleset: ${serverRulesetPath} does not exist — ` +
      "packages/content's build script did not copy dist/rulesets/ (the Codex PR #66 P1 regression).",
  );
}
const serverText = readFileSync(serverRulesetPath, 'utf8');

// --- Leg 1d: compare BYTES ---------------------------------------------------------
if (clientText !== serverText) {
  let firstDiff = 0;
  const minLen = Math.min(clientText.length, serverText.length);
  while (firstDiff < minLen && clientText[firstDiff] === serverText[firstDiff]) firstDiff++;
  fail(
    'byte mismatch between the client-bundled ruleset and the packaged server ruleset:\n' +
      `  client bundle (${clientBundlePath}): ${String(clientText.length)} bytes\n` +
      `  server package (${serverRulesetPath}): ${String(serverText.length)} bytes\n` +
      `  first differing offset: ${String(firstDiff)}`,
  );
}

// --- Leg 1e: compare rulesetHash ---------------------------------------------------
const clientHash = rulesetDigest(parseRulesetJson(clientText));
const serverHash = rulesetDigest(parseRulesetJson(serverText));
if (clientHash !== serverHash) {
  fail(`rulesetHash mismatch: client=${clientHash} server=${serverHash}`);
}

console.log('\ncheck:artifact-parity — PASS');
console.log(`  client bundle:  ${clientBundlePath} (${String(clientText.length)} bytes)`);
console.log(`  server package: ${serverRulesetPath} (${String(serverText.length)} bytes)`);
console.log(`  rulesetHash:    ${clientHash}\n`);
