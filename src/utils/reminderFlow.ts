/**
 * @description The `/reminders` decisions that live OUTSIDE the pure wizard
 * module because they depend on the bot's own surroundings rather than on the
 * wizard's step machine: which hub screen to draw (a function of the scheduler's
 * per-thread reminder cap), whether a step-4 text wait has expired or is already
 * claimed by another inbound message, whether the captured text is short enough
 * to keep, whether the wait survives a given wizard transition at all, and
 * whether a tapped wizard button belongs to the wizard that is live right now.
 *
 * They are here rather than in `bot.ts` for the usual reason: `bot.ts` cannot be
 * imported by a test (its module-scope `parseEnv()` exits the process), and each
 * of these is a rule whose failure is silent — a hub that offers «add» at the cap
 * is a dead end, an unexpired text wait swallows an ordinary message that should
 * have reached the agent, an unclaimed one creates two reminders from one wizard,
 * and a mis-routed stale tap feeds picks into the wrong wizard.
 */

import {
  parseReminderWizardCallback,
  reminderTextMaxLength,
  type ReminderWizardTransition,
} from './reminderWizard';

/**
 * How long step 4 keeps waiting for the reminder text. The wait INTERCEPTS every
 * plain message in the topic, so it must expire: an abandoned wizard would
 * otherwise swallow, hours later, a message the operator meant for the agent.
 * 15 minutes is long enough to finish typing and short enough that nobody has
 * forgotten what they were doing.
 */
export const reminderTextWaitMs = 15 * 60 * 1000;

/**
 * @name ReminderHubBody
 * @description Which line the hub prints under its title.
 *  - `empty`   — nothing scheduled yet.
 *  - `active`  — the count.
 *  - `atLimit` — the count PLUS "delete one to add another", because the «add»
 *                button is gone and the operator needs to know why.
 */
export type ReminderHubBody = 'empty' | 'active' | 'atLimit';

/** The hub screen's two decisions: what the body says, and whether «add» is drawn. */
export interface ReminderHubPlan {
  body: ReminderHubBody;
  isAddOffered: boolean;
}

/**
 * @description Decide the hub screen. At (or past) the per-thread REMINDER cap
 * the «add» button is NOT offered: the create would be rejected by the store, so
 * a button that can only fail is worse than no button — provided the screen says
 * why, which is what the `atLimit` body is for.
 *
 * The comparison must be the one `createScheduleForThread` makes, or the hub walks
 * the operator through all four steps and only then hits a rejection. That store
 * counts a reminder against the REMINDER cap alone, so the topic's agent-prompt
 * jobs are irrelevant here — a topic full of `/schedule` jobs still has room for
 * reminders.
 *
 * A non-positive cap is treated as "at the limit" rather than special-cased: it
 * is the same user-visible truth (nothing more can be created).
 */
export function getReminderHubPlan(input: {
  reminderCount: number;
  maxReminders: number;
}): ReminderHubPlan {
  const isAtLimit = input.reminderCount >= input.maxReminders;
  if (isAtLimit) return { body: 'atLimit', isAddOffered: false };
  return { body: input.reminderCount === 0 ? 'empty' : 'active', isAddOffered: true };
}

/**
 * @name ReminderTextCaptureRoute
 * @description What an inbound message in the topic means for a reminder wizard.
 *  - `notArmed` — no wizard is waiting for text; handle the message normally.
 *  - `capture`  — this message IS the reminder text.
 *  - `claimed`  — a wizard is waiting, but another message got there first: handle
 *                 this one normally, because the wait it would have filled is
 *                 already being consumed.
 *  - `expired`  — a wizard was waiting but the window closed: retire it AND let
 *                 the message fall through to normal handling (swallowing it
 *                 would lose a prompt the operator meant for the agent).
 */
export type ReminderTextCaptureRoute = 'notArmed' | 'capture' | 'claimed' | 'expired';

/**
 * @description Route an inbound message against the step-4 wait. `armedAtMs` is
 * `null` whenever no wizard is on the text step (never armed, already finished,
 * cancelled). Takes the instant as an argument so the window is testable without
 * a clock.
 *
 * `isClaimed` is what makes the wait single-use. Telegraf handles updates
 * CONCURRENTLY and only the voice path is serialized per thread, so two messages
 * arriving together would both route `capture` and create two reminders from one
 * wizard; the caller claims the wait synchronously before its first `await`, and
 * the loser lands here as `claimed`.
 *
 * `claimed` is checked BEFORE the window: a claim means the winner is already
 * turning that wizard's message into the created card, so reporting `expired`
 * underneath it would retire the wizard and relabel the very message being
 * finished.
 */
export function getReminderTextCaptureRoute(input: {
  armedAtMs: number | null;
  isClaimed: boolean;
  nowMs: number;
}): ReminderTextCaptureRoute {
  if (input.armedAtMs === null) return 'notArmed';
  if (input.isClaimed) return 'claimed';
  return input.nowMs - input.armedAtMs >= reminderTextWaitMs ? 'expired' : 'capture';
}

/**
 * @name ReminderTextAcceptance
 * @description Whether a captured reminder text can be kept.
 *  - `accept`  — within {@link reminderTextMaxLength}; create the reminder.
 *  - `tooLong` — over it: nothing is saved, step 4 re-renders with the reason and
 *                the wait stays armed for a shorter retry.
 */
export type ReminderTextAcceptance = 'accept' | 'tooLong';

/**
 * @description Bound the captured reminder text — the ONE gate both text sources
 * (a typed message and a transcribed voice note) pass, since a transcript carries
 * no length bound of its own.
 *
 * An over-long text is REJECTED, never truncated. Truncating would silently ship a
 * reminder whose words are not the operator's, while accepting it breaks three
 * screens at once: the "created" edit fails, so they still see step 4 and believe
 * nothing happened; the card cannot be opened, which is the only place a delete
 * button lives; and at fire time the announcement send fails while the run is
 * still recorded as delivered.
 */
export function getReminderTextAcceptance(text: string): ReminderTextAcceptance {
  return text.length > reminderTextMaxLength ? 'tooLong' : 'accept';
}

/**
 * @description Whether a wizard transition leaves the step-4 text wait ARMED.
 * Only the two outcomes that end ON the text step do; every other outcome moves
 * the wizard off step 4 and must disarm it.
 *
 * Load-bearing for «‹ Back» out of the text step: the screen then asks for a TIME
 * again, so a wait left armed would capture the operator's next ordinary message
 * and create the reminder from the very picks they went back to change — and that
 * message never reaches the agent it was meant for.
 */
export function checkIsReminderTextWaitKept(
  transitionKind: ReminderWizardTransition['kind'],
): boolean {
  return transitionKind === 'awaitText' || transitionKind === 'createNow';
}

/**
 * @name ReminderWizardTapRoute
 * @description Where a tapped wizard button is routed.
 *  - `foreign` — it belongs to no live wizard (a different wizard's id, or none
 *                is live at all): answer "out of date" and strip THAT message's
 *                keyboard, since the screen it came from is dead.
 *  - `apply`   — it belongs to the live wizard: hand it to
 *                `applyReminderWizardCallback`, which owns the remaining guard
 *                (an action that does not belong to the step now on screen).
 */
export type ReminderWizardTapRoute = 'foreign' | 'apply';

/**
 * @description Split "this tap is from a dead screen" from "this tap is for the
 * live wizard". The distinction is load-bearing for the recovery action, not just
 * the message: stripping the keyboard is right for a dead screen and WRONG for
 * the live wizard (a tap on a stale VIEW of the live wizard would otherwise leave
 * the operator staring at a keyboard-less, unfinishable wizard).
 */
export function getReminderWizardTapRoute(input: {
  liveWizardId: string | null;
  callbackData: string;
}): ReminderWizardTapRoute {
  if (input.liveWizardId === null) return 'foreign';
  const parsed = parseReminderWizardCallback(input.callbackData);
  if (parsed === null || parsed.wizardId !== input.liveWizardId) return 'foreign';
  return 'apply';
}
