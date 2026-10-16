import type { SttInstallProgressMessage, StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { keyToString } from '../sessionKey';
import type { SttInstallProgress } from './sttInstall';
import type { SttInstallReporter } from './sttAutoInstall';
import { buildSttInstallProgressText, formatSttInstallLogLine, type SttTranslate } from './sttScreenPlan';

/**
 * @description Reporters for an install job's progress: one that keeps a SINGLE message of a topic up to date
 * (the boot auto-install in General, the `/stt` button in its own topic), and one that only writes `[STT]` log
 * lines (no group is paired). The message id is kept in `state.json` so a reloaded bot re-attaches to the same
 * message instead of posting a second one.
 */

export interface SttInstallMessagePorts {
  getState: () => Pick<StateStore, 'getSttInstallProgressMessage' | 'setSttInstallProgressMessage'>;
  /** Post into the topic; the new message's id, or `null` when it failed. */
  replyToThread: (key: SessionKey, text: string) => Promise<number | null>;
  /** Edit a message of the topic; false when it failed (a deleted message). */
  editThreadMessage: (key: SessionKey, messageId: number, text: string) => Promise<boolean>;
  /** `t(...)` in the topic's locale, for the whole text of one report. */
  translateFor: (key: SessionKey) => SttTranslate;
  nowMs: () => number;
}

/**
 * @description The message to edit: `existing` (a message the caller already posted — the `/stt` confirm screen),
 * else the one `state.json` remembers for THIS topic, else a new one on the first report.
 */
export function createSttInstallMessageReporter(
  ports: SttInstallMessagePorts,
  key: SessionKey,
  existing?: SttInstallProgressMessage,
): SttInstallReporter {
  const threadKey = keyToString(key);
  const startedAtMs = ports.nowMs();
  const remembered = ports.getState().getSttInstallProgressMessage();
  const rememberedId = remembered?.threadKey === threadKey ? remembered.messageId : null;
  let messageId: number | null = existing?.messageId ?? rememberedId;
  let persistedId: number | null = rememberedId;

  return async (progress: SttInstallProgress) => {
    const text = buildSttInstallProgressText(progress, (ports.nowMs() - startedAtMs) / 1000, ports.translateFor(key));
    const isEdited = messageId !== null && (await ports.editThreadMessage(key, messageId, text));
    if (!isEdited) messageId = await ports.replyToThread(key, text);

    const isEnded = progress.phase === 'done' || progress.phase === 'failed';
    if (isEnded) {
      if (persistedId !== null) await ports.getState().setSttInstallProgressMessage(null);
      persistedId = null;
    } else if (messageId !== null && messageId !== persistedId) {
      await ports.getState().setSttInstallProgressMessage({ threadKey, messageId });
      persistedId = messageId;
    }
  };
}

/** @description The reporter for an install nobody is watching in a chat: one `[STT] install: …` line per phase change. */
export function createSttInstallLogReporter(log: (line: string) => void): SttInstallReporter {
  let lastPhase = '';
  return (progress) => {
    if (progress.phase === lastPhase) return;
    lastPhase = progress.phase;
    log(formatSttInstallLogLine(progress));
  };
}

/** What the Telegram side lends the install message: the topic send helpers and the locale. */
export interface SttInstallMessageCore {
  getState: SttInstallMessagePorts['getState'];
  replyToThread: (key: SessionKey, text: string, extra?: object) => Promise<number | null>;
  editThreadMessage: (key: SessionKey, messageId: number, text: string, extra?: object) => Promise<boolean>;
  withThreadLocale: <TResult>(key: SessionKey, fn: () => TResult) => TResult;
}

/** @description The ports of {@link createSttInstallMessageReporter} over the bot's topic helpers; `translate` is `t(…)`. */
export function createSttInstallMessagePorts(core: SttInstallMessageCore, translate: SttTranslate): SttInstallMessagePorts {
  return {
    getState: core.getState,
    replyToThread: (key, text) => core.replyToThread(key, text),
    editThreadMessage: (key, messageId, text) => core.editThreadMessage(key, messageId, text),
    translateFor: (key) => (code, vars) => core.withThreadLocale(key, () => translate(code, vars)),
    nowMs: () => Date.now(),
  };
}
