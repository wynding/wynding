import { describe, it, expect, vi } from 'vitest';
import { createSettings } from './settings';

describe('settings — session-scoped a11y store', () => {
  it('defaults to the base palette, motion on, and ignores an invalid seed', () => {
    expect(createSettings().get()).toEqual({ colourMode: 'default', reducedMotion: false });
    expect(createSettings({ colourMode: 'bogus' as never }).get().colourMode).toBe('default');
    expect(createSettings({ reducedMotion: true }).get().reducedMotion).toBe(true);
  });

  it('seeds a valid colour mode from the initializer', () => {
    expect(createSettings({ colourMode: 'protan' }).get().colourMode).toBe('protan');
  });

  it('sets a valid colour mode and notifies subscribers, but no-ops an unchanged/invalid one', () => {
    const s = createSettings();
    const seen: string[] = [];
    const off = s.subscribe((v) => seen.push(v.colourMode));
    s.setColourMode('protan');
    s.setColourMode('protan'); // unchanged → no emit
    s.setColourMode('nope' as never); // invalid → no emit
    expect(s.get().colourMode).toBe('protan');
    expect(seen).toEqual(['protan']);
    off();
    s.setColourMode('deutan');
    expect(seen).toEqual(['protan']); // unsubscribed
  });

  it('toggles reduced motion and emits only on a real change', () => {
    const s = createSettings();
    const cb = vi.fn();
    s.subscribe(cb);
    s.setReducedMotion(true);
    s.setReducedMotion(true);
    expect(s.get().reducedMotion).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
