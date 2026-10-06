import { afterEach, expect, it, vi } from 'vitest';
import { createResultsPanel } from './results-panel';

// results-panel.test.ts — the panel's own teardown (#181 H2). Its wiring under a real dialog is
// `overlay.test.ts`'s.
afterEach(() => vi.restoreAllMocks());

it('destroy drops the press guard: its document-wide listeners go with it', () => {
  const dialog = document.createElement('div');
  document.body.append(dialog);
  const panel = createResultsPanel(document, dialog);
  const removed = vi.spyOn(document, 'removeEventListener');
  panel.destroy();
  const types = removed.mock.calls.map(([type]) => type);
  expect(types).toEqual(
    expect.arrayContaining(['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'click']),
  );
  dialog.remove();
});
