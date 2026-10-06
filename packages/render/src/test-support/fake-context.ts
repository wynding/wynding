// fake-context.ts — TEST SUPPORT: the one fake 2D context the bake's tests paint into
// (`canvas-graphics.test.ts`, `art-paint.test.ts`, `bake.test.ts`, `bake-runner.test.ts`).
// Kept out of the build (`tsconfig.json`) and out of the coverage denominator
// (`vitest.config.ts`).
//
// It is the art painter's slice of a context (`ArtCanvas2DLike`, which includes the board
// bake's `Canvas2DLike`), and it behaves as a browser's does where the code under test could
// tell: `arc` and `ellipse` reject a negative radius (the HTML spec's `IndexSizeError`), so a
// bake that would throw in a browser throws here too; `save`/`restore` stack the composite
// operation; and the style properties start at a real context's defaults. What it records is
// chosen per test (`FakeContextOptions`).

import type { ArtCanvas2DLike } from '../art-paint';

/** One recorded operation: a method call, or (with `recordStyles`) a style write as
 *  `set:<prop>`. Fills and strokes carry the composite operation they ran under when
 *  `recordComposite` is set. */
export type CtxOp = { op: string; args: unknown[]; composite?: GlobalCompositeOperation };

export interface FakeContextOptions {
  /** Record each method call as an op. Default true. */
  readonly recordOps?: boolean;
  /** Also record each style write, as a `set:<prop>` op, so a test can see which style a
   *  fill or stroke ran under. */
  readonly recordStyles?: boolean;
  /** Stamp each `fill`, `stroke` and `fillRect` op with the composite operation in force. */
  readonly recordComposite?: boolean;
  /** Push the text of every `fillStyle` written here. */
  readonly fills?: string[];
  /** Throw this from every method call — so from a painter's first drawing call. */
  readonly throws?: unknown;
}

/** The style properties a test may write, at a real context's defaults. */
const STYLE_DEFAULTS = {
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  globalCompositeOperation: 'source-over',
} as const;

/** Which arguments of a method are radii, for the negative-radius check. */
const RADII: Readonly<Record<string, readonly number[]>> = { arc: [2], ellipse: [2, 3] };

const METHODS = [
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'arc',
  'ellipse',
  'rect',
  'fill',
  'stroke',
  'fillRect',
  'save',
  'restore',
  'setTransform',
  'transform',
  'clip',
  'setLineDash',
] as const;

const DRAWS: ReadonlySet<string> = new Set(['fill', 'stroke', 'fillRect']);

export function fakeContext(options: FakeContextOptions = {}): ArtCanvas2DLike & { ops: CtxOp[] } {
  const { recordOps = true, recordStyles = false, recordComposite = false, fills } = options;
  const throws = options.throws ?? null;
  const ops: CtxOp[] = [];
  const style: Record<string, unknown> = { ...STYLE_DEFAULTS };
  const saved: unknown[] = [];
  const ctx: Record<string, unknown> = { ops };
  for (const method of METHODS) {
    ctx[method] = (...args: unknown[]): void => {
      if (throws !== null) throw throws;
      const radii = (RADII[method] ?? []).map((i) => args[i] as number);
      if (radii.some((r) => r < 0)) {
        throw new RangeError(`IndexSizeError: ${method} radius ${radii.join(', ')} is negative`);
      }
      if (method === 'save') saved.push(style.globalCompositeOperation);
      if (method === 'restore' && saved.length > 0) {
        style.globalCompositeOperation = saved.pop();
      }
      if (!recordOps) return;
      ops.push(
        recordComposite && DRAWS.has(method)
          ? {
              op: method,
              args,
              composite: style.globalCompositeOperation as GlobalCompositeOperation,
            }
          : { op: method, args },
      );
    };
  }
  for (const prop of Object.keys(STYLE_DEFAULTS)) {
    Object.defineProperty(ctx, prop, {
      get: () => style[prop],
      set: (v: unknown) => {
        style[prop] = v;
        if (prop === 'fillStyle') fills?.push(String(v));
        if (recordOps && recordStyles) ops.push({ op: `set:${prop}`, args: [v] });
      },
    });
  }
  return ctx as unknown as ArtCanvas2DLike & { ops: CtxOp[] };
}

/** A stand-in `Path2D` factory: the "path" carries the string it was made from. */
export const fakePath = (d: string): Path2D => ({ d }) as unknown as Path2D;

/** One draw in a recording, with the style it ran under: the fill style for a `fill` or
 *  `fillRect`, the stroke style and line width for a `stroke`. */
export type StyledDraw =
  | { readonly op: 'fill' | 'fillRect'; readonly fillStyle: unknown }
  | { readonly op: 'stroke'; readonly strokeStyle: unknown; readonly lineWidth: unknown };

/** Every draw in `ops` — recorded with `recordStyles` — with the style in force when it ran,
 *  replaying the style writes as a real context holds them (`save`/`restore` included, from
 *  its defaults). So a test can tell a style written before its draw from one written after
 *  it, or never. */
export function stylesAtDraws(ops: readonly CtxOp[]): StyledDraw[] {
  let style: Record<string, unknown> = { ...STYLE_DEFAULTS };
  const saved: Record<string, unknown>[] = [];
  const draws: StyledDraw[] = [];
  for (const { op, args } of ops) {
    if (op === 'save') saved.push({ ...style });
    else if (op === 'restore') style = saved.pop() ?? style;
    else if (op.startsWith('set:')) style[op.slice(4)] = args[0];
    else if (op === 'fill' || op === 'fillRect') draws.push({ op, fillStyle: style.fillStyle });
    else if (op === 'stroke') {
      draws.push({ op, strokeStyle: style.strokeStyle, lineWidth: style.lineWidth });
    }
  }
  return draws;
}
