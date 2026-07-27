#!/usr/bin/env node
// install-git-hooks.mjs — run by `pnpm install` (the root `prepare` script) to point git at the
// repo's tracked hooks: `core.hooksPath = .githooks`. That is what makes the pre-push QC gate
// (docs/ai-workflow.md §3.5) arrive with a clone instead of with a setup instruction nobody reads.
//
// A tarball install or a checkout that is not a git repo is not an error — there is nothing to
// wire, so say so and exit 0 rather than failing everyone's install.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const HOOKS_PATH = '.githooks';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// `git rev-parse` walks upward, so an unpacked source tarball sitting inside someone else's
// repository would otherwise rewire *that* repository's hooks. Only wire our own checkout.
let toplevel = null;
try {
  toplevel = realpathSync(git('rev-parse', '--show-toplevel'));
} catch {
  toplevel = null;
}
if (toplevel === null || toplevel !== realpathSync(process.cwd())) {
  console.log('· not a git checkout — skipping git hook setup');
  process.exit(0);
}

let current = '';
try {
  current = git('config', '--get', 'core.hooksPath');
} catch {
  current = ''; // unset
}

if (current === HOOKS_PATH) {
  console.log(`✓ git hooks already wired (core.hooksPath = ${HOOKS_PATH})`);
  process.exit(0);
}

if (current !== '') {
  // Someone (or another tool) owns this setting — say so rather than silently taking it over.
  console.warn(`⚠️  core.hooksPath is set to '${current}', not '${HOOKS_PATH}'.`);
  console.warn(
    `   The pre-push QC gate will not run. To use it: git config core.hooksPath ${HOOKS_PATH}`,
  );
  process.exit(0);
}

try {
  git('config', 'core.hooksPath', HOOKS_PATH);
  console.log(`✓ git hooks wired (core.hooksPath = ${HOOKS_PATH})`);
} catch (err) {
  console.warn(`⚠️  could not set core.hooksPath: ${err.message}`);
}
