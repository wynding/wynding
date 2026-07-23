import { describe, it, expect } from 'vitest';
import { t, format } from './t';

describe('i18n t() — typed catalog accessor', () => {
  it('returns a plain message for a param-less key', () => {
    expect(t('app.title')).toBe('Wynding');
  });

  it('substitutes ICU {name} placeholders from params', () => {
    expect(t('hud.lives', { count: 7 })).toBe('Lives: 7');
    expect(t('controls.speed', { factor: 2 })).toBe('Speed: 2x');
    expect(t('results.summary', { score: 120, stars: 3 })).toBe('Score 120 — 3 of 3 stars');
  });

  it('leaves an unknown placeholder intact rather than dropping it silently', () => {
    expect(format('hello {who}', {})).toBe('hello {who}');
    expect(format('plain')).toBe('plain');
  });
});
