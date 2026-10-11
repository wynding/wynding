// combat-feedback.ts — what the board shows when combat lands (visual pass C1, #181): a creep's
// hit flash, a kill's burst and bounty pop, and the exit's pulse on a leak. Pure and
// Phaser-free: `board-frame.ts` feeds the tracker once a frame and draws what it plans; the
// lives chip's shake is the web shell's (`apps/web`).
//
// WHAT TRIGGERS EACH. A HIT is a targeted shot reaching its impact while its target is still
// drawn: the tracker takes in each shot the first frame it is listed (the controller lists every
// shot a tick fires together, from the first frame after that tick until each lands — the fire
// tracker's rule, `tower-fire.ts`), and on the first frame whose render time reaches the shot's
// impact tick the creep it was aimed at flashes, if it is still drawn. One it killed is not
// drawn by then — the step that landed the shot has removed it — and its burst shows instead. A
// KILL and a LEAK come from the controller (`RenderOverlay.kills` and `leaks`), which reads them
// off the view models either side of each step and the ids the step reports as leaked.
//
// THE CLOCK is the wall clock the impact sparks fade on (`sparks.ts`), not render time: the
// frame's durations are wall-clock ones, and the rate bounds below are what a viewer sees in a
// second. So a pause lets a burst finish, and 2× speed brings kills twice as often but plays
// each at its own pace.
//
// PHOTOSENSITIVITY (ADR 0003, WCAG 2.3.1: no more than three flashes in any second). A creep's
// hit flashes begin at least `MIN_FLASH_GAP_MS` apart, however many towers hit it: a hit inside
// the gap shows nothing new, so four of one creep's flashes span more than a second. The exit's
// pulse plays `LEAK_PULSES` pulses and does not begin again until `LEAK_PULSE_GAP_MS` after it
// began, whatever leaks in between. The kill burst needs no bound: a creep dies once.
//
// REDUCE MOTION. The hit flash is the same: a white silhouette that fades where it is, with no
// motion to remove (the frame's motion table). The kill burst is its ring alone, fading in place
// at its own size, with no shards flying out; the bounty pop fades where it appears, without
// rising; the exit's pulse is one fade of its rings at their own size, not two that swell.

import { creepColour, type Palette } from './palette';
import { ART_HIT_FLASH, ART_LIVES } from './art-ink';
import { CREEP_SIZE } from './creep-art';
import { creepFamilyFor } from './creep-paint';
import { snapToDevicePx } from './device-px';
import {
  fxUnit,
  GEM_HALF_W,
  GEM_SCALE,
  GLYPH_ADVANCE,
  GLYPH_BOX,
  glyphUnit,
  KILL_BURST,
  LEAK_RINGS,
  type GlyphChar,
} from './effect-art';
import { GEM_FRAME_KEY, glyphFrameKey } from './art-frames';
import { anchorOf, type FrameAnchor, type SpritePlacement } from './placement';
import { MAX_FLASHES_PER_SECOND } from './tower-fire';
import type { KillVM, TracerVM } from './types';

/** How long a hit flash lasts, ms: the frame's 80 ms white overlay. */
export const HIT_FLASH_MS = 80;
/** A hit flash's opacity the instant it begins: the frame's. */
export const HIT_FLASH_ALPHA = 0.85;
/** The least time between the starts of two of one creep's hit flashes, ms: four of them then
 *  span three gaps, more than a second, so no second holds four, both ends counted (ADR 0003). */
export const MIN_FLASH_GAP_MS = Math.ceil(1000 / MAX_FLASHES_PER_SECOND);

/** How long a kill's burst lasts, ms: the frame's shards flying out over 260 ms. */
export const KILL_BURST_MS = 260;
/** How long a kill's bounty pop lasts, ms: the frame's 700 ms. */
export const BOUNTY_POP_MS = 700;
/** How far the pop rises over its life, design units (`fxUnit`): the frame's 18 px. */
export const BOUNTY_POP_RISE = 18;
/** Where the pop appears, design units above the kill's centre: the frame's, over where the
 *  creep's HP bar was. */
export const BOUNTY_POP_LIFT = 33;
/** The share of its life the pop holds at full opacity before it fades. */
export const BOUNTY_POP_HOLD = 0.4;

/** How long the exit's leak pulse lasts, ms, and how many pulses it plays in that time: the
 *  frame's two over 600 ms. */
export const LEAK_PULSE_MS = 600;
export const LEAK_PULSES = 2;
/** The least time between the starts of two leak pulses, ms. Two pulses of 300 ms each, then a
 *  wait until a full second from the first: at most three pulses fall in any second. */
export const LEAK_PULSE_GAP_MS = 1000;

/** How long a kill is kept, ms: the longer of its burst and its pop. */
const KILL_KEPT_MS = Math.max(KILL_BURST_MS, BOUNTY_POP_MS);

/** 1 at `sinceMs` = 0, falling linearly to 0 at `span`; 0 outside [0, span). */
function fade(sinceMs: number, span: number): number {
  return sinceMs >= 0 && sinceMs < span ? 1 - sinceMs / span : 0;
}

/** A hit flash's opacity `sinceMs` after it began: `HIT_FLASH_ALPHA`, fading linearly to
 *  nothing over `HIT_FLASH_MS`. */
export function hitFlashAlpha(sinceMs: number): number {
  return HIT_FLASH_ALPHA * fade(sinceMs, HIT_FLASH_MS);
}

/** What the tracker reads each frame. */
export interface FeedbackFrame {
  /** The wall clock, ms (the clock the impact sparks fade on). */
  readonly nowMs: number;
  /** Render time, in fractional ticks (`renderTimeOf`). */
  readonly renderTick: number;
  /** The shots in flight this frame (`RenderOverlay.tracers`). */
  readonly tracers: readonly TracerVM[];
  /** The creeps drawn this frame, by entity id. */
  readonly drawn: { has(id: number): boolean };
  /** The kills and leaks since the last frame (`RenderOverlay.kills`, `.leaks`). */
  readonly kills: readonly KillVM[];
  readonly leaks: number;
}

/** A kill still showing its burst or its pop: the kill, and how long ago it showed, ms. */
export interface LiveKill {
  readonly kill: KillVM;
  readonly sinceMs: number;
}

export interface FeedbackTracker {
  /** Take in one frame: land the hits now due, note the kills and leaks, and forget what has
   *  played out. */
  update(frame: FeedbackFrame): void;
  /** Creep `id`'s hit flash opacity as of the last update — 0 when it is not flashing. */
  flashOf(id: number): number;
  /** The kills still showing, oldest first, each with its age as of the last update. */
  kills(): readonly LiveKill[];
  /** How long ago the exit's leak pulse began, ms, as of the last update — null when it is not
   *  pulsing. */
  pulseSinceMs(): number | null;
  /** Forget everything — a new run starts with nothing showing. */
  reset(): void;
}

/** A targeted shot taken in and not yet landed: the creep it is aimed at, and when it lands. */
interface PendingHit {
  readonly targetId: number;
  readonly impactTick: number;
}

export function createFeedbackTracker(): FeedbackTracker {
  /** The shots taken in and not yet landed, in the order they were seen. */
  const pending: PendingHit[] = [];
  /** The latest launch tick taken in: a shot launched no later has been (the header). */
  let takenThrough = -Infinity;
  let lastTick = -Infinity;
  let now = -Infinity;
  /** When each creep's latest hit flash began, ms. */
  const flashedAt = new Map<number, number>();
  /** The kills still showing, oldest first, with the clock they arrived at. */
  let shown: { kill: KillVM; at: number }[] = [];
  let pulseAt: number | null = null;
  const live: LiveKill[] = [];

  const flash = (id: number): void => {
    const last = flashedAt.get(id);
    if (last === undefined || now - last >= MIN_FLASH_GAP_MS) flashedAt.set(id, now);
  };

  return {
    update({ nowMs, renderTick, tracers, drawn, kills, leaks }) {
      // Render time never runs backwards within a run: a frame earlier than the last is a run
      // gone by, and no shot it noted will land in this one.
      if (renderTick < lastTick) {
        pending.length = 0;
        takenThrough = -Infinity;
      }
      lastTick = renderTick;
      now = nowMs;
      let latest = takenThrough;
      for (const t of tracers) {
        if (t.launchTick <= takenThrough) continue;
        if (t.launchTick > latest) latest = t.launchTick;
        if (t.kind === 'targeted') pending.push({ targetId: t.targetId, impactTick: t.impactTick });
      }
      takenThrough = latest;
      if (pending.length > 0) {
        let kept = 0;
        for (const hit of pending) {
          if (renderTick >= hit.impactTick) {
            if (drawn.has(hit.targetId)) flash(hit.targetId);
          } else {
            pending[kept++] = hit;
          }
        }
        pending.length = kept;
      }
      // A flash's record is needed only as long as it bounds the next one.
      for (const [id, at] of flashedAt) if (now - at >= MIN_FLASH_GAP_MS) flashedAt.delete(id);
      for (const kill of kills) shown.push({ kill, at: now });
      if (shown.length > 0 && now - (shown[0] as { at: number }).at >= KILL_KEPT_MS) {
        shown = shown.filter((s) => now - s.at < KILL_KEPT_MS);
      }
      live.length = 0;
      for (const s of shown) live.push({ kill: s.kill, sinceMs: now - s.at });
      if (leaks > 0 && (pulseAt === null || now - pulseAt >= LEAK_PULSE_GAP_MS)) pulseAt = now;
    },
    flashOf(id) {
      const at = flashedAt.get(id);
      return at === undefined ? 0 : hitFlashAlpha(now - at);
    },
    kills() {
      return live;
    },
    pulseSinceMs() {
      if (pulseAt === null) return null;
      const since = now - pulseAt;
      return since < LEAK_PULSE_MS ? since : null;
    },
    reset() {
      pending.length = 0;
      takenThrough = -Infinity;
      lastTick = -Infinity;
      now = -Infinity;
      flashedAt.clear();
      shown = [];
      live.length = 0;
      pulseAt = null;
    },
  };
}

// ---- What each looks like, at a moment ----

/** A ring, or a straight shard, to stroke — CSS px. */
export type FeedbackStroke =
  | {
      readonly kind: 'ring';
      readonly x: number;
      readonly y: number;
      readonly r: number;
      readonly width: number;
      readonly colour: number;
      readonly alpha: number;
    }
  | {
      readonly kind: 'shard';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly width: number;
      readonly colour: number;
      readonly alpha: number;
    };

/** How far a kill burst's shards fly out over its life, design units: they start at the
 *  frame's 7 to 15 and end 8 further out. */
export const SHARD_TRAVEL = 8;
/** How much the burst's ring grows over its life, as a share of its radius. */
export const RING_GROWTH = 0.35;

/**
 * A kill's burst `sinceMs` after it, about its body's centre `at` (CSS px): a white ring and
 * `KILL_BURST.shards.count` shards in its family's hue, each sized by its family's size step —
 * the shards flying out and the ring swelling as both fade over `KILL_BURST_MS`. Under Reduce
 * motion, the ring alone, at its own size, fading in place. Empty once it has played out.
 */
export function killBurstStrokes(
  kill: Pick<KillVM, 'creepId' | 'boss'>,
  at: { readonly x: number; readonly y: number },
  sinceMs: number,
  reducedMotion: boolean,
  pal: Palette,
  cellPx: number,
): FeedbackStroke[] {
  const k = fade(sinceMs, KILL_BURST_MS);
  if (k === 0) return [];
  const family = creepFamilyFor(kill.creepId, kill.boss);
  const u = fxUnit(cellPx) * CREEP_SIZE[family];
  const p = 1 - k; // 0 → 1 over the burst's life
  const { ring, shards } = KILL_BURST;
  const out: FeedbackStroke[] = [
    {
      kind: 'ring',
      x: at.x,
      y: at.y,
      r: ring.r * u * (reducedMotion ? 1 : 1 + RING_GROWTH * p),
      width: Math.max(1, ring.width * u),
      colour: ART_HIT_FLASH,
      alpha: ring.alpha * k,
    },
  ];
  if (reducedMotion) return out;
  const hue = creepColour(pal, family);
  const travel = SHARD_TRAVEL * p;
  for (let i = 0; i < shards.count; i++) {
    const a = (i / shards.count) * 2 * Math.PI + shards.turn;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const r0 = (shards.r0 + travel) * u;
    const r1 = (shards.r1 + travel) * u;
    out.push({
      kind: 'shard',
      x1: at.x + r0 * c,
      y1: at.y + r0 * s,
      x2: at.x + r1 * c,
      y2: at.y + r1 * s,
      width: Math.max(1, shards.width * u),
      colour: hue,
      alpha: k,
    });
  }
  return out;
}

/** The characters a pop of `bounty` shows: a plus, then its digits. */
export function popChars(bounty: number): GlyphChar[] {
  return ['+', ...(String(Math.trunc(Math.abs(bounty))).split('') as GlyphChar[])];
}

/** The pop's opacity `sinceMs` after the kill: full for `BOUNTY_POP_HOLD` of its life, then
 *  fading to nothing at its end. */
export function popAlpha(sinceMs: number): number {
  if (!(sinceMs >= 0 && sinceMs < BOUNTY_POP_MS)) return 0;
  const p = sinceMs / BOUNTY_POP_MS;
  return p < BOUNTY_POP_HOLD ? 1 : (1 - p) / (1 - BOUNTY_POP_HOLD);
}

/**
 * A kill's bounty pop `sinceMs` after it, over its body's centre `at` (CSS px): the gem, then a
 * plus and the bounty's digits, each a baked glyph (`effect-art.ts`), in a row centred on the
 * kill, `BOUNTY_POP_LIFT` above it, rising `BOUNTY_POP_RISE` as it fades (`popAlpha`), easing
 * out. Under Reduce motion it fades where it appears. Each sprite sits on whole device pixels,
 * so the numerals stay crisp as they rise, and none rises above the canvas's top edge. No pop
 * for a kill that paid nothing, and none once it has played out.
 */
export function bountyPopPlacements(
  bounty: number,
  at: { readonly x: number; readonly y: number },
  sinceMs: number,
  reducedMotion: boolean,
  cellPx: number,
  dpr: number,
  frames: ReadonlyMap<string, FrameAnchor>,
): SpritePlacement[] {
  const alpha = popAlpha(sinceMs);
  if (alpha === 0 || !(bounty > 0)) return [];
  const u = fxUnit(cellPx);
  const gu = glyphUnit(cellPx);
  const p = sinceMs / BOUNTY_POP_MS;
  const rise = reducedMotion ? 0 : BOUNTY_POP_RISE * u * (1 - (1 - p) * (1 - p));
  const keys = [GEM_FRAME_KEY, ...popChars(bounty).map(glyphFrameKey)];
  const anchors = keys.map((key) => anchorOf(frames, key));
  // The row's centre line, its lift above the kill and risen — but never so high that a sprite's
  // top would leave the canvas. Anchors sit on whole texels, so the floor stays on the grid.
  let floor = 0;
  for (const a of anchors) floor = Math.max(floor, a.anchorY);
  const y = snapToDevicePx(Math.max(floor, at.y - BOUNTY_POP_LIFT * u - rise), dpr);
  const gemW = 2 * GEM_HALF_W * GEM_SCALE * gu;
  const glyphs = keys.length - 1;
  const width = gemW + gu + (glyphs - 1) * GLYPH_ADVANCE * gu + GLYPH_BOX.w * gu;
  // Each sprite's centre, left to right: the gem, a glyph's width apart from the numerals,
  // then each numeral `GLYPH_ADVANCE` on.
  const left = at.x - width / 2;
  return keys.map((key, i) => {
    const a = anchors[i] as FrameAnchor;
    const cx =
      i === 0
        ? left + gemW / 2
        : left + gemW + gu + (i - 1) * GLYPH_ADVANCE * gu + (GLYPH_BOX.w * gu) / 2;
    return { frame: key, x: snapToDevicePx(cx, dpr) - a.anchorX, y: y - a.anchorY, alpha };
  });
}

/** How large a leak pulse's rings swell over each pulse, as a share of their radius. */
export const PULSE_GROWTH = 0.3;

/**
 * The exit's leak pulse `sinceMs` after it began, about the exit's centre `at` (CSS px):
 * `LEAK_RINGS` in the lives colour, played `LEAK_PULSES` times over `LEAK_PULSE_MS`, each pulse
 * swelling its rings as they fade. Under Reduce motion, one fade of the rings at their own size
 * over the whole of it. Empty once it has played out.
 */
export function leakPulseStrokes(
  at: { readonly x: number; readonly y: number },
  sinceMs: number,
  reducedMotion: boolean,
  cellPx: number,
): FeedbackStroke[] {
  if (!(sinceMs >= 0 && sinceMs < LEAK_PULSE_MS)) return [];
  const u = fxUnit(cellPx);
  const each = LEAK_PULSE_MS / LEAK_PULSES;
  const k = reducedMotion ? fade(sinceMs, LEAK_PULSE_MS) : fade(sinceMs % each, each);
  const grow = reducedMotion ? 1 : 1 + PULSE_GROWTH * (1 - k);
  return LEAK_RINGS.map((ring) => ({
    kind: 'ring' as const,
    x: at.x,
    y: at.y,
    r: ring.r * u * grow,
    width: Math.max(1, ring.width * u),
    colour: ART_LIVES,
    alpha: ring.alpha * k,
  }));
}
