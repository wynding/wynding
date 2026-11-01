// reference-build.ts — M3 story 1: the balance checker's REFERENCE-BUILD FORMAT, which
// draws each maze as a grid. Test/tooling support, NOT part of this package's public API
// (not re-exported from `./index.ts`) — the `showcase-builds.ts` precedent.
//
// Beside its id and a one-line summary, a reference build is two strings a person writes
// and a reviewer diffs:
//
//   grid   — the whole board, one character per cell, one line per row (leading and
//            trailing whitespace on a line is ignored, as are blank lines):
//              `#` a blocked cell, `+` an entrance or exit, `.` an open buildable cell,
//              a letter (TOWER_LETTERS) a cell under a tower of that kind.
//            A tower covers its full 2×2 footprint, so it is drawn as four letters, and
//            its ANCHOR (the cell a placement names) is the footprint's top-left cell.
//            Read top to bottom, left to right, the first unclaimed letter is always an
//            anchor, so a drawing splits into footprints exactly one way; a letter that
//            can't (a 3-wide run, a lone cell) is an error.
//   order  — the build order: whitespace-separated steps, run one at a time in order:
//              `v14,10`      place the venom tower anchored at col 14, row 10 — the first
//                            tick bounty covers it (the runner's greedy rule);
//              `v14,10@600`  the same, but not before tick 600;
//              `-v14,10@900` sell it, not before tick 900 (`@` is optional on a sell too).
//            The letter repeats the grid's, so a mistyped coordinate fails loudly
//            instead of naming some other tower.
//
// Every tower in the grid must be placed at least once; a step may place only a tower
// not standing and sell only one that is. A juggling build re-places the same tower on
// the same anchor; a tower of a DIFFERENT kind on a sold tower's cells can't be drawn
// (one letter per cell) and is out of this format's scope until a build needs it. A
// `burst` tower (`mine`) is the exception to "not standing": it removes itself when it
// detonates, which the order can't see, so placing one again RE-ARMS it — the runner
// retries the placement each tick until the spent mine's cells are clear — and for the
// same reason it can't be sold: by the time the sell falls due it may be gone.
//
// `compileReferenceBuild` turns the strings into the runner's plan (`script-runner.ts`),
// checking the drawing against the board's own cell classes so a grid drawn one row or
// column off fails here, not as a mysteriously different run.

import type { CompiledRuleset } from '@wynding/sim';
import type { Placement, ScriptStep, Sell } from './script-runner';

/** One letter per tower kind. A build may use any tower its ruleset's catalog has. */
export const TOWER_LETTERS: Readonly<Record<string, string>> = {
  a: 'antiair',
  b: 'basic',
  c: 'beacon',
  f: 'frost-splash',
  m: 'mine',
  p: 'splash',
  s: 'slow',
  t: 'stun',
  v: 'venom',
};

/** A reference build as authored — see this file's header for the notation. */
export interface ReferenceBuild {
  /** Short, stable id: the report's and the tests' name for the build. */
  readonly id: string;
  /** One line on what the build is. */
  readonly summary: string;
  readonly grid: string;
  readonly order: string;
}

/** Reference builds registered against one board of one bundled ruleset, run from one
 *  seed. The board is named, never defaulted, so a set can't silently follow a change to
 *  the bundle's default board. */
export interface ReferenceSet {
  readonly id: string;
  readonly rulesetId: string;
  readonly boardId: string;
  readonly seed: number;
  readonly builds: readonly ReferenceBuild[];
}

const CELL_GLYPH = {
  blocked: '#',
  'walkable-unbuildable': '+',
  'buildable-open': '.',
} as const;

// Every tower is 2×2 — PRD 0001 fixes it and the sim holds it as a constant (`tower.ts`),
// not as ruleset data — so the footprint is fixed here too: the anchor and the three
// cells right, below and diagonal of it.
const FOOTPRINT = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

const STEP = /^(-?)([a-z])(\d+),(\d+)(?:@(\d+))?$/;

function reject(build: ReferenceBuild, msg: string): never {
  throw new Error(`reference build '${build.id}': ${msg}`);
}

/** The drawn towers, keyed `col,row` by anchor, valued by tower id. */
function readGrid(build: ReferenceBuild, ruleset: CompiledRuleset): Map<string, string> {
  const { grid } = ruleset.board;
  const lines = build.grid
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length !== grid.height) {
    reject(build, `grid has ${lines.length} rows, the board has ${grid.height}`);
  }
  lines.forEach((line, row) => {
    if (line.length !== grid.width) {
      reject(build, `grid row ${row} has ${line.length} cells, the board has ${grid.width}`);
    }
  });

  const at = (col: number, row: number): string | undefined => lines[row]?.[col];
  const claimed = new Set<string>();
  const anchors = new Map<string, string>();
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const glyph = at(col, row)!;
      const cellClass = grid.classAt({ col, row });
      if (!/^[a-z]$/.test(glyph)) {
        if (glyph !== CELL_GLYPH[cellClass]) {
          reject(
            build,
            `(${col},${row}) is drawn '${glyph}' but is ${cellClass} ('${CELL_GLYPH[cellClass]}')`,
          );
        }
        continue;
      }
      if (cellClass !== 'buildable-open')
        reject(build, `(${col},${row}) carries a tower but is ${cellClass}`);
      if (claimed.has(`${col},${row}`)) continue;
      const towerId = TOWER_LETTERS[glyph];
      if (towerId === undefined || ruleset.towerById[towerId] === undefined) {
        reject(build, `'${glyph}' at (${col},${row}) names no tower in this ruleset`);
      }
      for (const [dc, dr] of FOOTPRINT) {
        const c = col + dc;
        const r = row + dr;
        if (at(c, r) !== glyph || claimed.has(`${c},${r}`)) {
          reject(build, `'${glyph}' at (${col},${row}) does not complete a 2×2 footprint`);
        }
        claimed.add(`${c},${r}`);
      }
      anchors.set(`${col},${row}`, towerId);
    }
  }
  return anchors;
}

/** Draw `ruleset`'s board in this format with `towers` (anchor and letter) over it — an
 *  empty board to start authoring from, and the tests' fixture maker. */
export function drawGrid(
  ruleset: CompiledRuleset,
  towers: readonly (readonly [col: number, row: number, letter: string])[] = [],
): string {
  const { grid } = ruleset.board;
  const rows = Array.from({ length: grid.height }, (_, row) =>
    Array.from({ length: grid.width }, (_, col) => CELL_GLYPH[grid.classAt({ col, row })]),
  ) as string[][];
  for (const [col, row, letter] of towers) {
    for (const [dc, dr] of FOOTPRINT) rows[row + dr]![col + dc] = letter;
  }
  return rows.map((r) => r.join('')).join('\n');
}

/**
 * Compile a reference build into the runner's plan for `ruleset`'s board: one step per
 * order entry, in order. Throws, naming the build, on any drawing or order the board or
 * the notation rejects (see this file's header).
 */
export function compileReferenceBuild(
  build: ReferenceBuild,
  ruleset: CompiledRuleset,
): ScriptStep[] {
  const anchors = readGrid(build, ruleset);

  const standing = new Set<string>();
  const everPlaced = new Set<string>();
  const steps: ScriptStep[] = [];
  for (const token of build.order.split(/\s+/).filter((t) => t !== '')) {
    const m = STEP.exec(token);
    if (m === null) reject(build, `order step '${token}' is not [-]<letter><col>,<row>[@<tick>]`);
    const [, sell, letter, colText, rowText, tickText] = m;
    const col = Number(colText);
    const row = Number(rowText);
    const key = `${col},${row}`;
    const drawn = anchors.get(key);
    if (drawn === undefined || drawn !== TOWER_LETTERS[letter!]) {
      reject(
        build,
        `order step '${token}' names no '${letter}' tower anchored at (${key}) in the grid`,
      );
    }
    const timing = tickText === undefined ? {} : { notBeforeTick: Number(tickText) };
    const burst = ruleset.towerById[drawn]!.attack?.mode === 'burst';
    if (sell === '-') {
      if (burst) {
        reject(build, `order step '${token}' sells a ${drawn}, which may already have detonated`);
      }
      if (!standing.has(key))
        reject(build, `order step '${token}' sells a tower that is not standing`);
      standing.delete(key);
      steps.push({ kind: 'sell', col, row, ...timing } satisfies Sell);
    } else {
      if (standing.has(key) && !burst)
        reject(build, `order step '${token}' places a tower that is already standing`);
      standing.add(key);
      everPlaced.add(key);
      steps.push({ col, row, towerId: drawn, ...timing } satisfies Placement);
    }
  }
  for (const key of anchors.keys()) {
    if (!everPlaced.has(key))
      reject(build, `the tower anchored at (${key}) is drawn but never placed`);
  }
  return steps;
}
