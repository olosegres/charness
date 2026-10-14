/**
 * The «wait for the reset and continue» setting — whether the bot resumes an agent by itself when a usage-limit
 * window resets, per topic or (in General) for the instance. Its screen is `/limits` (`fallbackChain.ts`);
 * `/auto_continue_limits` stays as a hidden alias (`on|off` apply, bare opens `/limits`) and the old
 * `acl_on` / `acl_off` buttons keep working. See README.md in this folder.
 */
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import type { SessionKey } from '../../../sessionKey';
import { getTelegramChatId } from '../sessionKeyCodec';
import { enqueueSend } from '../../../rateLimiter';
import { t } from '../../../i18n';
import { checkIsApiError, getErrorDescription } from '../../../sendErrorClassifier';
import { RequestWakeUpEngine } from '../../../requests/wakeUpEngine';
import type { BotCore } from './botCore';

/**
 * @description Append the shared `/auto_continue_limits` pointer to a usage-limit
 * arming notice. ONE key appended at ONE place, so the reset-time notice and the
 * "retrying in N min" fallback can never drift apart (the `effort.current_hint`
 * block shared by both `/model`-set replies is the same pattern). No inline
 * keyboard is needed: Telegram auto-links a bare command written in message text.
 */
export function appendAutoContinueLimitsHint(noticeText: string): string {
  return `${noticeText}\n\n${t('autoContinueLimits.noticeHint')}`;
}

/**
 * What the auto-resume switch needs from the bot: the shared core, the armed usage-limit retry it reads and
 * cancels, and the request wake-up engine, which exists only after the boot built it.
 */
export interface AutoContinueLimitsPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'
  > {
  /** Open the `/limits` screen in the topic (the bare alias lands there). */
  openLimitsView: (key: SessionKey) => Promise<void>;
  getArmedLimitRetryFireAt: (key: SessionKey) => number | null;
  cancelApiRetry: (key: SessionKey) => void;
  getRequestWakeUpEngine: () => Pick<RequestWakeUpEngine, 'stopWakingForLimitWait'> | null;
}

/**
 * @description Build the auto-resume switch over its ports. It returns the picker consumer the usage-limit
 * notice's own buttons call, and the `register…()` calls.
 */
export function createAutoContinueLimits(ports: AutoContinueLimitsPorts) {
  const { openLimitsView, getArmedLimitRetryFireAt, cancelApiRetry, getRequestWakeUpEngine, bot, command, getState, replyToThread, authoriseContext, withThreadLocale, checkIsGeneral } = ports;

  /**
   * @description Apply the `/auto_continue_limits` setting and RETURN the
   * confirmation text — the single write path behind the command and its picker
   * buttons, so the two can never drift. The caller decides delivery (the command
   * replies; the picker edits its own message into the confirmation).
   *
   * Regular topic → the per-thread override; General topic → the instance-wide
   * default. Turning it OFF for a topic also drops that topic's armed resume:
   * staying armed after «Disable» would contradict the setting. Unlike
   * `/compact_on_idle` there is no timer to re-arm — the toggle is read at the
   * moment a limit error arrives.
   */
  async function applyAutoContinueLimits(key: SessionKey, isGeneral: boolean, enabled: boolean | null): Promise<string> {
    if (isGeneral) {
      const value = enabled ?? true;
      await getState().setAutoContinueOnLimitGlobalDefault(value);
      return t('autoContinueLimits.setGlobal', { state: value ? t('autoContinueLimits.on') : t('autoContinueLimits.off') });
    }
    await getState().setAutoContinueOnLimitOverride(key, enabled);
    // `null` drops the override: what the topic follows now is the instance default.
    const effective = getState().checkIsAutoContinueOnLimitEnabled(key);
    const stateWord = effective ? t('autoContinueLimits.on') : t('autoContinueLimits.off');
    if (!effective) {
      const isLimitWaitArmed = getArmedLimitRetryFireAt(key) !== null;
      cancelApiRetry(key);
      // Nothing resumes this wait any more: its request must not be woken into the same limit.
      if (isLimitWaitArmed) await getRequestWakeUpEngine()?.stopWakingForLimitWait(key);
    }
    return t('autoContinueLimits.setThisTopic', { state: stateWord });
  }

  /**
   * @description Rewrite the tapped picker into a final, keyboard-less confirmation:
   * a pick consumes the menu (the `/language` picker is the reference), so the same
   * button can't be acted on twice and the topic reads truthfully. Best-effort — a
   * failed edit only costs the relabel, never the state change that preceded it.
   */
  async function consumeAutoContinueLimitsPicker(key: SessionKey, cbMsg: Message | undefined, text: string): Promise<void> {
    if (!cbMsg) return;
    try {
      await enqueueSend(key, () => bot.telegram.editMessageText(getTelegramChatId(key), cbMsg.message_id, undefined, text));
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
      if (!/message is not modified/i.test(desc)) console.warn('[acl_cb] picker relabel failed:', desc || e);
    }
  }

  /** Shared `acl_on` / `acl_off` tap handler: apply, then consume the picker. */
  async function handleAutoContinueLimitsCallback(ctx: Context, enabled: boolean): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await withThreadLocale(key, async () => {
      const confirmation = await applyAutoContinueLimits(key, checkIsGeneral(key), enabled);
      await ctx.answerCbQuery();
      await consumeAutoContinueLimitsPicker(key, ctx.callbackQuery?.message as Message | undefined, confirmation);
    });
  }

  function registerAutoContinueLimitsCommands(): void {
    // `/auto_continue_limits` — hidden alias of `/limits`. `on` / `off` set the setting (regular topic →
    // per-thread override; General → the instance-wide default); bare opens the `/limits` screen. Deliberately
    // NOT gated on an adapter/session: a limit can hit any topic at any time, and the operator must be able to
    // set the preference before that.
    command('auto_continue_limits', async (ctx, key) => {
      const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        await replyToThread(key, await applyAutoContinueLimits(key, checkIsGeneral(key), arg === 'on'));
        return;
      }
      await openLimitsView(key);
    });
  }

  function registerAutoContinueLimitsCallbacks(): void {
    bot.action('acl_on', (ctx) => handleAutoContinueLimitsCallback(ctx, true));

    bot.action('acl_off', (ctx) => handleAutoContinueLimitsCallback(ctx, false));
  }

  return {
    applyAutoContinueLimits,
    consumeAutoContinueLimitsPicker,
    registerAutoContinueLimitsCommands,
    registerAutoContinueLimitsCallbacks,
  };
}
