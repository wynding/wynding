import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { stubFullscreen } from './fullscreen-stub';

// leak-cue.spec.ts — the lives chip's leak cue (#181 C1) in a real run, end to end. A creep
// reaching the exit sets `data-wy-leak` on the lives chip in the very frame its count drops
// (`main.ts`, through `leak-cue.ts`); `ui.css` then turns the chip red and shakes it, or under
// Reduce motion turns it red and holds it still; the cue clears after its span; and however
// fast creeps leak, a cue begins at most once a second (ADR 0003, WCAG 2.3.1). The unit tests
// pin the pieces — `leak-cue.test.ts` the timing, `overlay.test.ts` the attribute,
// `ui-contrast.test.ts` the red's contrast — but only a browser runs `main.ts`'s wiring and
// draws the CSS, so only this sees the two together.

/** One thing the recorder saw, at the frame time `main.ts` ran the cue on. */
interface CueEvent {
  readonly kind: 'lives' | 'on' | 'off';
  readonly t: number;
  /** The frame time of the frame before. */
  readonly prev: number;
  readonly lives: string;
  readonly bg?: string;
  readonly anim?: string;
}

interface Recording {
  readonly events: CueEvent[];
  /** Per cue: the glance's offset from its chip at each tenth of its shake's span, read by
   *  seeking the running animation (so a runner that draws few frames reads the same), or once,
   *  at rest, when no animation runs. A shake whose duration is not a number has no tenths to
   *  seek: it is recorded as one sample that is not a number either (`NaN`), which the test
   *  fails on by name rather than reading a sway from it. */
  readonly sway: number[][];
}

declare global {
  interface Window {
    __wyLeak?: Recording;
    __wyFrameNow?: number;
    __wyPrevFrameNow?: number;
  }
}

/** Keep the timestamp every animation frame hands its callbacks — the `now` `main.ts`'s frame
 *  loop runs the cue on — and the frame's before it, readable by the recorder. Records only;
 *  every callback still runs. */
async function stampFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      raf((ts) => {
        if (ts !== window.__wyFrameNow) {
          window.__wyPrevFrameNow = window.__wyFrameNow;
          window.__wyFrameNow = ts;
        }
        cb(ts);
      });
  });
}

/** Record every change of the lives count and of the cue, with what the glance looks like the
 *  moment the cue turns on or off, and read the glance's sway for each cue. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('.wy-chip[data-wy-chip="lives"]')!;
    const glance = chip.querySelector<HTMLElement>('.wy-chip-glance')!;
    const value = chip.querySelector<HTMLElement>('.wy-chip-value')!;
    const rec: Recording = { events: [], sway: [] };
    window.__wyLeak = rec;
    let lives = value.textContent ?? '';
    // Sampling the shake frame by frame read too few frames on a slow runner to meet its peaks,
    // so seek the running animation to each tenth of its span instead, and put it back.
    const sway = (): void => {
      const samples: number[] = [];
      rec.sway.push(samples);
      const offset = (): number =>
        glance.getBoundingClientRect().left - chip.getBoundingClientRect().left;
      const animations = glance.getAnimations();
      if (animations.length === 0) {
        samples.push(offset());
        return;
      }
      for (const a of animations) {
        const span = a.effect?.getTiming().duration;
        if (typeof span !== 'number' || !Number.isFinite(span)) {
          samples.push(Number.NaN); // see `Recording.sway`
          continue;
        }
        const was = a.currentTime;
        for (let k = 0; k <= 10; k++) {
          a.currentTime = (span * k) / 10;
          samples.push(offset());
        }
        // Back where it was; one that had no current time (idle) is never set to 0 instead.
        if (typeof was === 'number') a.currentTime = was;
      }
    };
    new MutationObserver((mutations) => {
      const t = window.__wyFrameNow ?? NaN;
      const prev = window.__wyPrevFrameNow ?? NaN;
      const now = value.textContent ?? '';
      // A leak is the count DROPPING (the first HUD refresh only fills it in).
      if (Number(now) < Number(lives)) rec.events.push({ kind: 'lives', t, prev, lives: now });
      lives = now;
      for (const m of mutations) {
        if (m.type !== 'attributes' || m.target !== chip) continue;
        const on = chip.hasAttribute('data-wy-leak');
        const cs = getComputedStyle(glance);
        rec.events.push({
          kind: on ? 'on' : 'off',
          t,
          prev,
          lives,
          bg: cs.backgroundColor,
          anim: cs.animationName,
        });
        if (on) sway();
      }
    }).observe(chip, {
      attributes: true,
      attributeFilter: ['data-wy-leak'],
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

async function resolveColour(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement('span');
    probe.style.color = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

/** An undefended run at 2×, from Start to its loss and the last cue cleared: wave 1's ten
 *  creeps take the ten lives twenty ticks apart, half a second at 2× — faster than a cue may
 *  begin. */
async function leakRun(page: Page, reduceMotion: boolean): Promise<Recording> {
  await stubFullscreen(page);
  await stampFrames(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
  if (reduceMotion) {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Reduce motion').check();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.wy-shell')).toHaveAttribute('data-wy-reduced-motion', '');
  }
  await record(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: /^Speed:/ }).click();
  await expect(page.getByRole('button', { name: 'Speed: 2x' })).toBeVisible();
  await expect(page.locator('.wy-results')).toBeVisible({ timeout: 75_000 });
  // The last leak's cue, if one began, clears on its own after the run has ended. (A run with
  // no cue at all passes here, to fail on the count below, which says so.)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const cues = window.__wyLeak!.events.filter((e) => e.kind !== 'lives');
        return cues.length === 0 || cues.at(-1)!.kind === 'off';
      }),
    )
    .toBe(true);
  return page.evaluate(() => window.__wyLeak!);
}

for (const reduceMotion of [false, true]) {
  test(`a leak in a real run cues the lives chip — ${reduceMotion ? 'red and still, under Reduce motion' : 'red and shaking'} — at most once a second`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const rec = await leakRun(page, reduceMotion);
    const red = await resolveColour(page, 'var(--wy-lives-leak)');
    const pill = await resolveColour(page, 'var(--wy-lives-pill)');
    const lives = rec.events.filter((e) => e.kind === 'lives');
    const ons = rec.events.filter((e) => e.kind === 'on');
    const offs = rec.events.filter((e) => e.kind === 'off');
    // The premise: a real run, creeps leaking faster than a cue may begin, every frame stamped.
    expect(lives.length, 'leaks seen').toBeGreaterThanOrEqual(5);
    expect(rec.events.every((e) => Number.isFinite(e.t))).toBe(true);
    expect(ons.length, 'cues begun').toBeGreaterThanOrEqual(2);
    expect(ons.length, 'some leaks fell inside a cue’s gap').toBeLessThan(lives.length);

    // The first leak shows at once, in the frame its count drops — and no cue begins without one.
    expect(ons[0]!.t).toBe(lives[0]!.t);
    expect(ons[0]!.lives).toBe(lives[0]!.lives);
    for (const on of ons) expect(lives.map((l) => l.t)).toContain(on.t);
    // At most one cue a second (ADR 0003: no more than three flashes in any second)…
    for (let i = 1; i < ons.length; i++) {
      expect(ons[i]!.t - ons[i - 1]!.t).toBeGreaterThanOrEqual(1000);
    }
    // …and a leak a second or more after the last cue began begins one.
    for (const l of lives) {
      const last = ons.filter((o) => o.t <= l.t).at(-1);
      expect(last, `a cue for the leak at ${l.t}`).toBeDefined();
      expect(l.t - last!.t).toBeLessThan(1000);
    }
    // On, off, on, off: each cue clears in the first frame 600 ms or more after it began — the
    // frame before was still inside its span — so before the next may begin.
    expect(rec.events.filter((e) => e.kind !== 'lives').map((e) => e.kind)).toEqual(
      ons.flatMap(() => ['on', 'off']),
    );
    ons.forEach((on, i) => {
      expect(offs[i]!.t - on.t, `cue ${i}`).toBeGreaterThanOrEqual(600);
      expect(offs[i]!.prev - on.t, `cue ${i}`).toBeLessThan(600);
    });

    // Drawn: the pill turns the leak's red — and shakes, or under Reduce motion holds still —
    // and goes back to the lives pill when the cue clears.
    for (const on of ons) {
      expect(on.bg).toBe(red);
      expect(on.anim).toBe(reduceMotion ? 'none' : 'wy-lives-shake');
    }
    for (const off of offs) {
      expect(off.bg).toBe(pill);
      expect(off.anim).toBe('none');
    }
    // Side to side, at least 1.5 px each way from where it rests (the keyframes reach 3 px); under
    // Reduce motion no animation runs at all.
    expect(rec.sway).toHaveLength(ons.length);
    for (const samples of rec.sway) {
      expect(
        samples.every((x) => Number.isFinite(x)),
        `every offset read is a number, so the shake's duration was one (read: ${samples.join(', ')})`,
      ).toBe(true);
      if (reduceMotion) {
        expect(samples, 'no animation runs').toHaveLength(1);
        continue;
      }
      expect(samples, 'one shake, read at each tenth of its span').toHaveLength(11);
      const moves = samples.map((x) => x - samples[0]!);
      expect(Math.min(...moves), 'sways left').toBeLessThanOrEqual(-1.5);
      expect(Math.max(...moves), 'and right').toBeGreaterThanOrEqual(1.5);
    }
  });
}

// The cue's box (#181 C1): the red is drawn inside the lives glance's own box, so no scroll box
// or neighbour clips it. Compact's chip sits against the left edge of the HUD column, a scroll
// box, which cut a ring drawn past the box flat on that side. The cue is set by hand on the
// chip (`main.ts` only writes the attribute on a change), at rest under Reduce motion, and the
// red is found in a screenshot rather than read from the CSS.

interface Box {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/** The glance's box, with the cue set by hand, and the pixels of `colour` around it: their extent.
 *  A colour with an alpha (the system highlight under forced colours has one) is taken as it
 *  shows over `over`, the page colour behind it. */
async function cuedExtent(
  page: Page,
  colour: string,
  over?: string,
): Promise<{ glance: Box; found: Box | null; count: number }> {
  const glance = await page.evaluate((): Box => {
    const chip = document.querySelector('.wy-chip[data-wy-chip="lives"]')!;
    chip.toggleAttribute('data-wy-leak', true);
    const g = chip.querySelector('.wy-chip-glance')!.getBoundingClientRect();
    return { l: g.left, t: g.top, r: g.right, b: g.bottom };
  });
  const pad = 14;
  const clip = {
    x: Math.max(0, Math.floor(glance.l - pad)),
    y: Math.max(0, Math.floor(glance.t - pad)),
    width: Math.ceil(glance.r - glance.l + 2 * pad),
    height: Math.ceil(glance.b - glance.t + 2 * pad),
  };
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const nums = (c: string): number[] => (c.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  const [r, g, b, a = 1] = nums(colour) as [number, number, number, number?];
  const behind = over === undefined ? [255, 255, 255] : nums(over);
  const want = [r, g, b].map((v, i) => v * a + behind[i]! * (1 - a));
  const png = PNG.sync.read(await page.screenshot({ clip, scale: 'device' }));
  let found: Box | null = null;
  let count = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const d =
        Math.abs(png.data[i]! - want[0]!) +
        Math.abs(png.data[i + 1]! - want[1]!) +
        Math.abs(png.data[i + 2]! - want[2]!);
      if (d > 24) continue;
      count++;
      const at = {
        l: clip.x + x / dpr,
        t: clip.y + y / dpr,
        r: clip.x + (x + 1) / dpr,
        b: clip.y + (y + 1) / dpr,
      };
      found =
        found === null
          ? at
          : {
              l: Math.min(found.l, at.l),
              t: Math.min(found.t, at.t),
              r: Math.max(found.r, at.r),
              b: Math.max(found.b, at.b),
            };
    }
  }
  return { glance, found, count };
}

for (const size of [
  { width: 658, height: 320, name: 'Compact' },
  { width: 1280, height: 720, name: 'Standard' },
]) {
  test(`the lives cue's red is a whole pill inside the glance's box, on every side — ${size.name} (${size.width}×${size.height})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.emulateMedia({ reducedMotion: 'reduce' }); // no shake: the red at rest
    await stubFullscreen(page);
    await page.goto('/');
    await expect(page.locator('.wy-board')).toBeVisible();
    const red = await resolveColour(page, 'var(--wy-lives-leak)');
    const { glance, found, count } = await cuedExtent(page, red);
    expect(count, 'red pixels around the glance').toBeGreaterThan(50);
    // Within a pixel of the glance's box on every side: none past it (a ring past the box is
    // cut off by the HUD's edge on the left in Compact, and rings the pill in Standard) and
    // none short of it (a clipped fill).
    // (Short: in Standard the chip's own border, in the lives colour, rings the red, so the red
    // starts a border's width in, give or take a device pixel's snapping: 0.5 to 1.7 px measured
    // in Chromium and WebKit. Compact has no border: 1.1 px at most. Past: the outer ring this
    // replaced passed by 1.7 to 3.3 px.)
    const past = 1;
    const short = 3;
    const gaps = {
      left: found!.l - glance.l,
      top: found!.t - glance.t,
      right: glance.r - found!.r,
      bottom: glance.b - found!.b,
    };
    for (const [side, gap] of Object.entries(gaps)) {
      expect(gap, `${side}: red past the box`).toBeGreaterThanOrEqual(-past);
      expect(gap, `${side}: red short of the box`).toBeLessThanOrEqual(short);
    }
  });
}

test('under forced colours the cue is an outline in the system highlight, inside the glance — Chromium', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'WebKit has no forced-colours emulation');
  await page.setViewportSize({ width: 658, height: 320 });
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await stubFullscreen(page);
  await page.goto('/');
  await expect(page.locator('.wy-board')).toBeVisible();
  const glance = page.locator('.wy-chip[data-wy-chip="lives"] .wy-chip-glance');
  const outline = (): Promise<string[]> =>
    glance.evaluate((el) => {
      const cs = getComputedStyle(el);
      return [cs.outlineStyle, cs.outlineWidth, cs.outlineOffset, cs.outlineColor];
    });
  // The chip at rest has none; the cue gives it one that is the system highlight colour.
  expect((await outline())[0]).toBe('none');
  const highlight = await resolveColour(page, 'Highlight');
  const canvas = await resolveColour(page, 'Canvas');
  const { glance: box, found, count } = await cuedExtent(page, highlight, canvas);
  expect(await outline()).toEqual(['solid', '2px', '-2px', highlight]);
  expect(count, 'outline pixels').toBeGreaterThan(20);
  // Drawn inside the glance's box, none past it.
  expect(found!.l).toBeGreaterThanOrEqual(box.l - 1);
  expect(found!.t).toBeGreaterThanOrEqual(box.t - 1);
  expect(found!.r).toBeLessThanOrEqual(box.r + 1);
  expect(found!.b).toBeLessThanOrEqual(box.b + 1);
  // And its extent is the glance's own: the outline is there on every side.
  expect(found!.l).toBeLessThanOrEqual(box.l + 3);
  expect(found!.t).toBeLessThanOrEqual(box.t + 3);
  expect(found!.r).toBeGreaterThanOrEqual(box.r - 3);
  expect(found!.b).toBeGreaterThanOrEqual(box.b - 3);
});
