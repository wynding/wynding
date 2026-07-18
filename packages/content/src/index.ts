// @wynding/content — level and wave data.
//
// The type definitions (./schema.ts) and this barrel are AGPL-3.0-or-later
// *code*. The authored data *values* live in ./levels.ts and are CC-BY-SA 4.0
// content (see ../../../docs/adr/0002-asset-and-content-licensing.md). This file
// holds no game logic — it just re-exports the shapes and the data.

export type { WaveEntry, Wave, Level } from './schema';

// Authored content data (CC-BY-SA 4.0) — see ./levels.ts.
export { sampleLevel, levels } from './levels';
