import { describe, it, expect } from 'vitest';
import { createKeymap, GAME_ACTIONS, type ArmTowerAction } from './keymap';

describe('keymap — rebindable controls (GAG §2)', () => {
  it('starts on the default layout and resolves both directions', () => {
    const km = createKeymap();
    expect(km.codeFor('up')).toBe('ArrowUp');
    expect(km.actionFor('Enter')).toBe('confirm');
    expect(km.actionFor('KeyQ')).toBeNull();
    expect(km.entries()).toHaveLength(GAME_ACTIONS.length);
  });

  it('rebinds an action to a free key', () => {
    const km = createKeymap();
    expect(km.rebind('confirm', 'KeyE')).toBeNull(); // KeyE was free
    expect(km.codeFor('confirm')).toBe('KeyE');
    expect(km.actionFor('KeyE')).toBe('confirm');
  });

  it('moves a key off its old action when reassigned, leaving it unbound (bijection)', () => {
    const km = createKeymap();
    const displaced = km.rebind('sell', 'Enter'); // Enter was confirm
    expect(displaced).toBe('confirm');
    expect(km.actionFor('Enter')).toBe('sell');
    expect(km.codeFor('confirm')).toBeNull(); // confirm is now genuinely unbound, not masked
    // ...and rebinding it to a fresh key restores it.
    km.rebind('confirm', 'KeyG');
    expect(km.codeFor('confirm')).toBe('KeyG');
  });

  it('is a no-op when rebinding an action to the key it already holds', () => {
    const km = createKeymap();
    expect(km.rebind('up', 'ArrowUp')).toBeNull();
    expect(km.codeFor('up')).toBe('ArrowUp');
  });

  it('resets to defaults', () => {
    const km = createKeymap();
    km.rebind('pause', 'KeyP');
    km.reset();
    expect(km.codeFor('pause')).toBe('Space');
  });

  // M2-S3: armTower2 is inserted immediately after armTower1 (settings-list adjacency —
  // GAME_ACTIONS derives from DEFAULTS' insertion order), defaulted to Digit2.
  it('armTower2 is inserted right after armTower1, defaulted to Digit2', () => {
    const km = createKeymap();
    const idx1 = GAME_ACTIONS.indexOf('armTower1');
    const idx2 = GAME_ACTIONS.indexOf('armTower2');
    expect(idx2).toBe(idx1 + 1);
    expect(km.codeFor('armTower2')).toBe('Digit2');
    expect(km.actionFor('Digit2')).toBe('armTower2');
  });

  // M2-S4a: armTower3 continues the same slot-order adjacency right after armTower2,
  // defaulted to Digit3.
  it('armTower3 is inserted right after armTower2, defaulted to Digit3', () => {
    const km = createKeymap();
    const idx2 = GAME_ACTIONS.indexOf('armTower2');
    const idx3 = GAME_ACTIONS.indexOf('armTower3');
    expect(idx3).toBe(idx2 + 1);
    expect(km.codeFor('armTower3')).toBe('Digit3');
    expect(km.actionFor('Digit3')).toBe('armTower3');
  });

  // PLAN.md P6, M2-S5a: the slot-wiring generalization. armTower1..armTower3 must come out
  // byte-identical to before (Digit1..Digit3, contiguous, in order); armTower4..armTower9
  // continue the SAME adjacency and Digit-N pattern, generated rather than hand-written.
  it('generates armTower1..armTower9 contiguously, each defaulted to its own DigitN', () => {
    const km = createKeymap();
    for (let n = 1; n <= 9; n++) {
      const action = `armTower${n}` as ArmTowerAction;
      const idx = GAME_ACTIONS.indexOf(action);
      if (n > 1) {
        const prev = `armTower${n - 1}` as ArmTowerAction;
        expect(idx).toBe(GAME_ACTIONS.indexOf(prev) + 1);
      }
      expect(km.codeFor(action)).toBe(`Digit${n}`);
      expect(km.actionFor(`Digit${n}`)).toBe(action);
    }
  });

  it('a displaced slot binding leaves the displaced action unbound, not defaulted (keymap.ts:77)', () => {
    const km = createKeymap();
    // Steal armTower4's default key (Digit4) via an unrelated action.
    const displaced = km.rebind('up', 'Digit4');
    expect(displaced).toBe('armTower4');
    expect(km.codeFor('armTower4')).toBeNull(); // no DEFAULTS fallback
    expect(km.actionFor('Digit4')).toBe('up');
  });
});
