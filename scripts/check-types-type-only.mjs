#!/usr/bin/env node
// check-types-type-only.mjs — guards @wynding/types' core invariant: the package
// stays TYPE ONLY. Its emitted `dist/index.js` must be nothing but `export {};` —
// the moment a runtime value (a helper function, a const, anything with a value)
// is added, this fails. Nothing else enforces that today: `--passWithNoTests`
// keeps `vitest run` green for a package with zero test files (load-bearing, not
// laxity — `vitest run` with no test files exits 1 on its own — see #113), so a
// runtime addition would otherwise ship with no tests and no coverage gate,
// silently.
//
// Follows the check:artifact-parity precedent (apps/server/scripts/check-artifact-parity.ts):
// a standalone script that builds its target itself rather than trusting turbo's
// task graph. `turbo run typecheck lint test`'s `test` task depends only on
// `^typecheck` (see turbo.json), not `^build` — a turbo-orchestrated version of
// this check would read a stale or absent dist/index.js. Building here, once,
// keeps the check honest without adding a build dependency to the turbo test task.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, 'packages', 'types');
const DIST_INDEX = join(PKG_DIR, 'dist', 'index.js');

function fail(message) {
  console.error(`❌ check:types-type-only failed: ${message}`);
  process.exit(1);
}

// CLEAN FIRST. `tsc -b` does not remove the outputs of a source file that was deleted or
// renamed, so an orphaned `dist/gone.js` survives indefinitely — and this check, which
// scans everything under `dist`, would then fail `verify` over a module whose source no
// longer exists. That is a false positive with no action the developer can take except
// guessing that `dist` is stale (verified by Codex on #113's PR). Removing `dist` makes the
// scan describe the CURRENT sources and nothing else; the package is tiny, so a full
// rebuild costs nothing. One `rmSync` is all it takes because this package's build info goes
// INSIDE that directory (`packages/types/tsconfig.json` sets
// `"tsBuildInfoFile": "dist/.tsbuildinfo"`); a second call for a root `tsconfig.tsbuildinfo`
// stood here and never deleted anything, because tsc never wrote one (Codex, #111's PR).
rmSync(join(PKG_DIR, 'dist'), { recursive: true, force: true });

const build = spawnSync('pnpm', ['-C', PKG_DIR, 'run', 'build'], { stdio: 'inherit' });
if (build.status !== 0) {
  fail(`packages/types build failed (exit ${String(build.status)}) — cannot check its emit.`);
}

if (!existsSync(DIST_INDEX)) {
  fail(`${DIST_INDEX} does not exist after build.`);
}

// EVERY emitted module, not just the entry point. Checking `dist/index.js` alone would
// announce the invariant held while a runtime `dist/sneaky.js` sat beside it — measured,
// that is exactly what an earlier draft of this script did. The package only `exports`
// ".", so such a module is not importable by package name today, but "not reachable
// through the current exports map" is a much weaker promise than "this package emits no
// runtime code", and the latter is what the header claims and what the missing coverage
// gate makes load-bearing.
/** Every file under `dir` whose name matches `re`. One walker: a fix to the traversal
 *  (symlinks, `withFileTypes`, an ignore) then lands once instead of half-landing. */
function filesUnder(dir, re) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, re));
    else if (re.test(entry)) out.push(full);
  }
  return out;
}

// Every JS extension tsc can emit, not just `.js`: a `.mts` source emits `.mjs` and a
// `.cts` emits `.cjs`, and a scan collecting only `.js` reported success while a
// runtime-bearing `.mjs` sat beside it unchecked (Codex, #113's PR).
const EMITTED_JS = /\.(js|mjs|cjs)$/;
const EMITTED_DTS = /\.d\.(ts|mts|cts)$/;

// COMMENTS ARE NOT CONTENT. tsc PRESERVES a `/* ... */` header from the source into the emit
// and appends a `//# sourceMappingURL` line, and a scan reading raw text counts that prose as
// runtime code (Codex, #113's PR).
//
// Used by the JS arm ONLY. It is a string-blind regex — `'/*'` inside a string literal opens a
// comment it cannot see — and that blindness was a live escape while the `.d.ts` arm shared it:
// `export type A = '/*'` … `export type B = '*/'` deleted an `export declare enum` sitting
// between them. That arm now parses instead (see `valueDeclarations`), which is the real fix.
// Here the blindness is harmless in the only direction that matters: this arm demands the body
// equal EXACTLY `export {};`, so mangled input fails the comparison rather than passing it.
// Fail-closed, and deliberately left simple.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\S\n]*\/\/.*$/gm, '');
}

// Comments and blank lines removed, what's left must be exactly the one runtime statement a
// type-only module emits.
function runtimeBody(file) {
  return stripComments(readFileSync(file, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
}

// WHAT THIS SCRIPT IS, AND IS NOT. It proves `@wynding/types` ships no runtime code by
// the two routes a consumer can actually reach: emitted JavaScript, and value-space
// declarations in the emitted types. It is a REGRESSION guard, not a proof — like the
// determinism lint zone, the set of ways to occupy value space is open, and successive
// review rounds on #113 each named another (a runtime `export const`, a `.mts` emitting
// `.mjs`, an `export declare const`, an `export declare namespace`). Add arms here as
// they are noticed; a newly-named one is an addition, not a defect in this check.
//
// The property that does NOT depend on enumeration: `dist/index.js` being exactly
// `export {};` means nothing this package emits can execute. Everything else here guards
// the types LYING about that — declarations a consumer can import against and that then
// are not there at runtime.

// The EMITTED JS is only half the invariant. `export declare const x: string` emits
// nothing at all — dist/index.js stays `export {};` — while the .d.ts advertises a value
// in the value space, so a consumer can import and use it and the package stops being
// type-only in the only sense that matters to callers. (Caught by Codex on #113's PR,
// verified: the JS-only form of this check reported success on exactly that input.)
// EXPORTED value-space declarations only, and that is the structural point rather than a
// concession. The invariant is about what a CONSUMER can reach: a non-exported
// `declare const brand: unique symbol` is the idiomatic way to key a branded type, emits
// no JavaScript, and cannot be imported — flagging it would fail a legitimately type-only
// package (Codex, #113's PR; the third false positive this check produced, and the one
// that showed the earlier arms were matching the wrong property). Requiring `export`
// removes that whole class instead of adding another exception for each shape of it.
//
// THIS ARM PARSES; IT DOES NOT MATCH TEXT. That is a reversal, and the evidence for it is
// specific rather than aesthetic. Four rounds of regex refinement on this check each closed one
// spelling and opened another, and the two most recent are the argument:
//
//   - Requiring an `export` prefix (added to kill a false positive on the branded-symbol idiom)
//     made `declare global { … }` and `declare module 'node:fs' { … }` invisible, because tsc
//     emits augmentations WITHOUT that prefix and strips `export` from their members. A package
//     could augment its own name — `declare module '@wynding/types' { export const x: number }` —
//     and this check would certify it type-only.
//   - `stripComments` (added to kill a false positive on a doc comment quoting a declaration) is
//     string-blind, so `export type A = '/*'` … `export type B = '*/'` deletes everything between
//     them, an `export declare enum` included.
//
// Both were measured end to end: a consumer importing the resulting phantom bindings compiled
// with `tsc` exit 0 and then died at runtime with `TypeError: Cannot read properties of
// undefined` — the exact lie this script exists to prevent, certified clean by it. (Adversarial
// review on #111's PR.) A guard that must strip comments to avoid false positives, in a language
// whose strings can contain comment delimiters, has the wrong substrate.
//
// So the question — "does this `.d.ts` declare anything a consumer can import as a VALUE?" — is
// handed to the parser that owns it. This is deliberately NOT the module-graph mistake made
// elsewhere in this PR: that question needed the bundler and no amount of parsing would have
// answered it, whereas this one is purely syntactic, single-file, and needs no type checker, no
// resolution, and no new dependency (`typescript` is already installed and already spawned to
// build this package). Comments and string literals stop being hazards because the parser knows
// what they are, and a namespace body becomes inspectable instead of guessed at.
const VALUE_STATEMENT = new Set([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.EnumDeclaration,
]);

const isExported = (node) =>
  (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Does this namespace/module body introduce anything that exists at runtime? Members are counted
 *  whether or not they carry `export`: inside an ambient block tsc omits the keyword, and counting
 *  them is the safe side. */
function bodyDeclaresValue(node) {
  // A DOTTED namespace nests through its BODY, not through a block. `namespace A.B { … }` parses
  // as A whose `body` is another ModuleDeclaration, so `body.statements` is `undefined` and the
  // whole form read as empty — `export declare namespace ZA.ZB { const smuggled: number }` shipped
  // a phantom binding that a consumer compiled against (tsc exit 0) and then crashed on at runtime
  // (adversarial review, #111's PR). Braced nesting was always handled; only this spelling was not.
  if (node.body !== undefined && ts.isModuleDeclaration(node.body))
    return bodyDeclaresValue(node.body);
  return (node.body?.statements ?? []).some(
    (s) =>
      VALUE_STATEMENT.has(s.kind) ||
      s.kind === ts.SyntaxKind.ExportAssignment ||
      (ts.isModuleDeclaration(s) && bodyDeclaresValue(s)),
  );
}

/** Every value-space binding this `.d.ts` puts within a consumer's reach, as printable text. */
function valueDeclarations(file, text) {
  const found = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // A PARSE ERROR MUST NOT READ AS "no values declared". `createSourceFile` never throws — it
  // recovers, and recovery can swallow whole declarations (an unterminated `interface {` absorbs
  // the `export declare const` after it). Unreachable today, since this scans emit that tsc has
  // just produced from a successful build, but a scan that examines nothing and reports success is
  // precisely this script's own stated failure mode, so it fails closed instead.
  if (source.parseDiagnostics?.length > 0) {
    fail(
      `${file} did not parse cleanly, so its value-space scan cannot be trusted:\n` +
        // `messageText` is a DiagnosticMessageChain for chained errors, which prints as
        // `[object Object]` — flatten it or the one diagnostic a reader needs is unreadable.
        `   ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, ' ')}`,
    );
  }
  // `getStart` rather than `node.pos`: the latter begins at the node's leading trivia, so a
  // declaration carrying a doc comment reported the COMMENT as the offending line.
  const record = (node, why) =>
    found.push(`${why}: ${text.slice(node.getStart(source), node.end).trim().split('\n')[0]}`);

  for (const node of source.statements) {
    if (VALUE_STATEMENT.has(node.kind) && isExported(node)) {
      record(node, 'exported value declaration');
    } else if (ts.isImportEqualsDeclaration(node) && isExported(node)) {
      // `export import X = Y` aliases whatever Y is, values included, and names none of the
      // keywords a text scan would look for.
      record(node, 'exported import-equals alias');
    } else if (ts.isExportAssignment(node)) {
      record(node, 'export assignment'); // `export = X` / `export default X`
    } else if (ts.isModuleDeclaration(node)) {
      if (node.flags & ts.NodeFlags.GlobalAugmentation) {
        // `declare global` needs no export to reach a consumer — it reaches EVERY consumer.
        record(node, 'global augmentation');
      } else if (ts.isStringLiteral(node.name)) {
        // `declare module 'x'` augments another module (or this one). A dependency-free
        // vocabulary package has no business doing that at all, so the container is the
        // offence and the body does not need inspecting.
        record(node, 'module augmentation');
      } else if (isExported(node) && bodyDeclaresValue(node)) {
        // A plain namespace is flagged only when it actually holds values — the check the old
        // regex could not make, and the reason `export declare namespace N { type T = string }`
        // used to be a standing false positive.
        record(node, 'exported namespace holding values');
      }
    }
  }
  return found;
}

// Deliberately NOT flagged here: a bare `export { x }` re-export. Whether `x` is a type or a
// value is not decidable from this file alone, and flagging it would red every type re-export.
// It needs no arm — `verbatimModuleSyntax` emits the re-export into `dist/index.js`, so the JS
// arm above fails on it. Measured, along with `export default <a value>` and a re-exported
// ambient enum; an earlier comment here claimed that form was an unguarded residual, and it
// was simply wrong.
//
// Also deliberately not counted: an `export import X = Y` sitting INSIDE a namespace body.
// Whether `Y` names a type or a value needs a type checker, and counting it flagged
// `declare namespace Pub { export import T = Internal.T }` — the idiomatic way to re-export a
// type from a namespace, which emits no JS whatsoever (adversarial review, #111's PR). Erring
// the other way is the deliberate choice this file has now made three times: a guard that reds
// correct code is worse than one with a stated gap. The gap is narrow — a namespace holding a
// real VALUE alias is instantiated, so tsc emits JS for it and the JS arm fires; only the
// ambient (`declare namespace`) spelling of a value alias would slip, and this package declares
// no namespaces at all. The top-level `export import` above IS still flagged, and costs nothing:
// `verbatimModuleSyntax` rejects that form at build (TS1269/TS1288) before it can reach here.

// A FLOOR, because zero files scanned is not a pass. The JS arm has `existsSync(DIST_INDEX)`
// above and so cannot silently examine nothing; this arm had no equivalent, and if
// declaration emit were ever turned off in `tsconfig.base.json` — or the declarations landed
// outside `dist` — it would report success having read no file at all (Codex, #111's PR).
// Silent under-coverage is the exact failure this script exists to catch, so it must not be
// this script's own failure mode.
const declarationFiles = filesUnder(join(PKG_DIR, 'dist'), EMITTED_DTS);
if (declarationFiles.length === 0) {
  fail(
    `no .d.ts files under ${join(PKG_DIR, 'dist')} after a successful build — the value-space\n` +
      '   check would have scanned nothing and passed. Has `declaration` been turned off, or\n' +
      '   the declaration output moved out of `dist`?',
  );
}

const declaring = declarationFiles
  .map((file) => ({ file, hits: valueDeclarations(file, readFileSync(file, 'utf8')) }))
  .filter(({ hits }) => hits.length > 0);

if (declaring.length > 0) {
  fail(
    '@wynding/types declares runtime values in its .d.ts — it is meant to stay type-only.\n' +
      declaring
        .map(({ file, hits }) => `   ${file}:\n${hits.map((h) => `     ${h}`).join('\n')}`)
        .join('\n') +
      '\n   (These emit no JS, so the dist/*.js check above cannot see them — but a consumer\n' +
      '   can still import and call them.)',
  );
}

// THE TWO SHAPES AN EMPTY MODULE COMPILES TO — which one tsc writes is decided by the module
// FORMAT, not by the source being empty. An ESM emit (`.js` from `.ts`, `.mjs` from `.mts`) is
// `export {};`; a CommonJS emit (`.cjs` from a `.cts`) is the `"use strict"` + `__esModule`
// scaffold instead. Comparing against the ESM form alone meant a perfectly type-only `.cts` was
// reported as "emits runtime code" while its own `.d.cts` declared nothing at all — so the
// package simply could not contain a `.cts`, whatever was in it (Codex, #111's PR).
//
// All three emissions were measured rather than reasoned about, which is what showed `.mjs`
// needs no entry of its own: it emits the identical ESM string.
//
// Still an EXACT comparison, against a closed set of two. That exactness is what makes this arm
// unforgeable — one extra statement of any kind fails it — and if a future tsc changes its
// scaffold, this fails CLOSED on a real build rather than quietly admitting something.
const EMPTY_MODULE_BODIES = new Set([
  'export {};',
  '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });',
]);

const emitted = filesUnder(join(PKG_DIR, 'dist'), EMITTED_JS);
const offenders = emitted
  .map((file) => ({ file, body: runtimeBody(file) }))
  .filter(({ body }) => !EMPTY_MODULE_BODIES.has(body));

if (offenders.length > 0) {
  fail(
    `@wynding/types emits runtime code — it is meant to stay type-only.\n` +
      offenders.map(({ file, body }) => `   ${file}:\n   ${body}`).join('\n'),
  );
}

// Both counts, because a success line naming only one arm cannot distinguish "the other arm
// found nothing wrong" from "the other arm read nothing at all".
console.log(
  `✓ @wynding/types emits only empty modules across all ${String(emitted.length)} emitted module(s), ` +
    `and declares no value-space exports across ${String(declarationFiles.length)} .d.ts file(s) (still type-only).`,
);
