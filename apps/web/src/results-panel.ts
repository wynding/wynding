// results-panel.ts — the results dialog's panel (#181 H2): the style frame's results screen,
// built to the frame. `overlay.ts` owns the dialog itself — its role, modality, priority,
// initial focus, Back/Escape behaviour and the shared status region's writers — and wires the
// actions; this module owns what is IN the dialog and how it reads.
//
// What the panel shows, top to bottom: the outcome heading under a thin top band (yellow for
// a win, red for a loss — decoration; the heading carries the outcome), a subtitle naming the
// waves, three stars and the score, the run's numbers in a 2×2 grid of labelled tiles, and one
// row of actions — Play again, the survey's Give feedback where the survey is offered, and Run
// data: a DISCLOSURE (a button that shows and hides a group, not an ARIA menu) holding Verify,
// Copy and Save. The survey form expands below the row, and the status region closes the panel.
//
// Where the panel stands: centred on the dialog by its height with nothing open below the
// action row, and FIXED there. The Run data group, the survey form and a status message grow it
// downward into the room below, then scroll inside its body (`settle` below; `ui.css`'s
// `.wy-results::before`). Content can still move under a resting pointer: something closing
// while the body is scrolled makes the browser clamp the scroll position, and opening the survey
// can bring its first question into view. So every press is guarded instead: a press never
// activates a control it was not aimed at (`press-guard.ts`). And the status region never
// shrinks within one dialog, so a shorter message is not one of the things that move. The panel
// opens with Play again focused, unless Play again is not wholly in view at the top of the panel
// (a short window at heavy text zoom): then the heading takes focus (`focusOnOpen`).
//
// One sentence carries the score and the stars to assistive tech (`results.summary`, today's
// string): it is the dialog's description, and the visual stars and score are `aria-hidden`
// beside it so nothing is read twice. The tiles are real text.

import { t } from './i18n/t';
import { chipIcon } from './hud-icons';
import { guardPresses } from './press-guard';
import type { RunStats } from './controller';
import type { SurveySlots } from './survey-form';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The star grade's ceiling — `results.summary` reads "{stars} of 3 stars". */
export const STAR_SLOTS = 3;

/** What one results dialog is about. */
export interface ResultsOutcome {
  readonly won: boolean;
  readonly score: number;
  readonly stars: number;
  readonly stats: RunStats;
}

/** The four tiles, in reading order (row by row). */
export type ResultsStat = 'wavesCleared' | 'creepsStopped' | 'leaks' | 'towersBuilt';
const STATS: readonly ResultsStat[] = ['wavesCleared', 'creepsStopped', 'leaks', 'towersBuilt'];

// Spelled out as string-literal `t()` keys for the i18n extraction gate (see `overlay.ts`'s
// COLOUR_LABEL note): a computed key would read as unused and fail CI.
const STAT_LABEL: Record<ResultsStat, () => string> = {
  wavesCleared: () => t('results.stat.wavesCleared'),
  creepsStopped: () => t('results.stat.creepsStopped'),
  leaks: () => t('results.stat.leaks'),
  towersBuilt: () => t('results.stat.towersBuilt'),
};

function statValue(stat: ResultsStat, stats: RunStats): string {
  switch (stat) {
    case 'wavesCleared':
      return t('results.stat.wavesCleared.value', {
        cleared: stats.wavesCleared,
        count: stats.waveCount,
      });
    case 'creepsStopped':
      return String(stats.creepsStopped);
    case 'leaks':
      return String(stats.leaks);
    case 'towersBuilt':
      return String(stats.towersBuilt);
  }
}

export interface ResultsPanel {
  /** The panel: the dialog's one child. */
  readonly root: HTMLElement;
  /** The part that scrolls when the panel is taller than the room below its resting place (a
   *  short viewport, the open survey or Run data group, heavy text zoom). The band and the
   *  panel's edge stay put around it. */
  readonly body: HTMLElement;
  readonly title: HTMLHeadingElement;
  /** The one accessible sentence carrying score and stars — the dialog's description. */
  readonly description: HTMLElement;
  readonly playAgain: HTMLButtonElement;
  /** The Run data disclosure: its toggle, and the group it shows and hides. */
  readonly runDataToggle: HTMLButtonElement;
  readonly runData: HTMLElement;
  readonly verify: HTMLButtonElement;
  readonly copyRun: HTMLButtonElement;
  readonly saveRun: HTMLButtonElement;
  /** Where the survey renders: Give feedback in the action row, the form below it. */
  readonly surveySlots: SurveySlots;
  /** The dialog's ONE shared status region (see `overlay.ts`). */
  readonly status: HTMLElement;
  /** Fill the panel for one finished run, with the disclosure collapsed. */
  render(outcome: ResultsOutcome): void;
  /** The dialog has just been shown: place the panel, then give it its first focus — Play
   *  again (ADR 0014 §1), or the heading where Play again is not wholly in view at the top. */
  focusOnOpen(): void;
  /** Show or hide the Run data group, keeping `aria-expanded` in step. */
  setRunDataExpanded(expanded: boolean): void;
  /** Stop following the dialog's size and the status region's height, and drop the press guard
   *  (the overlay's teardown). */
  destroy(): void;
}

/** The dialog's resting spacer (`ui.css`, `.wy-results::before`). */
const REST_PROPERTY = '--wy-results-rest';

/** Per-panel id prefix: two apps in one document (the unit suites) must not share ids. */
let nextPanelId = 0;

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

/** The disclosure's chevron: decoration, inked in the button's own text colour (so forced
 *  colors repaint it with the label), pointing down while collapsed. */
function chevron(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'wy-results-chevron');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M2 3.5L5 6.5L8 3.5');
  svg.append(path);
  return svg;
}

/** Build the panel INTO `dialog` — the results dialog, which `overlay.ts` owns — and keep it
 *  at its resting place there. */
export function createResultsPanel(doc: Document, dialog: HTMLElement): ResultsPanel {
  const prefix = `wy-results-${String(nextPanelId++)}`;

  const root = doc.createElement('div');
  root.className = 'wy-results-panel';
  const body = doc.createElement('div');
  body.className = 'wy-results-body';
  root.append(body);

  const title = doc.createElement('h2');
  title.className = 'wy-results-title';
  // Focusable by script only, never by Tab: the ARIA dialog pattern's first focus where the
  // first control would scroll the start of the content out of view (`focusOnOpen`).
  title.tabIndex = -1;
  const subtitle = doc.createElement('p');
  subtitle.className = 'wy-results-subtitle';
  const description = doc.createElement('p');
  description.className = 'wy-sr-only';
  description.id = `${prefix}-summary`;

  // The grade: three stars and the score, drawn for the eye. `aria-hidden` because the
  // description above already says both; read twice, the score would be noise.
  const grade = doc.createElement('div');
  grade.className = 'wy-results-grade';
  grade.setAttribute('aria-hidden', 'true');
  const starRow = doc.createElement('div');
  starRow.className = 'wy-results-stars';
  const stars = Array.from({ length: STAR_SLOTS }, () => {
    const star = chipIcon(doc, 'stars');
    star.classList.add('wy-results-star');
    return star;
  });
  starRow.append(...stars);
  const score = doc.createElement('div');
  score.className = 'wy-results-score';
  const scoreLabel = doc.createElement('span');
  scoreLabel.className = 'wy-results-score-label';
  scoreLabel.textContent = t('results.score');
  const scoreValue = doc.createElement('span');
  scoreValue.className = 'wy-results-score-value';
  score.append(scoreLabel, scoreValue);
  grade.append(starRow, score);

  // The run's numbers: a description list of labelled tiles, real text in reading order.
  const statList = doc.createElement('dl');
  statList.className = 'wy-results-stats';
  const statValues = new Map<ResultsStat, HTMLElement>();
  for (const stat of STATS) {
    const tile = doc.createElement('div');
    tile.className = 'wy-results-stat';
    tile.dataset.stat = stat;
    const term = doc.createElement('dt');
    term.textContent = STAT_LABEL[stat]();
    const value = doc.createElement('dd');
    tile.append(term, value);
    statList.append(tile);
    statValues.set(stat, value);
  }

  // One row of actions. Play again leads (primary, and the first focus wherever it is wholly in
  // view as the panel opens); Give feedback joins it where a survey renders; Run data closes it
  // and discloses the three secondary actions.
  const actions = doc.createElement('div');
  actions.className = 'wy-results-actions';
  const playAgain = button(doc, 'wy-btn wy-primary', t('controls.playAgain'));
  const opener = doc.createElement('div');
  opener.className = 'wy-survey-opener';
  opener.hidden = true; // until a survey renders into it — most builds never do
  const runDataToggle = doc.createElement('button');
  runDataToggle.type = 'button';
  runDataToggle.className = 'wy-btn wy-results-more';
  runDataToggle.id = `${prefix}-run-data-toggle`;
  const toggleText = doc.createElement('span');
  toggleText.textContent = t('controls.runData');
  runDataToggle.append(toggleText, chevron(doc));
  actions.append(playAgain, opener, runDataToggle);

  // The disclosed group. It follows its toggle directly in the DOM, so the three actions come
  // straight after it in the reading and tab order, and `hidden` takes them out of both while
  // collapsed. Named by the toggle, so a screen reader entering it hears "Run data".
  const runData = doc.createElement('div');
  runData.className = 'wy-results-run-data';
  runData.id = `${prefix}-run-data`;
  runData.setAttribute('role', 'group');
  runData.setAttribute('aria-labelledby', runDataToggle.id);
  runDataToggle.setAttribute('aria-controls', runData.id);
  const verify = button(doc, 'wy-btn wy-results-item', t('controls.verify'));
  // ADR 0011's local export (#133): two buttons rather than one because the destinations are
  // genuinely different acts — a paste into an issue form, and a file to attach.
  const copyRun = button(doc, 'wy-btn wy-results-item', t('controls.copyRun'));
  const saveRun = button(doc, 'wy-btn wy-results-item', t('controls.saveRun'));
  runData.append(verify, copyRun, saveRun);

  // ADR 0014 §1's survey form, expanded in place below the row, before the status region it
  // reports through.
  const surveyForm = doc.createElement('div');
  surveyForm.className = 'wy-survey';
  surveyForm.hidden = true;

  // The ONE shared status region. Named `.wy-verify` in the stylesheet since M1 and left that
  // way on purpose: the element's contract (one polite live region, cleared on every
  // show/hide) is what Verify, the exports and the survey share, not its class.
  const status = doc.createElement('p');
  status.className = 'wy-verify';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  body.append(title, subtitle, description, grade, statList, actions, runData, surveyForm, status);

  dialog.append(root);

  // The panel's RESTING place: a spacer above it (`ui.css`, `.wy-results::before`) centres the
  // panel by its height with nothing open below the action row, and caps it to the room left
  // below (`max-height`). The spacer never gives way: whatever opens below the row — the Run
  // data group, the survey form, a status message — grows the panel downward into that room and
  // then scrolls inside its body. A panel that moved instead (centred by its current height, or
  // pushed up to fit) would carry the control the pointer just pressed away from under it on
  // every open. The press guard below catches a second press wherever something still moves.
  const view = doc.defaultView;
  function settle(): void {
    if (view === null || dialog.hidden) return;
    const dialogStyle = view.getComputedStyle(dialog);
    const available =
      dialog.clientHeight -
      parseFloat(dialogStyle.paddingTop) -
      parseFloat(dialogStyle.paddingBottom);
    // The panel's whole height, counting back in whatever its body has scrolled out of view.
    const natural = root.offsetHeight + body.scrollHeight - body.clientHeight;
    // What stands below the action row beyond the empty status region's own gap. Both edges
    // are in the body, so the difference holds however far it is scrolled.
    const below =
      status.getBoundingClientRect().bottom -
      actions.getBoundingClientRect().bottom -
      parseFloat(view.getComputedStyle(status).marginTop);
    const rest = `${String(Math.max(0, Math.floor((available - natural + below) / 2)))}px`;
    if (dialog.style.getPropertyValue(REST_PROPERTY) !== rest) {
      dialog.style.setProperty(REST_PROPERTY, rest);
    }
  }
  // Re-settled only when the CLOSED panel or the room for it changes size: the dialog (the
  // viewport) and every part from the heading to the action row (a text-zoom reflow, Give
  // feedback arriving once the survey decides). Nothing that opens is observed — the group, the
  // form and the status region all sit below the row — so opening something can never move the
  // panel. Writing the spacer resizes none of the observed boxes (only the panel's height, which
  // is not observed), so a settle never feeds the observer back. jsdom has neither the observer
  // nor layout: there, the spacer keeps its 0 default.
  const RO = view?.ResizeObserver;
  const restObserver = typeof RO === 'function' ? new RO(() => settle()) : null;
  for (const box of [dialog, title, subtitle, grade, statList, actions]) {
    restObserver?.observe(box);
  }

  // A press never activates a control it was not aimed at (`press-guard.ts`).
  const unguardPresses = guardPresses(root);

  // The status region never shrinks within one dialog. A shorter message after a longer one
  // would shrink the body, and the scroll clamp of a scrolled body would then pull the panel
  // down under the pointer. Each taller message raises the floor, and the next dialog starts
  // from none (`render`). Measured as each message lands, before the next rendering update, so
  // the region is never painted shorter. jsdom has no layout, so the floor never rises there.
  let statusFloor = 0;
  const holdStatusHeight = (): void => {
    const height = status.getBoundingClientRect().height;
    if (height <= statusFloor) return;
    statusFloor = height;
    status.style.minHeight = `${String(height)}px`;
  };
  const MO = view?.MutationObserver;
  const statusObserver = typeof MO === 'function' ? new MO(holdStatusHeight) : null;
  statusObserver?.observe(status, { childList: true, characterData: true, subtree: true });

  /** Whether `el` stands wholly inside the body's scrollport as the body is scrolled now. */
  function wholeInView(el: HTMLElement): boolean {
    const box = el.getBoundingClientRect();
    const port = body.getBoundingClientRect();
    return box.top >= port.top && box.bottom <= port.top + body.clientHeight;
  }

  function setRunDataExpanded(expanded: boolean): void {
    runDataToggle.setAttribute('aria-expanded', String(expanded));
    runData.hidden = !expanded;
  }
  setRunDataExpanded(false);
  runDataToggle.addEventListener('click', () =>
    setRunDataExpanded(runDataToggle.getAttribute('aria-expanded') !== 'true'),
  );

  return {
    root,
    body,
    title,
    description,
    playAgain,
    runDataToggle,
    runData,
    verify,
    copyRun,
    saveRun,
    surveySlots: { opener, form: surveyForm },
    status,
    render({ won, score: points, stars: earned, stats }: ResultsOutcome): void {
      // The outcome drives the band's colour and the Leaks tile's danger ink (`ui.css`).
      root.dataset.outcome = won ? 'won' : 'lost';
      title.textContent = won ? t('results.won') : t('results.lost');
      subtitle.textContent = won
        ? t('results.subtitle.won', { count: stats.waveCount })
        : t('results.subtitle.lost', { wave: stats.wavesLaunched, count: stats.waveCount });
      description.textContent = t('results.summary', { score: points, stars: earned });
      // Raw digits, like every HUD glance value: the number the description states, never a
      // differently grouped one beside it.
      scoreValue.textContent = String(points);
      for (const [index, star] of stars.entries()) {
        star.setAttribute('data-earned', String(index < earned));
      }
      for (const stat of STATS) statValues.get(stat)!.textContent = statValue(stat, stats);
      // A new dialog starts collapsed: the run data belongs to the run it was opened for.
      setRunDataExpanded(false);
      body.scrollTop = 0;
      // ...and with no status floor: the last dialog's messages are not this one's.
      statusFloor = 0;
      status.style.minHeight = '';
    },
    focusOnOpen(): void {
      // Placed now rather than at the observer's next pass: where Play again stands decides
      // which element takes focus.
      settle();
      body.scrollTop = 0;
      if (wholeInView(playAgain)) {
        playAgain.focus();
      } else {
        // Play again is below the fold (a short window at heavy text zoom), and focusing it
        // would scroll the outcome out of view. The ARIA dialog pattern's answer: focus a static
        // element at the top — the heading — and let Tab reach Play again.
        title.focus({ preventScroll: true });
      }
    },
    setRunDataExpanded,
    destroy(): void {
      restObserver?.disconnect();
      statusObserver?.disconnect();
      unguardPresses();
    },
  };
}
