// sparks.ts — the impact sparks' lifetimes (lifted out of `scene.ts` for V2, #181). Phaser-
// free: the scene stamps sparks with its game clock, `board-frame.ts` draws the lit ones.
//
// The store bounds itself. Every intake drops the sparks already past their life, so a run of
// frames that draws nothing — before the first bake has succeeded, say — cannot pile them up.

import type { SparkPoint } from './types';

/** How long (ms) an impact spark stays lit. */
export const SPARK_MS = 180;

/** A spark's life in ms — cut to 0.4× under reduced motion. */
export function sparkLifeMs(reducedMotion: boolean): number {
  return reducedMotion ? SPARK_MS * 0.4 : SPARK_MS;
}

/** A spark still lit, and how far it has faded: `k` runs from 1 at its birth to 0 at the
 *  end of its life. */
export interface LiveSpark extends SparkPoint {
  readonly k: number;
}

export interface SparkStore {
  /** Points that arrive before the game clock runs (Phaser not READY): kept unstamped — the
   *  controller has already drained them, so dropping them would lose those flashes — and
   *  stamped at the first `intake`. Stamping them with a ~0 time would expire them at once. */
  hold(points: readonly SparkPoint[]): void;
  /** Stamp every held point and `points` at `now`, and drop every spark past its life. */
  intake(points: readonly SparkPoint[], now: number, reducedMotion: boolean): void;
  /** The sparks still lit at `now`, each with its fade, newest first — the order the board
   *  has always drawn them in. Drops the expired ones. */
  live(now: number, reducedMotion: boolean): LiveSpark[];
  /** Forget every spark, held or lit. */
  clear(): void;
  /** How many sparks are held or lit. */
  readonly size: number;
}

interface StampedSpark extends SparkPoint {
  readonly bornAt: number;
}

export function createSparkStore(): SparkStore {
  let held: SparkPoint[] = [];
  let lit: StampedSpark[] = [];
  const stamp = (p: SparkPoint, bornAt: number): StampedSpark => ({
    x: p.x,
    y: p.y,
    radiusFp: p.radiusFp,
    bornAt,
  });
  const prune = (now: number, reducedMotion: boolean): void => {
    const life = sparkLifeMs(reducedMotion);
    lit = lit.filter((s) => now - s.bornAt <= life);
  };
  return {
    hold(points) {
      for (const p of points) held.push({ x: p.x, y: p.y, radiusFp: p.radiusFp });
    },
    intake(points, now, reducedMotion) {
      for (const p of held) lit.push(stamp(p, now));
      held = [];
      for (const p of points) lit.push(stamp(p, now));
      prune(now, reducedMotion);
    },
    live(now, reducedMotion) {
      prune(now, reducedMotion);
      const life = sparkLifeMs(reducedMotion);
      const out: LiveSpark[] = [];
      for (let i = lit.length - 1; i >= 0; i--) {
        const s = lit[i] as StampedSpark;
        out.push({ x: s.x, y: s.y, radiusFp: s.radiusFp, k: 1 - (now - s.bornAt) / life });
      }
      return out;
    },
    clear() {
      held = [];
      lit = [];
    },
    get size() {
      return held.length + lit.length;
    },
  };
}
