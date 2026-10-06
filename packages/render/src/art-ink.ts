// art-ink.ts — the one fixed ink every painted outline and glyph shares. A leaf module, so a
// painter (`creep-paint.ts`) can take it without importing the tower art it has no other
// business with; `tower-art.ts` re-exports it for the importers that already read it there.

/** Outline and glyph ink: near-black, so a head's silhouette and the glyph inside it read
 *  against every role colour (`palette.test.ts` gates ink against each, >= 3:1). */
export const ART_INK = 0x0b0e14;
