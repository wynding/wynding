#!/usr/bin/env node
// clean-turbo-cache.mjs — purge the LOCAL turbo cache (and the per-package `.turbo` log
// dirs) as part of `pnpm run clean`.
//
// Why `pnpm run clean` needs this at all: turbo captures a task's declared `outputs`
// glob WHOLESALE, and it does not empty the output directory first. So a `dist/` that
// still holds files from an earlier configuration — the 60 compiled `*.test.js` that
// #108's `tsconfig.base.json` exclude stopped producing, say — gets vacuumed into the
// NEW cache entry, and every later cache hit faithfully restores them. Deleting the
// stale files by hand does not help: the next cache hit puts them straight back. The
// entries themselves have to go, once, and then the freshly-built ones are clean
// forever. (This is hygiene only. Nothing consumes `dist/` except the server artifact,
// which esbuild bundles from source, and CI always starts cold.)
//
// The alternative — making every build `rm -rf dist` first — taxes every build in the
// repo forever to fix a one-time local mess. This runs when someone asks for a clean.
//
// WHERE the cache lives: `<repo root>/.turbo/cache`, where turbo's "repo root" is the
// GIT root, not the working directory. In a linked worktree those differ — `.git` is a
// file pointing at the main checkout — and a plain `rm -rf .turbo` in the worktree
// deletes nothing while the real cache sits in the main repo. `git rev-parse
// --git-common-dir` resolves both cases, so this removes the cache the running turbo
// would actually read.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The `.turbo` directory turbo itself would use: beside the git common dir, falling
 *  back to this checkout when git is unavailable (a source tarball, a sandbox). */
function turboCacheRoot() {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return REPO_ROOT;
  const gitCommonDir = path.resolve(REPO_ROOT, result.stdout.trim());
  return path.dirname(gitCommonDir);
}

const removed = [];
function remove(target) {
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
  removed.push(path.relative(REPO_ROOT, target) || target);
}

remove(path.join(turboCacheRoot(), '.turbo'));
// This checkout's own `.turbo`, when it is not the one above (worktree), plus the
// per-package `.turbo/turbo-<task>.log` dirs turbo writes beside each package.
remove(path.join(REPO_ROOT, '.turbo'));
for (const group of ['packages', 'apps']) {
  const groupDir = path.join(REPO_ROOT, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir)) {
    const candidate = path.join(groupDir, entry, '.turbo');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) remove(candidate);
  }
}

console.log(
  removed.length === 0
    ? 'clean-turbo-cache: nothing to remove'
    : `clean-turbo-cache: removed ${String(removed.length)} path(s)\n  ${removed.join('\n  ')}`,
);
