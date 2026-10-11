// art-ink.ts — the fixed inks the art shares: the one ink every painted outline and glyph is
// edged in, and the few fixed colours combat feedback paints with (visual pass C1, #181). A leaf
// module, so a painter that needs only an ink (`board-draw.ts`, which edges the live creep cues
// in it; `combat-feedback.ts`, which draws the exit's leak pulse) can take it without importing
// the art it has no other business with; `tower-art.ts` re-exports the ink beside the other
// fixed art inks, for the importers that read them there.
//
// The feedback inks do not follow the colour-vision mode, and need not: each is decorative, and
// each matches the HUD chip whose value it echoes — the gem and the lives heart are fixed inks
// there too (`apps/web/src/ui.css`'s `--wy-bounty` and `--wy-lives`; `hud-icons.test.ts` holds
// the two equal) — so the board and the HUD show a bounty and a leak in the same colours.

/** Outline and glyph ink: near-black, so a head's silhouette and the glyph inside it read
 *  against every role colour (`palette.test.ts` gates ink against each, >= 3:1). */
export const ART_INK = 0x0b0e14;

/** A creep's hit flash: its body's silhouette, white (the style frame's). */
export const ART_HIT_FLASH = 0xffffff;

/** The bounty pop's numerals, white over an ink edge (the style frame's). */
export const ART_GLYPH = 0xffffff;

/** The bounty pop's gem: the HUD's bounty gem (`--wy-bounty`). */
export const ART_GEM = 0x7fd3ff;

/** The exit's leak pulse: the HUD's lives heart (`--wy-lives`), so the pulse reads as the life
 *  it cost. */
export const ART_LIVES = 0xff6b81;
