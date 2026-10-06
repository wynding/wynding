// ui-contrast.test.ts — the permanent DOM contrast gate (ADR 0003 §2). Parses `ui.css`'s
// `:root` custom-property tokens by regex (ui.css stays the single source of truth — no
// dual-maintenance token file) and asserts WCAG ratios directly against the token values,
// so the gate fails loudly if a token is renamed/removed and can never silently detach.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { COLOUR_MODES, resolvePalette } from '@wynding/render';

// `new URL('./ui.css', import.meta.url)` would normally suffice, but under the jsdom test
// environment the global `URL` is jsdom's DOM implementation, not Node's — resolve via
// node:url/node:path instead so the file read is unaffected by the test environment.
const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.css'), 'utf8');

function parseTokens(source: string): Record<string, number> {
  const tokens: Record<string, number> = {};
  // A `--wy-*` declaration inside a media query or other selector must not keep the gate
  // green if the root token is removed, so scan only the `:root { ... }` block. Strip block
  // comments first so a commented-out `--wy-*` declaration inside `:root` can't satisfy the
  // gate either.
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([^}]*)\}/s.exec(uncommented)?.[1];
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

// `armed` has no contrast PAIRING (the armed border is a redundant cue over the Card's
// gated accent-fill + on-accent flip — see its ui.css comment) but its EXISTENCE is gated
// here: deleting the token would make `border-color: var(--wy-armed)` fall back to
// `currentColor` (`--wy-on-accent` on the armed fill — near-invisible) with CI green.
const REQUIRED_TOKENS = [
  'bg',
  'surface',
  'fg',
  'accent',
  'focus',
  'armed',
  'on-accent',
  'board-bg',
  // M2-S12a P3: the pinned Panel's top edge. Deleting it would silently fall back to
  // `.wy-panel`'s ordinary 1.63:1 border against the Cards it now floats over.
  'panel-edge',
  // #181 (H1): the HUD's icon inks and the lives pill. Each is paired below against the
  // surface it is drawn on. (The countdown dial has no token: it is inked in the primary
  // control's own colours, gated in its own test below.)
  'fg-dim',
  'lives',
  'lives-pill',
  'bounty',
  'stars',
  'icon-ink',
];

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
      // #158: the survey's privacy-notice link is accent TEXT over the results dialog's
      // backdrop, which is near-black and darker than `bg`, so `bg` is the conservative
      // stand-in (the rule itself is gated below).
      ['accent', 'bg'],
      // #181 (H1/L1). The status row has no fill of its own, so its text sits on `bg`: the
      // score's dim "Score" label and the stars' "/ 3". The lives value is read on its pill.
      ['fg-dim', 'bg'],
      ['fg', 'lives-pill'],
      // The wave strip is a `surface` box: its title and counts (`fg`, gated above) and a
      // single-entry wave's dim name and clause.
      ['fg-dim', 'surface'],
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
      // M2-S12a P3. A pinned Panel stops being a resting seam between two same-plane boxes
      // and becomes the boundary between a floating overlay and the Cards beneath it, which
      // is ADR 0003's 3:1 UI-boundary case. axe cannot evaluate a rendered boundary, so this
      // is the only thing standing between the design and an invisible edge.
      ['panel-edge', 'surface'],
      // #152: the Standard Dock's scroll cue (track + chevrons) is drawn in `--wy-accent` in
      // the Dock's gutter, over the Stage's board backdrop — the only thing behind it.
      ['accent', 'board-bg'],
      // #158: the survey textarea's edge, over the results dialog's backdrop. The backdrop
      // is near-black and darker than `bg`, so `bg` is the conservative stand-in.
      ['panel-edge', 'bg'],
      // #181 (H1): the chip icons on the status row (`bg`). Decorative — each chip's full
      // message is its text alternative — so this gates legibility, not information. The
      // heart also sits on the lives pill, whose border is the same ink.
      ['lives', 'bg'],
      ['lives', 'lives-pill'],
      ['bounty', 'bg'],
      ['stars', 'bg'],
      // The gem's and star's outline and facets, against the fills they outline.
      ['icon-ink', 'bounty'],
      ['icon-ink', 'stars'],
    ];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(tokens[fg]!, tokens[bg]!);
      expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
    }
  });

  // #181 (L1): the wave strip's creep icons are inked from the ACTIVE colour-vision palette
  // (`hud-icons.ts`), not from a token here, and drawn on the strip's `surface`. Every mode's
  // body ink and airborne chevron must clear the non-text bar on that surface, or a mode switch
  // could leave a shape the player reads the wave by unreadable.
  it("every colour mode inks the strip's creep icons at 3:1 or better on its surface", () => {
    expect(COLOUR_MODES.length).toBeGreaterThan(1);
    for (const mode of COLOUR_MODES) {
      const pal = resolvePalette(mode);
      for (const [name, ink] of [
        ['creep', pal.creep],
        ['airborne', pal.airborne],
      ] as const) {
        const ratio = contrast(ink, tokens['surface']!);
        expect(ratio, `${mode} ${name} on surface = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          3.0,
        );
      }
    }
  });

  // #181 (QC): the countdown dial — a stopwatch face — is drawn INSIDE the primary Dock control
  // in that control's own text ink (`currentColor`): the ring, the crown and the remaining-time
  // wedge at full strength, the spent part of the face as the same ink, dimmed. Neither is a
  // token, so the rendered colours are derived here from the rules that paint them: the wedge
  // must clear 3:1 against the control's fill AND against the dimmed face it is drawn over — the
  // remaining share is the whole message — and the face's opacity is read from the stylesheet,
  // so a fainter or bolder face re-gates itself.
  it('the countdown dial reads on the primary control: the wedge against the fill and against the spent face', () => {
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const primary = /\n\.wy-primary\s*\{([^}]*)\}/.exec(uncommented)?.[1];
    expect(primary, 'missing the .wy-primary rule').toBeDefined();
    expect(primary!).toMatch(/background:\s*var\(--wy-accent\)/);
    expect(primary!).toMatch(/(^|[^-])color:\s*var\(--wy-on-accent\)/);
    const strokes = /\n\.wy-dial-ring,\s*\.wy-dial-crown,\s*\.wy-dial-wedge\s*\{([^}]*)\}/.exec(
      uncommented,
    )?.[1];
    expect(strokes, 'missing the dial inks rule').toBeDefined();
    expect(strokes!).toMatch(/stroke:\s*currentColor/);
    const track = /\n\.wy-dial-track\s*\{([^}]*)\}/.exec(uncommented)?.[1];
    expect(track, 'missing the dial face rule').toBeDefined();
    expect(track!).toMatch(/fill:\s*currentColor/);
    const alpha = Number(/fill-opacity:\s*([0-9.]+)/.exec(track ?? '')?.[1]);
    expect(alpha, 'the face carries an explicit fill-opacity').toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);

    const ink = tokens['on-accent']!;
    const fill = tokens['accent']!;
    // Source-over in sRGB, which is how the browser composites the track onto the fill.
    const [ir, ig, ib] = channels(ink);
    const [fr, fg, fb] = channels(fill);
    const mix = (a: number, b: number): number => Math.round(alpha * a + (1 - alpha) * b);
    const trackInk = (mix(ir, fr) << 16) | (mix(ig, fg) << 8) | mix(ib, fb);
    const onFill = contrast(ink, fill);
    const onTrack = contrast(ink, trackInk);
    expect(onFill, `dial on fill = ${onFill.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
    expect(onTrack, `dial on its track = ${onTrack.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
  });

  it('styles the survey privacy link in the accent, visited too (#158)', () => {
    // Without the rule the link falls back to the UA's link blue, about 2:1 on the dialog,
    // and axe cannot measure it there. The accent pair itself is gated above.
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.wy-survey-note a,\s*\.wy-survey-note a:visited\s*\{([^}]*)\}/.exec(uncommented);
    expect(rule, 'missing .wy-survey-note a / a:visited rule in ui.css').not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*var\(--wy-accent\)/);
  });
});
