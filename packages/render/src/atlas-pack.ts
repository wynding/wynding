// atlas-pack.ts — where each frame sits in the board atlas (V2, #181). Simple shelf packing:
// frames sorted tallest first, laid left to right along a shelf until the next one would
// cross the width limit, then a new shelf below. Pure and deterministic — the same frames
// always land in the same places — and texel-integral throughout.

export interface PackItem {
  readonly key: string;
  /** Size in texels — whole numbers. */
  readonly width: number;
  readonly height: number;
}

export interface PackedRect {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PackResult {
  /** The texture size the frames need — the widest shelf and the shelves' total height,
   *  outer gutters included. Never more than `maxWidth` wide unless one frame alone is. */
  readonly width: number;
  readonly height: number;
  readonly rects: readonly PackedRect[];
}

/**
 * Pack `items` into shelves no wider than `maxWidth`, with `gutter` transparent texels
 * between frames and around the edge. The gutter is what keeps one frame's edge texels
 * from bleeding into a neighbour's when a sprite is sampled off the texel grid (a degraded
 * bake scale). A frame wider than `maxWidth` on its own still gets a shelf to itself — the
 * result then reports the width it needs and the caller decides (`bake.ts` lowers the
 * scale until everything fits the renderer's limit).
 *
 * Ties in height keep the items' given order, so the layout is stable for a stable input.
 */
export function packShelves(
  items: readonly PackItem[],
  maxWidth: number,
  gutter: number,
): PackResult {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.height - a.item.height || a.index - b.index);
  const rects: PackedRect[] = [];
  let x = gutter;
  let y = gutter;
  let shelfHeight = 0;
  let width = 0;
  for (const { item } of order) {
    if (x > gutter && x + item.width + gutter > maxWidth) {
      y += shelfHeight + gutter;
      x = gutter;
      shelfHeight = 0;
    }
    rects.push({ key: item.key, x, y, width: item.width, height: item.height });
    x += item.width + gutter;
    width = Math.max(width, x);
    shelfHeight = Math.max(shelfHeight, item.height);
  }
  const height = rects.length === 0 ? 0 : y + shelfHeight + gutter;
  return { width, height, rects };
}
