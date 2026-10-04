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

  // HOSTED (ADR 0012, #146 consumer 3). Inside a Host, `/` resolves to the host's own root,
  // so the flow was: pause, tap the mark, confirm, lose the run, land on a blank view. The
  // mark stays — it is the app's identity in the bar and Compact's only branding — but every
  // trace of the link goes with the destination. Structural only, as above.
  it('hosted: the mark is a plain span — no href, no tab stop, no link name', () => {
    const shell = createShell(document, TWO_CARDS, { hosted: true });
    // A `span`, not an `<a>` with the href stripped. The two are equivalent to AT (an anchor
    // without `href` is already role-less and non-focusable), but only one of them cannot
    // REGAIN a destination by a later edit — and `a.wy-home:hover` in ui.css is keyed on the
    // element being an anchor, so the honest element is what removes the paint too.
    expect(shell.home.tagName).toBe('SPAN');
    expect(shell.home.hasAttribute('href')).toBe(false);
    // Not focusable: no tabindex of its own, and `span` has no implicit one. (jsdom reports
    // -1 for an element with no tabindex attribute and no implicitly-focusable tag.)
    expect(shell.home.hasAttribute('tabindex')).toBe(false);
    expect(shell.home.tabIndex).toBe(-1);
    // The name that announced an ACTION goes with the action. What is left is the ordinary
    // wordmark text, so AT hears "Wynding" and not "Wynding — home, link".
    expect(shell.home.getAttribute('aria-label')).toBeNull();
    expect(shell.home.getAttribute('role')).toBeNull();
  });

  it('hosted: the mark itself is untouched — same class, same artwork, same slot', () => {
    // Everything about the presentation is deliberately identical, so nothing in the grid,
    // the Compact column or the auto-hide fade moves between the two builds. The ONLY
    // difference is the link semantics asserted above.
    const web = createShell(document, TWO_CARDS);
    const hosted = createShell(document, TWO_CARDS, { hosted: true });
    for (const shell of [web, hosted]) {
      expect(shell.home.className).toBe('wy-home');
      expect(shell.status.firstElementChild).toBe(shell.home);
      const mark = shell.home.querySelector('svg.wy-mark')!;
      const wordmark = shell.home.querySelector('.wy-wordmark')!;
      expect([...shell.home.children]).toEqual([mark, wordmark]);
      expect(wordmark.textContent).toBe('Wynding');
      expect(mark.getAttribute('aria-hidden')).toBe('true');
      // Ships live-clear either way — `overlay.ts` drives `data-live`/`inert` on both forms.
      expect(shell.home.hasAttribute('inert')).toBe(false);
      expect(shell.home.dataset.live).toBeUndefined();
    }
  });

  it('an ABSENT declaration builds the web link (ADR 0012 constraint 3)', () => {
    // The deployed build passes no third argument at all — the default must be the anchor,
    // not merely a `hosted: false` that someone has to remember to pass.
    const shell = createShell(document, TWO_CARDS);
    expect(shell.home.tagName).toBe('A');
    expect(shell.home.getAttribute('href')).toBe(HOME_HREF);
    // …and an explicit `false` is the same thing, since a host declares itself or nothing.
    expect(createShell(document, TWO_CARDS, { hosted: false }).home.tagName).toBe('A');
  });

  it('the board is focusable and carries its ARIA role (its aria-label is set dynamically by overlay.ts)', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.board.tabIndex).toBe(0);
    expect(shell.board.getAttribute('role')).toBe('application');
    // The board's `aria-label` names the live bound keys, so overlay.ts owns it (like the
    // Card hotkey badge) — the Shell scaffolding no longer bakes in default-key text.
    expect(shell.board.getAttribute('aria-label')).toBeNull();
  });

  it('the HUD group holds wave/Lives/Bounty/Stars/Score/preview/board-summary, in that order (#181 QC: the countdown FIRST, so it always sits on the line the capped hud shows at rest; the strip LAST among the laid-out items; #79 appends the pollable summary last)', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.hudBox.className).toBe('wy-hud');
    expect(shell.hudBox.getAttribute('role')).toBe('group');
    expect([...shell.hudBox.children]).toEqual([
      shell.hud.wave.root,
      shell.hud.lives.root,
      shell.hud.bounty.root,
      shell.hud.stars.root,
      shell.hud.score.root,
      shell.preview.root,
      shell.statusSummary,
    ]);
  });

  it('the pollable board summary (#79) starts hidden, is aria-live="off", and is NOT a chip', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.statusSummary.hidden).toBe(true);
    expect(shell.statusSummary.textContent).toBe('');
    expect(shell.statusSummary.getAttribute('aria-live')).toBe('off');
    // Never `.wy-chip`: the dual-form chip contract (a visually-hidden `full` beside an
    // aria-hidden `glance`) does not apply here, and `layout-probe.ts`'s
    // `visibleChipAccessibleText` walks `.wy-hud > .wy-chip` — a summary wearing that
    // class would silently join the chip gate's subject list.
    expect(shell.statusSummary.classList.contains('wy-chip')).toBe(false);
  });

  it('the wave preview surface starts hidden, with its title/list scaffolding empty', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.preview.root.hidden).toBe(true);
    expect(shell.preview.title.textContent).toBe('');
    expect(shell.preview.list.children).toHaveLength(0);
  });

  // #181 QC: WebKit drops a list's semantics once it is styled `list-style: none` and laid out
  // as a flex row — the strip's form — so the role is stated, not implied.
  it('the wave preview list states its list role explicitly', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.preview.list.tagName).toBe('UL');
    expect(shell.preview.list.getAttribute('role')).toBe('list');
  });

  // #181 (L1): the preview has ONE home. It is built inside the chips list and nothing ever
  // moves it — the Stage never hosts it (the floating placement chain is gone).
  it('the wave preview lives in the chips list, never in the Stage', () => {
    const shell = createShell(document, TWO_CARDS);
    expect(shell.preview.root.parentElement).toBe(shell.hudBox);
    expect(shell.stage.contains(shell.preview.root)).toBe(false);
    expect('placePreview' in shell).toBe(false);
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

  // #181 (H1): the glance is [icon][value], led by an inline-SVG icon that is decoration
  // twice over (inside the aria-hidden glance AND aria-hidden itself). Two chips carry a
  // static, localized companion the style frame draws: the score's dim label before its value,
  // the stars' "/ 3" after it. The value is its own leaf, so a refresh rewrites only it (#98).
  it('every chip glance leads with its own aria-hidden SVG icon, then the value leaf', () => {
    const shell = createShell(document, TWO_CARDS);
    const shape = (slot: string): string[] =>
      [...shell.hud[slot as keyof typeof shell.hud].glance.children].map((c) =>
        c.tagName.toLowerCase() === 'svg' ? 'svg' : c.className,
      );
    expect(shape('lives')).toEqual(['svg', 'wy-chip-value']);
    expect(shape('bounty')).toEqual(['svg', 'wy-chip-value']);
    expect(shape('wave')).toEqual(['svg', 'wy-chip-value']);
    expect(shape('score')).toEqual(['svg', 'wy-chip-label', 'wy-chip-value']);
    expect(shape('stars')).toEqual(['svg', 'wy-chip-value', 'wy-chip-suffix']);
    for (const [slot, chip] of Object.entries(shell.hud)) {
      const icon = chip.glance.firstElementChild!;
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('focusable')).toBe('false');
      expect(icon.classList.contains(`wy-icon--${slot}`)).toBe(true);
      // The rewritten leaf is the glance's own value — or, for the countdown, the number in it.
      const valueBox = chip.glance.querySelector('.wy-chip-value')!;
      expect(valueBox.parentElement).toBe(chip.glance);
      expect(chip.value).toBe(slot === 'wave' ? valueBox.firstElementChild : valueBox);
      expect(chip.value.textContent).toBe('');
    }
    // The companions are written once, from the catalog (ADR 0004), never per frame.
    expect(shell.hud.score.glance.querySelector('.wy-chip-label')!.textContent).toBe('Score');
    expect(shell.hud.stars.glance.querySelector('.wy-chip-suffix')!.textContent).toBe('/ 3');
  });

  // #181 QC round 2: Compact's column is narrower than the countdown's value at 568×320 and
  // 175–200% text. Its unit is part of the value as read ("25s", one word in both layouts) but
  // static, after a `<wbr>` — the one place the value may wrap, so a digit never does.
  it('the countdown’s value is [number][<wbr>][unit]: the number is the rewritten leaf, the unit static from the catalog', () => {
    const shell = createShell(document, TWO_CARDS);
    const valueBox = shell.hud.wave.glance.querySelector('.wy-chip-value')!;
    expect(
      [...valueBox.childNodes].map((n) =>
        n.nodeName.toLowerCase() === 'wbr' ? 'wbr' : (n as Element).className,
      ),
    ).toEqual(['wy-chip-number', 'wbr', 'wy-chip-unit']);
    expect(shell.hud.wave.value).toBe(valueBox.firstElementChild);
    expect(valueBox.querySelector('.wy-chip-unit')!.textContent).toBe('s');
    // No other chip has a unit, or anywhere to wrap: its value box is its leaf.
    for (const slot of ['lives', 'bounty', 'stars', 'score'] as const) {
      expect(shell.hud[slot].glance.querySelector('.wy-chip-value')).toBe(shell.hud[slot].value);
      expect(shell.hud[slot].glance.querySelector('wbr, .wy-chip-unit')).toBeNull();
    }
  });

  it('the Dock holds Pause/Speed/Settings + a hidden empty primary slot (no global Sell — PLAN.md P2 moves Sell into the Panel; no separate Call-wave button — PLAN.md P4 wires the primary slot as Start)', () => {
    const shell = createShell(document, TWO_CARDS);
    // EXACTLY the four controls (#181 QC): the countdown dial is drawn inside the primary, never
    // as a Dock item of its own that could wrap onto a row.
    expect([...shell.dock.root.children]).toEqual([
      shell.dock.pause,
      shell.dock.speed,
      shell.dock.settings,
      shell.dock.primary,
    ]);
    expect(shell.dock.primary.hidden).toBe(true); // shown by overlay.ts's first render (P4)
  });

  // #181 (H1, QC): the countdown dial is decoration inside the primary control — the wave chip
  // is the readable AND the accessible countdown — so it is aria-hidden, carries no text and
  // nothing focusable, and is never a `.wy-btn`, the class the Dock's controls, the input
  // chrome selector and the Dock footprint measure key on.
  it('the countdown dial is aria-hidden decoration inside the primary control, hidden at boot', () => {
    const shell = createShell(document, TWO_CARDS);
    const { root, progress } = shell.dock.dial;
    expect(root.parentElement).toBe(shell.dock.primary);
    expect(shell.dock.primary.lastElementChild).toBe(root); // after the contract's two spans
    expect(root.className).toBe('wy-dial');
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.hidden).toBe(true); // overlay.ts shows it once there is a countdown to draw
    expect(root.classList.contains('wy-btn')).toBe(false);
    expect(root.querySelector('button, a, [tabindex]')).toBeNull(); // nothing focusable inside
    expect(root.contains(progress)).toBe(true);
    expect(root.textContent).toBe('');
    // The control's accessible name is still its label alone: the dial adds no text to it.
    expect(dockButtonParts(shell.dock.primary).text.textContent).toBe('');
    expect(shell.dock.primary.textContent).toBe('');
    for (const btn of [shell.dock.pause, shell.dock.speed, shell.dock.settings]) {
      expect(btn.querySelector('.wy-dial')).toBeNull();
    }
  });

  // P1's Dock markup contract, both layouts: aria-hidden icon span + localized text span.
  it('every Dock button carries an aria-hidden icon span then its text span', () => {
    const shell = createShell(document, TWO_CARDS);
    const { pause, speed, settings, primary } = shell.dock;
    for (const btn of [pause, speed, settings, primary]) {
      const parts = dockButtonParts(btn);
      // The primary also carries the countdown dial (#181), AFTER the contract's two spans.
      expect([...btn.children]).toEqual(
        btn === primary ? [parts.icon, parts.text, shell.dock.dial.root] : [parts.icon, parts.text],
      );
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

// The playtest round's Card glyph tile. (Its preview re-homing half went with #181's one home.)
describe('Card swatches (playtest round)', () => {
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
