/**
 * The question before a MANUAL switch of a topic between the two agent backends, Claude and OpenCode
 * (`utils/backendSwitchPlan.ts` decides when it is asked): «Switch this topic from OpenCode to Claude «work»? The
 * conversation context will be handed over in compacted form.» with ✅ Continue / ✖️ Cancel. It is a one-shot
 * keyboard: a tap consumes it (the message is edited into the outcome, the keyboard dropped), and an old one — the
 * topic changed backend meanwhile, a newer question replaced it, the bot restarted — only says it is out of date.
 * The switch itself is a port (`bot.ts`: the cross-backend move of the usage-limit switch, with the context
 * bridge as the first prompt). See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { t } from '../../../i18n';
import {
  backendSwitchCallbackRe,
  backendSwitchCancelCallback,
  backendSwitchContinueCallback,
  buildBackendSwitchQuestion,
  formatBackendFamily,
  formatBackendSwitchTarget,
  type BackendFamily,
  type BackendSwitchTarget,
} from '../../../utils/backendSwitchPlan';
import { buildMessageSnapshotKey, getCallbackMessageId } from './callbackMessage';
import type { BotCore } from './botCore';

/** Questions whose snapshot is kept (the newest); an older keyboard is refused as out of date. */
const pendingQuestionLimit = 20;

/** What the question needs from the bot: the shared core, the topic's backend now, and the switch itself. */
export interface BackendSwitchPorts
  extends Pick<BotCore, 'bot' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale'> {
  /** The backend family the topic's agent runs on now; `null` for no agent, a shell or an unknown name. */
  getCurrentFamily: (key: SessionKey) => BackendFamily | null;
  /**
   * Make the switch the operator confirmed: move the topic to `target` and hand the conversation over (the context
   * bridge is the new agent's first prompt). `userMessage` is the text typed with the command (`/opencode do X`).
   */
  performBackendSwitch: (key: SessionKey, target: BackendSwitchTarget, options: { userMessage?: string }) => Promise<void>;
}

/** What a question remembers, per MESSAGE: where the topic was asked to go from, and what the tap should do. */
interface PendingSwitch {
  topicKey: string;
  from: BackendFamily;
  target: BackendSwitchTarget;
  userMessage: string | undefined;
}

/** @description Build the question and its buttons over their ports. */
export function createBackendSwitch(ports: BackendSwitchPorts) {
  const { bot, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, getCurrentFamily, performBackendSwitch } = ports;

  /** Per MESSAGE, keyed by chat + message id (`buildMessageSnapshotKey`): a message id is unique only within one chat. */
  const pendingByMessage = new Map<string, PendingSwitch>();
  /** The one open question per topic (its snapshot key): a newer question retires the older one's snapshot. */
  const snapshotKeyByTopic = new Map<string, string>();

  function forget(snapshotKey: string): void {
    const pending = pendingByMessage.get(snapshotKey);
    pendingByMessage.delete(snapshotKey);
    if (pending && snapshotKeyByTopic.get(pending.topicKey) === snapshotKey) snapshotKeyByTopic.delete(pending.topicKey);
  }

  /**
   * @description Ask whether to switch `key` from `from` to `target`. Posts the question with its keyboard and
   * remembers it; the switch waits for the answer. A send that failed leaves nothing to remember.
   */
  async function askBackendSwitch(key: SessionKey, request: { from: BackendFamily; target: BackendSwitchTarget; userMessage?: string }): Promise<void> {
    const keyboard = Markup.inlineKeyboard([[
      Markup.button.callback(t('handover.continueButton'), backendSwitchContinueCallback),
      Markup.button.callback(t('handover.cancelButton'), backendSwitchCancelCallback),
    ]]);
    const messageId = await replyToThread(key, buildBackendSwitchQuestion(request), keyboard);
    if (messageId === null) return;
    const topicKey = keyToString(key);
    const snapshotKey = buildMessageSnapshotKey(key, messageId);
    const older = snapshotKeyByTopic.get(topicKey);
    if (older !== undefined) pendingByMessage.delete(older);
    pendingByMessage.set(snapshotKey, { topicKey, from: request.from, target: request.target, userMessage: request.userMessage });
    snapshotKeyByTopic.set(topicKey, snapshotKey);
    while (pendingByMessage.size > pendingQuestionLimit) {
      const oldest = pendingByMessage.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }
  }

  async function handleTap(ctx: Context, run: (key: SessionKey, messageId: number | null) => Promise<void>): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await withThreadLocale(key, () => run(key, getCallbackMessageId(ctx)));
  }

  function registerBackendSwitchCallbacks(): void {
    bot.action(backendSwitchCallbackRe, (ctx) => handleTap(ctx, async (key, messageId) => {
      // A button with no message to resolve a snapshot against (a very old message) is out of date by definition.
      if (messageId === null) { await ctx.answerCbQuery(t('backendSwitch.stale')); return; }
      const snapshotKey = buildMessageSnapshotKey(key, messageId);
      const pending = pendingByMessage.get(snapshotKey);
      // Out of date: nothing remembered (an older question, a restart), another topic's, or the topic is no longer on
      // the backend it was asked from. The keyboard is consumed all the same.
      if (!pending || pending.topicKey !== keyToString(key) || getCurrentFamily(key) !== pending.from) {
        await ctx.answerCbQuery(t('backendSwitch.stale'));
        forget(snapshotKey);
        await editThreadMessage(key, messageId, t('backendSwitch.stale'));
        return;
      }
      forget(snapshotKey);
      await ctx.answerCbQuery();
      const to = formatBackendSwitchTarget(pending.target);
      if (ctx.match[0] === backendSwitchCancelCallback) {
        await editThreadMessage(key, messageId, t('backendSwitch.cancelled', { from: formatBackendFamily(pending.from) }));
        return;
      }
      await editThreadMessage(key, messageId, t('backendSwitch.switching', { to }));
      try {
        await performBackendSwitch(key, pending.target, { userMessage: pending.userMessage });
        await editThreadMessage(key, messageId, t('backendSwitch.switched', { to }));
      } catch (e) {
        console.error(`[backendSwitch] ${keyToString(key)}: the switch to ${to} failed:`, e instanceof Error ? e.message : e);
        await editThreadMessage(key, messageId, t('backendSwitch.failed', { to, error: e instanceof Error ? e.message : 'unknown error' }));
      }
    }));
  }

  return { askBackendSwitch, registerBackendSwitchCallbacks };
}
