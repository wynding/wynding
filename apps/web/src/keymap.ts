// keymap.ts — the rebindable keyboard control map (GAG §2 "remappable controls"). Pure
// and session-scoped: a default binding of game ACTIONS to KeyboardEvent.code values,
// plus rebinding that keeps the map a bijection (assigning a code already bound to
// another action moves it, never leaving two actions on one key). Persistence of a
// custom layout waits for the ADR 0008 storage seam; here it lives for the session.

/** The arm-tower hotkey slots, catalog index 0..8 (`armTower1` = index 0). Nine is a
 *  ceiling, not a promise every slot is wired to a Card — `overlay.ts` and `input.ts`
 *  both no-op past `cards.length` (Codex R3-1's `towers[n]`/`cards[n]` guard). One list
 *  feeds the `GameAction` union below AND `DEFAULTS`' `Digit1`..`Digit9` bindings, so
 *  S5–S10 add a slot in one place instead of five files (PLAN.md P6, M2-S5a) — the
 *  chronic miss (S4a needed six coordinated edits and Codex caught one that was missed). */
export type ArmTowerAction = `armTower${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/** The bindable game actions (each has a catalog label under `action.*`). */
export type GameAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'confirm'
  | 'sell'
  | 'start'
  | 'pause'
  | 'speed'
  | ArmTowerAction;

/** The nine slot actions in catalog-index order, `overlay.ts`/`input.ts`'s single source
 *  for the arm-hotkey wiring (`ARM_HOTKEY_ACTIONS`, the rebind filter, the membership
 *  test in the keyboard switch) — see their own comments for what each does with it. */
export const ARM_TOWER_ACTIONS: readonly ArmTowerAction[] = Array.from(
  { length: 9 },
  (_, i) => `armTower${i + 1}` as ArmTowerAction,
);

const NON_SLOT_DEFAULTS: Readonly<Record<Exclude<GameAction, ArmTowerAction>, string>> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  confirm: 'Enter',
  sell: 'KeyX',
  // The primary action's key. WHAT it does is the app wiring's call, not this
  // table's: `main.ts` routes it through `primaryAction` (pre-start: unhold; then:
  // call the counting-down wave, sharing the Dock button's disabled-state gate),
  // while `input.ts`'s standalone default is a bare `controller.start()`.
  start: 'KeyC',
  pause: 'Space',
  speed: 'KeyF',
};

// Object-spread order is insertion order: the non-slot actions first, then
// `armTower1`..`armTower9` bound to `Digit1`..`Digit9` — preserving today's adjacency
// (the settings list renders in `GAME_ACTIONS`' order) and today's armTower1..3 →
// Digit1..3 bindings unchanged. Arming works at document scope (overlay.ts), not the
// board's own keydown switch, so it fires regardless of which element currently has
// focus (a Card, the board, or neither) — "any state" per the P2 table.
const DEFAULTS: Readonly<Record<GameAction, string>> = {
  ...NON_SLOT_DEFAULTS,
  ...(Object.fromEntries(ARM_TOWER_ACTIONS.map((action, i) => [action, `Digit${i + 1}`])) as Record<
    ArmTowerAction,
    string
  >),
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
