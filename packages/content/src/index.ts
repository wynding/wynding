// @wynding/content — board and wave data.
//
// Type shapes live in ./schema.ts and the authored data in ./boards.ts; this
// barrel re-exports both and holds no game logic. All AGPL-3.0-or-later, like the
// rest of the project (see ADR 0002).

export type { WaveEntry, Wave, Board } from './schema';
export { sampleBoard, boards } from './boards';
