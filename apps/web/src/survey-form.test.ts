import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSurveyForm, PRIVACY_HREF, type SurveyFormHost } from './survey-form';
import {
  buildSurveyPayload,
  SURVEY_TEXT_MAX,
  type SurveyPayload,
  type SurveyRunIdentity,
} from '@wynding/feedback';
import {
  createSurvey,
  type SurveyAsk,
  type SurveySendResult,
  type SurveyTransport,
} from './survey';

// survey-form.test.ts — the survey's DOM half (ADR 0014 §1, §2, §6), against the REAL model.
// The model's own rules are `survey.test.ts`'s; what is proven here is what only the DOM can
// get wrong: presence after the ask refresh, focus on every exit, the shared live region's
// take/hold/release, and the in-flight edit lock at the level that actually prevents edits.

const RUN: SurveyRunIdentity = {
  runId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  gameVersion: '0123456789abcdef0123456789abcdef01234567',
  simVersion: 1,
  rulesetHash: 'a'.repeat(64),
  boardId: 'board',
  seed: 1,
  outcome: 'won',
  score: 10,
  stars: 2,
  waveCursor: 3,
  finalTick: 100,
  finalHash: '0badf00d',
  replayDigest: 'b'.repeat(64),
};
const REFERENCE = 'session-ref';

interface Pending {
  readonly payload: SurveyPayload;
  readonly signal: AbortSignal;
  resolve(result: SurveySendResult): void;
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function setup(options: { offered?: boolean } = {}) {
  const doc = document;
  const dialog = doc.createElement('div');
  const playAgain = doc.createElement('button');
  // The results dialog's two survey slots (#181 H2): Give feedback in the action row beside
  // Play again, the form below it.
  const opener = doc.createElement('div');
  const slot = doc.createElement('div');
  const elsewhere = doc.createElement('button');
  dialog.append(playAgain, opener, elsewhere, slot);
  doc.body.append(dialog);
  mounted.push(dialog);

  let offered = options.offered ?? true;
  const commits: boolean[] = [];
  let refreshGate: Promise<void> | null = null;
  const ask: SurveyAsk = {
    offered: () => offered,
    refresh: vi.fn(async () => {
      if (refreshGate !== null) await refreshGate;
    }),
    commit: async (dontAskAgain) => void commits.push(dontAskAgain),
  };
  const pending: Pending[] = [];
  const transport: SurveyTransport = {
    send: (payload, signal) => new Promise((resolve) => pending.push({ payload, signal, resolve })),
  };
  let keys = 0;
  const survey = createSurvey({
    ask,
    transport,
    mintKey: () => `00000000-0000-4000-8000-${String(++keys).padStart(12, '0')}`,
  });
  // The shared status region, with main.ts's claim semantics: a writer goes quiet once
  // anything claims after it.
  let status = '';
  let seq = 0;
  const held: boolean[] = [];
  const host: SurveyFormHost = {
    survey,
    refreshAsk: () => ask.refresh(),
    compose: (idempotencyKey) =>
      buildSurveyPayload({ answers: survey.state().answers, run: RUN, idempotencyKey }),
    reference: () => REFERENCE,
    claimStatus: () => {
      const mine = ++seq;
      return (message) => {
        if (mine === seq) status = message;
      };
    },
    writeStatus: (message) => void (status = message),
    statusText: () => status,
    setRegionHeld: (h) => void held.push(h),
    focusPlayAgain: () => playAgain.focus(),
  };
  const form = createSurveyForm(doc, { opener, form: slot }, host);
  const q = <T extends Element>(selector: string): T => {
    const el = slot.querySelector<T>(selector);
    if (el === null) throw new Error(`no ${selector}`);
    return el;
  };
  const buttons = (): HTMLButtonElement[] => [
    ...opener.querySelectorAll('button'),
    ...slot.querySelectorAll('button'),
  ];
  const button = (label: string): HTMLButtonElement => {
    const b = buttons().find((x) => x.textContent === label);
    if (b === undefined) throw new Error(`no button ${label}`);
    return b;
  };
  const radios = (group: 0 | 1): HTMLInputElement[] => {
    const fieldset = slot.querySelectorAll<HTMLFieldSetElement>('fieldset')[group]!;
    return [...fieldset.querySelectorAll<HTMLInputElement>('input')];
  };
  const checkboxes = (): HTMLInputElement[] => [
    ...slot.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ];
  const textarea = (): HTMLTextAreaElement => q<HTMLTextAreaElement>('textarea');
  const formEl = (): HTMLElement => q<HTMLElement>('.wy-survey-form');
  /** Open a dialog and let its ask refresh settle. */
  async function open(): Promise<void> {
    form.dialogOpened();
    await vi.waitFor(() => expect(survey.state().phase).not.toBe('absent'));
  }
  async function expand(): Promise<void> {
    await open();
    button('Give feedback').click();
  }
  return {
    doc,
    slot,
    opener,
    playAgain,
    elsewhere,
    form,
    survey,
    ask,
    commits,
    pending,
    held,
    status: () => status,
    /** Another writer of the shared region (Verify, or an export), claiming as main.ts does. */
    otherWriter: () => host.claimStatus(),
    setOffered: (v: boolean) => void (offered = v),
    setRefreshGate: (g: Promise<void> | null) => void (refreshGate = g),
    button,
    buttons,
    radios,
    checkboxes,
    textarea,
    formEl,
    open,
    expand,
    last: (): Pending => pending[pending.length - 1]!,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function key(target: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('survey form — presence (ADR 0014 §1, §3)', () => {
  it('shows nothing until the dialog’s ask refresh settles, then Give feedback', async () => {
    const h = setup();
    expect(h.slot.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
    let release = (): void => {};
    h.setRefreshGate(new Promise<void>((r) => (release = r)));
    h.form.dialogOpened();
    await flush();
    expect(h.slot.hidden, 'presence is decided after the refresh, not before').toBe(true);
    expect(h.opener.hidden, 'Give feedback waits for the same decision').toBe(true);
    release();
    await vi.waitFor(() => expect(h.slot.hidden).toBe(false));
    expect(h.opener.hidden).toBe(false);
    expect(h.button('Give feedback').hidden).toBe(false);
    expect(h.formEl().hidden).toBe(true);
    expect(h.ask.refresh).toHaveBeenCalledTimes(1);
  });

  it('puts Give feedback in the action row’s slot and the form in the slot below it (#181 H2)', async () => {
    const h = setup();
    await h.expand();
    expect(h.opener.contains(h.button('Give feedback'))).toBe(true);
    expect(h.slot.contains(h.formEl())).toBe(true);
    expect(h.opener.contains(h.formEl())).toBe(false);
    // Expanded, the button gives way to the form it opened; the row's slot stays present.
    expect(h.button('Give feedback').hidden).toBe(true);
    expect(h.formEl().hidden).toBe(false);
    expect(h.opener.hidden).toBe(false);
  });

  it('is absent when the ask is consumed', async () => {
    const h = setup({ offered: false });
    h.form.dialogOpened();
    await flush();
    await flush();
    expect(h.survey.state().phase).toBe('absent');
    expect(h.slot.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
  });

  it('a refresh that settles after the dialog closed begins nothing', async () => {
    const h = setup();
    let release = (): void => {};
    h.setRefreshGate(new Promise<void>((r) => (release = r)));
    h.form.dialogOpened();
    h.form.dialogClosed();
    release();
    await flush();
    await flush();
    expect(h.survey.state().phase).toBe('absent');
    expect(h.slot.hasAttribute('data-ready'), 'never decided').toBe(false);
    expect(h.slot.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
  });

  it('two forms in one document never share a radio group', () => {
    const a = setup();
    const b = setup();
    expect(a.radios(0)[0]!.name).not.toBe(b.radios(0)[0]!.name);
    expect(a.radios(0)[0]!.name).not.toBe(a.radios(1)[0]!.name);
  });
});

describe('survey form — expansion, rating gate and Not now (§1, §2, §3)', () => {
  it('Give feedback expands in place, takes (and clears) the region, and focuses the first question', async () => {
    const h = setup();
    await h.open();
    h.button('Give feedback').click();
    expect(h.formEl().hidden).toBe(false);
    expect(h.button('Give feedback').hidden).toBe(true);
    expect(h.doc.activeElement).toBe(h.radios(0)[0]);
    expect(h.status()).toBe('');
    expect(h.slot.textContent).toContain(`Reference: ${REFERENCE}.`);
    expect(h.slot.textContent).toContain('privacy notice');
    expect(h.textarea().maxLength).toBe(SURVEY_TEXT_MAX);
  });

  it('Send is aria-disabled with no rating, and pressing it announces what is missing', async () => {
    const h = setup();
    await h.expand();
    const send = h.button('Send');
    expect(send.getAttribute('aria-disabled')).toBe('true');
    send.focus();
    send.click();
    expect(h.status()).toBe('Answer "How was it?" to send your feedback.');
    expect(h.pending).toHaveLength(0);
    expect(h.doc.activeElement, 'focus stays put').toBe(send);
    h.radios(0)[3]!.click();
    expect(h.survey.state().answers.rating).toBe(4);
    expect(send.getAttribute('aria-disabled')).toBe('false');
  });

  it('a hidden control’s stray activation does nothing', async () => {
    const h = setup();
    await h.open();
    h.button('Send').click(); // collapsed: the form (and Send) is hidden
    expect(h.pending).toHaveLength(0);
    expect(h.status()).toBe('');
    h.button('Give feedback').click();
    h.radios(0)[0]!.click();
    h.button('Give feedback').click(); // already open: hidden, and refused
    expect(h.survey.state().answers.rating, 'reopening never resets the draft').toBe(1);
  });

  it('Send carries the privacy notice and the reference as its description (§7)', async () => {
    const h = setup();
    await h.expand();
    const ids = (h.button('Send').getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    const described = ids.map((id) => h.doc.getElementById(id)?.textContent ?? '');
    expect(described[0]).toBe(
      `Reference: ${REFERENCE}. Quote it if you ask for this feedback to be deleted.`,
    );
    expect(described[1]).toContain('privacy notice');
  });

  it('links the privacy notice, in a new tab so the draft survives', async () => {
    const h = setup();
    await h.expand();
    const link = h.slot.querySelector<HTMLAnchorElement>('a[href]');
    expect(link?.getAttribute('href')).toBe(PRIVACY_HREF);
    expect(PRIVACY_HREF).toBe('/privacy');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener');
    expect(link?.textContent).toBe('Read the privacy notice');
    // It sits inside the note Send is described by, so the description still names it.
    const privacyId = (h.button('Send').getAttribute('aria-describedby') ?? '').split(' ')[1];
    expect(link?.closest('p')?.id).toBe(privacyId);
  });

  it('never silences a pending export: its prompts and clears write without claiming', async () => {
    const h = setup();
    await h.open();
    const copy = h.otherWriter(); // a Copy awaiting the clipboard
    h.button('Give feedback').click(); // clears the region...
    h.button('Send').click(); // ...and prompts for a rating...
    expect(h.status()).toBe('Answer "How was it?" to send your feedback.');
    copy('Run data copied to the clipboard.'); // ...and the export's result still lands
    expect(h.status()).toBe('Run data copied to the clipboard.');
  });

  it('Not now clears the survey’s own message, and only its own', async () => {
    const h = setup();
    await h.expand();
    h.button('Send').click();
    h.button('Not now').click();
    expect(h.status(), 'a stale rating prompt is cleared').toBe('');

    h.button('Give feedback').click();
    h.button('Send').click();
    h.otherWriter()('Verified: replay re-simulated to the same outcome.');
    h.button('Not now').click();
    expect(h.status(), 'a Verify result written since is kept').toBe(
      'Verified: replay re-simulated to the same outcome.',
    );
  });

  it('Not now after a failed send clears the failure notice', async () => {
    const h = setup();
    await h.expand();
    h.radios(0)[0]!.click();
    h.button('Send').click();
    h.last().resolve('rejected');
    await flush();
    expect(h.status()).toBe("Couldn't send your feedback.");
    h.button('Not now').click();
    expect(h.status()).toBe('');
  });

  it('a repeated rating prompt is re-announced (the node really changes)', async () => {
    const h = setup();
    await h.expand();
    h.button('Send').click();
    const first = h.status();
    h.button('Send').click();
    expect(h.status()).not.toBe(first);
    expect(h.status().trim()).toBe(first);
    h.button('Not now').click();
    expect(h.status(), 'the collapse still recognises its own message').toBe('');
  });

  it('marks presence as decided once the refresh settles, shown or not', async () => {
    const shown = setup();
    await shown.open();
    expect(shown.slot.hasAttribute('data-ready')).toBe(true);
    shown.form.dialogClosed();
    expect(shown.slot.hasAttribute('data-ready')).toBe(false);
    const absent = setup({ offered: false });
    absent.form.dialogOpened();
    await vi.waitFor(() => expect(absent.slot.hasAttribute('data-ready')).toBe(true));
    expect(absent.slot.hidden).toBe(true);
  });

  it('a commit that rejects on Not now never surfaces as an unhandled rejection', async () => {
    const h = setup();
    h.ask.commit = () => Promise.reject(new Error('storage exploded'));
    await h.expand();
    h.button('Not now').click();
    await flush();
    expect(h.formEl().hidden).toBe(true);
  });

  it('forwards every answer to the model', async () => {
    const h = setup();
    await h.expand();
    h.radios(0)[1]!.click();
    h.radios(1)[4]!.click();
    const [broke, dontAsk] = h.checkboxes();
    broke!.click();
    dontAsk!.click();
    h.textarea().value = 'the path went through a wall';
    h.textarea().dispatchEvent(new Event('input'));
    expect(h.survey.state()).toMatchObject({
      answers: {
        rating: 2,
        difficulty: 5,
        somethingBroke: true,
        text: 'the path went through a wall',
      },
      dontAskAgain: true,
    });
  });

  it('puts back text the model refused (past the cap)', async () => {
    const h = setup();
    await h.expand();
    h.textarea().value = 'ok';
    h.textarea().dispatchEvent(new Event('input'));
    h.textarea().value = 'x'.repeat(SURVEY_TEXT_MAX + 1); // a paste that slipped past maxlength
    h.textarea().dispatchEvent(new Event('input'));
    expect(h.textarea().value).toBe('ok');
  });

  it('Not now collapses, commits the checkbox’s state, and returns focus to Give feedback', async () => {
    const h = setup();
    await h.expand();
    h.checkboxes()[1]!.click(); // don't ask again
    h.button('Not now').click();
    await flush();
    expect(h.commits).toEqual([true]);
    expect(h.formEl().hidden).toBe(true);
    const openBtn = h.button('Give feedback');
    expect(openBtn.hidden, 'it stays live on this dialog').toBe(false);
    expect(h.doc.activeElement).toBe(openBtn);
    expect(h.pending).toHaveLength(0);
  });
});

describe('survey form — a send in flight (§6)', () => {
  async function sending() {
    const h = setup();
    await h.expand();
    h.held.splice(0); // the dialog opening's own release; these tests count from Send
    h.radios(0)[2]!.click();
    h.textarea().value = 'hello';
    h.textarea().dispatchEvent(new Event('input'));
    h.button('Send').focus();
    h.button('Send').click();
    expect(h.pending).toHaveLength(1);
    return h;
  }

  it('takes and HOLDS the region, and locks every control while in flight', async () => {
    const h = await sending();
    expect(h.status()).toBe('Sending your feedback…');
    expect(h.held).toEqual([true]);
    expect(h.textarea().readOnly, 'readonly, not disabled: still focusable').toBe(true);
    for (const input of [...h.radios(0), ...h.radios(1), ...h.checkboxes()]) {
      expect(input.getAttribute('aria-disabled')).toBe('true');
      expect(input.disabled).toBe(false);
    }
    expect(h.button('Send').getAttribute('aria-disabled')).toBe('true');
    expect(h.button('Not now').getAttribute('aria-disabled')).toBe('true');
    // A second press sends nothing more, and Not now does nothing.
    h.button('Send').click();
    h.button('Not now').click();
    await flush();
    expect(h.pending).toHaveLength(1);
    expect(h.commits).toEqual([]);
    expect(h.formEl().hidden).toBe(false);
  });

  it('suppresses a choice’s DEFAULT ACTION at keydown and click — not at input/change', async () => {
    const h = await sending();
    const radio = h.radios(0)[2]!;
    // No `change` may fire at all: the model refusing a change and the render putting it
    // back would leave the same final state, so the state alone cannot prove the lock.
    const changes = vi.fn();
    h.formEl().addEventListener('change', changes);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.radios(0)[0]!.dispatchEvent(click);
    expect(click.defaultPrevented, 'the click’s default action is cancelled').toBe(true);
    for (const k of [' ', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
      expect(key(radio, k).defaultPrevented, k).toBe(true);
    }
    expect(key(radio, 'Tab').defaultPrevented, 'Tab still moves focus').toBe(false);
    expect(key(h.textarea(), ' ').defaultPrevented, 'the textarea is readonly instead').toBe(false);
    const other = h.radios(0)[4]!;
    other.click();
    await vi.waitFor(() => expect(radio.checked).toBe(true));
    expect(other.checked).toBe(false);
    const broke = h.checkboxes()[0]!;
    broke.click();
    await vi.waitFor(() => expect(broke.checked).toBe(false));
    expect(changes).not.toHaveBeenCalled();
    expect(h.survey.state().answers).toMatchObject({ rating: 3, somethingBroke: false });
  });

  it('restores the prior state where a change slips past the lock (the fallback)', async () => {
    const h = await sending();
    const other = h.radios(0)[0]!;
    other.checked = true;
    other.dispatchEvent(new Event('change'));
    expect(other.checked).toBe(false);
    expect(h.radios(0)[2]!.checked).toBe(true);
    expect(h.survey.state().answers.rating).toBe(3);
  });

  it('accepted: releases the region on the thank-you, retires the survey, focus to Play again', async () => {
    const h = await sending();
    h.last().resolve('accepted');
    await flush();
    expect(h.held).toEqual([true, false]);
    expect(h.status()).toBe(`Thanks for the feedback. Reference: ${REFERENCE}.`);
    expect(h.slot.hidden).toBe(true);
    expect(h.opener.hidden, 'Give feedback is retired from the row too').toBe(true);
    expect(h.doc.activeElement).toBe(h.playAgain);
    expect(h.last().payload.answers).toEqual({ rating: 3, somethingBroke: false, text: 'hello' });
  });

  it('accepted does not pull back a player whose focus had already left the survey', async () => {
    const h = await sending();
    h.elsewhere.focus();
    h.last().resolve('accepted');
    await flush();
    expect(h.doc.activeElement).toBe(h.elsewhere);
  });

  it('rejected: Try again is the SAME node, focus never moves, the text is kept and the lock lifts', async () => {
    const h = await sending();
    const send = h.button('Send');
    h.last().resolve('rejected');
    await flush();
    expect(h.held).toEqual([true, false]);
    expect(h.status()).toBe("Couldn't send your feedback.");
    expect(send.textContent).toBe('Try again');
    expect(h.doc.activeElement).toBe(send);
    expect(h.textarea().value).toBe('hello');
    expect(h.textarea().readOnly).toBe(false);
    expect(send.getAttribute('aria-disabled')).toBe('false');
    // Try again re-takes the region.
    send.click();
    expect(h.status()).toBe('Sending your feedback…');
    expect(h.pending).toHaveLength(2);
  });

  it('offline says so, and is otherwise a rejection', async () => {
    const h = await sending();
    h.last().resolve('offline');
    await flush();
    expect(h.status()).toBe("You're offline, so your feedback wasn't sent.");
    expect(h.button('Try again').getAttribute('aria-disabled')).toBe('false');
  });

  it('a run start cancels the operation, releases the region, and announces nothing after', async () => {
    const h = await sending();
    h.form.dialogClosed();
    expect(h.last().signal.aborted).toBe(true);
    expect(h.held).toEqual([true, false]);
    expect(h.slot.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
    h.last().resolve('accepted'); // a late response to the aborted request
    await flush();
    expect(h.status(), 'nothing lands after the cancel').toBe('Sending your feedback…');
    expect(h.held).toEqual([true, false]);
    expect(h.commits, 'a run start commits nothing').toEqual([]);
  });

  it('a dialog opening releases a hold that nothing else would', async () => {
    const h = await sending();
    h.form.dialogOpened(); // a re-open path that skipped dialogClosed
    expect(h.last().signal.aborted).toBe(true);
    expect(h.held.at(-1)).toBe(false);
  });

  it('destroy empties both slots', () => {
    const h = setup();
    expect(h.opener.childElementCount).toBe(1);
    expect(h.slot.childElementCount).toBe(1);
    h.form.destroy();
    expect(h.slot.childElementCount).toBe(0);
    expect(h.opener.childElementCount).toBe(0);
  });
});
