// projection.ts — the pure geometry seam between the sim's fixed-point world (256
// units = 1 cell) and screen pixels, and its inverse (pointer → board cell). The board
// is fit-and-centred (letterboxed) inside the canvas at an integer-friendly cell size;
// all math is in CSS pixels (pointer events report CSS px), with `dpr` exposed only so
// the scene can size its WebGL backing store. No DOM, no Phaser — fully testable.

import { FP_ONE } from '@wynding/engine';

/** Inputs describing the current canvas + board, from which a `Projection` is built. */
export interface BoardLayout {
  /** Board size in cells. */
  readonly cols: number;
  readonly rows: number;
  /** Canvas size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Device pixel ratio (for the backing store; pointer math stays in CSS px). */
  readonly dpr: number;
}

export interface Projection {
  /** CSS px per cell (letterbox fit — the board is centred, never stretched). */
  readonly cellPx: number;
  /** CSS px of the board's top-left corner inside the canvas (letterbox offsets). */
  readonly originX: number;
  readonly originY: number;
  /** Backing-store scale for the scene (cellPx × dpr worth of device pixels). */
  readonly dpr: number;
  /** Top-left CSS pixel of cell (col,row). */
  cellToPixel(col: number, row: number): { x: number; y: number };
  /** CSS pixel of a fixed-point sim point (256 units = 1 cell). */
  fpToPixel(fpX: number, fpY: number): { x: number; y: number };
  /** CSS pixel length of a fixed-point range/length. */
  fpLenToPixel(fpLen: number): number;
  /** Board cell under a canvas-relative CSS pixel, or null if outside the board area. */
  pointerToCell(px: number, py: number): { col: number; row: number } | null;
}

/**
 * Build a `Projection` for the given layout. The cell size is `floor`ed so the board
 * grid lands on whole pixels (crisp lines); the leftover is split as equal letterbox
 * margins. A degenerate layout (non-positive size) yields a 1px fallback rather than
 * throwing — the scene may briefly measure a zero-size canvas during resize.
 */
export function createProjection(layout: BoardLayout): Projection {
  const cols = Math.max(1, layout.cols);
  const rows = Math.max(1, layout.rows);
  const w = Math.max(0, layout.cssWidth);
  const h = Math.max(0, layout.cssHeight);
  const dpr = layout.dpr > 0 ? layout.dpr : 1;

  const cellPx = Math.max(1, Math.floor(Math.min(w / cols, h / rows)));
  const originX = Math.floor((w - cellPx * cols) / 2);
  const originY = Math.floor((h - cellPx * rows) / 2);

  const cellToPixel = (col: number, row: number): { x: number; y: number } => ({
    x: originX + col * cellPx,
    y: originY + row * cellPx,
  });

  const fpToPixel = (fpX: number, fpY: number): { x: number; y: number } => ({
    x: originX + (fpX / FP_ONE) * cellPx,
    y: originY + (fpY / FP_ONE) * cellPx,
  });

  const fpLenToPixel = (fpLen: number): number => (fpLen / FP_ONE) * cellPx;

  const pointerToCell = (px: number, py: number): { col: number; row: number } | null => {
    const col = Math.floor((px - originX) / cellPx);
    const row = Math.floor((py - originY) / cellPx);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    return { col, row };
  };

  return { cellPx, originX, originY, dpr, cellToPixel, fpToPixel, fpLenToPixel, pointerToCell };
}
