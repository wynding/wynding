// keymap.ts — the rebindable keyboard control map (GAG §2 "remappable controls"). Pure
// and session-scoped: a default binding of game ACTIONS to KeyboardEvent.code values,
// plus rebinding that keeps the map a bijection (assigning a code already bound to
// another action moves it, never leaving two actions on one key). Persistence of a
// custom layout waits for the ADR 0008 storage seam; here it lives for the session.

/** The bindable game actions (each has a catalog label under `action.*`). */
export type GameAction =
  'up' | 'down' | 'left' | 'right' | 'confirm' | 'sell' | 'start' | 'pause' | 'speed' | 'armTower1';

const DEFAULTS: Readonly<Record<GameAction, string>> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  confirm: 'Enter',
  sell: 'KeyX',
  // Triggers `start()` (PLAN.md P4): pre-start, launches the run (M1's one wave); a
  // no-op once already started (no later-wave UI in M1).
  start: 'KeyC',
  pause: 'Space',
  speed: 'KeyF',
  // Arms the M1 `basic` Card for placement (PLAN.md P2). Handled at document scope
  // (overlay.ts), not the board's own keydown switch, so it works regardless of which
  // element currently has focus (Card, board, or neither) — "any state" per the P2 table.
  armTower1: 'Digit1',
};

// Derived from DEFAULTS (insertion order) so the action list, the union, and the default
// bindings can never silently drift — a new action added to DEFAULTS is automatically
// bindable/resettable and shown in the settings UI.
export const GAME_ACTIONS: readonly GameAction[] = Object.keys(DEFAULTS) as GameAction[];

export interface Keymap {
  /** The KeyboardEvent.code currently bound to `action`, or null if the action is
   *  unbound (its key was reassigned to another action and not yet rebound). */
  codeFor(action: GameAction): string | null;
  /** The action a pressed `code` triggers, or null if unbound. */
  actionFor(code: string): GameAction | null;
  /** Bind `action` to `code`; if `code` was on another action, that action is left
   *  unbound (a key maps to at most one action). Returns the displaced action, if any. */
  rebind(action: GameAction, code: string): GameAction | null;
  /** Restore the default layout. */
  reset(): void;
  /** A snapshot of the whole action→code map (null code = unbound). */
  entries(): Array<[GameAction, string | null]>;
}

export function createKeymap(): Keymap {
  const map = new Map<GameAction, string>(Object.entries(DEFAULTS) as [GameAction, string][]);

  const actionFor = (code: string): GameAction | null => {
    for (const [action, bound] of map) if (bound === code) return action;
    return null;
  };

  return {
    // No DEFAULTS fallback: a displaced action is genuinely unbound (null) until the
    // player rebinds it, so the map stays a strict bijection and the UI never shows two
    // actions on one key.
    codeFor: (action) => map.get(action) ?? null,
    actionFor,
    rebind(action, code) {
      const displaced = actionFor(code);
      if (displaced === action) return null; // no-op: already bound here
      if (displaced !== null) map.delete(displaced); // that action is now unbound
      map.set(action, code);
      return displaced;
    },
    reset() {
      map.clear();
      for (const action of GAME_ACTIONS) map.set(action, DEFAULTS[action]);
    },
    entries: () => GAME_ACTIONS.map((a) => [a, map.get(a) ?? null] as [GameAction, string | null]),
  };
}
