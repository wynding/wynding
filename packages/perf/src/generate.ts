#!/usr/bin/env -S tsx
// generate.ts — regenerates the two committed stress-scene replays in one command.
//
// `rulesetHash` and `simVersion` are stamped into every `Replay` envelope (see
// `scenario.ts`), so ANY `simVersion` bump or any change to the stress bundle's content
// invalidates both committed JSON files — and M2 has six more bumps left (S5–S10) after
// this story. Without this script, keeping the committed replays current would mean
// hand-editing two JSON files (with a SHA-256 hex hash inside them) after every bump;
// with it, it's `pnpm -C packages/perf run gen:scenario` followed by `git diff`
// to see what changed. `scenario.test.ts` is what turns "forgot to run this" into a
// failing test, by deep-equaling the committed files against what the builders produce
// right now.
//
// This file is excluded from the coverage gate (see `vitest.config.ts`) — it is a thin
// CLI wrapper around `buildStressReplay`/`buildControlReplay`, both of which are
// covered directly by `scenario.test.ts`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRulesetJson } from '@wynding/sim';
import { STRESS_RULESET_URL } from '@wynding/content/stress';
import { buildStressReplay, buildControlReplay } from './scenario';

const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');

// The genuine load path — `readFileSync` + `parseRulesetJson` — is the same one
// `stress.test.ts` and any real consumer uses. No bespoke JSON.parse: a bundle that
// fails structural validation must fail here too, not just at test time.
const text = readFileSync(STRESS_RULESET_URL, 'utf8');
const bundle = parseRulesetJson(text);

const stressReplay = buildStressReplay(bundle);
const controlReplay = buildControlReplay(bundle);

writeFileSync(
  join(scenariosDir, 'stress-40x40.replay.json'),
  JSON.stringify(stressReplay, null, 2) + '\n',
);
writeFileSync(
  join(scenariosDir, 'control-40x40.replay.json'),
  JSON.stringify(controlReplay, null, 2) + '\n',
);

console.log(`Wrote ${join(scenariosDir, 'stress-40x40.replay.json')}`);
console.log(`Wrote ${join(scenariosDir, 'control-40x40.replay.json')}`);
