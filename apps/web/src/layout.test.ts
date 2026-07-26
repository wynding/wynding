// layout.test.ts — the mechanical synchronization gate for the ONE published Compact
// trigger (Story 11's two-layouts contract §3). `ui.css` cannot import a TypeScript
// constant, so the query text is necessarily duplicated there; this test makes that
// duplication SAFE by asserting, against the real stylesheet, that (a) the query appears in
// exactly one block and (b) it is string-equal to `COMPACT_QUERY`. Editing either side
// alone fails CI.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  COMPACT_QUERY,
  LAYOUT_REGIONS,
  REGION_ATTR,
  EXEMPT_CONTAINER_SELECTOR,
  EXEMPT_CONTENT_SELECTOR,
  EXEMPT_FROM_DECLARATION,
  WALKED_CONTAINERS,
} from './layout';

// `new URL('./ui.css', import.meta.url)` would normally suffice, but under the jsdom test
// environment the global `URL` is jsdom's DOM implementation, not Node's — resolve via
// node:url/node:path instead (the same approach ui-contrast.test.ts uses).
const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.css'), 'utf8');

/** Every `@media <prelude> {` prelude in the stylesheet, comments stripped first so a
 *  commented-out block can neither satisfy nor break the count. */
function mediaPreludes(source: string): string[] {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = /@media\s+([^{]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(uncommented)) !== null) out.push((m[1] as string).trim());
  return out;
}

describe('layout — the one published Compact trigger (contract §3)', () => {
  it('ui.css declares the Compact trigger in exactly ONE media block', () => {
    // The complement block (`not all and …`) also contains the `max-height` substring —
    // exclude `not`-prefixed preludes so only positive triggers are counted.
    const matching = mediaPreludes(css).filter(
      (p) => p.includes('max-height') && !p.startsWith('not'),
    );
    expect(matching).toHaveLength(1);
  });

  it("that block's query is string-equal to COMPACT_QUERY", () => {
    const matching = mediaPreludes(css).filter(
      (p) => p.includes('max-height') && !p.startsWith('not'),
    );
    expect(matching[0]).toBe(COMPACT_QUERY);
  });

  it('the Standard-only re-budget block is the exact gap-free COMPLEMENT of COMPACT_QUERY', () => {
    // ui.css cannot negate a TypeScript constant, so the Standard-only fork at the banner
    // re-budget is written as the query's NEGATION (`not all and <trigger>`), which is
    // gap-free for fractional viewport heights — `(min-height: 501px)` would leave e.g.
    // 500.5px (page zoom) matching NEITHER fork. Assert the pair stays complementary —
    // otherwise moving the trigger would strand the re-budget on a stale query.
    const matching = mediaPreludes(css).filter((p) => p.startsWith('not'));
    expect(matching).toEqual([`not all and ${COMPACT_QUERY}`]);
  });

  it('COMPACT_QUERY is height-keyed only (decision 1: viewport height alone, never pointer)', () => {
    expect(COMPACT_QUERY).not.toMatch(/pointer|width|hover/);
  });

  it('the region registry names the P1 regions and the exempt structural container', () => {
    expect([...LAYOUT_REGIONS]).toEqual(['status', 'stage', 'dock', 'rail', 'banner']);
    expect(REGION_ATTR).toBe('data-wy-region');
    expect(EXEMPT_CONTAINER_SELECTOR).toBe('.wy-main');
  });

  it('centralizes the probe walk/exemption vocabulary (contract §5, consumed by layout-probe)', () => {
    expect(EXEMPT_CONTENT_SELECTOR).toBe('.wy-wordmark, .wy-hud');
    expect(EXEMPT_FROM_DECLARATION).toBe('.wy-main, .wy-wordmark, .wy-hud');
    expect([...WALKED_CONTAINERS]).toEqual(['.wy-shell', '.wy-main', '.wy-status']);
  });
});

// Every custom-property declaration of `prop`, comments stripped first, so a token declared
// in more than one block (e.g. `--wy-rail-w`'s base + Compact override) yields both values
// and the caller can pick the one it means to assert on.
function tokenDecls(source: string, prop: string): string[] {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = new RegExp(`${prop}\\s*:\\s*([^;]+);`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(uncommented)) !== null) out.push((m[1] as string).trim());
  return out;
}

describe('layout — Compact fixed tracks grow by their safe-area inset (Codex P1)', () => {
  // A Compact region that spends a safe-area inset as INTERNAL padding while its grid track is
  // a fixed width starves the content by the inset (≈44–59px on a notched iPhone in
  // landscape, invisible in CI where env()=0). Pin that each such token grows its track by the
  // matching inset so the content keeps its intended min() width. Assert on the source text
  // rather than computed layout because jsdom resolves env() to nothing.
  it('--wy-compact-col grows its track by the left inset (`.wy-status` pads left)', () => {
    const decls = tokenDecls(css, '--wy-compact-col');
    expect(decls).toHaveLength(1);
    expect(decls[0]).toContain('min(4rem, 10vw)');
    expect(decls[0]).toContain('env(safe-area-inset-left');
  });

  it('the Compact --wy-rail-w override grows its track by the right inset (`.wy-rail` pads right)', () => {
    // `--wy-rail-w` is declared twice — the Standard base clamp and this Compact override;
    // pick the override by its distinctive `min(9rem, 28vw)` core.
    const override = tokenDecls(css, '--wy-rail-w').find((d) => d.includes('min(9rem, 28vw)'));
    expect(override).toBeDefined();
    expect(override).toContain('env(safe-area-inset-right');
  });
});
