// ui-contrast.test.ts — the permanent DOM contrast gate (ADR 0003 §2). Parses `ui.css`'s
// `:root` custom-property tokens by regex (ui.css stays the single source of truth — no
// dual-maintenance token file) and asserts WCAG ratios directly against the token values,
// so the gate fails loudly if a token is renamed/removed and can never silently detach.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// `new URL('./ui.css', import.meta.url)` would normally suffice, but under the jsdom test
// environment the global `URL` is jsdom's DOM implementation, not Node's — resolve via
// node:url/node:path instead so the file read is unaffected by the test environment.
const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.css'), 'utf8');

function parseTokens(source: string): Record<string, number> {
  const tokens: Record<string, number> = {};
  // A `--wy-*` declaration inside a media query or other selector must not keep the gate
  // green if the root token is removed, so scan only the `:root { ... }` block.
  const root = /:root\s*\{([^}]*)\}/s.exec(source)?.[1];
  if (root === undefined) throw new Error('missing :root token block');
  const re = /--wy-([a-z-]+):\s*(#[0-9a-f]{6})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(root)) !== null) {
    tokens[m[1]!.toLowerCase()] = parseInt(m[2]!.slice(1), 16);
  }
  return tokens;
}

function channels(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function relativeLuminance(hex: number): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const REQUIRED_TOKENS = ['bg', 'surface', 'fg', 'accent', 'focus', 'on-accent', 'board-bg'];

describe('DOM contrast gate — ui.css tokens (WCAG text ≥ 4.5:1, non-text ≥ 3:1)', () => {
  const tokens = parseTokens(css);

  it('declares every required token', () => {
    for (const name of REQUIRED_TOKENS) {
      expect(tokens[name], `missing --wy-${name} in ui.css :root`).toBeTypeOf('number');
    }
  });

  it('text pairs clear 4.5:1', () => {
    const pairs: Array<[string, string]> = [
      ['fg', 'bg'],
      ['fg', 'surface'],
      ['on-accent', 'accent'],
    ];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(tokens[fg]!, tokens[bg]!);
      expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('non-text pairs clear 3:1', () => {
    const pairs: Array<[string, string]> = [
      ['accent', 'bg'],
      ['accent', 'surface'],
      ['focus', 'bg'],
      ['focus', 'surface'],
      // The focus ring renders at the board's edge — its real adjacent fills are the
      // board backdrop and the page bg (gated above), both.
      ['focus', 'board-bg'],
    ];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(tokens[fg]!, tokens[bg]!);
      expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
    }
  });
});
