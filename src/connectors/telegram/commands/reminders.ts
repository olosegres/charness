/**
 * `/reminders` — bot-LOCAL reminders (buttons only, zero agent involvement): the hub, the four-step wizard, the
 * list, the card and delete. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import { checkIsApiError, getErrorDescription } from '../../../sendErrorClassifier';
import type { SchedulerEngine } from '../../../scheduler/engine';
import { checkIsReminderSchedule } from '../../../scheduler/deliveryKind';
import { maxRemindersPerThread, createScheduleForThread } from '../../../scheduler/store';
import type { ScheduleRecord, ScheduleSpec } from '../../../scheduler/types';
import {
  type ReminderWizardState,
  type ReminderSchedulePicks,
  type ReminderWizardErrorCode,
  reminderTextMaxLength,
  type ReminderButtonLabel,
  type ReminderKeyboardPlan,
  reminderCloseCallback,
  type ReminderListRow,
  getReminderScheduleDescriptor,
  type ReminderScheduleDescriptor,
  reminderLabelKeys,
  buildReminderDeleteCallback,
  buildReminderListPageCallback,
  reminderRepeatLabelKeys,
  reminderWeekdayLabelKeys,
  formatReminderTime,
  getShortenedText,
  reminderSummaryTextMaxLength,
  buildReminderStepKeyboard,
  buildReminderHubKeyboard,
  buildReminderListPlan,
  buildReminderCardPlan,
  getReminderNameFromText,
  buildReminderSpec,
  getReminderStateForRetime,
  reminderAddCallback,
  createReminderWizardState,
  createReminderWizardId,
  reminderHubCallback,
  reminderListPageCallbackRe,
  parseReminderListPageCallback,
  reminderCardCallbackRe,
  parseReminderCardCallback,
  reminderDeleteCallbackRe,
  parseReminderDeleteCallback,
  getReminderDeleteTarget,
  getReminderCardBackPage,
  reminderWizardCallbackRe,
  applyReminderWizardCallback,
  getReminderPicksFromState,
  getReminderStateForStep,
} from '../../../utils/reminderWizard';
import {
  getReminderRowLabel,
  getReminderScheduleDescriptorText,
  getReminderNextRunText,
} from '../../../utils/reminderScheduleText';
import {
  getReminderHubPlan,
  type ReminderTextCaptureRoute,
  getReminderTextCaptureRoute,
  getReminderTextAcceptance,
  getReminderWizardTapRoute,
  checkIsReminderTextWaitKept,
} from '../../../utils/reminderFlow';
import { getCallbackMessageId } from './callbackMessage';
import type { BotCore } from './botCore';

// ═══════════════════════════════════════════════════════════════════════════════
//  /reminders — bot-LOCAL reminders (buttons only, zero agent involvement)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description One topic's in-flight add wizard.
 *
 * Kept in MEMORY, not `state.json`, on purpose: hot mode restarts the bot on
 * every code change and an unfinished wizard is a few taps, not data worth
 * persisting — while the reminder it produces goes straight to disk through the
 * normal schedule store.
 *
 * `messageId` is the ONE message the whole flow occupies: the hub message becomes
 * the wizard, each tap re-renders it, and it finally becomes the created card.
 * `textWait` is set only on step 4 and carries the COMPLETE pick set, so the
 * creation path is unreachable with a half-answered wizard.
 */
export interface ReminderWizardSession {
  state: ReminderWizardState;
  messageId: number;
  textWait: {
    picks: ReminderSchedulePicks;
    armedAtMs: number;
    /**
     * Set by the message that consumed this wait, so a second message arriving
     * concurrently cannot create a second reminder from the same wizard. Released
     * again only when the wizard STAYS on step 4 (an over-long text), because then
     * a shorter retry still has to be captured.
     */
    isClaimed: boolean;
  } | null;
}

/** Width of the `HH` field in the minute step's `21:__` header. */
const reminderHourFieldWidth = 2;

/** Error code → the line the wizard prints above the step it re-renders. */
const reminderWizardErrorKeys: Readonly<Record<ReminderWizardErrorCode, string>> = {
  pastTime: 'reminders.errorPastTime',
  invalidDate: 'reminders.errorInvalidDate',
  invalidTime: 'reminders.errorInvalidTime',
  textTooLong: 'reminders.errorTextTooLong',
};

/**
 * @description Resolve a wizard error into its localized line. One choke point so
 * the `textTooLong` wording names the bound it rejected from the SINGLE constant
 * instead of having the number spelled out in 12 translations; the other codes
 * carry no `{limit}` and simply ignore it.
 */
function getReminderWizardErrorText(errorCode: ReminderWizardErrorCode): string {
  return t(reminderWizardErrorKeys[errorCode], { limit: reminderTextMaxLength });
}

/** A rendered reminder screen: the message text plus the keyboard that goes with it. */
interface ReminderScreen {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}

/**
 * Resolve one planned button caption: a locale-neutral literal, an i18n key, or a
 * list row — whose caption is composed HERE because its schedule half is itself a
 * localized lookup the pure planner cannot make.
 */
function renderReminderButtonLabel(label: ReminderButtonLabel): string {
  switch (label.kind) {
    case 'literal':
      return label.text;
    case 'key':
      return t(label.key, label.vars);
    case 'listRow':
      return getReminderRowLabel(label.name, label.descriptor);
  }
}

/** Turn a keyboard PLAN from the pure module into telegraf button rows. */
function renderReminderButtonRows(plan: ReminderKeyboardPlan) {
  return plan.map((row) =>
    row.map((button) =>
      Markup.button.callback(renderReminderButtonLabel(button.label), button.callbackData),
    ),
  );
}

function buildReminderKeyboard(plan: ReminderKeyboardPlan) {
  return Markup.inlineKeyboard(renderReminderButtonRows(plan));
}

/**
 * The «close» button. Composed HERE rather than inside `buildReminderHubKeyboard`
 * because that builder owns the rows whose PRESENCE is a decision (add at the
 * cap, list when empty), whereas «close» is an unconditional dismissal that both
 * the hub and the created card carry.
 */
function buildReminderCloseButton() {
  return Markup.button.callback(t('reminders.closeButton'), reminderCloseCallback);
}

/** Records → the rows the pure list/card plans consume. */
function toReminderListRows(records: readonly ScheduleRecord[]): ReminderListRow[] {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    descriptor: getReminderScheduleDescriptor(record.spec),
  }));
}

/**
 * The three detail lines a reminder is described by. Shared by the card opened
 * from the list and by the created-screen, so the two can never describe the same
 * reminder differently.
 */
function buildReminderDetailLines(
  record: ScheduleRecord,
  descriptor: ReminderScheduleDescriptor,
): string[] {
  return [
    t('reminders.cardWhen', { schedule: getReminderScheduleDescriptorText(descriptor) }),
    t('reminders.cardText', { text: record.prompt }),
    t('reminders.cardNext', { next: getReminderNextRunText(record.nextRunAt, Date.now()) }),
  ];
}

/** The done screen: what was created, plus delete / list / close. */
function buildReminderCreatedScreen(record: ScheduleRecord): ReminderScreen {
  return {
    text: [
      t('reminders.createdTitle'),
      ...buildReminderDetailLines(record, getReminderScheduleDescriptor(record.spec)),
    ].join('\n'),
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback(t(reminderLabelKeys.cardDelete), buildReminderDeleteCallback(record.id)),
        Markup.button.callback(t('reminders.doneListButton'), buildReminderListPageCallback(0)),
        buildReminderCloseButton(),
      ],
    ]),
  };
}

/** The question the wizard's CURRENT step asks. */
function getReminderStepQuestion(wizardState: ReminderWizardState): string {
  switch (wizardState.step) {
    case 'repeat':
      return t('reminders.stepRepeatQuestion');
    case 'date':
      return t('reminders.stepDateQuestion');
    case 'dateGrid':
      return t('reminders.stepDateGridQuestion');
    case 'weekday':
      return t('reminders.stepWeekdayQuestion');
    case 'dayOfMonth':
      return t('reminders.stepDayOfMonthQuestion');
    case 'dayOfMonthGrid':
      return t('reminders.stepDayOfMonthGridQuestion');
    case 'time':
      return t('reminders.stepTimeQuestion');
    case 'hour':
      return t('reminders.stepHourQuestion');
    case 'minute':
      // The hour is committed before this screen renders; `?? 0` only narrows the
      // optional field (a minute step with no hour is refused by the pure module).
      return t('reminders.stepMinuteQuestion', {
        hour: (wizardState.hour ?? 0).toString().padStart(reminderHourFieldWidth, '0'),
      });
    case 'text':
      return t('reminders.stepTextQuestion');
  }
}

/**
 * @description The wizard screen for a state: the title, the running summary of
 * everything already picked, then the current step's question (preceded by an
 * error line when a pick could not be applied). The summary is what makes a
 * single re-rendered message readable as a flow — each tap appends its value.
 */
function buildReminderWizardScreen(
  wizardState: ReminderWizardState,
  errorCode: ReminderWizardErrorCode | null,
): ReminderScreen {
  const lines = [t('reminders.wizardTitle')];
  if (wizardState.repeatKind !== null) {
    lines.push(t('reminders.pickRepeat', { value: t(reminderRepeatLabelKeys[wizardState.repeatKind]) }));
  }
  if (wizardState.dateIso !== null) {
    lines.push(t('reminders.pickDate', { value: wizardState.dateIso }));
  }
  if (wizardState.weekday !== null) {
    lines.push(t('reminders.pickWeekday', { value: t(reminderWeekdayLabelKeys[wizardState.weekday]) }));
  }
  if (wizardState.dayOfMonth !== null) {
    lines.push(t('reminders.pickDayOfMonth', { value: wizardState.dayOfMonth }));
  }
  if (wizardState.hour !== null && wizardState.minute !== null) {
    lines.push(
      t('reminders.pickTime', {
        value: formatReminderTime({ hour: wizardState.hour, minute: wizardState.minute }),
      }),
    );
  }
  if (wizardState.text !== null) {
    // Only a stale-instant retry holds text. The line is what tells the operator it
    // was KEPT — without it they retype the reminder, and a retyped message is no
    // longer captured by the (now disarmed) text wait: it reaches the agent instead.
    lines.push(
      t('reminders.pickText', {
        value: getShortenedText(wizardState.text, reminderSummaryTextMaxLength),
      }),
    );
  }
  const question = getReminderStepQuestion(wizardState);
  const body = errorCode === null ? question : `${getReminderWizardErrorText(errorCode)}\n\n${question}`;
  return {
    text: `${lines.join('\n')}\n\n${body}`,
    keyboard: buildReminderKeyboard(buildReminderStepKeyboard({ state: wizardState, nowMs: Date.now() })),
  };
}

/** Drop the keyboard of a tapped DEAD screen, swallowing a benign no-op edit. */
async function stripReminderKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) {
      console.warn('[reminders] keyboard strip failed:', desc || e);
    }
  }
}

/**
 * What the `/reminders` flow needs from the bot: the shared core, the in-flight wizards (the bot drops one when
 * its topic is gone), and the scheduler engine, which exists only after the boot built it.
 */
export interface RemindersPorts
  extends Pick<BotCore, 'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext'> {
  reminderWizards: Map<string, ReminderWizardSession>;
  getSchedulerEngine: () => SchedulerEngine | null;
}

/**
 * @description Build the `/reminders` flow over its ports. It returns what the bot reaches into from outside
 * the flow — the text-capture hooks of the wizard's last step and its cancel — and the two `register…()` calls.
 */
export function createReminders(ports: RemindersPorts) {
  const { reminderWizards, getSchedulerEngine, bot, command, getState, replyToThread, editThreadMessage, authoriseContext } = ports;

  /** The thread's reminders — its agent-prompt schedules filtered out. */
  function getThreadReminders(key: SessionKey): ScheduleRecord[] {
    return getState().getThreadSchedules(key).filter(checkIsReminderSchedule);
  }

  /** Screen 0: the count (or why «add» is missing) plus the add/list/close rows. */
  function buildReminderHubScreen(key: SessionKey): ReminderScreen {
    const records = getThreadReminders(key);
    const plan = getReminderHubPlan({
      // The reminder cap is the comparison `createScheduleForThread` makes for a
      // reminder, so «add» is never drawn for a create the store would reject four
      // steps later.
      reminderCount: records.length,
      maxReminders: maxRemindersPerThread,
    });
    const bodyLine =
      plan.body === 'empty'
        ? t('reminders.hubEmptyLine')
        : plan.body === 'atLimit'
          ? t('reminders.hubLimitLine', { count: records.length, limit: maxRemindersPerThread })
          : t('reminders.hubActiveLine', { count: records.length });
    const rows = buildReminderHubKeyboard(records.length, { isAddOffered: plan.isAddOffered });
    return {
      text: `${t('reminders.hubTitle')}\n${bodyLine}`,
      keyboard: Markup.inlineKeyboard([...renderReminderButtonRows(rows), [buildReminderCloseButton()]]),
    };
  }

  /**
   * @description One list page, or `null` when the thread has no reminders (the
   * caller falls back to the hub — a list screen with no rows is a dead end).
   *
   * Each row BUTTON carries «🔔 name · localized schedule», so the message text is
   * only a header — printing the same rows in the body as well would show the list
   * twice.
   */
  function buildReminderListScreen(key: SessionKey, page: number): ReminderScreen | null {
    const rows = toReminderListRows(getThreadReminders(key));
    if (rows.length === 0) return null;
    const plan = buildReminderListPlan(rows, page);
    const lines = [t('reminders.listTitle', { count: rows.length })];
    if (plan.totalPages > 1) {
      lines.push(t('reminders.listPageLine', { page: plan.currentPage + 1, total: plan.totalPages }));
    }
    return { text: lines.join('\n'), keyboard: buildReminderKeyboard(plan.keyboard) };
  }

  /** One reminder's card, or `null` for a stale row index / a record already gone. */
  function buildReminderCardScreen(key: SessionKey, reminderIndex: number): ReminderScreen | null {
    const records = getThreadReminders(key);
    const plan = buildReminderCardPlan(toReminderListRows(records), reminderIndex);
    if (plan === null) return null;
    const record = records.find((candidate) => candidate.id === plan.row.id);
    if (record === undefined) return null;
    return {
      text: [
        t('reminders.cardTitle', { name: plan.row.name }),
        ...buildReminderDetailLines(record, plan.row.descriptor),
      ].join('\n'),
      keyboard: buildReminderKeyboard(plan.keyboard),
    };
  }

  /** Replace a reminder screen in place (the flow never creates a second message). */
  async function renderReminderScreen(
    key: SessionKey,
    messageId: number,
    screen: ReminderScreen,
  ): Promise<void> {
    await editThreadMessage(key, messageId, screen.text, screen.keyboard);
  }

  /**
   * Relabel a reminder screen into a final notice and DROP its keyboard (an edit
   * with no `reply_markup` removes it), so a finished screen can't be acted on.
   */
  async function retireReminderScreen(key: SessionKey, messageId: number, text: string): Promise<void> {
    await editThreadMessage(key, messageId, text);
  }

  /**
   * @description Retire the topic's in-flight wizard, if any: drop the session and
   * relabel its message so no dead keyboard is left tappable.
   *
   * Called by EVERY command (a command always wins over the step-4 text wait),
   * which is also what makes a repeat `/reminders` retire the previous wizard
   * before opening a new one — exactly one wizard is live per topic.
   */
  async function cancelReminderWizard(key: SessionKey): Promise<void> {
    const kStr = keyToString(key);
    const session = reminderWizards.get(kStr);
    if (!session) return;
    reminderWizards.delete(kStr);
    await retireReminderScreen(key, session.messageId, t('reminders.cancelledNotice'));
  }

  /**
   * @description Retire a wizard whose step-4 text wait ran out. The triggering
   * message is NOT consumed by the caller — it falls through to normal handling,
   * because swallowing it would lose a prompt the operator meant for the agent.
   */
  async function expireReminderWizard(key: SessionKey): Promise<void> {
    const kStr = keyToString(key);
    const session = reminderWizards.get(kStr);
    if (!session) return;
    reminderWizards.delete(kStr);
    await retireReminderScreen(key, session.messageId, t('reminders.expiredNotice'));
  }

  /**
   * @description Route an inbound message against the topic's step-4 text wait and,
   * when it IS the reminder text, CLAIM that wait — synchronously, before the caller
   * reaches its first `await`.
   *
   * The claim is the mutual exclusion: telegraf handles updates concurrently, so two
   * messages arriving together both pass an unclaimed wait and would each create a
   * reminder from the one wizard. A single-threaded event loop needs nothing heavier
   * than this flag — no lock, no timer — provided it is taken in the same synchronous
   * run as the decision, which is why claiming and routing are one function. Both the
   * typed and the voice path call it, so they cannot claim differently.
   */
  function claimReminderTextCapture(key: SessionKey): ReminderTextCaptureRoute {
    const textWait = reminderWizards.get(keyToString(key))?.textWait;
    const route = getReminderTextCaptureRoute({
      armedAtMs: textWait?.armedAtMs ?? null,
      isClaimed: textWait?.isClaimed === true,
      nowMs: Date.now(),
    });
    if (route === 'capture' && textWait) textWait.isClaimed = true;
    return route;
  }

  /**
   * @description Persist a finished wizard's reminder, retire the wizard and turn its
   * message into the created card. The SINGLE creation path — shared by the text
   * capture and by the `createNow` retry after a stale instant — so the two can never
   * create reminders differently.
   */
  async function createReminderFromWizard(input: {
    key: SessionKey;
    session: ReminderWizardSession;
    spec: ScheduleSpec;
    text: string;
    nowMs: number;
  }): Promise<void> {
    const { key, session, text } = input;
    reminderWizards.delete(keyToString(key));
    const created = await createScheduleForThread(getState(), {
      threadKey: key,
      // The wizard never ASKS for a name — one less typing step; the list rows and
      // the card show the first words of the reminder itself.
      name: getReminderNameFromText(text),
      spec: input.spec,
      prompt: text,
      createdBy: 'user',
      nowMs: input.nowMs,
      deliveryKind: 'reminder',
    });
    if (!created.ok) {
      await retireReminderScreen(
        key,
        session.messageId,
        t('reminders.capReachedNotice', { limit: created.limit }),
      );
      return;
    }
    getSchedulerEngine()?.armJob(created.record);
    await renderReminderScreen(key, session.messageId, buildReminderCreatedScreen(created.record));
  }

  /**
   * @description Turn the wizard's picks plus the operator's text into a reminder —
   * the entry point shared by the typed message and the transcribed voice note.
   *
   * The spec is rebuilt at THIS instant rather than reused from the time step:
   * minutes pass while the operator types, so a `once` reminder for «today» may have
   * gone by. That is reported on the time screen — and the text they just sent is
   * KEPT on the wizard, so the next time pick creates the reminder without asking for
   * it again. Re-typing the reminder is the one thing this all-buttons flow exists to
   * avoid.
   */
  async function finishReminderWizard(key: SessionKey, text: string): Promise<void> {
    const session = reminderWizards.get(keyToString(key));
    const textWait = session?.textWait;
    if (!session || !textWait) return;

    // An over-long text is refused outright — it is never truncated, because the
    // words are the operator's own. The wizard therefore STAYS on step 4 (the error
    // rides the same screen) and the claim is released first, so the shorter retry is
    // captured instead of reaching the agent as a prompt.
    if (getReminderTextAcceptance(text) === 'tooLong') {
      textWait.isClaimed = false;
      await renderReminderScreen(
        key,
        session.messageId,
        buildReminderWizardScreen(session.state, 'textTooLong'),
      );
      return;
    }

    const nowMs = Date.now();
    const built = buildReminderSpec({ picks: textWait.picks, nowMs });
    if (!built.ok) {
      const retimeStep = getReminderStateForRetime(session.state, text);
      session.state = retimeStep;
      // Disarmed on purpose: the screen now asks for a TIME, not for text.
      session.textWait = null;
      await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(retimeStep, built.code));
      return;
    }

    await createReminderFromWizard({ key, session, spec: built.spec, text, nowMs });
  }

  function registerReminderCommands(): void {
    // `/reminders` — the reminder hub. Deliberately NOT gated on a binding or a
    // session: the bot itself posts and pins a reminder, so it needs neither a folder
    // nor an agent and works in every topic, General included.
    command('reminders', async (_ctx, key) => {
      const screen = buildReminderHubScreen(key);
      await replyToThread(key, screen.text, screen.keyboard);
    });
  }

  function registerReminderCallbacks(): void {
    /**
     * @description `/reminders` callbacks. Every one of them EDITS the tapped message
     * — the hub, the list, a card, the wizard and the created screen are all the same
     * message re-rendered, so a reminder session never litters the topic.
     *
     * The flat ids (`rmadd` / `rmhub` / `rmclose`) are registered before the prefixed
     * matchers, following the ordering rule the `/timezone` and `/model` pickers rely
     * on (Telegraf dispatches action patterns first-match-wins).
     */

    // «➕ Add» → open the wizard IN the hub message.
    bot.action(reminderAddCallback, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const messageId = getCallbackMessageId(ctx);
      if (messageId === null) { await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer')); return; }

      // At the cap the hub draws no «add», so a tap can only come from a keyboard
      // rendered before the cap was reached: say why and refresh the screen.
      const hubPlan = getReminderHubPlan({
        reminderCount: getThreadReminders(key).length,
        maxReminders: maxRemindersPerThread,
      });
      if (!hubPlan.isAddOffered) {
        await ctx.answerCbQuery(t('reminders.capReachedNotice', { limit: maxRemindersPerThread }));
        await renderReminderScreen(key, messageId, buildReminderHubScreen(key));
        return;
      }

      // An older hub message can still open a wizard while one is live; retire that
      // one first so only ever one wizard belongs to the topic.
      await cancelReminderWizard(key);
      const wizardState = createReminderWizardState(createReminderWizardId(Date.now()));
      reminderWizards.set(keyToString(key), { state: wizardState, messageId, textWait: null });
      await ctx.answerCbQuery();
      await renderReminderScreen(key, messageId, buildReminderWizardScreen(wizardState, null));
    });

    // «‹ Back» from the list → the hub.
    bot.action(reminderHubCallback, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const messageId = getCallbackMessageId(ctx);
      await ctx.answerCbQuery();
      if (messageId !== null) await renderReminderScreen(key, messageId, buildReminderHubScreen(key));
    });

    // «✕ Close» → relabel the screen and drop its keyboard.
    bot.action(reminderCloseCallback, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const messageId = getCallbackMessageId(ctx);
      await ctx.answerCbQuery();
      if (messageId !== null) await retireReminderScreen(key, messageId, t('reminders.closedNotice'));
    });

    // A list page (or a prev/next arrow). A now-empty list falls back to the hub.
    bot.action(reminderListPageCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const messageId = getCallbackMessageId(ctx);
      const page = parseReminderListPageCallback(ctx.match[0]);
      await ctx.answerCbQuery();
      if (messageId === null || page === null) return;
      await renderReminderScreen(
        key,
        messageId,
        buildReminderListScreen(key, page) ?? buildReminderHubScreen(key),
      );
    });

    // A list row → its card. A stale index (the list shrank since it was rendered)
    // says so and reopens the list rather than opening a NEIGHBOURING reminder.
    bot.action(reminderCardCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const messageId = getCallbackMessageId(ctx);
      const reminderIndex = parseReminderCardCallback(ctx.match[0]);
      if (messageId === null || reminderIndex === null) { await ctx.answerCbQuery(); return; }
      const screen = buildReminderCardScreen(key, reminderIndex);
      if (screen === null) {
        await ctx.answerCbQuery(t('reminders.cardExpiredCbAnswer'));
        await renderReminderScreen(
          key,
          messageId,
          buildReminderListScreen(key, 0) ?? buildReminderHubScreen(key),
        );
        return;
      }
      await ctx.answerCbQuery();
      await renderReminderScreen(key, messageId, screen);
    });

    // «🗑 Delete» — there is deliberately NO extra confirmation step: the card the
    // button sits on shows exactly what is about to go, so the card IS the
    // confirmation. The reminder's own id is baked into the callback (never a
    // positional index), so an old card can't delete whatever now occupies its row.
    bot.action(reminderDeleteCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const messageId = getCallbackMessageId(ctx);
      const reminderId = parseReminderDeleteCallback(ctx.match[0]);
      if (messageId === null || reminderId === null) { await ctx.answerCbQuery(); return; }

      const rows = toReminderListRows(getThreadReminders(key));
      const target = getReminderDeleteTarget(rows, reminderId);
      if (target.kind === 'notFound') {
        await ctx.answerCbQuery(t('reminders.deleteGoneCbAnswer'));
        await renderReminderScreen(
          key,
          messageId,
          buildReminderListScreen(key, 0) ?? buildReminderHubScreen(key),
        );
        return;
      }
      // Return to the page the deleted row was on (a shrunk list clamps the page).
      const listPage = getReminderCardBackPage(rows.findIndex((row) => row.id === target.row.id));
      await getState().removeSchedule(target.row.id);
      getSchedulerEngine()?.disarmJob(target.row.id);
      await ctx.answerCbQuery(t('reminders.deletedCbAnswer'));
      await renderReminderScreen(
        key,
        messageId,
        buildReminderListScreen(key, listPage) ?? buildReminderHubScreen(key),
      );
    });

    // Every wizard button. The wizard id baked into the callback is what makes an
    // abandoned keyboard inert: a tap from a dead screen changes NO state.
    bot.action(reminderWizardCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const kStr = keyToString(key);
      const session = reminderWizards.get(kStr);
      const callbackData = ctx.match[0];

      // A tap from a DEAD screen (no wizard live, or a different wizard's id): say so
      // and strip THAT message's keyboard, because it can never be finished.
      if (
        session === undefined ||
        getReminderWizardTapRoute({ liveWizardId: session.state.wizardId, callbackData }) === 'foreign'
      ) {
        await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer'));
        await stripReminderKeyboard(ctx);
        return;
      }

      const nowMs = Date.now();
      const transition = applyReminderWizardCallback({ state: session.state, callbackData, nowMs });
      // ONE choke point for the step-4 wait: any outcome that moves the wizard off the
      // text step disarms it here. «‹ Back» out of step 4 is the reachable case — the
      // screen goes back to asking for a TIME, and a wait left armed would swallow the
      // operator's next ordinary message and create the reminder from the picks they
      // went back to change.
      if (!checkIsReminderTextWaitKept(transition.kind)) session.textWait = null;
      switch (transition.kind) {
        case 'expired':
          // The live wizard, but an action from a step it has already left (a tap on a
          // stale VIEW of this same message). Re-render the current step instead of
          // stripping the keyboard — the wizard is alive and must stay finishable.
          await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer'));
          await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(session.state, null));
          return;
        case 'cancelled':
          reminderWizards.delete(kStr);
          await ctx.answerCbQuery();
          await retireReminderScreen(key, session.messageId, t('reminders.cancelledNotice'));
          return;
        case 'backToHub':
          reminderWizards.delete(kStr);
          await ctx.answerCbQuery();
          await renderReminderScreen(key, session.messageId, buildReminderHubScreen(key));
          return;
        case 'error':
          // The time was not committed: the screen re-renders WITH the reason, so
          // «today» plus a time that has gone by is said out loud rather than silently
          // rolled to tomorrow. The returned state is written back because it is not
          // always the one that came in — a DST-skipped time hands back the TIME step,
          // and a screen the session disagreed with would treat the next tap as stale.
          session.state = transition.state;
          await ctx.answerCbQuery(getReminderWizardErrorText(transition.code));
          await renderReminderScreen(
            key,
            session.messageId,
            buildReminderWizardScreen(transition.state, transition.code),
          );
          return;
        case 'render':
          session.state = transition.state;
          await ctx.answerCbQuery();
          await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(session.state, null));
          return;
        case 'awaitText': {
          const picks = getReminderPicksFromState(transition.state);
          if (picks === null) {
            // Unreachable through the keyboards (`awaitText` is returned only after a
            // spec built cleanly from these very picks). Park the wizard back on the
            // time step rather than arming a wait that could not create anything.
            const timeStep = getReminderStateForStep(session.state, 'time');
            session.state = timeStep;
            await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer'));
            await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(timeStep, null));
            return;
          }
          session.state = transition.state;
          session.textWait = { picks, armedAtMs: nowMs, isClaimed: false };
          await ctx.answerCbQuery();
          await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(session.state, null));
          return;
        }
        case 'createNow':
          // The text is already in hand — it arrived before the picked instant went
          // stale — so this replacement time pick finishes the reminder outright
          // instead of sending the operator back through step 4. The session is
          // retired by the create, so there is no state left to write back.
          await ctx.answerCbQuery();
          await createReminderFromWizard({
            key,
            session,
            spec: transition.spec,
            text: transition.text,
            nowMs,
          });
          return;
      }
    });
  }

  return {
    cancelReminderWizard,
    claimReminderTextCapture,
    expireReminderWizard,
    finishReminderWizard,
    registerReminderCommands,
    registerReminderCallbacks,
  };
}
