#!/usr/bin/env node
// sync-perf.mjs — stage the PERF artifact into the Android project (#148).
//
// WHY A SCRIPT AND NOT `cap sync`. The Capacitor CLI has no `--config` flag (verified
// against `cap sync --help` / `cap copy --help` on Capacitor 8.5), so there is no way to
// point `cap` at `capacitor.perf.config.ts`. What `cap copy android` does for our purposes
// is two file operations — stage `webDir` into `app/src/main/assets/public`, and write
// `capacitor.config.json` beside it — and both are reproduced here, reading their values
// FROM the perf config so the variant is declared once rather than twice.
//
// `cap update` is deliberately NOT reproduced: it regenerates the Gradle plugin includes,
// which are identical for both variants (same plugins, same versions) and are committed.
// The play `sync:android` is what maintains them.
//
// THE PAYLOAD SLOT IS SHARED with the play build, and the pairing is enforced by the
// COMMANDS rather than by discipline: `perf:android` runs this and then assembles the perf
// build type; `release:android` runs `cap sync android` and then assembles release. Neither
// can package the other's leftovers, because each stages its own artifact first.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, '..');
const CONFIG = join(MOBILE, 'capacitor.perf.config.ts');

/** Read one single-quoted top-level string from the perf config.
 *
 *  A regex rather than a TS import, for the same reason `check-native-invariants.mjs` uses
 *  one: this runs under plain `node` with no loader. The PARSE is asserted, never assumed —
 *  a config these patterns cannot read fails loudly here instead of silently staging the
 *  wrong directory, which is the failure mode ADR 0013 exists to narrow. */
function readConfigString(source, key) {
  const match = new RegExp(`${key}:\\s*'([^']+)'`).exec(source);
  if (match === null) {
    throw new Error(
      `sync-perf: could not read \`${key}: '...'\` from capacitor.perf.config.ts. ` +
        `This script stages what that file declares; it must not guess.`,
    );
  }
  return match[1];
}

if (!existsSync(CONFIG)) throw new Error(`sync-perf: missing ${CONFIG}`);
const source = readFileSync(CONFIG, 'utf8');

const appId = readConfigString(source, 'appId');
const appName = readConfigString(source, 'appName');
const webDir = readConfigString(source, 'webDir');
const debugging = /webContentsDebuggingEnabled:\s*true/.test(source);

const payload = resolve(MOBILE, webDir);
if (!existsSync(join(payload, 'index.html'))) {
  throw new Error(
    `sync-perf: ${payload} has no root index.html. Build it first:\n` +
      `  pnpm --filter @wynding/web run build:perf`,
  );
}

const assets = join(MOBILE, 'android', 'app', 'src', 'main', 'assets');
const publicDir = join(assets, 'public');
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
cpSync(payload, publicDir, { recursive: true });

const runtimeConfig = { appId, appName, webDir };
if (debugging) runtimeConfig.android = { webContentsDebuggingEnabled: true };
writeFileSync(join(assets, 'capacitor.config.json'), `${JSON.stringify(runtimeConfig, null, 2)}\n`);

console.log(`✓ staged the perf artifact (${webDir}) into android/app/src/main/assets/public`);
console.log(
  `  appId ${appId} (+ the .perf build-type suffix), WebView debugging ${String(debugging)}`,
);
console.log(`  next: pnpm --filter @wynding/mobile run perf:android`);
