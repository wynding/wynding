// survey-form.ts — the end-of-run survey's DOM (ADR 0014 §1, §2, §6), rendered into the
// results dialog's two survey slots (`results-panel.ts`): Give feedback in the dialog's action
// row, and the form, expanded in place, below it.
//
// Every RULE lives in `survey.ts`'s model: what may be edited when, what a Send consumes,
// when the idempotency key rotates, what a run start cancels. This module is the other
// half: it turns the model's state into controls, turns controls back into model calls, and
// owns the three things only a DOM can get wrong — focus, the shared live region, and the
// in-flight edit lock. It renders FROM the model after every action rather than tracking a
// parallel copy, so what the player sees can only ever be the state the model holds.

import { t } from './i18n/t';
import { SURVEY_TEXT_MAX, type SurveyPayload, type SurveyScale } from '@wynding/feedback';
import { type Survey, type SurveySendResult } from './survey';

/** The privacy notice the survey is sent under (wynding-site ADR 0001 §5). */
export const PRIVACY_HREF = '/privacy';

/** What the form needs from the app (`main.ts`), and nothing else. */
export interface SurveyFormHost {
  readonly survey: Survey;
  /** Re-read the ask state (another tab may have answered) before a dialog decides whether
   *  Give feedback is present. Never rejects. */
  refreshAsk(): Promise<void>;
  /** Build the payload for the run on this dialog — synchronously (§1), so a run start has
   *  no window to fall into between the press and the request. */
  compose(idempotencyKey: string): SurveyPayload;
  /** The reference shown in the form at Send and in the thank-you (§7): the session id a
   *  deletion request quotes. */
  reference(): string;
  /** Claim the results dialog's one status region. The writer goes quiet once anything
   *  claims after it, or the dialog closes. Only a SEND claims: it holds the region across
   *  its request and must own the outcome announcement (§6). */
  claimStatus(): (message: string) => void;
  /** Write the region WITHOUT claiming it — for the survey's immediate, final messages (the
   *  rating prompt, the clear on opening and on Not now). A claim would silence a pending
   *  asynchronous writer (#133's Copy, awaiting the clipboard) whose result the player is
   *  still owed; an unclaimed write lets that result land after it instead. */
  writeStatus(message: string): void;
  /** What the region shows now — so Not now clears only the survey's OWN message. */
  statusText(): string;
  /** The region is held (a send in flight) or released (its outcome announced): the
   *  dialog's other writers are locked exactly while it is held (§6). */
  setRegionHeld(held: boolean): void;
  focusPlayAgain(): void;
}

/** Where the survey renders (#181 H2). Give feedback is one of the results dialog's actions,
 *  so it sits in their row; the form it expands is too tall for a row, so it opens below. Both
 *  slots are hidden while the survey is absent — so a build with no survey shows neither. */
export interface SurveySlots {
  readonly opener: HTMLElement;
  readonly form: HTMLElement;
}

export interface SurveyForm {
  /** A results dialog opened: refresh the ask, then decide presence. */
  dialogOpened(): void;
  /** `hideResults()` — every run-start path: cancel the whole operation, release the region,
   *  commit nothing (§1, §3). */
  dialogClosed(): void;
  destroy(): void;
}

const SCALE: readonly SurveyScale[] = [1, 2, 3, 4, 5];

/** Per-form radio-group names (see `groupPrefix`). */
let nextFormId = 0;

/** The keys whose DEFAULT ACTION changes a choice control: Space toggles or checks, and an
 *  Arrow moves a radio group's selection. §6: the lock must stop these at `keydown`, since
 *  `input`/`change` fire after the flip and cannot be cancelled. */
const CHOICE_KEYS = new Set([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

interface ScaleGroup {
  readonly fieldset: HTMLFieldSetElement;
  readonly inputs: readonly HTMLInputElement[];
}

export function createSurveyForm(
  doc: Document,
  slots: SurveySlots,
  host: SurveyFormHost,
): SurveyForm {
  const { survey } = host;
  // Radio groups need a name, and two apps in one document (the unit suite) must not share
  // one — a shared name would join their groups. The counter is per form, never global.
  const groupPrefix = `wy-survey-${String(nextFormId++)}`;

  const openBtn = doc.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'wy-btn';
  openBtn.textContent = t('survey.open');

  const form = doc.createElement('div');
  form.className = 'wy-survey-form';
  form.setAttribute('role', 'group');
  form.setAttribute('aria-label', t('survey.group'));

  const scaleGroup = (name: string, legendText: string): ScaleGroup => {
    const fieldset = doc.createElement('fieldset');
    fieldset.className = 'wy-survey-scale';
    const legend = doc.createElement('legend');
    legend.textContent = legendText;
    fieldset.append(legend);
    const inputs = SCALE.map((value) => {
      const label = doc.createElement('label');
      const input = doc.createElement('input');
      input.type = 'radio';
      input.name = `${groupPrefix}-${name}`;
      input.value = String(value);
      const text = doc.createElement('span');
      text.textContent = t('survey.scaleValue', { value });
      label.append(input, text);
      fieldset.append(label);
      return input;
    });
    return { fieldset, inputs };
  };
  const rating = scaleGroup('rating', t('survey.rating'));
  const difficulty = scaleGroup('difficulty', t('survey.difficulty'));

  const checkbox = (labelText: string): { label: HTMLLabelElement; input: HTMLInputElement } => {
    const label = doc.createElement('label');
    label.className = 'wy-survey-check';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    const text = doc.createElement('span');
    text.textContent = labelText;
    label.append(input, text);
    return { label, input };
  };
  const broke = checkbox(t('survey.somethingBroke'));

  const textLabel = doc.createElement('label');
  textLabel.className = 'wy-survey-text';
  const textCaption = doc.createElement('span');
  textCaption.textContent = t('survey.text');
  const textArea = doc.createElement('textarea');
  // §2: the cap is in UTF-16 code units, which is exactly what `maxlength` counts.
  textArea.maxLength = SURVEY_TEXT_MAX;
  textArea.rows = 3;
  textLabel.append(textCaption, textArea);

  // §7: the reference is shown BEFORE and at Send, not only on success — an aborted request
  // may still have been stored, and the player needs the id to ask for its deletion.
  const referenceEl = doc.createElement('p');
  referenceEl.className = 'wy-survey-note';
  referenceEl.id = `${groupPrefix}-reference`;
  const privacyEl = doc.createElement('p');
  privacyEl.className = 'wy-survey-note';
  privacyEl.id = `${groupPrefix}-privacy`;
  // The notice lives on the site (wynding-site `/privacy`). Root-absolute like the home
  // link, and a new tab, so reading it never navigates away from a half-written survey.
  const privacyLink = doc.createElement('a');
  privacyLink.href = PRIVACY_HREF;
  privacyLink.target = '_blank';
  privacyLink.rel = 'noopener';
  privacyLink.textContent = t('survey.privacyLink');
  privacyEl.append(t('survey.privacy'), ' ', privacyLink);

  const actions = doc.createElement('div');
  actions.className = 'wy-survey-actions';
  const sendBtn = doc.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'wy-btn';
  const notNowBtn = doc.createElement('button');
  notNowBtn.type = 'button';
  notNowBtn.className = 'wy-btn';
  notNowBtn.textContent = t('survey.notNow');
  // §7: Send references the notice — and the reference a deletion request quotes — AT the
  // point of submission, so a player who tabs straight to it (or lands back on it as Try
  // again) hears both, not just "Send".
  sendBtn.setAttribute('aria-describedby', `${referenceEl.id} ${privacyEl.id}`);
  // A MODIFIER, not an action (§3): it arms the dismissal the next Not now / Send commits.
  const dontAsk = checkbox(t('survey.dontAskAgain'));
  actions.append(sendBtn, notNowBtn, dontAsk.label);

  form.append(
    rating.fieldset,
    difficulty.fieldset,
    broke.label,
    textLabel,
    referenceEl,
    privacyEl,
    actions,
  );
  slots.opener.append(openBtn);
  slots.form.append(form);

  /** False from a dialog opening until its ask refresh settles: nothing shows until the
   *  model has decided presence against current storage. */
  let ready = false;
  /** The survey's last message in the region, so a collapse clears it only while it is still
   *  what the region shows — never a Verify or export result written since. */
  let ownMessage: string | null = null;
  const say = (message: string): void => {
    // A polite live region does not re-announce an unchanged node, so a second press of a
    // rating-less Send would say nothing. The overlay's own region uses the same fix: a
    // trailing space when the text would collide, which reads identically to a human.
    const next = message !== '' && host.statusText() === message ? `${message} ` : message;
    ownMessage = next;
    host.writeStatus(next);
  };
  /** Identifies the current dialog, so a refresh that settles after the dialog closed (or a
   *  newer one opened) cannot begin a survey on the wrong one. */
  let dialogSeq = 0;

  const choiceInputs: readonly HTMLInputElement[] = [
    ...rating.inputs,
    ...difficulty.inputs,
    broke.input,
    dontAsk.input,
  ];

  function render(): void {
    const state = survey.state();
    const { phase } = state;
    const shown = ready && phase !== 'absent' && phase !== 'retired';
    slots.opener.hidden = !shown;
    slots.form.hidden = !shown;
    // Presence is DECIDED once the ask refresh settles — shown or not. Exposed so a test can
    // tell "absent" from "not decided yet", which `hidden` alone cannot.
    slots.form.toggleAttribute('data-ready', ready);
    const expanded = phase === 'open' || phase === 'sending';
    openBtn.hidden = expanded;
    form.hidden = !expanded;
    const sending = phase === 'sending';
    for (const [index, input] of rating.inputs.entries()) {
      input.checked = state.answers.rating === SCALE[index];
    }
    for (const [index, input] of difficulty.inputs.entries()) {
      input.checked = state.answers.difficulty === SCALE[index];
    }
    broke.input.checked = state.answers.somethingBroke;
    dontAsk.input.checked = state.dontAskAgain;
    // Only when it differs: an unconditional write moves the caret to the end mid-typing.
    if (textArea.value !== state.answers.text) textArea.value = state.answers.text;
    // §6: free text goes READONLY in flight — still focusable and selectable, unlike
    // `disabled` — and every choice control is `aria-disabled` with its edits refused at
    // the source (the listeners below).
    textArea.readOnly = sending;
    for (const input of choiceInputs) input.setAttribute('aria-disabled', String(sending));
    // Try again is the Send control RELABELLED IN PLACE (§1): the same node, so focus never
    // moves on a failure.
    sendBtn.textContent = state.failure === null ? t('survey.send') : t('survey.tryAgain');
    sendBtn.setAttribute('aria-disabled', String(sending || state.answers.rating === null));
    notNowBtn.setAttribute('aria-disabled', String(sending));
    referenceEl.textContent = expanded
      ? t('survey.reference', { reference: host.reference() })
      : '';
  }

  const locked = (): boolean => survey.state().phase === 'sending';

  // §6's in-flight lock for choice controls, at the level that can actually prevent the
  // change: the default action, at `keydown` and `click`, in the CAPTURE phase so nothing
  // under the form sees an event the lock refused. A click on a wrapping label reaches the
  // input as a synthetic click, so one listener covers both routes.
  form.addEventListener(
    'keydown',
    (event) => {
      if (!locked() || !(event.target instanceof HTMLInputElement)) return;
      if (CHOICE_KEYS.has(event.key)) event.preventDefault();
    },
    true,
  );
  form.addEventListener(
    'click',
    (event) => {
      if (!locked() || !(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      // The fallback (§6), for a surface whose cancelled activation does not fully restore
      // a radio group — the spec restores the previously checked radio, and not every
      // implementation does. Rendering from the model on the next task, once activation
      // has finished, puts the displayed answers back to the payload's either way.
      doc.defaultView?.setTimeout(render, 0);
    },
    true,
  );

  // The edits. Each forwards to the model and then renders FROM it — which is also §6's
  // fallback: a change the model refused (any surface where the default action slipped
  // past the lock) is put straight back to the state the payload was built from.
  const onScale = (group: ScaleGroup, set: (value: SurveyScale) => boolean): void => {
    for (const [index, input] of group.inputs.entries()) {
      input.addEventListener('change', () => {
        const value = SCALE[index];
        if (value !== undefined && input.checked) set(value);
        render();
      });
    }
  };
  onScale(rating, (value) => survey.setRating(value));
  onScale(difficulty, (value) => survey.setDifficulty(value));
  broke.input.addEventListener('change', () => {
    survey.setSomethingBroke(broke.input.checked);
    render();
  });
  dontAsk.input.addEventListener('change', () => {
    survey.setDontAskAgain(dontAsk.input.checked);
    render();
  });
  textArea.addEventListener('input', () => {
    survey.setText(textArea.value);
    render();
  });

  openBtn.addEventListener('click', () => {
    if (!survey.open()) return;
    // Opening CLEARS the region without claiming it (§6): a Verify result still showing has
    // no pending outcome to lose, and a Copy still awaiting the clipboard keeps its claim,
    // so its result lands after this. Only Send takes the region.
    say('');
    render();
    rating.inputs[0]?.focus();
  });

  notNowBtn.addEventListener('click', () => {
    if (notNowBtn.getAttribute('aria-disabled') === 'true') return;
    // The model's commit never rejects, but an injected ask is not ours to trust: a rejection
    // must not surface as an unhandled one. The accepted-Send path guards the same way.
    survey.notNow().catch(() => {});
    // Every collapse but an accepted Send clears the survey's message (§6): a rating prompt
    // or a failure notice is about a submission that is no longer pending.
    if (ownMessage !== null && ownMessage !== '' && host.statusText() === ownMessage) say('');
    render();
    // Give feedback stays present and live on this dialog (§3), so it is a real target.
    openBtn.focus();
  });

  const OUTCOME: Record<SurveySendResult, () => string> = {
    accepted: () => t('survey.accepted', { reference: host.reference() }),
    rejected: () => t('survey.rejected'),
    offline: () => t('survey.offline'),
  };

  sendBtn.addEventListener('click', () => {
    // In flight, Send is one of the controls the region's owner has locked: silent.
    if (locked()) return;
    const attempt = survey.send((key) => host.compose(key));
    if (attempt.kind === 'needsRating') {
      // §2's deliberate divergence from the Dock: an explicit submit attempt gets an answer.
      // A button's keyboard activation IS this click, so the keymap route is the same path.
      say(t('survey.needsRating'));
      return;
    }
    if (attempt.kind === 'refused') return;
    // TAKE the region at Send and HOLD it across the request (§6).
    const announce = host.claimStatus();
    ownMessage = t('survey.sending');
    announce(ownMessage);
    host.setRegionHeld(true);
    render();
    void attempt.done.then((result) => {
      // A run start (or a newer dialog) already released the region and cleared it: an
      // aborted send has no result worth announcing, and none may reach the next dialog.
      if (result === 'cancelled') return;
      // RELEASE on the outcome announcement — accepted, rejected and offline alike.
      host.setRegionHeld(false);
      ownMessage = OUTCOME[result]();
      announce(ownMessage);
      const focusWasHere =
        slots.form.contains(doc.activeElement) || slots.opener.contains(doc.activeElement);
      render();
      // An accepted Send retires the control the player was on, so focus goes to Play
      // again (§1) — but only if it was in the survey: a player who had already moved on
      // is not pulled back.
      if (result === 'accepted' && focusWasHere) host.focusPlayAgain();
    });
  });

  render();

  return {
    dialogOpened(): void {
      const mine = ++dialogSeq;
      ready = false;
      survey.endDialog();
      // A new dialog starts with the region free, whatever path reached it: a send cancelled
      // here announces nothing, so nothing else would ever release its hold.
      host.setRegionHeld(false);
      render();
      void host.refreshAsk().then(() => {
        if (mine !== dialogSeq) return;
        survey.beginDialog();
        ready = true;
        render();
      });
    },
    dialogClosed(): void {
      dialogSeq++;
      ready = false;
      survey.endDialog();
      host.setRegionHeld(false);
      render();
    },
    destroy(): void {
      dialogSeq++;
      survey.endDialog();
      slots.opener.replaceChildren();
      slots.form.replaceChildren();
    },
  };
}
