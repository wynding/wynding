// settings.ts — the in-memory accessibility settings store (GAG §2). It still holds no
// storage of its own and never will: writing `localStorage` from here is what would
// bypass ADR 0008's accepted architecture. What changed at #142 is that the seam it was
// waiting for now EXISTS — `@wynding/platform`'s async `StorageDriver`, wired in
// `persist.ts` — so `boot()` hydrates a seed from it before the first render and writes
// through on every change. This module's contract is unchanged: seed in, changes out,
// and a tiny observer so the UI + scene can react.

import { COLOUR_MODES, type ColourMode } from '@wynding/render';

/** The player-adjustable accessibility state. */
export interface Settings {
  colourMode: ColourMode;
  reducedMotion: boolean;
}

export type SettingsListener = (settings: Readonly<Settings>) => void;

export interface SettingsStore {
  get(): Readonly<Settings>;
  setColourMode(mode: ColourMode): void;
  setReducedMotion(on: boolean): void;
  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(listener: SettingsListener): () => void;
}

const VALID_MODES: ReadonlySet<ColourMode> = new Set(COLOUR_MODES);

const isColourMode = (value: unknown): value is ColourMode =>
  typeof value === 'string' && VALID_MODES.has(value as ColourMode);

/** What may seed a store. Both fields are `unknown` because the two real seed sources
 *  disagree about typing: `prefers-reduced-motion` is a genuine boolean, while a value
 *  read back through ADR 0008's `StorageDriver` is whatever JSON the device held. The
 *  guards below are what turn either into a `Settings`, and they were written for exactly
 *  that — see their comments. */
export interface SettingsSeed {
  readonly colourMode?: unknown;
  readonly reducedMotion?: unknown;
}

/** Create a fresh settings store. `initial` seeds it — from the `prefers-reduced-motion`
 *  media query, and (since #142) from the `StorageDriver` slot `persist.ts` hydrates
 *  before the first render. */
export function createSettings(initial?: SettingsSeed): SettingsStore {
  const state: Settings = {
    colourMode: isColourMode(initial?.colourMode) ? initial.colourMode : 'default',
    // Coerce to a REAL boolean (not just `?? false`): the untyped StorageDriver seed this
    // was written for now exists, and it can pass a truthy non-boolean — which would take
    // wrong scene branches and break the `on === state.reducedMotion` no-op guard in
    // setReducedMotion.
    reducedMotion: initial?.reducedMotion === true,
  };
  const listeners = new Set<SettingsListener>();

  const emit = (): void => {
    const snapshot = { ...state };
    for (const l of listeners) l(snapshot);
  };

  return {
    get: () => ({ ...state }),
    setColourMode(mode: ColourMode): void {
      if (!VALID_MODES.has(mode) || mode === state.colourMode) return;
      state.colourMode = mode;
      emit();
    },
    setReducedMotion(on: boolean): void {
      if (on === state.reducedMotion) return;
      state.reducedMotion = on;
      emit();
    },
    subscribe(listener: SettingsListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
