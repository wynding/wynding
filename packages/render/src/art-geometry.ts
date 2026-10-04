// art-geometry.ts — the vector art kit's geometry (visual pass, #181), Phaser-free and
// canvas-free: SVG path strings parsed and flattened to polylines, every IR shape's outline,
// and the bounds of a set of shapes. The painter never needs it — Canvas2D parses a path
// string itself (`Path2D`) — but frame sizing does (a frame must hold its art with the
// shadow and the strokes), and so do the tests that reason about what the art covers.

import { rectRadius, strokeWidthAt, type ArtShape } from './art-ir';

export type Point = readonly [number, number];

/** One flattened sub-path: its points in order, and whether it closes back to the first. */
export interface Polyline {
  readonly points: readonly Point[];
  readonly closed: boolean;
}

/** One absolute path command, after parsing — the forms everything else reduces to. */
export type PathCommand =
  | { readonly c: 'M'; readonly x: number; readonly y: number }
  | { readonly c: 'L'; readonly x: number; readonly y: number }
  | {
      readonly c: 'C';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly c: 'Q';
      readonly x1: number;
      readonly y1: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly c: 'A';
      readonly rx: number;
      readonly ry: number;
      readonly rotation: number;
      readonly large: boolean;
      readonly sweep: boolean;
      readonly x: number;
      readonly y: number;
    }
  | { readonly c: 'Z' };

const COMMAND_LETTERS = 'MmLlHhVvCcSsQqTtAaZz';
const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?/g;
/** A whole token that is a number without a sign — what may follow a packed arc flag. */
const UNSIGNED_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
/** A number token's integer digits and exponent field, which a browser checks one by one. */
const NUMBER_PARTS = /^[-+]?(\d*)(?:\.\d+)?(?:[eE]([-+]?\d+))?$/;
/** The largest finite 32-bit float. */
const FLOAT32_MAX = 3.4028234663852886e38;

/** Whether `token` is a number rather than a command letter. */
const isNumber = (token: string): boolean => !COMMAND_LETTERS.includes(token);

/**
 * Parse an SVG path string into absolute M/L/C/Q/A/Z commands: relative forms are made
 * absolute, H/V become L, S/T become C/Q with their reflected control point. Throws on
 * anything it cannot read — art is code, so a malformed path is a bug to surface at once,
 * never a shape to skip.
 *
 * NEVER MORE LENIENT THAN `Path2D`, which is what paints the art: a browser drops path data
 * from its first error on, so data it would draw as nothing must not measure as a shape
 * here. So the path must open with a moveto (`'L50 50'` and `'h40'` paint nothing); a comma
 * may only separate two numbers, once (`'M10,,10L50 50'` and `',M10 10L50 50'` paint nothing
 * either) — the SVG grammar's `comma-wsp`; whitespace is SVG's own (space, tab, line feed,
 * form feed, carriage return — not the no-break or ideographic spaces JS's `\s` admits); a
 * decimal point is followed by a digit (`'L90. 50'` and `'L1.e1 50'` paint nothing); a number
 * is one the browser can read into the 32-bit float it parses path data into, which it
 * checks part by part: integer digits within a float's range, an exponent field of at most
 * 38 whatever comes before it, and a value within range (`'L1e39 50'`, `'L0e39 50'` and a
 * 40-digit `'L1000…0e-38 50'` paint nothing, though the last two are 0 and 10; a negative
 * exponent may be any size, as it only underflows); and an arc flag is the one character `0` or `1`, which may be packed against
 * what follows it (`'A40 40 0 0190 50'` is flags 0 and 1, then 90 50).
 */
export function parsePath(d: string): PathCommand[] {
  /** What may stand between the token `before` and the token `after` (either missing at the
   *  ends of the string): whitespace, and one comma only between two numbers. */
  const checkGap = (gap: string, before: string | undefined, after: string | undefined): void => {
    if (!/^[ \t\n\f\r,]*$/.test(gap)) throw new Error(`unreadable path data: '${d}'`);
    if (!gap.includes(',')) return;
    if (
      gap.indexOf(',') !== gap.lastIndexOf(',') ||
      // (A leading comma is caught twice over: here, and by the moveto rule below, since
      // what follows it is either a command letter or numbers before any moveto.)
      before === undefined ||
      after === undefined ||
      !isNumber(before) ||
      !isNumber(after)
    ) {
      throw new Error(`a comma must separate two numbers, once: '${d}'`);
    }
  };
  const tokens: string[] = [];
  let gapStart = 0;
  for (const m of d.matchAll(TOKEN)) {
    checkGap(d.slice(gapStart, m.index), tokens[tokens.length - 1], m[0]);
    tokens.push(m[0]);
    gapStart = m.index + m[0].length;
  }
  checkGap(d.slice(gapStart), tokens[tokens.length - 1], undefined);
  if (tokens[0] !== 'M' && tokens[0] !== 'm') {
    throw new Error(`path data must open with a moveto (M or m): '${d}'`);
  }
  const out: PathCommand[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // The previous command's last control point, for S/T reflection.
  let lastCubic: readonly [number, number] | null = null;
  let lastQuad: readonly [number, number] | null = null;
  let letter = '';
  const num = (): number => {
    const t = tokens[i++];
    if (t === undefined || COMMAND_LETTERS.includes(t)) {
      throw new Error(`path data ends early: '${d}'`);
    }
    const v = Number(t);
    // A browser reads path data into 32-bit floats, and a number it cannot hold ends it:
    // integer digits past a float's range, an exponent field over 38 (`0e39`, though it is
    // 0), or a value past the range. (Measured in Chromium and WebKit, which agree.)
    const [, whole, exponent] = NUMBER_PARTS.exec(t) ?? [];
    if (
      Number(whole || '0') > FLOAT32_MAX ||
      (exponent !== undefined && Number(exponent) > 38) ||
      !Number.isFinite(Math.fround(v))
    ) {
      throw new Error(`a number past a 32-bit float, which a browser reads it into: '${d}'`);
    }
    return v;
  };
  /** An arc flag: the one character `0` or `1` at the front of the next token. What follows
   *  it in a packed token (`'0190'`) is left to be read as the next token — and must be a
   *  number itself (`'1e5'` leaves `'e5'`, which is not). */
  const flag = (): boolean => {
    const t = tokens[i];
    if (t === undefined || (t[0] !== '0' && t[0] !== '1')) {
      throw new Error(`an arc flag must be 0 or 1: '${d}'`);
    }
    const rest = t.slice(1);
    if (rest === '') i++;
    else if (UNSIGNED_NUMBER.test(rest)) tokens[i] = rest;
    else throw new Error(`an arc flag must be 0 or 1: '${d}'`);
    return t[0] === '1';
  };
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (COMMAND_LETTERS.includes(t)) {
      letter = t;
      i++;
    } else if (letter === '') {
      throw new Error(`path data has numbers without a command: '${d}'`);
    } else if (letter === 'M') {
      letter = 'L'; // implicit repeats of a moveto are linetos
    } else if (letter === 'm') {
      letter = 'l';
    }
    const upper = letter.toUpperCase();
    const rel = letter !== upper;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let cubic: readonly [number, number] | null = null;
    let quad: readonly [number, number] | null = null;
    if (upper === 'M') {
      cx = ox + num();
      cy = oy + num();
      startX = cx;
      startY = cy;
      out.push({ c: 'M', x: cx, y: cy });
    } else if (upper === 'L' || upper === 'H' || upper === 'V') {
      if (upper !== 'V') cx = ox + num();
      if (upper !== 'H') cy = oy + num();
      out.push({ c: 'L', x: cx, y: cy });
    } else if (upper === 'C' || upper === 'S') {
      let x1 = cx;
      let y1 = cy;
      if (upper === 'C') {
        x1 = ox + num();
        y1 = oy + num();
      } else if (lastCubic !== null) {
        x1 = 2 * cx - lastCubic[0];
        y1 = 2 * cy - lastCubic[1];
      }
      const x2 = ox + num();
      const y2 = oy + num();
      cx = ox + num();
      cy = oy + num();
      out.push({ c: 'C', x1, y1, x2, y2, x: cx, y: cy });
      cubic = [x2, y2];
    } else if (upper === 'Q' || upper === 'T') {
      let x1 = cx;
      let y1 = cy;
      if (upper === 'Q') {
        x1 = ox + num();
        y1 = oy + num();
      } else if (lastQuad !== null) {
        x1 = 2 * cx - lastQuad[0];
        y1 = 2 * cy - lastQuad[1];
      }
      cx = ox + num();
      cy = oy + num();
      out.push({ c: 'Q', x1, y1, x: cx, y: cy });
      quad = [x1, y1];
    } else if (upper === 'A') {
      const rx = num();
      const ry = num();
      const rotation = num();
      const large = flag();
      const sweep = flag();
      cx = ox + num();
      cy = oy + num();
      out.push({ c: 'A', rx, ry, rotation, large, sweep, x: cx, y: cy });
    } else {
      // 'Z' — close back to the sub-path's start. Numbers after it need a new command.
      cx = startX;
      cy = startY;
      out.push({ c: 'Z' });
      letter = '';
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
  return out;
}

/** Segments per Bézier when flattening — ample for art a few dozen units across. */
const BEZIER_STEPS = 24;
/** Largest angle step when flattening an arc or a circle, radians (5°). */
const ARC_STEP = Math.PI / 36;

/** Points along an SVG elliptical arc from `(x0, y0)` to the command's end — the endpoint
 *  included, the start not — by the SVG specification's endpoint-to-centre conversion
 *  (implementation notes F.6.5) with its out-of-range radii correction (F.6.6). */
function arcPoints(x0: number, y0: number, a: Extract<PathCommand, { c: 'A' }>): Point[] {
  let rx = Math.abs(a.rx);
  let ry = Math.abs(a.ry);
  if ((x0 === a.x && y0 === a.y) || rx === 0 || ry === 0) return [[a.x, a.y]];
  const phi = (a.rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - a.x) / 2;
  const dy = (y0 - a.y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (a.large === a.sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const ccx = cos * cxp - sin * cyp + (x0 + a.x) / 2;
  const ccy = sin * cxp + cos * cyp + (y0 + a.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!a.sweep && delta > 0) delta -= 2 * Math.PI;
  else if (a.sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(delta) / ARC_STEP));
  const pts: Point[] = [];
  for (let k = 1; k < steps; k++) {
    const t = theta1 + (delta * k) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    pts.push([cos * ex - sin * ey + ccx, sin * ex + cos * ey + ccy]);
  }
  // Land exactly on the endpoint the path names, not a rounding error beside it.
  pts.push([a.x, a.y]);
  return pts;
}

/** Flatten a path string into its sub-paths as polylines. */
export function flattenPath(d: string): Polyline[] {
  const lines: Polyline[] = [];
  let pts: Point[] = [];
  let x = 0;
  let y = 0;
  const end = (closed: boolean): void => {
    if (pts.length > 1) lines.push({ points: pts, closed });
    pts = [];
  };
  for (const cmd of parsePath(d)) {
    if (cmd.c === 'Z') {
      const first = pts[0];
      end(true);
      if (first !== undefined) [x, y] = first;
      continue;
    }
    if (cmd.c === 'M') {
      end(false);
      pts.push([cmd.x, cmd.y]);
    } else {
      if (pts.length === 0) pts.push([x, y]); // drawing on after a Z starts a new sub-path
      if (cmd.c === 'L') {
        pts.push([cmd.x, cmd.y]);
      } else if (cmd.c === 'C') {
        for (let k = 1; k <= BEZIER_STEPS; k++) {
          const t = k / BEZIER_STEPS;
          const u = 1 - t;
          pts.push([
            u * u * u * x + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
            u * u * u * y + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
          ]);
        }
      } else if (cmd.c === 'Q') {
        for (let k = 1; k <= BEZIER_STEPS; k++) {
          const t = k / BEZIER_STEPS;
          const u = 1 - t;
          pts.push([
            u * u * x + 2 * u * t * cmd.x1 + t * t * cmd.x,
            u * u * y + 2 * u * t * cmd.y1 + t * t * cmd.y,
          ]);
        }
      } else {
        pts.push(...arcPoints(x, y, cmd));
      }
    }
    x = cmd.x;
    y = cmd.y;
  }
  end(false);
  return lines;
}

/** Points around an ellipse (closed, the first point not repeated). */
function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
  const steps = Math.ceil((2 * Math.PI) / ARC_STEP);
  return Array.from({ length: steps }, (_, k): Point => {
    const t = (2 * Math.PI * k) / steps;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });
}

/** The outline of one IR shape, flattened: the polylines a fill encloses and a stroke traces. */
export function shapeOutline(shape: ArtShape): Polyline[] {
  switch (shape.kind) {
    case 'path':
      return flattenPath(shape.d);
    case 'circle':
      return [{ points: ellipsePoints(shape.cx, shape.cy, shape.r, shape.r), closed: true }];
    case 'ellipse':
      return [{ points: ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry), closed: true }];
    case 'polygon':
      return [{ points: shape.points.map(([x, y]): Point => [x, y]), closed: true }];
    case 'rect': {
      const r = rectRadius(shape);
      const { x, y, w, h } = shape;
      // Corner centres, each with the angle its quarter-arc starts at, clockwise from the
      // top-right.
      const corners: readonly (readonly [number, number, number])[] = [
        [x + w - r, y + r, -Math.PI / 2],
        [x + w - r, y + h - r, 0],
        [x + r, y + h - r, Math.PI / 2],
        [x + r, y + r, Math.PI],
      ];
      const steps = Math.ceil(Math.PI / 2 / ARC_STEP);
      const pts: Point[] = [];
      for (const [ccx, ccy, from] of corners) {
        for (let k = 0; k <= steps; k++) {
          const t = from + (Math.PI / 2) * (k / steps);
          pts.push([ccx + r * Math.cos(t), ccy + r * Math.sin(t)]);
        }
      }
      return [{ points: pts, closed: true }];
    }
  }
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The design-unit box `shapes` paint into at `unit` CSS px per unit: every outline point,
 *  grown by half the stroke width where the shape strokes. Exact for round joins and caps —
 *  the art's choice wherever a stroke turns a sharp corner — and for strokes that turn no
 *  corner at all. No shapes give an empty box (`minX > maxX`). */
export function artBounds(shapes: readonly ArtShape[], unit: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const grow = shape.stroke === undefined ? 0 : strokeWidthAt(shape, unit) / 2;
    for (const line of shapeOutline(shape)) {
      for (const [x, y] of line.points) {
        minX = Math.min(minX, x - grow);
        minY = Math.min(minY, y - grow);
        maxX = Math.max(maxX, x + grow);
        maxY = Math.max(maxY, y + grow);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}
