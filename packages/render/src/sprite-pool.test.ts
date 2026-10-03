// sprite-pool.test.ts — the pooled sprites of a board layer, against recording sprites: growth,
// reuse (a frame or an alpha is re-set only when it changed), hiding what a frame does not
// place, and showing again what a later frame does — after a Play-again reset hid every one.

import { describe, it, expect } from 'vitest';
import { createSpritePool, type PoolSprite } from './sprite-pool';
import type { SpritePlacement } from './placement';

interface FakeSprite extends PoolSprite {
  readonly id: number;
  frame: string;
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
  originX: number;
  originY: number;
  rotation: number;
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
      alpha: 1, // opaque, as Phaser makes an image: the pool gives it its placement's alpha
      // At its top-left and unturned, as the scene makes one: the pool gives it the rest.
      originX: 0,
      originY: 0,
      rotation: 0,
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
      setAlpha(alpha) {
        this.calls.push(`setAlpha ${alpha}`);
        this.alpha = alpha;
      },
      setOrigin(x, y) {
        this.calls.push(`setOrigin ${x},${y}`);
        this.originX = x;
        this.originY = y;
      },
      setRotation(radians) {
        this.calls.push(`setRotation ${radians}`);
        this.rotation = radians;
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

  it('gives a sprite its placement’s alpha — new or reused, re-set ONLY when it changed, opaque when the placement has none', () => {
    // A scorch fades frame by frame (`placeScorches`); every other layer is opaque.
    const { pool, made } = fakePool();
    pool.sync([{ ...at('scorch', 1), alpha: 0.5 }]);
    // `create` makes it opaque; the pool gives it its alpha before anything else.
    expect(made[0]!.calls[0]).toBe('setAlpha 0.5');
    expect(made[0]!.alpha).toBe(0.5);
    pool.sync([{ ...at('scorch', 1), alpha: 0.25 }]);
    pool.sync([{ ...at('scorch', 1), alpha: 0.25 }]);
    pool.sync([at('scorch', 1)]); // the slot reused by an opaque placement
    expect(made[0]!.calls.filter((c) => c.startsWith('setAlpha'))).toEqual([
      'setAlpha 0.5',
      'setAlpha 0.25',
      'setAlpha 1',
    ]);
    expect(made[0]!.alpha).toBe(1);
    // An opaque placement makes an opaque sprite: no alpha call at all.
    pool.sync([at('scorch', 1), at('plate', 2)]);
    expect(made[1]!.calls.filter((c) => c.startsWith('setAlpha'))).toEqual([]);
  });

  it('gives a sprite its placement’s origin and turn — new or reused, re-set ONLY when changed, top-left and unturned when the placement has none', () => {
    // A turned head (`placeTowers`) is placed by its footprint centre; every other sprite by
    // its top-left.
    const { pool, made } = fakePool();
    const turned = (rotation: number): SpritePlacement => ({
      ...at('tower:head:plain:damage:committed', 40, 40),
      originX: 0.5,
      originY: 0.6,
      rotation,
    });
    pool.sync([turned(0.3)]);
    expect(made[0]!.calls).toEqual(['setOrigin 0.5,0.6', 'setRotation 0.3']);
    pool.sync([turned(0.3)]);
    pool.sync([turned(0.4)]); // still turning: only the turn changes
    expect(made[0]!.calls.slice(2)).toEqual([
      'setPosition 40,40',
      'setRotation 0.4',
      'setPosition 40,40',
    ]);
    // Back at rest: top-left and unturned again.
    pool.sync([at('tower:head:plain:damage:committed', 30, 30)]);
    expect(made[0]!.calls.slice(5)).toEqual([
      'setOrigin 0,0',
      'setRotation 0',
      'setPosition 30,30',
    ]);
    expect([made[0]!.originX, made[0]!.originY, made[0]!.rotation]).toEqual([0, 0, 0]);
    // A sprite made for a placement at rest gets neither call.
    pool.sync([at('a', 1), at('b', 2)]);
    expect(made[1]!.calls).toEqual([]);
  });

  it('re-frames a sprite BEFORE re-setting its origin, so the new origin is measured on the new frame', () => {
    // Phaser keeps an origin's fractions across a new frame and re-measures them against
    // it; the placement's own origin, set after, is the one that stands.
    const { pool, made } = fakePool();
    pool.sync([
      { ...at('tower:head:plain:damage:committed', 0), originX: 0.5, originY: 0.5, rotation: 1 },
    ]);
    pool.sync([
      { ...at('tower:head:arrow:air:committed', 0), originX: 0.4, originY: 0.45, rotation: 1 },
    ]);
    expect(made[0]!.calls).toEqual([
      'setOrigin 0.5,0.5', // made: given its origin and turn
      'setRotation 1',
      'setFrame tower:head:arrow:air:committed', // reused: the frame, then the origin
      'setOrigin 0.4,0.45',
      'setPosition 0,0', // the turn did not change
    ]);
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

  it('after hideAll (a Play-again reset) the next sync shows exactly what it places — new frames and places included', () => {
    const { pool, made } = fakePool();
    pool.sync([at('a', 1), at('b', 2), at('c', 3)]);
    pool.hideAll();
    expect(made.every((s) => !s.visible)).toBe(true);
    // The hidden sprites are reused for DIFFERENT frames at new places: each is re-framed,
    // moved and shown; the one left over stays hidden, as it was.
    pool.sync([at('x', 7), at('y', 8)]);
    expect(made.map((s) => [s.visible, s.frame, s.x])).toEqual([
      [true, 'x', 7],
      [true, 'y', 8],
      [false, 'c', 3],
    ]);
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
