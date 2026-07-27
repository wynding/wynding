#!/usr/bin/env node
// check-glossary-terms.mjs — the CONTEXT.md terminology gate (the check-dependabot-config.mjs
// pattern: no workspace owns `docs/`, so the root `verify` script is the only place this runs).
//
// Reads the `_Avoid_:` lines out of docs/CONTEXT.md and fails (exit 1) if an avoided term
// appears in the docs that carry Wynding's game vocabulary. The point is to keep mechanical
// vocabulary drift out of code review: a grep can settle "projectile → tracer", so it should,
// rather than costing review rounds.
//
// Ordinary English collides with the glossary ("hit points", "flow-field", "core loop"), so
// every different-sense allowance lives in scripts/glossary-lint.config.json — data, with a
// stated reason per entry. Config, never a code edit, and never a silent skip: an exception
// that stops matching anything is reported as dead and must be deleted.
//
// COMPLETENESS BOUNDARY. This is a grep with a prose mask, not a Markdown parser, and it
// deliberately stays one. It handles the constructs these docs use: fenced blocks (including
// inside a blockquote), inline code spans — of any backtick run, and carried across a line break
// for the one- and two-backtick forms the docs actually use — link and reference-definition
// destinations, bare URLs, emphasis. It does NOT model the rest of Markdown: an indented
// (four-space) code block is scanned as prose, an unmatched run of three or more backticks is
// scanned as prose, and a bare relative reference destination that reads like a sentence is
// scanned rather than masked. Deeper corners of the spec will mis-mask a line, and the honest
// statement is that this is bounded rather than impossible: a span is never carried past a blank
// line, a fence, or the end of a file without being reported, so a mis-mask costs one line or one
// paragraph, never a file. What it buys is the mechanical class — "projectile" for "tracer" —
// which is the whole job. If the docs ever grow Markdown this cannot read, take a real parser
// deliberately rather than teaching this one more corners.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GLOSSARY = 'docs/CONTEXT.md';
const CONFIG_PATH = join(HERE, 'glossary-lint.config.json');

const errors = [];
const fail = (msg) => errors.push(msg);
const posix = (p) => p.split(sep).join('/');

// ---------------------------------------------------------------- config

const CONFIG_KEYS = new Set(['note', 'include', 'ignoredTerms', 'allowedSenses']);
const IGNORED_KEYS = new Set(['term', 'why']);
const ALLOWED_KEYS = new Set(['term', 'pattern', 'files', 'why']);

// The one way this check reports failure — including config mistakes, which are the one
// interaction it asks of an author, so they read as findings rather than as a stack trace.
const die = (msg) => {
  console.error('❌ glossary terminology check failed:');
  for (const e of msg === undefined ? errors : [...errors, msg]) console.error(`   - ${e}`);
  process.exit(1);
};

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  die(`config: could not read/parse ${posix(relative(ROOT, CONFIG_PATH))} — ${err.message}`);
}
for (const key of Object.keys(config)) {
  if (!CONFIG_KEYS.has(key)) fail(`config: unknown top-level key '${key}'`);
}
for (const key of ['include', 'ignoredTerms', 'allowedSenses']) {
  if (!Array.isArray(config[key])) die(`config: '${key}' must be an array`);
}
const checkEntry = (entry, i, list, allowed, required) => {
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) fail(`config: ${list}[${i}] has unknown key '${key}'`);
  }
  for (const key of required) {
    if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
      fail(`config: ${list}[${i}] needs a non-empty '${key}'`);
    }
  }
  if (
    'files' in entry &&
    (!Array.isArray(entry.files) || entry.files.some((f) => typeof f !== 'string'))
  ) {
    fail(`config: ${list}[${i}] 'files' must be an array of paths`);
  }
};
config.ignoredTerms.forEach((e, i) =>
  checkEntry(e, i, 'ignoredTerms', IGNORED_KEYS, ['term', 'why']),
);
config.allowedSenses.forEach((e, i) =>
  checkEntry(e, i, 'allowedSenses', ALLOWED_KEYS, ['term', 'pattern', 'why']),
);
if (errors.length > 0) die('config: fix the entries above, then re-run');

// ---------------------------------------------------------------- glossary

// A glossary entry is `**Term**…:` followed by its definition and one `_Avoid_:` line listing
// the words that entry claims. Parentheticals are the glossary's own asides ("(that's a creep
// stat)"), not terms.
const avoided = new Map(); // avoided term (lowercase) -> the canonical terms that claim it
let canonical = null;
for (const line of readFileSync(join(ROOT, GLOSSARY), 'utf8').split('\n')) {
  const heading = line.match(/^\*\*(.+?)\*\*/);
  if (heading) canonical = heading[1];
  const avoid = line.match(/^_Avoid_:\s*(.+)$/);
  if (!avoid) continue;
  if (!canonical) {
    fail(`${GLOSSARY}: an _Avoid_ line appears before any **term** heading`);
    continue;
  }
  const listed = avoid[1].replace(/\([^)]*\)/g, '').replace(/\.\s*$/, '');
  // Commas separate terms; a slash separates alternatives inside one ("high/medium/low" is
  // three words the entry rejects, not one literal string nobody would ever type).
  for (const raw of listed.split(/[,/]/)) {
    const term = raw.trim().toLowerCase();
    // Several entries claim the same word — "level" belongs to Board, Wave and Difficulty
    // tier — so the report has to offer every canonical rather than the last one parsed.
    if (term) avoided.set(term, (avoided.get(term) ?? new Set()).add(canonical));
  }
}
if (avoided.size === 0)
  fail(`${GLOSSARY}: no _Avoid_ lines found — has the glossary format changed?`);

for (const { term } of [...config.ignoredTerms, ...config.allowedSenses]) {
  if (!avoided.has(term.toLowerCase())) {
    fail(`config: '${term}' is not an avoided term in ${GLOSSARY} (stale exception — delete it)`);
  }
}

const ignored = new Set(config.ignoredTerms.map((e) => e.term.toLowerCase()));
const linted = [...avoided.keys()].filter((t) => !ignored.has(t));

// ---------------------------------------------------------------- files

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = [];
for (const target of config.include) {
  const abs = join(ROOT, target);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    fail(`config: include target '${target}' does not exist`);
    continue;
  }
  files.push(...(stat.isDirectory() ? walk(abs) : [abs]));
}
files.sort();

// Prose only: fenced blocks, inline code, and link destinations carry identifiers and paths
// (`packages/engine`, flow-field.md) that are not prose usage. Emphasis markers are blanked so a
// sense pattern can span them ("the wave **launches**"). Replacements preserve column offsets.
const blank = (m) => ' '.repeat(m.length);

// Inline code hides identifiers and literals from the scan. A span may be delimited by any run of
// backticks (``a `literal` inside``), so the closing run has to match the opening one — and it may
// close on a later line, as the glossary's own `{ seed, … }` span does. `span` carries that state:
// null outside a span, otherwise the open run's length. An opener that never closes is reported,
// so a stray backtick cannot quietly swallow the rest of a file.
function maskCodeSpans(line, span) {
  // A backslash-escaped backtick is literal text — but only outside a span. Inside one, Markdown
  // takes backslashes literally, so `` `foo\` `` really does end there.
  const escaped = (i) => {
    let slashes = 0;
    while (line[i - 1 - slashes] === '\\') slashes += 1;
    return slashes % 2 === 1;
  };
  const runAt = (i, insideSpan = false) => {
    if (line[i] !== '`' || (!insideSpan && escaped(i))) return 0;
    let n = 0;
    while (line[i + n] === '`') n += 1;
    return n;
  };
  let out = '';
  let i = 0;
  if (span.open !== null) {
    // Inside a span from an earlier line: everything up to a run of the same length is code.
    for (; i < line.length;) {
      const run = runAt(i, true);
      if (run === span.open) {
        i += run;
        span.open = null;
        break;
      }
      i += run === 0 ? 1 : run;
    }
    out += ' '.repeat(i);
    if (span.open !== null) return out; // the span runs past this line too
  }
  for (; i < line.length;) {
    const open = runAt(i);
    if (open === 0) {
      out += line[i];
      i += 1;
      continue;
    }
    let close = -1;
    for (let j = i + open; j < line.length;) {
      const run = runAt(j, true);
      if (run === open) {
        close = j;
        break;
      }
      j += run === 0 ? 1 : run;
    }
    // No closing run on this line. One or two backticks is a span continuing onto the next line
    // (the glossary has one). A longer run is a fence marker that landed in prose — indented past
    // a fence's three columns, say — and must not open a span that swallows the rest of the file.
    if (close === -1) {
      if (open > 2) {
        out += line.slice(i, i + open);
        i += open;
        continue;
      }
      span.open = open;
      out += ' '.repeat(line.length - i);
      return out;
    }
    out += ' '.repeat(close + open - i);
    i = close + open;
  }
  return out;
}

function maskProse(text, isGlossary, rel) {
  let fence = null; // the open fence's marker character and length
  const span = { open: null }; // an inline code span's run length, while one is open
  const lines = text.split('\n').map((line) => {
    // Fences count inside a blockquote too, so match against the line with its `>` markers
    // stripped. Only fence detection uses this — the masked line keeps its original columns.
    const stripped = line.replace(/^\s*(?:>\s?)+/, '');
    const inQuote = stripped !== line;
    // A fenced block cannot outlive the blockquote that opened it, and a fence opened outside one
    // is not closed by a quoted marker: leaving the quote ends the block, and the line that ended
    // it is prose to be scanned — never skipped silently.
    if (fence?.quoted && !inQuote && line.trim() !== '') fence = null;
    // An opening fence may carry an info string (```js); a closing one may not, so a ```js line
    // inside a block is content rather than the end of it. Four spaces of indent is an indented
    // code block, not a fence — treating it as one would open a block that never closes.
    const opener = stripped.match(/^ {0,3}(`{3,}|~{3,})/);
    const closer = stripped.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    if (opener && fence === null) {
      // A span cannot reach across a fenced block to pair with a backtick on the far side.
      if (span.open !== null) {
        fail(`${rel}: unclosed \`code span\` — the prose after it went unchecked`);
        span.open = null;
      }
      fence = { char: opener[1][0], length: opener[1].length, quoted: inQuote };
      return '';
    }
    // A shorter or different fence inside a block is content — a ```` block quoting a ``` one
    // must not close on the inner example.
    if (
      closer &&
      closer[1][0] === fence?.char &&
      closer[1].length >= fence.length &&
      inQuote === fence.quoted
    ) {
      fence = null;
      return '';
    }
    if (fence !== null) return '';
    // A code span cannot cross a blank line. Ending one here stops two stray backticks in
    // different paragraphs from pairing up and masking everything between them.
    if (span.open !== null && line.trim() === '') {
      fail(`${rel}: unclosed \`code span\` — the prose after it went unchecked`);
      span.open = null;
    }
    // The glossary necessarily writes the words it warns against: its `_Avoid_` lines list them,
    // and its entry headings name terms that other entries avoid (**Engine** vs the Sim entry).
    if (/^_Avoid_:/.test(line)) return '';
    if (isGlossary && /^\*\*.+\*\*.*:\s*$/.test(line)) return '';
    return (
      maskCodeSpans(line, span)
        .replace(/\]\([^)]*\)/g, blank)
        // A reference-style definition's destination is a path, URL, or fragment — not prose. It
        // has to look like one: "[note]: monster tactics matter" is a sentence, and stays scanned.
        .replace(
          /^(\s*\[[^\]]+\]:\s*)(<[^>]*>|#\S+|\S*[/.]\S*)/,
          (_, label, dest) => label + blank(dest),
        )
        .replace(/\bhttps?:\/\/\S+/g, blank)
        .replace(/[*_]/g, ' ')
    );
  });
  // An unclosed fence or span would mask the rest of the file — silently switching the check off.
  if (fence !== null) fail(`${rel}: unclosed code fence — everything after it went unchecked`);
  if (span.open !== null) {
    fail(`${rel}: unclosed \`code span\` — everything after it went unchecked`);
  }
  return lines;
}

// ---------------------------------------------------------------- scan

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A plural is the same drift as the singular — "resistances", "enemies". Not the reverse: a term
// the glossary lists in the plural ("hearts", "credits") is matched as listed, because the
// singulars of the others ("point") are ordinary words this domain uses constantly.
const withPlural = (term) =>
  term.endsWith('y') ? `${escape(term.slice(0, -1))}(?:y|ies)` : `${escape(term)}(?:e?s)?`;
const termPatterns = linted.map((term) => [term, new RegExp(`\\b${withPlural(term)}\\b`, 'gi')]);
const exceptions = config.allowedSenses.map((entry) => {
  try {
    return {
      ...entry,
      term: entry.term.toLowerCase(),
      regexp: new RegExp(entry.pattern, 'gi'),
      used: false,
    };
  } catch (err) {
    return die(
      `config: the '${entry.term}' pattern /${entry.pattern}/ is not a valid regex — ${err.message}`,
    );
  }
});
// A `files` scope is a path prefix, but only at a path boundary: "docs/prd" must not match
// "docs/prd-notes.md".
const scoped = (rel, f) => rel === f || rel.startsWith(f.endsWith('/') ? f : `${f}/`);

for (const file of files) {
  const rel = posix(relative(ROOT, file));
  const lines = maskProse(readFileSync(file, 'utf8'), rel === GLOSSARY, rel);
  const active = exceptions.filter((e) => !e.files || e.files.some((f) => scoped(rel, f)));

  lines.forEach((line, index) => {
    // Spans of this line that a configured different-sense exception covers.
    const allowed = [];
    for (const exception of active) {
      exception.regexp.lastIndex = 0;
      for (const m of line.matchAll(exception.regexp)) {
        exception.used = true;
        allowed.push([m.index, m.index + m[0].length, exception.term]);
      }
    }

    for (const [term, pattern] of termPatterns) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        const [start, end] = [m.index, m.index + m[0].length];
        const covered = allowed.some(([s, e, t]) => t === term && s <= start && end <= e);
        if (covered) continue;
        const canonicals = [...avoided.get(term)].map((c) => `"${c}"`).join(' / ');
        fail(
          `${rel}:${index + 1}: "${m[0]}" → use ${canonicals} ` +
            `(${GLOSSARY}) — or add the different sense to ${posix(relative(ROOT, CONFIG_PATH))}`,
        );
      }
    }
  });
}

for (const exception of exceptions) {
  if (!exception.used) {
    fail(
      `config: the '${exception.term}' exception /${exception.pattern}/ matches nothing — ` +
        `delete it (an exception nobody needs hides the next real one)`,
    );
  }
}

if (errors.length > 0) die();
console.log(
  `✓ glossary terminology check passed (${linted.length} avoided terms across ${files.length} docs, ` +
    `${exceptions.length} sense exceptions)`,
);
