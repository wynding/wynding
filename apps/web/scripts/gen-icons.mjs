#!/usr/bin/env node
// gen-icons.mjs — regenerate the committed PWA icon PNGs (PLAN.md Story 11 P2).
//
// Run with `pnpm --filter @wynding/web gen:icons`. This is NOT part of `verify`/`build`:
// the PNGs are committed artefacts, and their CONTENT is verified by unit tests
// (`icons.test.ts` — exact dimensions, apple-touch opacity, maskable safe zone) plus the
// manifest schema test, so CI never needs a browser to keep them honest.
//
// It lives in the web package because that is where the Playwright dependency lives — the
// mark is authored below as inline SVG and rendered by a real browser, so the committed
// PNGs are exactly what a browser would paint rather than an approximation from a
// hand-rolled rasteriser.
//
// The mark is WORDLESS (an icon is shown at 48px on a home screen; a wordmark is unreadable
// there): a navy ground, the gold EXIT square, the blue TOWER block, and the path stroke
// that winds between them — the game's one idea, in three shapes.

/* global console */
// `console` is a Node runtime global here. The root `scripts/**` get it from eslint.config's
// globals block; this file sits under `apps/web/scripts/` (outside that block) and is not part
// of `verify`'s lint scope, so it declares the global locally rather than widening either.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'icons');

// Palette, kept in step with ui.css's tokens (`--wy-bg`, `--wy-focus`, `--wy-accent`).
const GROUND = '#0d1b2a';
const EXIT = '#ffd166';
const TOWER = '#4aa3ff';
const PATH = '#4d6a8a';

/**
 * The mark, on a 100×100 user-space canvas.
 *
 * `inset` is the fraction of the canvas kept clear on every side. A maskable icon may be
 * cropped by the platform to any shape inside the "safe zone" — the centred circle of
 * radius 40% of the icon (the W3C manifest spec's definition) — so the maskable variant
 * pulls the artwork well inside that circle, while the plain variants use the full canvas.
 */
function markSvg(size, inset) {
  const s = 100;
  const c = s / 2;
  // Scale the artwork about the centre so every painted pixel stays within `1 - 2*inset`
  // of the canvas — for the maskable variant that keeps it inside the safe-zone circle.
  const k = 1 - 2 * inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" fill="${GROUND}"/>
  <g transform="translate(${c} ${c}) scale(${k}) translate(${-c} ${-c})">
    <path d="M 22 74 L 22 50 L 50 50 L 50 26 L 78 26"
          fill="none" stroke="${PATH}" stroke-width="9"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="12" y="64" width="20" height="20" rx="3" fill="${TOWER}"/>
    <rect x="68" y="16" width="20" height="20" rx="3" fill="${EXIT}"/>
  </g>
</svg>`;
}

/** Every icon this script owns: the manifest's three plus the iOS home-screen icon. */
const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0.06 },
  { file: 'icon-512.png', size: 512, inset: 0.06 },
  // Maskable: artwork pulled inside the safe-zone circle (radius 40% of the icon), ground
  // painted edge to edge so any platform crop shape still lands on navy.
  { file: 'icon-maskable-512.png', size: 512, inset: 0.14 },
  // apple-touch-icon: iOS composites it onto its own background and applies its own corner
  // radius, so this one must be FULLY OPAQUE and must not pre-round its own corners.
  { file: 'apple-touch-icon.png', size: 180, inset: 0.08 },
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const icon of ICONS) {
      const page = await browser.newPage({
        viewport: { width: icon.size, height: icon.size },
        deviceScaleFactor: 1,
      });
      const svg = markSvg(icon.size, icon.inset);
      await page.setContent(
        `<!doctype html><style>html,body{margin:0;padding:0;background:${GROUND}}</style>${svg}`,
      );
      // `omitBackground: false` keeps the page background composited in, so every pixel is
      // opaque — the apple-touch-icon requirement, and harmless for the others.
      const buf = await page.screenshot({ type: 'png', omitBackground: false });
      writeFileSync(join(OUT_DIR, icon.file), buf);
      await page.close();
      console.log(`icons: wrote ${icon.file} (${icon.size}×${icon.size})`);
    }
  } finally {
    await browser.close();
  }
}

await main();
