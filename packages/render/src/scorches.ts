// scorches.ts — the scorch a mine leaves where it went off (visual pass T4, #181): which
// detonations the board has seen, and how far each scorch has faded. Pure and Phaser-free;
// `scene.ts` feeds it every `draw()`, before any early return, and shows what `live` returns
// as sprites on the floor layer (`placement.ts`'s `placeScorches`).
//
// DETECTION reads what the renderer is already handed, never the sim. A mine fires a blast
// whose origin IS its destination — it detonates on its own footprint centre, never leading
// a creep (`packages/sim/src/combat.ts`, the burst branch of the fire step) — so a blast
// tracer with `originX === destX && originY === destY` is a mine going off. No other blast
// in the catalog can look like that: `splash` and `frost-splash` lead a GROUND target, and
// no ground route crosses the centre of the tower's own blocked footprint.
//
// The tracer list is pruned once a shot lands, though, and a frame that covers two sim ticks
// (a slow frame, or 2× speed on a slow device) can step past a mine's whole one-tick flight
// before any frame sees its tracer. The blast's LANDING is never lost — impact points are
// accumulated per tick until a frame drains them (`RenderOverlay.sparks`) — and the
// controller marks a landing `detonation` when the shot that made it was a detonation
// (`SparkPoint.detonation`), so a marked landing no seen tracer already scorched is the same
// detonation seen from its other end, even if the mine itself was never drawn. Each
// detonation scorches once: a landing whose tracer was already seen is consumed, not
// scorched again.
//
// TIME is the sim's, in ticks: a scorch fades over `SCORCH_TICKS` of render time, so it
// holds while the game is paused (as every creep does) and fades in step with the game's
// speed. A fade, never a motion, so Reduce motion leaves it as it is. Render time never runs
// backwards within a run, so a scorch "born" after the time being drawn belongs to a time
// base that is gone (a new run the scene was not reset for) and is dropped.

import type { ScorchPoint } from './placement';
import type { SparkPoint, TracerVM } from './types';

/** How long a scorch takes to fade away: 4 s of game time at the 20 Hz tick. */
export const SCORCH_TICKS = 80;

/** What the tracker reads each frame — all of it already on the renderer's per-frame path. */
export interface ScorchFrame {
  /** The shots in flight this frame (`RenderOverlay.tracers`). */
  readonly tracers: readonly TracerVM[];
  /** The impacts that landed since the last frame (`RenderOverlay.sparks`). */
  readonly sparks: readonly SparkPoint[];
  /** Render time, in fractional ticks (`renderTimeOf`). */
  readonly renderTick: number;
}

export interface ScorchTracker {
  /** Take in one frame: start a scorch for every detonation not seen before. */
  update(frame: ScorchFrame): void;
  /** The scorches still showing at `renderTick`, each with its opacity — 1 when it was
   *  made, falling linearly to 0 over `SCORCH_TICKS`; gone ones are dropped. */
  live(renderTick: number): ScorchPoint[];
  /** Forget everything — a new run starts with a clean floor. */
  reset(): void;
}

/** Whether `t` is a mine detonating: a blast whose origin is its destination. */
export function isDetonation(t: TracerVM): t is Extract<TracerVM, { kind: 'blast' }> {
  return t.kind === 'blast' && t.originX === t.destX && t.originY === t.destY;
}

const pointKey = (x: number, y: number): string => `${x},${y}`;

interface Scorch {
  readonly x: number;
  readonly y: number;
  readonly bornTick: number;
}

export function createScorchTracker(): ScorchTracker {
  let scorches: Scorch[] = [];
  /** Detonation tracers already scorched, while they are still in the tracer list. */
  let seen = new Set<string>();
  /** Points scorched from a tracer whose landing has not arrived yet, so it is not
   *  scorched twice — a count, since two mines can share a centre across a rebuild. */
  const awaitingLanding = new Map<string, number>();

  return {
    update({ tracers, sparks, renderTick }) {
      const stillListed = new Set<string>();
      for (const t of tracers) {
        if (!isDetonation(t)) continue;
        const key = `${t.launchTick}@${pointKey(t.originX, t.originY)}`;
        stillListed.add(key);
        if (seen.has(key)) continue;
        scorches.push({ x: t.originX, y: t.originY, bornTick: renderTick });
        const at = pointKey(t.originX, t.originY);
        awaitingLanding.set(at, (awaitingLanding.get(at) ?? 0) + 1);
      }
      seen = stillListed;

      for (const s of sparks) {
        if (s.radiusFp <= 0) continue;
        const at = pointKey(s.x, s.y);
        const waiting = awaitingLanding.get(at) ?? 0;
        if (waiting > 0) {
          // The landing of a detonation already scorched from its tracer.
          if (waiting === 1) awaitingLanding.delete(at);
          else awaitingLanding.set(at, waiting - 1);
        } else if (s.detonation === true) {
          // A detonation's landing whose tracer came and went between two frames.
          scorches.push({ x: s.x, y: s.y, bornTick: renderTick });
        }
      }
    },
    live(renderTick) {
      scorches = scorches.filter((s) => {
        const age = renderTick - s.bornTick;
        return age >= 0 && age < SCORCH_TICKS;
      });
      return scorches.map((s) => ({
        x: s.x,
        y: s.y,
        alpha: 1 - (renderTick - s.bornTick) / SCORCH_TICKS,
      }));
    },
    reset() {
      scorches = [];
      seen = new Set();
      awaitingLanding.clear();
    },
  };
}
