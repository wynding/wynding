import { describe, it, expect } from 'vitest';
import { formatKeyLabel } from './keylabel';

describe('keylabel — the shared code→display/aria-keyshortcuts formatter (PLAN.md P2)', () => {
  it('maps digits, letters, Space, and arrows to their PLAN-specified labels', () => {
    expect(formatKeyLabel('Digit1')).toBe('1');
    expect(formatKeyLabel('KeyC')).toBe('C');
    expect(formatKeyLabel('Space')).toBe('Space');
    expect(formatKeyLabel('ArrowRight')).toBe('ArrowRight');
  });

  it('handles the generic Digit0-9 and KeyA-Z families, not just the specimen keys', () => {
    expect(formatKeyLabel('Digit0')).toBe('0');
    expect(formatKeyLabel('Digit9')).toBe('9');
    expect(formatKeyLabel('KeyA')).toBe('A');
    expect(formatKeyLabel('KeyZ')).toBe('Z');
  });

  it('maps every arrow direction, not just ArrowRight', () => {
    expect(formatKeyLabel('ArrowUp')).toBe('ArrowUp');
    expect(formatKeyLabel('ArrowDown')).toBe('ArrowDown');
    expect(formatKeyLabel('ArrowLeft')).toBe('ArrowLeft');
  });

  it('returns null for the explicit unbound state (code === null)', () => {
    expect(formatKeyLabel(null)).toBeNull();
  });

  it('falls back to identity for anything not one of the special-cased families', () => {
    expect(formatKeyLabel('Enter')).toBe('Enter');
    expect(formatKeyLabel('Escape')).toBe('Escape');
    expect(formatKeyLabel('Tab')).toBe('Tab');
    expect(formatKeyLabel('F1')).toBe('F1');
  });
});
