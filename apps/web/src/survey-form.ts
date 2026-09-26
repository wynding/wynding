// survey-form.ts — the end-of-run survey's DOM (ADR 0014 §1, §2, §6), rendered into the
// results dialog's survey slot (`overlay.ts`).
//
// Every RULE lives in `survey.ts`'s model: what may be edited when, what a Send consumes,
// when the idempotency key rotates, what a run start cancels. This module is the other
// half: it turns the model's state into controls, turns controls back into model calls, and
// owns the three things only a DOM can get wrong — focus, the shared live region, and the
// in-flight edit lock. It renders FROM the model after every action rather than tracking a
// parallel copy, so what the player sees can only ever be the state the model holds.

import { t } from './i18n/t';
import {
  SURVEY_TEXT_MAX,
  type Survey,
  type SurveyPayload,
  type SurveyScale,
  type SurveySendResult,
} from './survey';

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
   *  claims after it, or the dialog closes. */
  claimStatus(): (message: string) => void;
  /** The region is held (a send in flight) or released (its outcome announced): the
   *  dialog's other writers are locked exactly while it is held (§6). */
  setRegionHeld(held: boolean): void;
  focusPlayAgain(): void;
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
  slot: HTMLElement,
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
  const privacyEl = doc.createElement('p');
  privacyEl.className = 'wy-survey-note';
  privacyEl.textContent = t('survey.privacy');

  const actions = doc.createElement('div');
  actions.className = 'wy-survey-actions';
  const sendBtn = doc.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'wy-btn';
  const notNowBtn = doc.createElement('button');
  notNowBtn.type = 'button';
  notNowBtn.className = 'wy-btn';
  notNowBtn.textContent = t('survey.notNow');
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
  slot.append(openBtn, form);

  /** False from a dialog opening until its ask refresh settles: nothing shows until the
   *  model has decided presence against current storage. */
  let ready = false;
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
    slot.hidden = !shown;
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
    // Opening TAKES the region, and taking clears (§6): a Verify result still showing has
    // no pending outcome to lose.
    host.claimStatus()('');
    render();
    rating.inputs[0]?.focus();
  });

  notNowBtn.addEventListener('click', () => {
    if (notNowBtn.getAttribute('aria-disabled') === 'true') return;
    void survey.notNow();
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
      host.claimStatus()(t('survey.needsRating'));
      return;
    }
    if (attempt.kind === 'refused') return;
    // TAKE the region at Send and HOLD it across the request (§6).
    const announce = host.claimStatus();
    announce(t('survey.sending'));
    host.setRegionHeld(true);
    render();
    void attempt.done.then((result) => {
      // A run start (or a newer dialog) already released the region and cleared it: an
      // aborted send has no result worth announcing, and none may reach the next dialog.
      if (result === 'cancelled') return;
      // RELEASE on the outcome announcement — accepted, rejected and offline alike.
      host.setRegionHeld(false);
      announce(OUTCOME[result]());
      const focusWasHere = slot.contains(doc.activeElement);
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
      slot.replaceChildren();
    },
  };
}
