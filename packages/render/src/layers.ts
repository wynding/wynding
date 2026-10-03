// layers.ts — the board canvas's draw order, as ONE constant (V2, #181).
//
// The board used to be one `Graphics`, cleared and re-recorded every frame, and its draw
// order was the order of the calls that recorded it. Static art now lives in textures shown
// by sprites, so the order is a property of the scene graph instead: every board object
// sits at its layer's depth, and Phaser draws lower depths first. What moves or comes and
// goes is still drawn live, split across three `Graphics` so each lands at its place in
// the stack:
//
//   board     the baked board texture — floor, border ring, entrance, exit
//   scorches  sprites: the fading scorch a spent mine leaves, on the floor (visual pass T4)
//   shells    live: every support-aura shell, UNDER every tower (M2-S8's rule, which used
//             to be "draw every shell before any body" and is now structural)
//   plates    sprites: committed towers' plates, each with its shadow and rim — or, for
//             the plateless mine, its floor-coloured pad, which keeps shells off its
//             footprint as a plate does
//   heads     sprites: committed towers' heads — boosted ones with their glow — over the
//             plates, a layer of their own so a head turns to aim without touching its plate
//   pending   sprites: pending builds — each one translucent picture with its dashed rim
//   effects   live: the selection ring/outline/blast spokes, then each shot's muzzle flash
//             or ring pulse (visual pass T3), then in-flight tracers
//   creeps    sprites: every creep silhouette
//   cues      live: every health pip and status cue, then the build ghost, then sparks
//
// Creep cues sit ABOVE every silhouette, so a creep's status cue is never hidden under a
// neighbour's body — the one ordering V2 changed on purpose (creeps used to draw one whole
// stack at a time). The visual pass split a tower into a plate and a head and put scorches
// on the floor under everything a tower draws; the rest keeps the order it had.

export const BOARD_LAYERS = [
  'board',
  'scorches',
  'shells',
  'plates',
  'heads',
  'pending',
  'effects',
  'creeps',
  'cues',
] as const;

export type BoardLayer = (typeof BOARD_LAYERS)[number];

/** The scene-graph depth of `layer`: its index in `BOARD_LAYERS`, so the array IS the order. */
export function layerDepth(layer: BoardLayer): number {
  return BOARD_LAYERS.indexOf(layer);
}
