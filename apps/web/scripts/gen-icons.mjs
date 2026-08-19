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

// `console` is a Node runtime global here, supplied by eslint.config.mjs's Node-globals
// block. That block's glob was widened from `scripts/**` to `**/scripts/**` at M2-S10
// (CodeRabbit, PR #92) precisely because package-local script directories like this one
// were matched by nobody — so the `/* global console */` this file used to carry is now
// redundant, and `no-redeclare` says so.
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

/** The shared user-space canvas every variant below is authored on. */
const CANVAS = 100;

/**
 * The three shapes, as a group, on the 100×100 canvas. No ground — each caller below decides
 * whether one is painted behind them, because the Android adaptive foreground must not have
 * one.
 *
 * `inset` is the fraction of the canvas kept clear on every side. A maskable icon may be
 * cropped by the platform to any shape inside the "safe zone" — the centred circle of
 * radius 40% of the icon (the W3C manifest spec's definition) — so the maskable variant
 * pulls the artwork well inside that circle, while the plain variants use the full canvas.
 */
function markBody(inset) {
  const c = CANVAS / 2;
  const k = 1 - 2 * inset;
  return `<g transform="translate(${c} ${c}) scale(${k}) translate(${-c} ${-c})">
    <path d="M 22 74 L 22 50 L 50 50 L 50 26 L 78 26"
          fill="none" stroke="${PATH}" stroke-width="9"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="12" y="64" width="20" height="20" rx="3" fill="${TOWER}"/>
    <rect x="68" y="16" width="20" height="20" rx="3" fill="${EXIT}"/>
  </g>`;
}

/** Wrap SVG content on the shared 100×100 user-space canvas at a pixel `size`. */
function canvasSvg(size, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  ${content}
</svg>`;
}

const groundRect = `<rect width="${CANVAS}" height="${CANVAS}" fill="${GROUND}"/>`;

function markSvg(size, inset) {
  // Scale the artwork about the centre so every painted pixel stays within `1 - 2*inset`
  // of the canvas — for the maskable variant that keeps it inside the safe-zone circle.
  return canvasSvg(size, `${groundRect}${markBody(inset)}`);
}

/** Android adaptive FOREGROUND: artwork only, no ground — the layer is composited over the
 *  background layer and the platform masks the pair to whatever shape the launcher uses. */
function foregroundSvg(size, inset) {
  return canvasSvg(size, markBody(inset));
}

/** Android adaptive BACKGROUND: flat ground, no artwork. Every mask shape lands on navy. */
function backgroundSvg(size) {
  return canvasSvg(size, groundRect);
}

/** Splash: the mark small and centred on the ground, because the platform CROPS this image
 *  to each device's aspect ratio from the centre — anything near an edge is cut on some
 *  device. `fraction` is the share of the canvas the mark occupies. */
function splashSvg(size, fraction) {
  const offset = (CANVAS * (1 - fraction)) / 2;
  return canvasSvg(
    size,
    `${groundRect}<g transform="translate(${offset} ${offset}) scale(${fraction})">${markBody(0.06)}</g>`,
  );
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

/**
 * The native source artwork (#135, plan step 21/22).
 *
 * `apps/mobile` does NOT author a mark of its own: this script stays the single authoring
 * pipeline, and `@capacitor/assets` is the single downstream stage that derives the full
 * native matrix from what is written here — Android legacy density buckets, round icons,
 * adaptive layers, the Android 12+ splash, and iOS asset catalogs with valid
 * `Contents.json`. Hand-rolling that matrix here would be a second pipeline and a large
 * one, and dimension-only assertions over it would not prove any reference is complete.
 *
 * These live OUTSIDE `public/` deliberately. `public/` is copied verbatim into the web
 * build, and a 2732×2732 splash has no business being downloaded by a browser — these are
 * build-time source material for the native projects, not web assets.
 */
const NATIVE_OUT_DIR = join(HERE, '..', 'assets', 'native');

// Exactly the four `@capacitor/assets` reads in Full Control mode, and no more. There is
// deliberately no plain `icon.png`: that name belongs to the tool's Easy Mode, so in this mode
// it is never opened — verified by deleting it and regenerating, which produced a byte-identical
// iOS AppIcon. The plain icons (iOS, and Android's pre-API-26 legacy set) are COMPOSITED from
// the foreground over the background below, which is why authoring a fifth source would change
// nothing except add a file nobody reads.
const NATIVE = [
  // Adaptive foreground. WHICH STAGE OWNS THE SAFE ZONE MATTERS, and it is not this one:
  // `@capacitor/assets` wraps this image in `<inset android:inset="16.7%">` in the adaptive
  // icon XML it generates, which already reduces it to the central 72 of 108dp. Its contract
  // is therefore a near FULL-BLEED foreground — an image that also pre-insets gets the
  // allowance applied twice and ships a small mark floating in a large field. (It did: at an
  // earlier 0.19 the mark rendered at about two thirds its intended linear size.)
  //
  // So this inset only has to cover what the XML's does not: the mask inside that 72dp
  // square may be a CIRCLE, and the artwork's painted bounding box (about 76×68 of the 100
  // canvas) must keep its corners inside it. Canvas maps to 72dp, so the half-diagonal is
  // 0.72 × 0.9 × √(38² + 34²) ≈ 33.0dp against a 36dp radius — an 8% margin.
  { file: 'icon-foreground.png', size: 1024, svg: (size) => foregroundSvg(size, 0.05) },
  { file: 'icon-background.png', size: 1024, svg: backgroundSvg, opaque: true },
  // Splash, and its dark variant. Wynding's ground is already navy, so the two are the same
  // artwork — generated explicitly rather than omitted, because a missing `splash-dark.png`
  // makes the tool fall back to the light one and Android 12+ dark mode would then be
  // showing an image nobody chose.
  { file: 'splash.png', size: 2732, svg: (size) => splashSvg(size, 0.22), opaque: true },
  { file: 'splash-dark.png', size: 2732, svg: (size) => splashSvg(size, 0.22), opaque: true },
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(NATIVE_OUT_DIR, { recursive: true });
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

    for (const asset of NATIVE) {
      const page = await browser.newPage({
        viewport: { width: asset.size, height: asset.size },
        deviceScaleFactor: 1,
      });
      // The adaptive FOREGROUND must keep its transparency — it is composited over the
      // background layer, and an opaque square would defeat the launcher's mask entirely.
      // Every other native asset is fully opaque, like the PWA set above.
      const opaque = asset.opaque === true;
      const bg = opaque ? `background:${GROUND}` : 'background:transparent';
      await page.setContent(
        `<!doctype html><style>html,body{margin:0;padding:0;${bg}}</style>${asset.svg(asset.size)}`,
      );
      const buf = await page.screenshot({ type: 'png', omitBackground: !opaque });
      writeFileSync(join(NATIVE_OUT_DIR, asset.file), buf);
      await page.close();
      console.log(`icons: wrote native/${asset.file} (${asset.size}×${asset.size})`);
    }
  } finally {
    await browser.close();
  }
}

await main();
