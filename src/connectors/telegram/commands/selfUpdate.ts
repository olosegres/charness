/**
 * `/update` — the self-update screen of the bot: what it runs, whether it updates itself, what the last check saw, and the controls
 * (mode, "what's new", check now, update now). One message, re-rendered in place on every tap; in General it carries the buttons,
 * in any other topic it is the same text without them. See README.md in this folder and `src/selfUpdate/README.md`.
 */
import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { t } from '../../../i18n';
import { getCaughtErrnoCode } from '../../../configDirFile';
import { loadInstanceSettingsForUpdate, saveInstanceSettings, type InstanceSettings } from '../../../instanceSettings';
import { autoUpdateModes, type AutoUpdateMode } from '../../../selfUpdate/updateModes';
import type { InstallRequestResult, UpdateEngine } from '../../../selfUpdate/updateEngine';
import type { SessionKey } from '../../../sessionKey';
import {
  buildUpdateScreen,
  updateCheckCallback,
  updateInstallCallbackRe,
  updateModeCallbackPrefix,
  updateWhatsNewCallbackPrefix,
} from '../../../utils/updateScreenPlan';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';
import { answerCallbackQuerySafely } from './callbackToast';

/** What `/update` needs from the bot: the shared core and the engine, which exists only after the boot built it. */
export interface SelfUpdatePorts extends Pick<BotCore, 'bot' | 'command' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  getUpdateEngine: () => UpdateEngine | null;
  /** Where `settings.json` lives (the config directory of the instance's real env file). */
  getSettingsPath: () => string;
  now: () => number;
  /** The wall-clock time of an instant in the instance's time zone. */
  formatClock: (epochMs: number) => string;
}

const modeCallbackRe = new RegExp(`^${updateModeCallbackPrefix}(${autoUpdateModes.join('|')})$`);
const whatsNewCallbackRe = new RegExp(`^${updateWhatsNewCallbackPrefix}(on|off)$`);
const onWord = 'on';

function isAutoUpdateMode(text: string): text is AutoUpdateMode {
  return autoUpdateModes.some((mode) => mode === text);
}

/** The words a text form takes for a switch: `on` / `off`. */
function parseSwitch(text: string | undefined): boolean | null {
  if (text === onWord) return true;
  return text === 'off' ? false : null;
}

export function createSelfUpdate(ports: SelfUpdatePorts) {
  const { bot, command, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, getUpdateEngine, getSettingsPath, now, formatClock } = ports;

  /** The screen of `key`'s topic, worded in its language; `null` while the engine is not built yet. */
  function buildScreen(key: SessionKey): { text: string; extra: object } | null {
    const engine = getUpdateEngine();
    if (engine === null) return null;
    return withThreadLocale(key, () => {
      const screen = buildUpdateScreen({ status: engine.getStatus(), isGeneral: checkIsGeneral(key), now: now(), formatClock }, t);
      const extra = screen.rows.length === 0 ? {} : Markup.inlineKeyboard(screen.rows.map((row) => row.map((button) => Markup.button.callback(button.text, button.data))));
      return { text: screen.text, extra };
    });
  }

  async function sendScreen(key: SessionKey): Promise<void> {
    const screen = buildScreen(key);
    if (screen === null) {
      await replyToThread(key, withThreadLocale(key, () => t('update.cmd.notReady')));
      return;
    }
    await replyToThread(key, screen.text, screen.extra);
  }

  /** Re-render the message a tap came from; "message is not modified" (the same tap twice) is swallowed by the shared edit helper. */
  async function rerenderScreen(ctx: Context, key: SessionKey): Promise<void> {
    const messageId = getCallbackMessageId(ctx);
    const screen = buildScreen(key);
    if (messageId === null || screen === null) return;
    await editThreadMessage(key, messageId, screen.text, screen.extra);
  }

  /** Write a change on top of what `settings.json` already holds. `null` on success, else the errno code of the failed write. */
  function saveSetting(change: Partial<Pick<InstanceSettings, 'autoUpdate' | 'whatsNew'>>): string | null {
    const filePath = getSettingsPath();
    try {
      saveInstanceSettings(filePath, { ...loadInstanceSettingsForUpdate(filePath), ...change });
      return null;
    } catch (error) {
      const code = getCaughtErrnoCode(error);
      console.warn(`[Settings] could not write ${filePath} (${code})`);
      return code;
    }
  }

  function getWriteFailedText(key: SessionKey, code: string): string {
    return withThreadLocale(key, () => t('update.cmd.writeFailed', { path: getSettingsPath(), code }));
  }

  function getInstallResultText(key: SessionKey, result: InstallRequestResult, version: string): string {
    return withThreadLocale(key, () => {
      switch (result) {
        case 'started':
          return t('update.cmd.installStarted', { version });
        case 'busy':
          return t('update.cmd.busy');
        case 'cannotInstall':
          return t('update.cmd.cannotInstall');
        case 'alreadyUpToDate':
          return t('update.cmd.upToDate');
      }
    });
  }

  /** The target an «update now» means: what the last check found and this install can install. */
  function getInstallableTarget(): string | null {
    const offer = getUpdateEngine()?.getStatus().offer;
    return offer?.canInstallNow ? offer.target : null;
  }

  async function handleCommand(key: SessionKey, args: string[]): Promise<void> {
    const [first, second] = args.map((argument) => argument.toLowerCase());
    if (first === undefined) {
      await sendScreen(key);
      return;
    }
    if (first === 'check') {
      await getUpdateEngine()?.checkNow();
      await sendScreen(key);
      return;
    }
    const isWrite = isAutoUpdateMode(first) || first === 'whatsnew' || first === 'now';
    if (!isWrite) {
      await replyToThread(key, withThreadLocale(key, () => t('update.cmd.usage')));
      return;
    }
    if (!checkIsGeneral(key)) {
      await replyToThread(key, withThreadLocale(key, () => t('update.cmd.generalOnly')));
      return;
    }
    if (isAutoUpdateMode(first)) {
      const code = saveSetting({ autoUpdate: first });
      await replyToThread(key, code === null ? withThreadLocale(key, () => t(`update.cmd.modeSet.${first}`)) : getWriteFailedText(key, code));
      return;
    }
    if (first === 'whatsnew') {
      const isOn = parseSwitch(second);
      if (isOn === null) {
        await replyToThread(key, withThreadLocale(key, () => t('update.cmd.usage')));
        return;
      }
      const code = saveSetting({ whatsNew: isOn });
      await replyToThread(key, code === null ? withThreadLocale(key, () => t(isOn ? 'update.cmd.whatsNewSet.on' : 'update.cmd.whatsNewSet.off')) : getWriteFailedText(key, code));
      return;
    }
    // With nothing to install the engine is asked all the same, for "" — an install that cannot update itself says so,
    // instead of claiming it is up to date.
    const target = getInstallableTarget();
    const result = (await getUpdateEngine()?.requestInstall(target ?? '')) ?? 'alreadyUpToDate';
    await replyToThread(key, getInstallResultText(key, result, target ?? ''));
    if (result === 'started') await sendScreen(key);
  }

  /** A tap's common start: the topic it came from, and — for a write — General only. `null` when the tap was refused (already answered). */
  async function authoriseTap(ctx: Context, options: { isWrite: boolean }): Promise<SessionKey | null> {
    const key = await authoriseContext(ctx);
    if (!key) {
      await answerCallbackQuerySafely(ctx, t('cb.access_denied'));
      return null;
    }
    if (options.isWrite && !checkIsGeneral(key)) {
      await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => t('update.cmd.generalOnly')));
      return null;
    }
    return key;
  }

  async function handleSettingTap(ctx: Context, change: Partial<Pick<InstanceSettings, 'autoUpdate' | 'whatsNew'>>, confirmation: (key: SessionKey) => string): Promise<void> {
    const key = await authoriseTap(ctx, { isWrite: true });
    if (key === null) return;
    const code = saveSetting(change);
    if (code !== null) {
      await answerCallbackQuerySafely(ctx, getWriteFailedText(key, code));
      return;
    }
    await answerCallbackQuerySafely(ctx, confirmation(key));
    await rerenderScreen(ctx, key);
  }

  function registerSelfUpdateCommands(): void {
    command('update', async (ctx, key) => {
      await handleCommand(key, ctx.message.text.split(/\s+/).slice(1).filter((argument) => argument !== ''));
    });
  }

  function registerSelfUpdateCallbacks(): void {
    bot.action(modeCallbackRe, async (ctx) => {
      const mode = ctx.match[1];
      if (!isAutoUpdateMode(mode)) return;
      await handleSettingTap(ctx, { autoUpdate: mode }, (key) => withThreadLocale(key, () => t(`update.cmd.modeSet.${mode}`)));
    });

    bot.action(whatsNewCallbackRe, async (ctx) => {
      const isOn = parseSwitch(ctx.match[1]) === true;
      await handleSettingTap(ctx, { whatsNew: isOn }, (key) => withThreadLocale(key, () => t(isOn ? 'update.cmd.whatsNewSet.on' : 'update.cmd.whatsNewSet.off')));
    });

    // A check changes nothing persistent and posts nothing to General: any topic may run one. It asks the registry or the remote
    // (up to two minutes), so the tap is answered FIRST: Telegram drops an answer that comes after its wait; the screen follows.
    bot.action(updateCheckCallback, async (ctx) => {
      const key = await authoriseTap(ctx, { isWrite: false });
      if (key === null) return;
      await answerCallbackQuerySafely(ctx, withThreadLocale(key, () => t('update.cmd.checking')));
      await getUpdateEngine()?.checkNow();
      await rerenderScreen(ctx, key);
    });

    // The version printed on the button is the version it installs: a keyboard that has gone stale answers "already up to date".
    bot.action(updateInstallCallbackRe, async (ctx) => {
      const key = await authoriseTap(ctx, { isWrite: true });
      if (key === null) return;
      const target = ctx.match[1];
      const result = (await getUpdateEngine()?.requestInstall(target)) ?? 'alreadyUpToDate';
      await answerCallbackQuerySafely(ctx, getInstallResultText(key, result, target));
      await rerenderScreen(ctx, key);
    });
  }

  return { registerSelfUpdateCommands, registerSelfUpdateCallbacks };
}
