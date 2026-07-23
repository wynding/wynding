// settings.ts — SESSION-SCOPED accessibility settings (GAG §2). Held in memory only: no
// localStorage, no direct persistence. Cross-session persistence is deferred to the ADR
// 0008 async `StorageDriver` seam (which does not exist yet); writing storage here would
// bypass that accepted architecture, so Story 6 settings reset on reload — the
// "remappable controls" GAG function is satisfied per-session. A tiny observer lets the
// UI + scene react when a setting changes.

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

/** Create a fresh session-scoped settings store. `initial` seeds it (e.g. from a media
 *  query for `prefers-reduced-motion` at boot — a read, not a persisted write). */
export function createSettings(initial?: Partial<Settings>): SettingsStore {
  const state: Settings = {
    colourMode: isColourMode(initial?.colourMode) ? initial.colourMode : 'default',
    // Coerce to a REAL boolean (not just `?? false`): a future untyped StorageDriver seed
    // could pass a truthy non-boolean, which would take wrong scene branches and break the
    // `on === state.reducedMotion` no-op guard in setReducedMotion.
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
