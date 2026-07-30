import { describe, it, expect } from 'vitest';
import { createKeymap, GAME_ACTIONS } from './keymap';

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
});
