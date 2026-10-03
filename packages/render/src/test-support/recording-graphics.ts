// recording-graphics.ts — TEST SUPPORT: the recording drawing surfaces the render tests draw
// into, in one place. Each records every call, in order, as `{ method, args }`, and draws
// nothing. Kept out of the build (`tsconfig.json`) and out of the coverage denominator
// (`vitest.config.ts`): it is test code, not a module the renderer ships.
//
// They satisfy the real interfaces directly, with no cast — the same shapes a real
// `Phaser.GameObjects.Graphics`, the bake's Canvas2D adapter and the art kit satisfy — so a
// draw function cannot call a method here that the real surfaces lack.

import type { ArtGraphics } from '../art-paint';
import type { GraphicsLike } from '../board-draw';
import type { LayerGraphics } from '../board-frame';

/** One recorded call. */
export type Call = { method: string; args: unknown[] };

/** A recorder for `calls`: each named method pushes its arguments there. */
function recorderFor(calls: Call[]): (method: string) => (...args: unknown[]) => void {
  return (method) =>
    (...args) => {
      calls.push({ method, args });
    };
}

/** A recording `GraphicsLike` — exactly the methods the board's draw functions call. */
export function recordingGraphics(): GraphicsLike & { calls: Call[] } {
  const calls: Call[] = [];
  const record = recorderFor(calls);
  return {
    calls,
    fillStyle: record('fillStyle'),
    lineStyle: record('lineStyle'),
    fillRect: record('fillRect'),
    fillRoundedRect: record('fillRoundedRect'),
    strokeRoundedRect: record('strokeRoundedRect'),
    fillTriangle: record('fillTriangle'),
    fillCircle: record('fillCircle'),
    strokeCircle: record('strokeCircle'),
    fillPoints: record('fillPoints'),
    lineBetween: record('lineBetween'),
  };
}

/** A recording live layer (`board-frame.ts`): `recordingGraphics` plus `clear` and
 *  `strokeRect`, the calls only per-frame drawing makes. */
export function recordingLayer(): LayerGraphics & { calls: Call[] } {
  const g = recordingGraphics();
  const record = recorderFor(g.calls);
  return { ...g, clear: record('clear'), strokeRect: record('strokeRect') };
}

/** A recording atlas-frame surface: `recordingGraphics` plus the bake's `flush` and the art
 *  kit's `art` and `fade` — what a frame painter (`art-frames.ts`) draws into. */
export function recordingArtGraphics(): ArtGraphics & { calls: Call[] } {
  const g = recordingGraphics();
  const record = recorderFor(g.calls);
  return { ...g, flush: record('flush'), art: record('art'), fade: record('fade') };
}
