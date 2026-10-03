// sprite-pool.test.ts — the pooled sprites of a board layer, against recording sprites: growth,
// reuse (a frame is re-set only when it changed), hiding what a frame does not place, and
// showing again what a later frame does — after a Play-again reset hid every one.

import { describe, it, expect } from 'vitest';
import { createSpritePool, type PoolSprite } from './sprite-pool';
import type { SpritePlacement } from './placement';

interface FakeSprite extends PoolSprite {
  readonly id: number;
  frame: string;
  x: number;
  y: number;
  visible: boolean;
  calls: string[];
}

function fakePool() {
  const made: FakeSprite[] = [];
  const pool = createSpritePool<FakeSprite>((p) => {
    const sprite: FakeSprite = {
      id: made.length,
      frame: p.frame,
      x: p.x,
      y: p.y,
      visible: true,
      calls: [],
      setPosition(x, y) {
        this.calls.push(`setPosition ${x},${y}`);
        this.x = x;
        this.y = y;
      },
      setFrame(frame) {
        this.calls.push(`setFrame ${frame}`);
        this.frame = frame;
      },
      setVisible(visible) {
        this.calls.push(`setVisible ${String(visible)}`);
        this.visible = visible;
      },
    };
    made.push(sprite);
    return sprite;
  });
  return { pool, made };
}

const at = (frame: string, x: number, y = 0): SpritePlacement => ({ frame, x, y });

describe('createSpritePool', () => {
  it('creates a sprite per placement as the count grows, each showing its placement', () => {
    const { pool, made } = fakePool();
    pool.sync([at('a', 1), at('b', 2)]);
    expect(pool.size).toBe(2);
    expect(made.map((s) => [s.frame, s.x, s.visible])).toEqual([
      ['a', 1, true],
      ['b', 2, true],
    ]);
    pool.sync([at('a', 1), at('b', 2), at('c', 3)]);
    expect(pool.size).toBe(3); // grew by one; the first two were reused, not remade
    expect(made[2]).toMatchObject({ frame: 'c', x: 3 });
  });

  it('reuses sprite i for placement i: moves it, and re-sets its frame ONLY when the frame changed', () => {
    const { pool, made } = fakePool();
    pool.sync([at('creep:triangle:normal:standard', 10, 20)]);
    pool.sync([at('creep:triangle:normal:standard', 11, 21)]);
    expect(made[0]!.calls).toEqual(['setPosition 11,21']); // same frame: not re-set
    pool.sync([at('creep:triangle:low:standard', 12, 22)]); // it turned low-health
    expect(made[0]!.calls.slice(1)).toEqual([
      'setFrame creep:triangle:low:standard',
      'setPosition 12,22',
    ]);
    expect(pool.size).toBe(1);
  });

  it('hides every sprite past this frame’s count, and only once', () => {
    const { pool, made } = fakePool();
    pool.sync([at('a', 1), at('b', 2), at('c', 3)]);
    pool.sync([at('a', 1)]);
    expect(made.map((s) => s.visible)).toEqual([true, false, false]);
    pool.sync([at('a', 1)]);
    expect(made[1]!.calls.filter((c) => c.startsWith('setVisible'))).toEqual(['setVisible false']);
  });

  it('shows a hidden sprite again when a later frame places it', () => {
    const { pool, made } = fakePool();
    pool.sync([at('a', 1), at('b', 2)]);
    pool.sync([]);
    expect(made.map((s) => s.visible)).toEqual([false, false]);
    pool.sync([at('a', 5), at('b', 6)]);
    expect(made.map((s) => [s.visible, s.x])).toEqual([
      [true, 5],
      [true, 6],
    ]);
  });

  it('after hideAll (a Play-again reset) the next sync shows exactly what it places', () => {
    const { pool, made } = fakePool();
    pool.sync([at('a', 1), at('b', 2), at('c', 3)]);
    pool.hideAll();
    expect(made.every((s) => !s.visible)).toBe(true);
    pool.sync([at('a', 1), at('b', 2)]);
    expect(made.map((s) => s.visible)).toEqual([true, true, false]);
  });

  it('lists every sprite with the frame it shows, for a rebake to repoint', () => {
    const { pool } = fakePool();
    pool.sync([at('a', 1), at('b', 2)]);
    pool.sync([at('c', 1)]); // sprite 0 re-framed; sprite 1 hidden but still listed
    const seen: [number, string][] = [];
    pool.forEach((sprite, frame) => seen.push([sprite.id, frame]));
    expect(seen).toEqual([
      [0, 'c'],
      [1, 'b'],
    ]);
  });
});
