// layers.ts — the board canvas's draw order, as ONE constant (V2, #181).
//
// The board used to be one `Graphics`, cleared and re-recorded every frame, and its draw
// order was the order of the calls that recorded it. Static art now lives in textures shown
// by sprites, so the order is a property of the scene graph instead: every board object
// sits at its layer's depth, and Phaser draws lower depths first. What moves or comes and
// goes is still drawn live, split across three `Graphics` so each lands at its place in
// the stack:
//
//   board    the baked board texture — floor, border ring, entrance, exit
//   shells   live: every support-aura shell, UNDER every tower body (M2-S8's rule, which
//            used to be "draw every shell before any body" and is now structural)
//   towers   sprites: committed towers — body, footprint mark, the buffed ✦
//   pending  sprites: queued builds — the translucent outline and its mark
//   effects  live: the selection ring/outline/blast spokes, then in-flight tracers
//   creeps   sprites: every creep silhouette
//   cues     live: every health pip and status cue, then the build ghost, then sparks
//
// Creep cues sit ABOVE every silhouette, so a creep's status cue is never hidden under a
// neighbour's body — the one ordering this layout changed on purpose (creeps used to draw
// one whole stack at a time). Everything else keeps the order it was recorded in before.

export const BOARD_LAYERS = [
  'board',
  'shells',
  'towers',
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
