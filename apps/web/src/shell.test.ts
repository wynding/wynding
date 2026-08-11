import { describe, it, expect } from 'vitest';
import { createShell, dockButtonParts, HOME_HREF } from './shell';

const TWO_CARDS = [{ towerId: 'basic' }, { towerId: 'slow' }] as const;
import { LAYOUT_REGIONS, REGION_ATTR } from './layout';

describe('shell — pinned DOM topology (PLAN.md P1)', () => {
  it('builds .wy-shell > header.wy-status (wordmark + .wy-hud + .wy-dock) + div.wy-main > .wy-stage > .wy-board + aside.wy-rail', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.root.className).toBe('wy-shell');

    const status = shell.root.querySelector(':scope > header.wy-status');
    expect(status).toBe(shell.status);
    expect(status!.querySelector('.wy-wordmark')!.textContent).toBe('Wynding');

    const main = shell.root.querySelector(':scope > div.wy-main')!;
    expect(main).not.toBeNull();
    const stage = main.querySelector(':scope > div.wy-stage')!;
    expect(stage).not.toBeNull();
    expect(stage.contains(shell.board)).toBe(true);
    const rail = main.querySelector(':scope > aside.wy-rail');
    expect(rail).toBe(shell.rail);
  });

  // Story 11's two-layouts contract §1, deliberate topology amendment #1 (decision 10's
  // enumerated exception to the Standard-unchanged promise): the Dock moves ONCE in the DOM,
  // permanently and in BOTH layouts, because an ancestor grid cannot place a grandchild —
  // the Compact status COLUMN has to own the controls it lays out. Standard RENDERING is
  // unchanged: ui.css positions it absolutely against `.wy-shell`, and `compact.spec.ts`
  // asserts it is still visible and hit-testable over the Stage.
  it('the Dock is a child of header.wy-status (NOT the Stage) in both layouts', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.status.contains(shell.dock.root)).toBe(true);
    const stage = shell.root.querySelector('.wy-stage')!;
    expect(stage.contains(shell.dock.root)).toBe(false);
    expect([...shell.status.children]).toEqual([shell.home, shell.hudBox, shell.dock.root]);
  });

  // The home affordance. STRUCTURAL ONLY: jsdom performs no CSS layout, so nothing here is
  // "measured" — every size, clipping, hit-test, focus-ring and grid-intersection claim is
  // Playwright's, in BOTH layouts, and lives in `apps/web/e2e/home.spec.ts`.
  it('wraps the board-mark and the existing wordmark in a.wy-home[href="/"]', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.home.tagName).toBe('A');
    expect(shell.home.className).toBe('wy-home');
    // The ATTRIBUTE, not `.href` — the IDL property resolves against the document base URL,
    // so it would read "http://localhost/" and prove nothing about what was authored. The
    // link must stay root-absolute so it is correct from `/play/` under any `--base`.
    expect(shell.home.getAttribute('href')).toBe('/');
    expect(HOME_HREF).toBe('/');
    // Mark first, then the wordmark it upgraded — one element, one "Wynding" in the bar.
    const mark = shell.home.querySelector('svg.wy-mark')!;
    const wordmark = shell.home.querySelector('.wy-wordmark')!;
    expect([...shell.home.children]).toEqual([mark, wordmark]);
    expect(wordmark.textContent).toBe('Wynding'); // unchanged by the move
  });

  it('names the home link from the catalog, with the mark as aria-hidden decoration', () => {
    const shell = createShell(document, TWO_CARDS);
    // ADR 0004: the accessible name is an externalized string on the ANCHOR, not the raw
    // `aria-label` the source mark shipped with.
    expect(shell.home.getAttribute('aria-label')).toBe('Wynding — home');
    const mark = shell.home.querySelector('svg.wy-mark')!;
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(mark.getAttribute('focusable')).toBe('false');
    // Decoration carries no name of its own — AT must never hear the link twice.
    expect(mark.getAttribute('aria-label')).toBeNull();
    expect(mark.getAttribute('role')).toBeNull();
    // …and no `title` either. A `title` matching the `aria-label` does not add a second NAME
    // (aria-label wins), but per accname it becomes the accessible DESCRIPTION — so AT would
    // read the name and then the identical description. The hover affordance is CSS instead.
    expect(shell.home.getAttribute('title')).toBeNull();
  });

  it('draws the canonical board-mark with the dark values hardcoded and no <style> block', () => {
    const shell = createShell(document, TWO_CARDS);
    const mark = shell.home.querySelector('svg.wy-mark')!;
    expect(mark.getAttribute('viewBox')).toBe('0 0 32 32');
    // A scoped `<style>` inside an inline SVG leaks its class names into the whole document,
    // and the game UI is fixed dark anyway — so the source mark's style block and its
    // `prefers-color-scheme` query are replaced by presentation attributes.
    expect(mark.querySelector('style')).toBeNull();
    // The four canonical shapes: grid edge, two tower-walls, vermilion route.
    const shapes = [...mark.children].map((el) => el.tagName);
    expect(shapes).toEqual(['rect', 'rect', 'rect', 'polyline']);
    const [edge, wallA, wallB, route] = [...mark.children];
    expect(edge!.getAttribute('stroke')).toBe('#e6e9ee');
    expect(edge!.getAttribute('fill')).toBe('none');
    expect(wallA!.getAttribute('fill')).toBe('#e6e9ee');
    expect(wallB!.getAttribute('fill')).toBe('#e6e9ee');
    expect(route!.getAttribute('points')).toBe('4,9 16,9 16,19 28,19');
    expect(route!.getAttribute('stroke')).toBe('#e8552f');
    // No intrinsic size attributes — `ui.css` sizes the mark per layout (~1.25rem beside the
    // Standard wordmark, ~2.5rem alone in the Compact column).
    expect(mark.getAttribute('width')).toBeNull();
    expect(mark.getAttribute('height')).toBeNull();
  });

  it('the home link is the Shell first tab stop, and starts visible and interactive', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.status.firstElementChild).toBe(shell.home);
    // The Shell ships it live-clear; `overlay.ts` is the only writer of these two.
    expect(shell.home.hasAttribute('inert')).toBe(false);
    expect(shell.home.dataset.live).toBeUndefined();
  });

  it('the board is focusable and carries its ARIA role (its aria-label is set dynamically by overlay.ts)', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.board.tabIndex).toBe(0);
    expect(shell.board.getAttribute('role')).toBe('application');
    // The board's `aria-label` names the live bound keys, so overlay.ts owns it (like the
    // Card hotkey badge) — the Shell scaffolding no longer bakes in default-key text.
    expect(shell.board.getAttribute('aria-label')).toBeNull();
  });

  it('the HUD group holds Lives/Bounty/Score/wave/preview/Stars, in that order (M2-S2: the wave preview surface sits near the countdown)', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.hudBox.className).toBe('wy-hud');
    expect(shell.hudBox.getAttribute('role')).toBe('group');
    expect([...shell.hudBox.children]).toEqual([
      shell.hud.lives.root,
      shell.hud.bounty.root,
      shell.hud.score.root,
      shell.hud.wave.root,
      shell.preview.root,
      shell.hud.stars.root,
    ]);
  });

  it('the wave preview surface starts hidden, with its title/list scaffolding empty', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.preview.root.hidden).toBe(true);
    expect(shell.preview.title.textContent).toBe('');
    expect(shell.preview.list.children).toHaveLength(0);
  });

  // Contract §1: the chips list is the bounded scrollport now that the Dock shares the
  // header, and a scrollable region must be operable without a pointer. The tab stop exists
  // in Standard too — an intentional accessibility improvement (decision 10).
  it('the chips list is the labelled, keyboard-reachable scrollport', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.hudBox.tabIndex).toBe(0);
    expect(shell.hudBox.getAttribute('aria-label')).toBe('Game status');
  });

  // Contract §4: dual-form chips. The full ICU message node is the chip's accessible text
  // in BOTH layouts; the glance node is aria-hidden so AT never hears the value twice.
  it('every chip carries a full-message node plus an aria-hidden glance node', () => {
    const shell = createShell(document, TWO_CARDS);
    for (const [slot, chip] of Object.entries(shell.hud)) {
      expect(chip.root.dataset.wyChip).toBe(slot);
      expect([...chip.root.children]).toEqual([chip.full, chip.glance]);
      expect(chip.full.className).toBe('wy-chip-full');
      expect(chip.glance.getAttribute('aria-hidden')).toBe('true');
      expect(chip.full.getAttribute('aria-hidden')).toBeNull();
    }
  });

  it('the Dock holds Pause/Speed/Settings + a hidden empty primary slot (no global Sell — PLAN.md P2 moves Sell into the Panel; no separate Call-wave button — PLAN.md P4 wires the primary slot as Start)', () => {
    const shell = createShell(document, TWO_CARDS);
    expect([...shell.dock.root.children]).toEqual([
      shell.dock.pause,
      shell.dock.speed,
      shell.dock.settings,
      shell.dock.primary,
    ]);
    expect(shell.dock.primary.hidden).toBe(true); // shown by overlay.ts's first render (P4)
  });

  // P1's Dock markup contract, both layouts: aria-hidden icon span + localized text span.
  it('every Dock button carries an aria-hidden icon span then its text span', () => {
    const shell = createShell(document, TWO_CARDS);
    const { pause, speed, settings, primary } = shell.dock;
    for (const btn of [pause, speed, settings, primary]) {
      const parts = dockButtonParts(btn);
      expect([...btn.children]).toEqual([parts.icon, parts.text]);
      expect(parts.icon.getAttribute('aria-hidden')).toBe('true');
      expect(parts.text.className).toBe('wy-btn-text');
    }
  });

  it('dockButtonParts throws on a button that does not carry the pinned spans', () => {
    const bare = document.createElement('button');
    expect(() => dockButtonParts(bare)).toThrow(/icon\/text spans/);
  });

  // Contract §5: the declared-region registry. Enforced geometrically end-to-end by
  // compact.spec.ts; asserted structurally here so a missing attribute fails fast in unit.
  it('declares every layout region via data-wy-region, and nothing else', () => {
    const shell = createShell(document, TWO_CARDS);
    const declared = [...shell.root.querySelectorAll(`[${REGION_ATTR}]`)].map((el) =>
      el.getAttribute(REGION_ATTR),
    );
    expect(new Set(declared)).toEqual(new Set(LAYOUT_REGIONS));
    // A Set hides DUPLICATE declarations — two elements claiming one region collapse into a
    // single member. Pin the exact per-region count (exactly one element each) so a duplicated
    // region fails here rather than passing the Set check.
    expect(declared.length).toBe(LAYOUT_REGIONS.length);
    for (const region of LAYOUT_REGIONS) {
      expect(
        shell.root.querySelectorAll(`[${REGION_ATTR}="${region}"]`).length,
        `exactly one element must declare region "${region}"`,
      ).toBe(1);
    }
    expect(shell.status.getAttribute(REGION_ATTR)).toBe('status');
    expect(shell.dock.root.getAttribute(REGION_ATTR)).toBe('dock');
    expect(shell.rail.getAttribute(REGION_ATTR)).toBe('rail');
    expect(shell.banner.root.getAttribute(REGION_ATTR)).toBe('banner');
    expect(shell.root.querySelector('.wy-stage')!.getAttribute(REGION_ATTR)).toBe('stage');
    // `.wy-main` is the enumerated structural exemption — it holds regions, it isn't one.
    expect(shell.root.querySelector('.wy-main')!.hasAttribute(REGION_ATTR)).toBe(false);
  });

  it('the Rail holds one Card per catalog tower then the (hidden) Panel, in that order (PLAN.md P2, M2-S3)', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.cards).toHaveLength(2);
    expect([...shell.rail.children]).toEqual([
      shell.cards[0]!.root,
      shell.cards[1]!.root,
      shell.panel.root,
    ]);
    for (const card of shell.cards) {
      expect(card.root.tagName).toBe('BUTTON');
      expect(card.root.getAttribute('aria-pressed')).toBe('false');
    }
    expect(shell.cards.map((c) => c.towerId)).toEqual(['basic', 'slow']);
    expect(shell.panel.root.hidden).toBe(true);
  });

  it('builds exactly one Card for a one-tower descriptor list', () => {
    const shell = createShell(document, [{ towerId: 'basic' }]);
    expect(shell.cards).toHaveLength(1);
    expect(shell.cards[0]!.towerId).toBe('basic');
  });

  it('carries a visually-hidden polite live region, always present in the DOM', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.live.getAttribute('role')).toBe('status');
    expect(shell.live.getAttribute('aria-live')).toBe('polite');
    expect(shell.root.contains(shell.live)).toBe(true);
  });

  it('destroy() removes the Shell from its parent', () => {
    const shell = createShell(document, TWO_CARDS);
    document.body.appendChild(shell.root);
    expect(document.body.contains(shell.root)).toBe(true);
    shell.destroy();
    expect(document.body.contains(shell.root)).toBe(false);
  });
});

// The playtest round's Shell additions: the preview's two homes and the Card's glyph tile.
describe('placePreview + Card swatches (playtest round)', () => {
  it('re-homes the ONE preview node between its Stage and hud homes, restoring the exact slot', () => {
    const shell = createShell(document, [{ towerId: 'basic' }]);
    const original = [...shell.hudBox.children];
    expect(original).toContain(shell.preview.root); // the hud slot is the boot default

    shell.placePreview('stage');
    expect(shell.preview.root.parentElement).toBe(shell.stage);
    // MOVED, never cloned: the same node object left the chips column (one AT surface).
    expect([...shell.hudBox.children]).not.toContain(shell.preview.root);

    shell.placePreview('hud');
    expect([...shell.hudBox.children]).toEqual(original); // byte-exact original order
    shell.destroy();
  });

  it('every Card leads with an aria-hidden canvas swatch — presentation only, no AT surface', () => {
    const shell = createShell(document, [{ towerId: 'basic' }, { towerId: 'slow' }]);
    for (const card of shell.cards) {
      expect(card.swatch.tagName).toBe('CANVAS');
      expect(card.swatch.getAttribute('aria-hidden')).toBe('true');
      expect(card.root.firstElementChild).toBe(card.swatch);
    }
    shell.destroy();
  });
});

// The conditional reparent (playtest round 4): an unconditional re-append on an
// already-homed preview would zero a reader's scrollTop on every ResizeObserver tick.
describe('placePreview — no-op when already home', () => {
  it('does not move an already-stage-homed preview (a sentinel keeps its position)', () => {
    const shell = createShell(document, [{ towerId: 'basic' }]);
    shell.placePreview('stage');
    const sentinel = document.createElement('div');
    shell.stage.append(sentinel); // now: [...board..., preview, sentinel]
    shell.placePreview('stage'); // must NOT re-append (which would put preview last again)
    expect(shell.stage.lastElementChild).toBe(sentinel);
    shell.placePreview('hud');
    shell.placePreview('hud'); // same on the hud side: the slot insert happens once
    const idx = [...shell.hudBox.children].indexOf(shell.preview.root);
    shell.placePreview('hud');
    expect([...shell.hudBox.children].indexOf(shell.preview.root)).toBe(idx);
    shell.destroy();
  });
});
