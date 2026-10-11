// sprite-pool.ts — the pooled sprites of one board layer (V2, #181). Phaser-free: a sprite is
// anything with the calls below — a Phaser `Image` satisfies them structurally, the unit tests
// use a recorder. Sprites are created as a layer's count grows and never destroyed: one past
// this frame's count is hidden, and shown again when a later frame places it — after a
// Play-again `reset()` has hidden every one, say.
//
// ONE SHAPE FOR EVERY SPRITE (visual pass T3, QC round 2). A new sprite is given its alpha,
// origin, turn and visibility at once, in that order, even where they are the defaults, so
// every pooled sprite owns the same fields from birth. Phaser keeps those defaults on the
// prototype (its Alpha, Origin, Transform and Visible components), so a field set on only
// some sprites — a turned head's `_rotation`, a fading scorch's `_alpha`, a hidden sprite's
// `_visible` — would give those sprites a different hidden class from the rest, and every
// per-object loop in Phaser's render would slow down for all of them. A trace measured it when
// heads began to turn (ADR 0005, the T3 entry): Phaser's visibility filter took about three
// times as long, and drawing its images half as long again. Flip is never set, on any sprite.
// This rests on where Phaser 3.90 keeps those defaults, so a Phaser upgrade could change it:
// `sprite-pool.test.ts` fails on any other Phaser release until this is re-checked.

import type { SpritePlacement } from './placement';

/** The sprite surface a pool drives. */
export interface PoolSprite {
  readonly visible: boolean;
  readonly alpha: number;
  setPosition(x: number, y: number): unknown;
  setFrame(frame: string): unknown;
  setVisible(visible: boolean): unknown;
  setAlpha(alpha: number): unknown;
  /** Its origin, as fractions of its frame's width and height (Phaser keeps those fractions
   *  across a `setFrame`, and re-measures them against the new frame). */
  setOrigin(x: number, y: number): unknown;
  /** Its turn about its origin, radians clockwise. */
  setRotation(radians: number): unknown;
}

export interface SpritePool<S extends PoolSprite> {
  /**
   * Show `placements`: sprite `i` takes placement `i` — its frame, its alpha (a placement
   * without one is opaque), its origin and its rotation (the top-left and none unless it
   * says otherwise; on a reused sprite each of these is set only when it changed, and a new
   * sprite is given all of them), its position, and visibility.
   * Sprites are created as the count grows and every one past it is hidden. Creating them in
   * index order, at one depth, is what keeps a layer drawing in list order under Phaser's
   * stable depth sort — a later creep still covers an earlier one.
   */
  sync(placements: readonly SpritePlacement[]): void;
  /** Hide every sprite; the next `sync` shows exactly what it places. */
  hideAll(): void;
  /** Each sprite with the frame it shows — what a rebake repoints at the new atlas. */
  forEach(fn: (sprite: S, frame: string) => void): void;
  /** How many sprites exist, shown or hidden. */
  readonly size: number;
}

/** What the pool last set on a sprite, so it sets each only when it changes. Rotation is kept
 *  here rather than read back: Phaser wraps the angle it is given, so its reading need not
 *  equal the one placed. */
interface Shown {
  frame: string;
  originX: number;
  originY: number;
  rotation: number;
}

/** A pool whose new sprites come from `create`, which returns one already showing the
 *  placement it is given (its frame, at its position, visible) with its origin at its
 *  top-left and no turn. The pool then gives every new sprite its placement's alpha, origin
 *  and turn and makes it visible, each set even when it is the default (ONE SHAPE, above);
 *  a reused sprite is given each only when it changed. */
export function createSpritePool<S extends PoolSprite>(
  create: (placement: SpritePlacement) => S,
): SpritePool<S> {
  const sprites: S[] = [];
  const shown: Shown[] = [];
  return {
    sync(placements) {
      placements.forEach((p, i) => {
        const alpha = p.alpha ?? 1;
        const originX = p.originX ?? 0;
        const originY = p.originY ?? 0;
        const rotation = p.rotation ?? 0;
        const sprite = sprites[i];
        if (sprite === undefined) {
          const made = create(p);
          // Every field, every time, in one order: one shape for every pooled sprite.
          made.setAlpha(alpha);
          made.setOrigin(originX, originY);
          made.setRotation(rotation);
          made.setVisible(true);
          sprites.push(made);
          shown.push({ frame: p.frame, originX, originY, rotation });
          return;
        }
        const was = shown[i] as Shown;
        // The frame first: a new frame keeps the origin's fractions, re-measured against it,
        // so an origin set after it is the one that stands.
        if (was.frame !== p.frame) {
          sprite.setFrame(p.frame);
          was.frame = p.frame;
        }
        if (was.originX !== originX || was.originY !== originY) {
          sprite.setOrigin(originX, originY);
          was.originX = originX;
          was.originY = originY;
        }
        if (was.rotation !== rotation) {
          sprite.setRotation(rotation);
          was.rotation = rotation;
        }
        if (sprite.alpha !== alpha) sprite.setAlpha(alpha);
        sprite.setPosition(p.x, p.y);
        if (!sprite.visible) sprite.setVisible(true);
      });
      for (let i = placements.length; i < sprites.length; i++) {
        const sprite = sprites[i] as S;
        if (sprite.visible) sprite.setVisible(false);
      }
    },
    hideAll() {
      for (const sprite of sprites) if (sprite.visible) sprite.setVisible(false);
    },
    forEach(fn) {
      sprites.forEach((sprite, i) => fn(sprite, (shown[i] as Shown).frame));
    },
    get size() {
      return sprites.length;
    },
  };
}
