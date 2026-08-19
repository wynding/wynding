#!/usr/bin/env node
// assert-no-forwarded-args.mjs — refuse to run an aggregate script that was handed arguments.
//
// WHY THIS EXISTS. `build` runs two Vite builds (`build:web` → `dist`, the deployed open web;
// `build:host` → `dist-host`, the Host build the native apps package). pnpm forwards a script's
// arguments by APPENDING them to the end of its command line, so `pnpm run build --base=/play/`
// becomes `pnpm run build:web && pnpm run build:host --base=/play/`: the flag reaches only the
// LAST build — precisely the one that must never carry a base, because Capacitor serves from the
// WebView root — while `dist`, the artifact served under `/play/`, is built without it and every
// asset href 404s. Both halves wrong, exit code 0, no warning. PLAN.md item 6 states the rule
// ("the aggregate must never be the target of forwarded arguments"); this makes breaking it loud.
//
// HOW IT DETECTS THEM. The appended text is visible in `npm_lifecycle_script`, which pnpm sets to
// the command line it is about to run — the declared script string plus whatever the caller
// passed (including a `--` separator, which `pnpm run` forwards verbatim and Vite's parser then
// discards). Comparing that against the declared script catches the arguments BEFORE the first
// build runs, which this script's own `process.argv` cannot do: the append lands on the last
// command in the chain, never on this one. Both are checked anyway — argv costs one condition and
// covers a runner that passes arguments through directly.
//
// FAILS OPEN, ON PURPOSE. Anything unexpected — no env var, a command line that is not the
// declared script plus a suffix — reports nothing rather than failing, so a future runner that
// composes scripts differently cannot break the build here. CONTRIBUTING.md carries the rule for
// humans; this is a guard over it, not the only line of defence.

import { readFileSync } from 'node:fs';

/** The arguments the caller appended to this script's command line, or '' if there are none. */
function forwardedArgs() {
  if (process.argv.length > 2) return process.argv.slice(2).join(' ');

  const event = process.env.npm_lifecycle_event;
  const running = process.env.npm_lifecycle_script;
  if (!event || !running) return '';

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = pkg.scripts?.[event];
  if (typeof declared !== 'string' || !running.startsWith(declared)) return '';

  return running.slice(declared.length).trim();
}

const forwarded = forwardedArgs();

if (forwarded) {
  const script = process.env.npm_lifecycle_event ?? 'this script';
  console.error(
    `Refusing to run \`${script}\`: it does not accept arguments, and received: ${forwarded}\n` +
      '\n' +
      'It runs more than one build, and pnpm appends arguments to the LAST command only — so a\n' +
      'flag passed here lands on the wrong artifact, silently. Build one artifact at a time,\n' +
      'calling Vite directly (a `--` separator is passed through to Vite, which ignores it):\n' +
      '\n' +
      '  pnpm --filter @wynding/web run build:web --base=/play/   # dist, the deployed web build\n' +
      '  pnpm --filter @wynding/web run build:host                # dist-host, the Host build\n',
  );
  process.exit(1);
}
