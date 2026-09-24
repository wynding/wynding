// build-layering-attribution.test.ts — the sourcemap reader behind `check:build-layering`'s
// `emittedBy` binding (`scripts/build-layering-attribution.mjs`, #168), on synthetic chunks.
//
// The real check needs two Vite builds and reads whatever they happen to emit, so it can only
// ever show that today's output attributes correctly. The reader's contract is narrower and
// is pinned here directly: a generated column is a UTF-16 code-unit offset, so an emitted chunk
// must be decoded as UTF-8 before a marker's index is compared with the map's segments. A
// latin1 decode (the check's presence-scanning read) turns every non-ASCII character before
// the marker into several units, and on a minified line that walks the marker onto a later
// segment belonging to a different source.
//
// It lives beside `layering.test.ts` and `layering-lint.test.ts`: this package is where the
// layering guards are tested.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface SourceMapLike {
  readonly mappings: string;
  readonly sources: readonly string[];
}

/** The module's surface, typed here because it is plain `.mjs` run by Node, outside any
 *  TypeScript program. */
interface Attribution {
  MalformedSourcemap: new (message: string) => Error;
  decodeMappings(mappings: string): [number, number][][];
  originsIn(code: string, map: SourceMapLike, text: string): (string | null)[];
  originsOf(file: string, text: string, repoRoot: string): (string | null)[] | null;
  isWithin(path: string, home: string): boolean;
}

let attribution: Attribution;

beforeAll(async () => {
  const url = pathToFileURL(join(REPO_ROOT, 'scripts', 'build-layering-attribution.mjs')).href;
  attribution = (await import(url)) as Attribution;
});

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One base64 VLQ value, as the Source Map v3 spec encodes it. */
function vlq(n: number): string {
  let value = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = value & 31;
    value >>>= 5;
    if (value !== 0) digit |= 32;
    out += BASE64[digit];
  } while (value !== 0);
  return out;
}

/** `mappings` for per-line `[generatedColumn, sourceIndex]` segments, both ABSOLUTE; source
 *  line and column are irrelevant to attribution and encoded as zero deltas. */
function encodeMappings(lines: readonly (readonly [number, number])[][]): string {
  let source = 0;
  return lines
    .map((segments) => {
      let column = 0;
      return segments
        .map(([col, src]) => {
          const out = vlq(col - column) + vlq(src - source) + vlq(0) + vlq(0);
          column = col;
          source = src;
          return out;
        })
        .join(',');
    })
    .join(';');
}

// A minified chunk, two lines. On line 1 the marker is preceded by `————————✅🎯`: nine
// characters of three UTF-8 bytes and one UTF-16 unit each, and one astral character (four
// bytes, TWO units) — 20 bytes more than units, against the 14 units from the marker's start
// to `C`'s segment. Every column below is computed with `indexOf`, i.e. in UTF-16 code units,
// which is how a bundler writes them.
const MARKER = 'stress-40x40';
const LINE_0 = '"use strict";';
const LINE_1 = `A="————————✅🎯";B="${MARKER}";C=1;`;
const CODE = `${LINE_0}\n${LINE_1}\n`;
const B_AT = LINE_1.indexOf('B=');
const C_AT = LINE_1.indexOf('C=');
// Source 0 owns `A` and `C`; source 1 owns `B` — the statement carrying the marker.
const SEGMENTS: (readonly [number, number])[][] = [
  [[0, 0]],
  [
    [0, 0],
    [B_AT, 1],
    [C_AT, 0],
  ],
];
const MAP = {
  mappings: encodeMappings(SEGMENTS),
  sources: ['packages/content/src/catalog.ts', 'packages/content/src/stress.ts'],
};

describe('sourcemap attribution counts columns in UTF-16 code units (check:build-layering)', () => {
  it('the fixture is the hazard: the marker sits past the next segment in BYTES, not in units', () => {
    const units = LINE_1.indexOf(MARKER);
    const bytes = Buffer.byteLength(LINE_1.slice(0, units), 'utf8');
    expect(units).toBeGreaterThanOrEqual(B_AT);
    expect(units).toBeLessThan(C_AT);
    expect(bytes).toBeGreaterThanOrEqual(C_AT); // a byte offset lands on C's segment
  });

  it('attributes the marker to the source whose segment covers it', () => {
    expect(attribution.originsIn(CODE, MAP, MARKER)).toEqual(['packages/content/src/stress.ts']);
  });

  it('a latin1 decode — byte offsets — misattributes the same occurrence to the other source', () => {
    const latin1 = Buffer.from(CODE, 'utf8').toString('latin1');
    expect(latin1.includes(MARKER)).toBe(true); // presence scanning is unaffected...
    // ...but position is not: this is exactly what the check computed before, and it would
    // have credited `stress-40x40` to catalog.ts.
    expect(attribution.originsIn(latin1, MAP, MARKER)).toEqual(['packages/content/src/catalog.ts']);
  });

  it('originsOf reads an emitted chunk as UTF-8 and resolves sources against the repo root', () => {
    const root = mkdtempSync(join(tmpdir(), 'wy-attribution-'));
    try {
      const chunk = join(root, 'dist', 'assets', 'chunk.js');
      mkdirSync(dirname(chunk), { recursive: true });
      writeFileSync(chunk, CODE, 'utf8');
      writeFileSync(
        `${chunk}.map`,
        JSON.stringify({
          version: 3,
          mappings: MAP.mappings,
          sources: ['../../src/catalog.ts', '../../src/stress.ts'],
        }),
        'utf8',
      );
      expect(attribution.originsOf(chunk, MARKER, root)).toEqual(['src/stress.ts']);
      // No sibling map: unattributable, which the caller reports — never an empty pass.
      expect(attribution.originsOf(join(root, 'dist', 'nomap.js'), MARKER, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a position after a source-less segment maps to nothing, not to the previous source', () => {
    const map = { mappings: `${vlq(0)}${vlq(0)}${vlq(0)}${vlq(0)},${vlq(5)}`, sources: ['a.ts'] };
    expect(attribution.originsIn('xxxxx_MARK', map, 'MARK')).toEqual([null]);
    expect(attribution.originsIn('MARK_xxxxx', map, 'MARK')).toEqual(['a.ts']);
  });

  it('rejects a mappings string that is not base64 VLQ with its own error', () => {
    expect(() => attribution.decodeMappings('AA!A')).toThrow(attribution.MalformedSourcemap);
  });
});

describe('isWithin — the one containment relation for both ownership sites', () => {
  it('a file home contains exactly itself, so stress.ts does not claim stress.tsx', () => {
    const home = 'packages/content/src/stress.ts';
    expect(attribution.isWithin('packages/content/src/stress.ts', home)).toBe(true);
    expect(attribution.isWithin('packages/content/src/stress.tsx', home)).toBe(false);
  });

  it('a directory home contains everything under it, and nothing beside it', () => {
    expect(attribution.isWithin('packages/perf/src/layout.ts', 'packages/perf/')).toBe(true);
    expect(attribution.isWithin('packages/perf-extra/src/x.ts', 'packages/perf/')).toBe(false);
  });
});
