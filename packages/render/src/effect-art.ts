// effect-art.ts — the art of shots and combat feedback (visual pass C1/C2, #181), in the art
// kit's IR (`art-ir.ts`), the editable master as the towers' and creeps' art is. What does not
// change shape is baked into the board atlas (`art-frames.ts`'s `effectFrameSpecs`) and shown by
// pooled sprites: each shot's tracer, a creep's hit flash, the bounty pop's numerals and
// gem. What moves or grows is drawn live from the dimensions here (`shots.ts`,
// `combat-feedback.ts`): the stun arc, a lob's arc, the kill burst and the exit's leak pulse.
//
// UNITS. Shots and feedback are drawn in the style frame's own pixels at the cell it was drawn
// at, `FX_CELL`, so its numbers carry over as they are; `fxUnit` scales them to the board's
// cell, and never below `FX_MIN_UNIT_PX`, so a shot stays visible at a phone's cell size (the
// dot it replaces had a 2px floor). A hit flash is drawn in its creep's own units
// (`creep-art.ts`), and the bounty pop's numerals in their own glyph box.
//
// COLOURS. A shot is drawn in its tower's ROLE colour, per colour-vision mode, with a bright
// core mixed from it (`core`): the frame's cores are its role colours' tints, and mixing keeps
// that true in every mode. The kill burst wears the killed creep's family hue. The rest are the
// fixed feedback inks (`art-ink.ts`). `effectArtColour` resolves every token effect art uses.
//
// ORIGINAL ART (ADR 0002). The numerals are drawn here as strokes, in this file, not taken from
// any typeface: the canvas draws no text (ADR 0003 §3), and the pop is decoration — the HUD's
// bounty chip stays the value's accessible source.

import { ART_GEM, ART_GLYPH, ART_HIT_FLASH, ART_INK } from './art-ink';
import type { ArtColour, ArtShape } from './art-ir';
import { CREEP_BODY } from './creep-art';
import type { CreepShape } from './creep-paint';
import { roleColour, type Palette } from './palette';
import { ART_SHADOW } from './tower-art';
import { towerRoleFor, type TowerRole } from './tower-paint';

/** The style frame's cell, in its own pixels: the design units shots and feedback are drawn
 *  in, per cell. */
export const FX_CELL = 30;

/** The fewest CSS px a shot or feedback design unit is drawn at: below 15px cells a shot stops
 *  shrinking, so its head keeps about the 2px radius the dot before it had. */
export const FX_MIN_UNIT_PX = 0.5;

/** CSS px per shot or feedback design unit at `cellPx`. */
export function fxUnit(cellPx: number): number {
  return Math.max(FX_MIN_UNIT_PX, cellPx / FX_CELL);
}

/** How far a shot's core is mixed from its role colour toward white. */
export const SHOT_CORE_MIX = 0.8;

/** `a` mixed `t` of the way to `b`, channel by channel. */
export function mixColour(a: number, b: number, t: number): number {
  const ch = (shift: number): number => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

/** The colour `token` resolves to in effect art, in `pal`, for a shot of a tower of `role`. */
export function effectArtColour(token: ArtColour, pal: Palette, role: TowerRole): number {
  switch (token) {
    case 'role':
      return roleColour(pal, role);
    case 'core':
      return mixColour(roleColour(pal, role), 0xffffff, SHOT_CORE_MIX);
    case 'ink':
      return ART_INK;
    case 'shadow':
      return ART_SHADOW;
    case 'flash':
      return ART_HIT_FLASH;
    case 'glyph':
      return ART_GLYPH;
    case 'gem':
      return ART_GEM;
    default:
      throw new Error(`effect art has no '${token}' colour`);
  }
}

// ---- Shots (C2) ----

/** How a tower's shot looks. A `dot` is the shot before C2 — an id this table does not know
 *  keeps it. */
export type ShotStyle = 'bolt' | 'lob' | 'glob' | 'arc' | 'shard' | 'streak' | 'dot';

/** Each shipped tower's shot, the style frame's (`SHOT`): Basic's bolt, Splash's and Frost
 *  Splash's lob, Venom's glob, Stun's arc, Slow's ice shard and Anti-Air's streak. A mine has no
 *  shot — its detonation is shown by its scorch — and a beacon never fires. Keyed by catalog
 *  id, never by look, so an id the catalog has never heard of keeps the dot rather than taking
 *  Basic's bolt with Basic's look. */
const SHOT_STYLE_BY_TOWER: Readonly<Partial<Record<string, Exclude<ShotStyle, 'dot'>>>> = {
  basic: 'bolt',
  splash: 'lob',
  'frost-splash': 'lob',
  venom: 'glob',
  stun: 'arc',
  slow: 'shard',
  antiair: 'streak',
};

/** A shot's look: its style, and the role whose colour it is drawn in. */
export interface ShotLook {
  readonly style: ShotStyle;
  readonly role: TowerRole;
}

const SHOT_LOOKS = new Map<string, ShotLook>();

/** The look of a shot fired by a tower of `towerId` — the dot, in Basic's role, for an id the
 *  table does not know and for a shot whose tower is not known at all. Each id's look is kept:
 *  a frame asks once per shot. Total over any string, guarded like `towerFootprintMarkFor`. */
export function shotLookFor(towerId: string | undefined): ShotLook {
  const id = towerId ?? '';
  let look = SHOT_LOOKS.get(id);
  if (look === undefined) {
    const style = Object.prototype.hasOwnProperty.call(SHOT_STYLE_BY_TOWER, id)
      ? (SHOT_STYLE_BY_TOWER[id] as ShotStyle)
      : 'dot';
    look = { style, role: towerRoleFor(id) };
    SHOT_LOOKS.set(id, look);
  }
  return look;
}

/** Every look a shot of a known tower takes, deduplicated in table order — what the atlas bakes
 *  shots from: each look's tracer, but the stun arc's, which is drawn live, and each lob's
 *  landing ring. (A `Map` keeps a key where it was first set, so two towers sharing a look bake
 *  it once, in the first one's place.) */
export const SHOT_LOOKS_BAKED: readonly ShotLook[] = [
  ...new Map(
    Object.keys(SHOT_STYLE_BY_TOWER).map((id) => {
      const look = shotLookFor(id);
      return [`${look.style}:${look.role}`, look] as const;
    }),
  ).values(),
];

/** Every tracer below points along +x with its head at design (0, 0), where the shot is
 *  (`positionTracers`); a sprite turns it to the shot's heading about that point. */

/** Basic's bolt: a bright head trailing a short streak of its role colour. */
export const BOLT_ART: readonly ArtShape[] = [
  {
    kind: 'path',
    d: 'M-14 0H0',
    stroke: 'role',
    width: 2.4,
    minWidthPx: 1,
    cap: 'round',
    alpha: 0.55,
  },
  { kind: 'circle', cx: 0, cy: 0, r: 3.2, fill: 'core', stroke: 'role', width: 1.4 },
];

/** Venom's glob: a drop of its role colour, outlined in ink, with two drips behind it. */
export const GLOB_ART: readonly ArtShape[] = [
  { kind: 'circle', cx: -17, cy: 0, r: 1.6, fill: 'role', alpha: 0.6 },
  { kind: 'circle', cx: -9, cy: 0, r: 2.2, fill: 'role', alpha: 0.75 },
  { kind: 'circle', cx: 0, cy: 0, r: 4.4, fill: 'role', stroke: 'ink', width: 1.4 },
];

/** Slow's ice shard: a long diamond along its heading, outlined in ink, over a faint trail. */
export const SHARD_ART: readonly ArtShape[] = [
  { kind: 'path', d: 'M-20 0H-4', stroke: 'role', width: 1.2, minWidthPx: 1, alpha: 0.45 },
  {
    kind: 'polygon',
    points: [
      [7, 0],
      [0, 3.4],
      [-7, 0],
      [0, -3.4],
    ],
    fill: 'role',
    stroke: 'ink',
    width: 1.3,
    join: 'round',
  },
];

/** Anti-Air's streak: a long, thin trail behind a bright head — a shot climbing at a flyer. */
export const STREAK_ART: readonly ArtShape[] = [
  {
    kind: 'path',
    d: 'M-26 0H0',
    stroke: 'role',
    width: 2,
    minWidthPx: 1,
    cap: 'round',
    alpha: 0.5,
  },
  { kind: 'circle', cx: 0, cy: 0, r: 2.6, fill: 'core', stroke: 'role', width: 1.4 },
];

/** A lob's ball, drawn up its arc above the ground point the shot is at. */
export const LOB_BALL_ART: readonly ArtShape[] = [
  { kind: 'circle', cx: 0, cy: 0, r: 5, fill: 'role', stroke: 'ink', width: 1.6 },
];

/** A lob's shadow, on the ground under its ball. */
export const LOB_SHADOW_ART: readonly ArtShape[] = [
  { kind: 'ellipse', cx: 0, cy: 0, rx: 4.5, ry: 2, fill: 'shadow', alpha: 0.3 },
];

/** Where a lob will land: a dashed ring in its role colour, on the ground at its destination
 *  for its whole flight. */
export const LANDING_ART: readonly ArtShape[] = [
  {
    kind: 'circle',
    cx: 0,
    cy: 0,
    r: 16,
    stroke: 'role',
    width: 1.6,
    minWidthPx: 1,
    dash: [3, 3],
    dashMinPx: 1.5,
    alpha: 0.6,
  },
];

/** The art each baked tracer style draws. */
export const SHOT_ART: Readonly<
  Record<'bolt' | 'glob' | 'shard' | 'streak' | 'lob', readonly ArtShape[]>
> = {
  bolt: BOLT_ART,
  glob: GLOB_ART,
  shard: SHARD_ART,
  streak: STREAK_ART,
  lob: LOB_BALL_ART,
};

/** How high a lob's ball climbs, at the middle of its flight: this share of the flight's
 *  length, and never more than `LOB_MAX_RISE_CELLS`. The frame's arc rose about a cell and a
 *  half over a long lob; a short one rises less, as a thrown ball does. */
export const LOB_RISE = 0.4;
export const LOB_MAX_RISE_CELLS = 1.5;

/** A lob's path, dashed from the tower to where it lands: the frame's. Dashes, and the stroke
 *  and opacity, in design units. */
export const LOB_TRAIL = { dashes: 6, width: 1.4, alpha: 0.55 } as const;

/** Stun's arc: a fixed zigzag from the tower to the shot — the same zig every frame, so it
 *  never flickers — under-stroked by a wide, faint glow of its role colour, with a bright
 *  core: the frame's six segments, each corner `offset` design units off the line. */
export const STUN_ARC = {
  segments: 6,
  offset: 6,
  glowWidth: 4,
  glowAlpha: 0.35,
  coreWidth: 1.6,
} as const;

/** The dot a shot of an unknown tower keeps — the shot before C2: `max(2px, 0.15 cell)`. */
export const SHOT_DOT = { cells: 0.15, minPx: 2 } as const;

// ---- The hit flash (C1) ----

/** How much larger than its body a creep's hit flash is drawn: the frame's, just over its
 *  outline's middle, so the flash reads as the whole body turning white. */
export const HIT_FLASH_SCALE = 1.02;

/** A creep's hit flash: its body's silhouette, scaled `HIT_FLASH_SCALE` about its centre, filled
 *  white — no outline and no wings, which stay as they are. In the creep's design units. */
export function hitFlashArt(shape: CreepShape): readonly ArtShape[] {
  let art = FLASH_ART.get(shape);
  if (art === undefined) {
    art = [scaledSilhouette(CREEP_BODY[shape], HIT_FLASH_SCALE)];
    FLASH_ART.set(shape, art);
  }
  return art;
}

const FLASH_ART = new Map<CreepShape, readonly ArtShape[]>();

/** `body` scaled `k` about its centre and filled white, with no outline: a creep body is a
 *  polygon or a rounded rect (`CREEP_BODY`), and any other shape is refused. */
export function scaledSilhouette(body: ArtShape, k: number): ArtShape {
  switch (body.kind) {
    case 'polygon':
      return {
        kind: 'polygon',
        points: body.points.map(([x, y]) => [x * k, y * k] as const),
        fill: 'flash',
      };
    case 'rect':
      return {
        kind: 'rect',
        x: body.x * k,
        y: body.y * k,
        w: body.w * k,
        h: body.h * k,
        rx: body.rx * k,
        fill: 'flash',
      };
    default:
      throw new Error(`a creep body is a polygon or a rect, not a ${body.kind}`);
  }
}

// ---- The kill burst (C1), drawn live ----

/** A kill's burst, in design units for a creep of the base size — each family's scales with its
 *  size step (`CREEP_SIZE`): a white ring, and `shards.count` shards of the creep's family hue,
 *  each `r0` to `r1` out from its centre, the first `turn` radians past straight right. The
 *  frame's, as it draws the moment of the kill. */
export const KILL_BURST = {
  ring: { r: 9, width: 1.4, alpha: 0.6 },
  shards: { count: 7, r0: 7, r1: 15, width: 2.4, turn: 0.3 },
} as const;

// ---- The leak pulse (C1), drawn live ----

/** The exit's leak pulse: two rings in the lives colour about the exit's centre — the frame's,
 *  in design units. */
export const LEAK_RINGS = [
  { r: 14, width: 2.4, alpha: 0.9 },
  { r: 24, width: 1.4, alpha: 0.45 },
] as const;

// ---- The bounty pop's numerals and gem (C1) ----

/** The characters the bounty pop draws: a plus, then the bounty's digits. */
export type GlyphChar = '+' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** A numeral's box, glyph units: every glyph is drawn inside it, and the pop sets them
 *  `GLYPH_ADVANCE` apart. */
export const GLYPH_BOX = { w: 6, h: 9 } as const;
export const GLYPH_ADVANCE = 7;

/** The glyph box's height in cells, and its floor in CSS px: the frame's 12px numerals at its
 *  30px cell, and still readable at a phone's 10px cell. */
export const GLYPH_BOX_CELLS = 1 / 3;
export const GLYPH_MIN_PX = 8;

/** CSS px per glyph unit at `cellPx`. */
export function glyphUnit(cellPx: number): number {
  return Math.max(GLYPH_MIN_PX, cellPx * GLYPH_BOX_CELLS) / GLYPH_BOX.h;
}

/** Each numeral's strokes, in its glyph box: our own, drawn for this game. */
const GLYPH_PATHS: Readonly<Record<GlyphChar, string>> = {
  '+': 'M3 2.2V6.8M0.7 4.5H5.3',
  '0': 'M3 0.6C4.6 0.6 5.4 2.3 5.4 4.5C5.4 6.7 4.6 8.4 3 8.4C1.4 8.4 0.6 6.7 0.6 4.5C0.6 2.3 1.4 0.6 3 0.6Z',
  '1': 'M1.3 2.2L3.5 0.6V8.4',
  '2': 'M0.9 2.3C1.1 1.2 1.9 0.6 3 0.6C4.3 0.6 5.1 1.4 5.1 2.6C5.1 4.4 0.9 6 0.9 8.4H5.2',
  '3': 'M0.8 1.5C1.3 0.9 2.1 0.6 3 0.6C4.3 0.6 5.1 1.4 5.1 2.5C5.1 3.6 4.2 4.4 2.7 4.4C4.3 4.4 5.3 5.2 5.3 6.4C5.3 7.7 4.3 8.4 3 8.4C2 8.4 1.2 8.1 0.7 7.5',
  '4': 'M3.9 8.4V0.6L0.7 6H5.4',
  '5': 'M5 0.6H1.3L1 4.1C1.6 3.7 2.3 3.5 3 3.5C4.4 3.5 5.3 4.4 5.3 5.9C5.3 7.4 4.3 8.4 2.9 8.4C2 8.4 1.2 8.1 0.7 7.5',
  '6': 'M4.9 1C4.4 0.7 3.8 0.6 3.2 0.6C1.6 0.6 0.7 2.3 0.7 4.9C0.7 7.3 1.6 8.4 3 8.4C4.4 8.4 5.3 7.4 5.3 6C5.3 4.6 4.4 3.7 3.1 3.7C2 3.7 1.1 4.3 0.8 5.2',
  '7': 'M0.7 0.6H5.3L2.3 8.4',
  '8': 'M3 4.4C1.7 4.4 1 3.6 1 2.5C1 1.4 1.8 0.6 3 0.6C4.2 0.6 5 1.4 5 2.5C5 3.6 4.3 4.4 3 4.4C1.6 4.4 0.7 5.2 0.7 6.4C0.7 7.6 1.6 8.4 3 8.4C4.4 8.4 5.3 7.6 5.3 6.4C5.3 5.2 4.4 4.4 3 4.4Z',
  '9': 'M1.1 8C1.6 8.3 2.2 8.4 2.8 8.4C4.4 8.4 5.3 6.7 5.3 4.1C5.3 1.7 4.4 0.6 3 0.6C1.6 0.6 0.7 1.6 0.7 3C0.7 4.4 1.6 5.3 2.9 5.3C4 5.3 4.9 4.7 5.2 3.8',
};

/** Every glyph the pop draws, in the order they are baked: listed, since `Object.keys` would put
 *  the digit keys before the plus. */
export const GLYPH_CHARS: readonly GlyphChar[] = [
  '+',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
];

/** A numeral as the pop draws it: a wide ink stroke under a white one, both round-capped, so it
 *  reads over the floor, a tower or a creep — the frame's white numerals edged in ink. */
export function glyphArt(c: GlyphChar): readonly ArtShape[] {
  const d = GLYPH_PATHS[c];
  return [
    { kind: 'path', d, stroke: 'ink', width: 3.4, minWidthPx: 2, cap: 'round', join: 'round' },
    { kind: 'path', d, stroke: 'glyph', width: 1.7, minWidthPx: 1, cap: 'round', join: 'round' },
  ];
}

/** The pop's gem: the HUD's bounty gem (`apps/web/src/hud-icons.ts`), in its own units — 14
 *  across and 16 tall about its centre. */
export const GEM_ART: readonly ArtShape[] = [
  { kind: 'path', d: 'M0 -8L7 0L0 8L-7 0Z', fill: 'gem', stroke: 'ink', width: 1.2, join: 'round' },
  { kind: 'path', d: 'M-7 0H7M0 -8L-2.5 0L0 8L2.5 0Z', stroke: 'ink', width: 0.9, alpha: 0.55 },
];

/** The gem's half-width, in its units. */
export const GEM_HALF_W = 7;

/** Gem units per glyph unit: the gem stands about as tall as a numeral, as in the frame. */
export const GEM_SCALE = 0.55;
