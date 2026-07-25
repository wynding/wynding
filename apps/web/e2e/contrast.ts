import { expect, type Page } from '@playwright/test';

// Shared WCAG relative-luminance / contrast-ratio helpers for the e2e specs — the
// real-browser counterpart to the unit contrast gates (palette.test.ts, ui-contrast.test.ts):
// these check the ACTUAL rendered colours via getComputedStyle, catching a future hardcoded
// hex or unused token that a static/token test cannot see.

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rl, gl, bl] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

export function parseRgb(css: string): [number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  if (m === null) throw new Error(`unparsable colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rendered-contrast spot check for one element: its own `color` against its own
 *  `background-color` (each pair has its own background — not the page's). */
export async function assertRenderedContrast(
  page: Page,
  selector: string,
  minRatio: number,
): Promise<void> {
  const colours = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
  const ratio = contrastRatio(parseRgb(colours.color), parseRgb(colours.background));
  expect(
    ratio,
    `${selector}: ${colours.color} on ${colours.background} = ${ratio.toFixed(2)}`,
  ).toBeGreaterThanOrEqual(minRatio);
}
