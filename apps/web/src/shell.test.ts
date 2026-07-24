import { describe, it, expect } from 'vitest';
import { createShell } from './shell';

describe('shell — pinned DOM topology (PLAN.md P1)', () => {
  it('builds .wy-shell > header.wy-status + div.wy-main > (.wy-stage > .wy-board + .wy-dock) + aside.wy-rail', () => {
    const shell = createShell(document);
    expect(shell.root.className).toBe('wy-shell');

    const status = shell.root.querySelector(':scope > header.wy-status');
    expect(status).not.toBeNull();
    expect(status!.querySelector('.wy-wordmark')!.textContent).toBe('Wynding');

    const main = shell.root.querySelector(':scope > div.wy-main')!;
    expect(main).not.toBeNull();
    const stage = main.querySelector(':scope > div.wy-stage')!;
    expect(stage).not.toBeNull();
    expect(stage.contains(shell.board)).toBe(true);
    expect(stage.contains(shell.dock.root)).toBe(true);
    const rail = main.querySelector(':scope > aside.wy-rail');
    expect(rail).toBe(shell.rail);
  });

  it('the board is focusable and carries its ARIA role/label', () => {
    const shell = createShell(document);
    expect(shell.board.tabIndex).toBe(0);
    expect(shell.board.getAttribute('role')).toBe('application');
    expect(shell.board.getAttribute('aria-label')).toContain('Game board');
  });

  it('the HUD group holds Lives/Bounty/Score/wave/Stars spans, in that order', () => {
    const shell = createShell(document);
    const hudBox = shell.hud.lives.parentElement!;
    expect(hudBox.className).toBe('wy-hud');
    expect(hudBox.getAttribute('role')).toBe('group');
    expect([...hudBox.children]).toEqual([
      shell.hud.lives,
      shell.hud.bounty,
      shell.hud.score,
      shell.hud.wave,
      shell.hud.stars,
    ]);
  });

  it('the Dock holds Pause/Speed/Call-wave/Sell/Settings + a hidden empty primary slot', () => {
    const shell = createShell(document);
    expect([...shell.dock.root.children]).toEqual([
      shell.dock.pause,
      shell.dock.speed,
      shell.dock.callWave,
      shell.dock.sell,
      shell.dock.settings,
      shell.dock.primary,
    ]);
    expect(shell.dock.primary.hidden).toBe(true); // wired in P4
  });

  it('the Rail starts empty (Cards land in P2)', () => {
    const shell = createShell(document);
    expect(shell.rail.childElementCount).toBe(0);
  });

  it('destroy() removes the Shell from its parent', () => {
    const shell = createShell(document);
    document.body.appendChild(shell.root);
    expect(document.body.contains(shell.root)).toBe(true);
    shell.destroy();
    expect(document.body.contains(shell.root)).toBe(false);
  });
});
