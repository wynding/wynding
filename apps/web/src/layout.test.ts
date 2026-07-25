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
import { COMPACT_QUERY, LAYOUT_REGIONS, REGION_ATTR, EXEMPT_CONTAINER_SELECTOR } from './layout';

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
});
