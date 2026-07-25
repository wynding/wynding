import { describe, it, expect } from 'vitest';
import { createShell, dockButtonParts } from './shell';
import { LAYOUT_REGIONS, REGION_ATTR } from './layout';

describe('shell — pinned DOM topology (PLAN.md P1)', () => {
  it('builds .wy-shell > header.wy-status (wordmark + .wy-hud + .wy-dock) + div.wy-main > .wy-stage > .wy-board + aside.wy-rail', () => {
    const shell = createShell(document);
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
    const shell = createShell(document);
    expect(shell.status.contains(shell.dock.root)).toBe(true);
    const stage = shell.root.querySelector('.wy-stage')!;
    expect(stage.contains(shell.dock.root)).toBe(false);
    expect([...shell.status.children]).toEqual([
      shell.root.querySelector('.wy-wordmark'),
      shell.hudBox,
      shell.dock.root,
    ]);
  });

  it('the board is focusable and carries its ARIA role (its aria-label is set dynamically by overlay.ts)', () => {
    const shell = createShell(document);
    expect(shell.board.tabIndex).toBe(0);
    expect(shell.board.getAttribute('role')).toBe('application');
    // The board's `aria-label` names the live bound keys, so overlay.ts owns it (like the
    // Card hotkey badge) — the Shell scaffolding no longer bakes in default-key text.
    expect(shell.board.getAttribute('aria-label')).toBeNull();
  });

  it('the HUD group holds Lives/Bounty/Score/wave/Stars chips, in that order', () => {
    const shell = createShell(document);
    expect(shell.hudBox.className).toBe('wy-hud');
    expect(shell.hudBox.getAttribute('role')).toBe('group');
    expect([...shell.hudBox.children]).toEqual([
      shell.hud.lives.root,
      shell.hud.bounty.root,
      shell.hud.score.root,
      shell.hud.wave.root,
      shell.hud.stars.root,
    ]);
  });

  // Contract §1: the chips list is the bounded scrollport now that the Dock shares the
  // header, and a scrollable region must be operable without a pointer. The tab stop exists
  // in Standard too — an intentional accessibility improvement (decision 10).
  it('the chips list is the labelled, keyboard-reachable scrollport', () => {
    const shell = createShell(document);
    expect(shell.hudBox.tabIndex).toBe(0);
    expect(shell.hudBox.getAttribute('aria-label')).toBe('Game status');
  });

  // Contract §4: dual-form chips. The full ICU message node is the chip's accessible text
  // in BOTH layouts; the glance node is aria-hidden so AT never hears the value twice.
  it('every chip carries a full-message node plus an aria-hidden glance node', () => {
    const shell = createShell(document);
    for (const [slot, chip] of Object.entries(shell.hud)) {
      expect(chip.root.dataset.wyChip).toBe(slot);
      expect([...chip.root.children]).toEqual([chip.full, chip.glance]);
      expect(chip.full.className).toBe('wy-chip-full');
      expect(chip.glance.getAttribute('aria-hidden')).toBe('true');
      expect(chip.full.getAttribute('aria-hidden')).toBeNull();
    }
  });

  it('the Dock holds Pause/Speed/Settings + a hidden empty primary slot (no global Sell — PLAN.md P2 moves Sell into the Panel; no separate Call-wave button — PLAN.md P4 wires the primary slot as Start)', () => {
    const shell = createShell(document);
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
    const shell = createShell(document);
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
    const shell = createShell(document);
    const declared = [...shell.root.querySelectorAll(`[${REGION_ATTR}]`)].map((el) =>
      el.getAttribute(REGION_ATTR),
    );
    expect(new Set(declared)).toEqual(new Set(LAYOUT_REGIONS));
    expect(shell.status.getAttribute(REGION_ATTR)).toBe('status');
    expect(shell.dock.root.getAttribute(REGION_ATTR)).toBe('dock');
    expect(shell.rail.getAttribute(REGION_ATTR)).toBe('rail');
    expect(shell.root.querySelector('.wy-stage')!.getAttribute(REGION_ATTR)).toBe('stage');
    // `.wy-main` is the enumerated structural exemption — it holds regions, it isn't one.
    expect(shell.root.querySelector('.wy-main')!.hasAttribute(REGION_ATTR)).toBe(false);
  });

  it('the Rail holds the Card then the (hidden) Panel, in that order (PLAN.md P2)', () => {
    const shell = createShell(document);
    expect([...shell.rail.children]).toEqual([shell.card.root, shell.panel.root]);
    expect(shell.card.root.tagName).toBe('BUTTON');
    expect(shell.card.root.getAttribute('aria-pressed')).toBe('false');
    expect(shell.panel.root.hidden).toBe(true);
  });

  it('carries a visually-hidden polite live region, always present in the DOM', () => {
    const shell = createShell(document);
    expect(shell.live.getAttribute('role')).toBe('status');
    expect(shell.live.getAttribute('aria-live')).toBe('polite');
    expect(shell.root.contains(shell.live)).toBe(true);
  });

  it('destroy() removes the Shell from its parent', () => {
    const shell = createShell(document);
    document.body.appendChild(shell.root);
    expect(document.body.contains(shell.root)).toBe(true);
    shell.destroy();
    expect(document.body.contains(shell.root)).toBe(false);
  });
});
