// build-layering-attribution.mjs — the pure half of `check-build-layering.mjs`'s `emittedBy`
// binding (#168): reading a Source Map v3 and saying which source module an emitted occurrence
// of a marker came from, plus the one containment relation both of that script's ownership
// sites share. Split out of the check itself only so it can be unit-tested
// (`packages/perf/src/build-layering-attribution.test.ts`) without running two Vite builds —
// the check runs `check()` at its top level, so importing it would start them.
//
// Written here rather than imported because no sourcemap library is a declared dependency of
// the repo root, and this is a few dozen lines against a stable, fifteen-year-old format.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** A `mappings` string this reader cannot decode. The check reports it as its own verdict. */
export class MalformedSourcemap extends Error {}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `mappings` -> one array per generated line of `[generatedColumn, sourceIndex]` pairs,
 *  ascending by column. Segments with no source (length 1) are kept as `[column, -1]` so a
 *  position after one is attributed to NOTHING rather than to the previous source. */
export function decodeMappings(mappings) {
  const lines = [];
  // Only the source index is needed; line, column and name deltas are decoded and ignored.
  let source = 0;
  for (const line of mappings.split(';')) {
    const segments = [];
    let column = 0;
    for (const segment of line === '' ? [] : line.split(',')) {
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = BASE64.indexOf(char);
        if (digit === -1) {
          throw new MalformedSourcemap(`malformed sourcemap: '${char}' is not a base64 VLQ digit`);
        }
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value % 2 === 1 ? -((value - 1) / 2) : value / 2);
          value = 0;
          shift = 0;
        }
      }
      column += fields[0];
      if (fields.length >= 4) {
        source += fields[1];
        segments.push([column, source]);
      } else {
        segments.push([column, -1]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** For every occurrence of `text` in the generated `code`, the `map.sources` entry its
 *  sourcemap attributes it to, or `null` when the position maps to no source.
 *
 *  COLUMNS ARE UTF-16 CODE UNITS. Source Map v3 counts a generated column in UTF-16 code units
 *  — exactly what a JavaScript string index is — so `code` must be the chunk DECODED AS UTF-8,
 *  never as latin1. Vite emits UTF-8 and leaves non-ASCII literals unescaped (this repo's
 *  strings carry `—` and `✅`), so under a latin1 decode every such character before a marker
 *  on a minified line pushes its index one or more units further right than the column the map
 *  records (`—` is three bytes and one unit), and the segment walk below can then land on a
 *  LATER segment from another source: a false fail, or a false pass. */
export function originsIn(code, map, text) {
  const lines = decodeMappings(map.mappings);
  const origins = [];
  code.split('\n').forEach((line, lineIndex) => {
    for (let at = line.indexOf(text); at !== -1; at = line.indexOf(text, at + 1)) {
      let owner = -1;
      for (const [column, source] of lines[lineIndex] ?? []) {
        if (column > at) break;
        owner = source;
      }
      origins.push(owner === -1 ? null : (map.sources[owner] ?? null));
    }
  });
  return origins;
}

/** `originsIn` for an emitted JS `file` and its sibling `.map`, with each source resolved to a
 *  `repoRoot`-relative, '/'-separated path. Returns `null` outright when the file has no
 *  sibling `.map` — the caller reports that, because an unattributable chunk is a reason leg 1
 *  cannot bind, not a reason it passes. The chunk is read as UTF-8 (see `originsIn`). */
export function originsOf(file, text, repoRoot) {
  const mapFile = `${file}.map`;
  if (!existsSync(mapFile)) return null;
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const base = join(dirname(mapFile), map.sourceRoot ?? '');
  const sources = map.sources.map((source) =>
    relative(repoRoot, join(base, source)).split(sep).join('/'),
  );
  return originsIn(readFileSync(file, 'utf8'), { mappings: map.mappings, sources }, text);
}

/** Whether repo-relative `path` lies inside `home`: a directory home (trailing '/') contains
 *  everything under it; a file home contains exactly itself, so `stress.ts` does not also
 *  claim `stress.tsx`. The ONE containment relation for both of the check's ownership sites —
 *  the table invariant ("every forbidden module owns a marker") and leg 1's binding ("this
 *  occurrence was emitted by the marker's source") — so the two cannot disagree. */
export function isWithin(path, home) {
  return home.endsWith('/') ? path.startsWith(home) : path === home;
}
