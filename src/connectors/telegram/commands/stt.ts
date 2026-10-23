/**
 * `/stt` — the voice-recognition settings, from any topic (General included), instance-wide like `/limits`: the
 * main screen holds the ordered engine chain, Add engine and the language; each engine has a card (reorder, use /
 * don't use, timeout, key, remove), and the local engine's own settings live only on its card and in its adding
 * (add = install with live progress when needed; idle exit, workers, "try again" after the spawn-storm guard,
 * remove its files). Everything is written to `stt.json` and applies to the next voice note. The screens, the callback codec and the decision of what a tap
 * does are pure (`stt/sttScreenPlan.ts`); this file renders them, reads the host's facts and runs the effects.
 * See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import { t } from '../../../i18n';
import type { SttAwaitedInputStep } from '../../../utils/recvPreviewRedaction';
import { keyToString, tryKeyFromString, type SessionKey } from '../../../sessionKey';
import {
  isGigaamInstalled,
  isGigaamInstalling,
  readSttInstallProgress,
  removeSttInstall,
  type SttInstallProgress,
} from '../../../stt/sttInstall';
import { addSttEngine, dropLocalSttEngine, enableLocalSttEngine, setSttEngineApiKey, type SttEditResult } from '../../../stt/sttConfigEdit';
import {
  createFailedInstallProgress,
  installJobEndedWithoutResultError,
  type SttInstallJobManager,
} from '../../../stt/sttAutoInstall';
import {
  createSttInstallLogReporter,
  createSttInstallMessagePorts,
  createSttInstallMessageReporter,
} from '../../../stt/sttInstallReporter';
import {
  buildSttCancelRow,
  buildSttCallback,
  buildSttScreen,
  buildSttInstallProgressText,
  computeSttRevision,
  decideSttInput,
  parseSttCallback,
  reduceSttAction,
  sttCallbackRe,
  type SttKeyTarget,
  type SttButton,
  type SttEffect,
  type SttNotice,
  type SttScreenId,
  type SttScreenInput,
} from '../../../stt/sttScreenPlan';
import { getCaughtErrnoCode } from '../../../configDirFile';
import { saveSttConfig, sttEngineLimit, type ResolvedSttSettings, type SttConfigFile } from '../../../stt/sttSettings';
import type { SttOwnerContext, SttSidecarOwner } from '../../../stt/sttSidecarOwner';
import type { BotCore } from './botCore';
import { getCallbackMessageId } from './callbackMessage';
import { createWholeTextAnswerer } from './callbackToast';

/** How long a typed-input step (the address, the key) waits before it is given up and its prompt retired. */
export const sttInputTimeoutMs = 10 * 60 * 1000;

/** The first line of the install progress before the job reports anything. */
const initialInstallProgress: SttInstallProgress = { phase: 'creatingEnvironment', detail: '', bytesDownloaded: 0 };

export interface SttPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'deleteThreadMessage' | 'authoriseContext' | 'withThreadLocale'
  > {
  getConfigPath: () => string;
  getDataDir: () => string;
  /** The chain in effect now (re-reads `stt.json` if it changed). */
  getResolvedSettings: () => ResolvedSttSettings;
  getOwnerContext: () => SttOwnerContext | null;
  owner: Pick<SttSidecarOwner, 'getStatus' | 'stop' | 'applySettingsChange' | 'resetSpawnGuard'>;
  installJobs: SttInstallJobManager;
  /** General of the paired group — where an install that `stt.json` asked for reports; `null` when no group is paired. */
  getGeneralKey: () => SessionKey | null;
}

/** How an install message ends: its text and the buttons under it. */
interface SttInstallEnding {
  text: string;
  rows: SttButton[][];
}

/** A typed-input step the next plain message of a topic answers. Only `url` and `key` consume text. */
interface PendingSttInput {
  step: 'url' | 'key' | 'keyChoice';
  /** `key` step: whose key this is. */
  target?: SttKeyTarget;
  /** `keyChoice` step: the address waiting for "does it need a key?". */
  url?: string;
  /** The screen message the prompt sits in (edited into the result, or retired on timeout). */
  promptMessageId: number;
  timer: NodeJS.Timeout;
}

/** @description Build the `/stt` feature over its ports: the command (+ hidden aliases), its buttons and the typed-input hooks the text handler calls. */
export function createStt(ports: SttPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, deleteThreadMessage, authoriseContext, withThreadLocale,
    getConfigPath, getDataDir, getResolvedSettings, getOwnerContext, owner, installJobs, getGeneralKey,
  } = ports;
  const answerWithWholeText = createWholeTextAnswerer(replyToThread);

  const pendingInputs = new Map<string, PendingSttInput>();
  const installMessagePorts = createSttInstallMessagePorts({ getState, replyToThread, editThreadMessage, withThreadLocale }, t);

  // ── rendering ──

  async function gatherScreenInput(): Promise<SttScreenInput> {
    const dataDir = getDataDir();
    const isInstalling = isGigaamInstalling(dataDir);
    return {
      resolved: getResolvedSettings(),
      configPath: getConfigPath(),
      isLocalInstalled: isGigaamInstalled(dataDir),
      installing: isInstalling ? (readSttInstallProgress(dataDir) ?? initialInstallProgress) : null,
      sidecar: await owner.getStatus(),
      hasOwnerContext: getOwnerContext() !== null,
    };
  }

  function toMarkup(rows: SttButton[][]) {
    return Markup.inlineKeyboard(rows.map((row) => row.map((button) => Markup.button.callback(button.text, button.data))));
  }

  function formatNotice(notice: SttNotice | undefined): string | undefined {
    return notice ? t(notice.code, notice.vars) : undefined;
  }

  /** Show a screen: a new message when `messageId` is null, else an edit of it (a new message when the edit fails). */
  async function render(key: SessionKey, messageId: number | null, screenId: SttScreenId, notice?: SttNotice | string): Promise<number | null> {
    const input = await gatherScreenInput();
    const noticeText = typeof notice === 'string' ? notice : formatNotice(notice);
    const screen = buildSttScreen(screenId, input, t, noticeText) ?? buildSttScreen({ id: 'main' }, input, t, noticeText);
    if (!screen) return messageId;
    const markup = toMarkup(screen.rows);
    if (messageId !== null && (await editThreadMessage(key, messageId, screen.text, markup))) return messageId;
    return replyToThread(key, screen.text, markup);
  }

  // ── saving ──

  /** Write the next settings and stop a process the change invalidates; `false` (and a log line) when the file cannot be written. */
  async function save(previous: SttConfigFile, next: SttConfigFile): Promise<boolean> {
    try {
      saveSttConfig(getConfigPath(), next);
    } catch (e) {
      console.warn(`[STT] could not write ${getConfigPath()} (${getCaughtErrnoCode(e)})`);
      return false;
    }
    try {
      await owner.applySettingsChange(previous, next);
    } catch (e) {
      console.warn('[STT] applying the settings change failed:', e instanceof Error ? e.message : e);
    }
    return true;
  }

  // ── typed input (the address, the key) ──

  function clearPending(threadKey: string): PendingSttInput | undefined {
    const pending = pendingInputs.get(threadKey);
    if (pending) clearTimeout(pending.timer);
    pendingInputs.delete(threadKey);
    return pending;
  }

  function armInput(key: SessionKey, spec: Omit<PendingSttInput, 'timer'>): void {
    const threadKey = keyToString(key);
    clearPending(threadKey);
    const timer = setTimeout(() => {
      const pending = pendingInputs.get(threadKey);
      if (!pending || pending.promptMessageId !== spec.promptMessageId) return;
      pendingInputs.delete(threadKey);
      void withThreadLocale(key, () => editThreadMessage(key, pending.promptMessageId, t('stt.input.expired'))).catch(() => {});
    }, sttInputTimeoutMs);
    timer.unref();
    pendingInputs.set(threadKey, { ...spec, timer });
  }

  /** Edit the screen message into a prompt with a cancel button and arm the step. */
  async function armPrompt(key: SessionKey, messageId: number | null, spec: Omit<PendingSttInput, 'timer' | 'promptMessageId'>, promptText: string): Promise<void> {
    const revision = computeSttRevision(getResolvedSettings().settings);
    const markup = toMarkup(buildSttCancelRow(t, revision));
    let promptMessageId = messageId;
    if (promptMessageId === null || !(await editThreadMessage(key, promptMessageId, promptText, markup))) {
      promptMessageId = await replyToThread(key, promptText, markup);
    }
    if (promptMessageId !== null) armInput(key, { ...spec, promptMessageId });
  }

  /** The typed step the next plain message of the topic answers; the output trace must not record that message. */
  function getAwaitedStep(key: SessionKey): SttAwaitedInputStep | null {
    const step = pendingInputs.get(keyToString(key))?.step;
    return step === 'url' || step === 'key' ? step : null;
  }

  /** Whether any topic waits for a typed address or key — a restart would drop it. */
  function checkIsAnyInputAwaited(): boolean {
    return pendingInputs.size > 0;
  }

  /** A slash command or a topic teardown ends an armed step; the prompt is retired out loud only when asked to. */
  async function cancelInput(key: SessionKey, options: { isSilent?: boolean } = {}): Promise<void> {
    const pending = clearPending(keyToString(key));
    if (!pending || options.isSilent) return;
    await withThreadLocale(key, () => editThreadMessage(key, pending.promptMessageId, t('stt.input.cancelled')));
  }

  async function saveNewKey(previous: SttConfigFile, target: SttKeyTarget, apiKey: string): Promise<{ ok: true; next: SttConfigFile; engineId: string } | { ok: false }> {
    let result: SttEditResult & { engineId?: string };
    let engineId: string | undefined;
    if (target.kind === 'engine') {
      result = setSttEngineApiKey(previous, target.engineId, apiKey);
      engineId = target.engineId;
    } else if (target.kind === 'newKeyed') {
      result = addSttEngine(previous, { kind: target.engineKind, apiKey });
      engineId = result.engineId;
    } else {
      result = addSttEngine(previous, { kind: 'url', url: target.url, apiKey });
      engineId = result.engineId;
    }
    if (!result.ok || engineId === undefined || !(await save(previous, result.config))) return { ok: false };
    return { ok: true, next: result.config, engineId };
  }

  /**
   * @description The text handler's hook: the message is the answer to an armed step. A plausible key is deleted
   * from the topic the moment it is accepted and never echoed, logged or put into an error; an implausible one
   * stays visible (it is not a secret) and the step re-arms.
   */
  async function submitInput(key: SessionKey, text: string, userMessageId: number): Promise<void> {
    const threadKey = keyToString(key);
    const pending = pendingInputs.get(threadKey);
    if (!pending || (pending.step !== 'url' && pending.step !== 'key')) return;
    await withThreadLocale(key, async () => {
      const decision = decideSttInput(pending.step === 'url' ? 'url' : 'key', text);
      if (decision.outcome !== 'accept') {
        if (decision.outcome === 'retryAndDelete') await deleteThreadMessage(key, userMessageId);
        armInput(key, { step: pending.step, target: pending.target, promptMessageId: pending.promptMessageId });
        await replyToThread(key, t(`stt.input.${decision.hint}`));
        return;
      }
      if (pending.step === 'url') {
        armInput(key, { step: 'keyChoice', url: decision.value, promptMessageId: pending.promptMessageId });
        await render(key, pending.promptMessageId, { id: 'keyChoice' });
        return;
      }
      // A key: out of the topic's history FIRST, then used.
      await deleteThreadMessage(key, userMessageId);
      clearPending(threadKey);
      const previous = getResolvedSettings().settings;
      const target = pending.target;
      const saved = target ? await saveNewKey(previous, target, decision.value) : { ok: false as const };
      if (!saved.ok) {
        await render(key, pending.promptMessageId, { id: 'main' }, buildSaveFailedNotice());
        return;
      }
      await render(key, pending.promptMessageId, { id: 'card', engineId: saved.engineId }, { code: 'stt.input.keySaved' });
    });
  }

  // ── the install ──

  /** True while this process runs an install report that `stt.json` asked for (never two messages for one job). */
  let isAutoInstallRunning = false;

  function logInstallOutcome(outcome: SttInstallProgress): void {
    if (outcome.phase === 'failed') console.warn(`[STT] install failed: ${outcome.error ?? 'unknown error'}`);
    else console.log('[STT] install finished: the local engine starts with the next voice note');
  }

  /**
   * The install is over: a finished one puts the local engine into the chain (when the install was asked for in
   * `/stt`) and says so — or names why it could not; a failed one shows the error and the log tail with Retry.
   */
  async function buildInstallEnding(outcome: SttInstallProgress, shouldEnable: boolean): Promise<SttInstallEnding> {
    // Read after the save: a button must carry the revision of the settings it now opens.
    const buildButton = (text: string, action: 'er' | 'bk'): SttButton => ({
      text,
      data: buildSttCallback(action, [], computeSttRevision(getResolvedSettings().settings)),
    });
    const openSettingsText = t('stt.btn.openSettings');
    if (outcome.phase !== 'done') {
      return {
        text: buildSttInstallProgressText(outcome, 0, t),
        rows: [[buildButton(t('stt.btn.retry'), 'er'), buildButton(openSettingsText, 'bk')]],
      };
    }
    let text = t('stt.install.done');
    if (shouldEnable) {
      const previous = getResolvedSettings().settings;
      const enabled = enableLocalSttEngine(previous);
      if (!enabled.ok) text = t('stt.install.doneNotAdded', { limit: sttEngineLimit });
      else if (enabled.config !== previous && !(await save(previous, enabled.config))) text = t('stt.install.doneNotSaved', { path: getConfigPath() });
    }
    // Ready and listed: the message becomes the local engine's card (read after the save, so it shows the saved list).
    const localEngine = getResolvedSettings().settings.engines.find((engine) => engine.kind === 'gigaam');
    const card = localEngine ? buildSttScreen({ id: 'card', engineId: localEngine.id }, await gatherScreenInput(), t, text) : null;
    if (card) return card;
    return { text, rows: [[buildButton(openSettingsText, 'bk')]] };
  }

  /**
   * The ONE way an install that reports into a message ends — the tapped button, a re-attach after a reload and an
   * install that finished while the bot was down all come through here: enable, save, the final edit, and only
   * then forget the message (a reload in between repeats this idempotent step instead of losing it).
   */
  async function finishInstall(key: SessionKey, messageId: number | null, outcome: SttInstallProgress, shouldEnable: boolean): Promise<void> {
    logInstallOutcome(outcome);
    await withThreadLocale(key, async () => {
      const ending = await buildInstallEnding(outcome, shouldEnable);
      const markup = toMarkup(ending.rows);
      if (messageId === null || !(await editThreadMessage(key, messageId, ending.text, markup))) {
        await replyToThread(key, ending.text, markup);
      }
    });
    const remembered = getState().getSttInstallProgressMessage();
    // Only the message this job owned: another job's message (a /stt tap during an auto-install) stays remembered.
    if (remembered && remembered.threadKey === keyToString(key) && (messageId === null || remembered.messageId === messageId)) {
      await getState().setSttInstallProgressMessage(null);
    }
  }

  /** Install (or attach to the running install) with the progress edited into `messageId`; on success the local engine joins the chain. */
  async function runInstall(key: SessionKey, messageId: number, isAttach: boolean): Promise<void> {
    const threadKey = keyToString(key);
    if (!isAttach) {
      await editThreadMessage(key, messageId, buildSttInstallProgressText(initialInstallProgress, 0, t));
    }
    const message = { threadKey, messageId, shouldEnableOnDone: true };
    await getState().setSttInstallProgressMessage(message);
    const reporter = createSttInstallMessageReporter(installMessagePorts, key, message);
    const outcome = await installJobs.start({ reportTo: reporter.report });
    await finishInstall(key, reporter.getMessageId() ?? messageId, outcome, true);
  }

  /**
   * `stt.json` names the local engine before it is installed (a hand edit, or boot): fetch it with the progress in
   * one message in General — or as `[STT] install:` lines when no group is paired. The engine is already named, so
   * nothing is enabled at the end. A job whose message is already owned (a `/stt` tap, a boot re-attach) is left
   * to that owner; a failure is reported once and not retried.
   */
  async function startAutoInstall(): Promise<void> {
    if (isAutoInstallRunning || getState().getSttInstallProgressMessage()) return;
    isAutoInstallRunning = true;
    try {
      const generalKey = getGeneralKey();
      if (generalKey === null) {
        logInstallOutcome(await installJobs.start({ reportTo: createSttInstallLogReporter((line) => console.log(line)) }));
        return;
      }
      const reporter = createSttInstallMessageReporter(installMessagePorts, generalKey);
      const outcome = await installJobs.start({ reportTo: reporter.report });
      await finishInstall(generalKey, reporter.getMessageId(), outcome, false);
    } catch (e) {
      console.warn('[STT] install job error:', e instanceof Error ? e.message : e);
    } finally {
      isAutoInstallRunning = false;
    }
  }

  /** How a job that is no longer running ended, from what it left on disk: done only while the engine is really installed. */
  function readEndedInstallOutcome(): SttInstallProgress {
    const dataDir = getDataDir();
    const last = readSttInstallProgress(dataDir);
    if (last?.phase === 'failed') return last;
    if (last?.phase === 'done' && isGigaamInstalled(dataDir)) return last;
    return createFailedInstallProgress(installJobEndedWithoutResultError);
  }

  /**
   * Boot, after the state is loaded: an install a reload interrupted is picked up where it stands — attached to
   * while its job still runs, or settled at once when it ended while the bot was down (the remembered message is
   * turned into the outcome, never left frozen at "installing"); with no message to continue, a running job or a
   * `stt.json` that names the missing engine starts the auto-install.
   */
  async function resumeInstallAtBoot(): Promise<void> {
    const remembered = getState().getSttInstallProgressMessage();
    const rememberedKey = remembered ? tryKeyFromString(remembered.threadKey) : null;
    if (remembered && rememberedKey) {
      const shouldEnable = remembered.shouldEnableOnDone === true;
      if (!isGigaamInstalling(getDataDir())) {
        await finishInstall(rememberedKey, remembered.messageId, readEndedInstallOutcome(), shouldEnable);
        return;
      }
      try {
        const reporter = createSttInstallMessageReporter(installMessagePorts, rememberedKey, remembered);
        const outcome = await installJobs.start({ reportTo: reporter.report });
        await finishInstall(rememberedKey, reporter.getMessageId() ?? remembered.messageId, outcome, shouldEnable);
      } catch (e) {
        console.warn('[STT] install job error:', e instanceof Error ? e.message : e);
      }
      return;
    }
    if (remembered) await getState().setSttInstallProgressMessage(null);
    if (isGigaamInstalling(getDataDir()) || getResolvedSettings().needsAutoInstall) await startAutoInstall();
  }

  async function removeLocalEngineFiles(): Promise<boolean> {
    await owner.stop();
    return removeSttInstall(getDataDir());
  }

  // ── command and buttons ──

  function registerSttCommands(): void {
    // Bare `/stt` opens the screen; `/voice` and `/speech` are hidden aliases. Not gated on a bound folder or a
    // session: the voice settings are instance-wide and must be reachable before anything else is set up.
    command(['stt', 'voice', 'speech'], async (_ctx, key) => {
      await render(key, null, { id: 'main' });
    });
  }

  /** The shared tap prologue: authorise, resolve the topic, run under its locale. */
  async function handleTap(ctx: Context, run: (key: SessionKey, messageId: number | null) => Promise<void>): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await withThreadLocale(key, () => run(key, getCallbackMessageId(ctx)));
  }

  /** The notice for a save that failed: it names the file, so the operator knows which directory to fix. */
  function buildSaveFailedNotice(): SttNotice {
    return { code: 'stt.saveFailed', vars: { path: getConfigPath() } };
  }

  /** A tap's answer: the notice as the toast (whole, or cut with the full text posted), or a bare answer when there is none. */
  async function answerWith(ctx: Context, key: SessionKey, notice: SttNotice | undefined): Promise<void> {
    const text = formatNotice(notice);
    if (text === undefined) await ctx.answerCbQuery();
    else await answerWithWholeText(ctx, key, text);
  }

  function registerSttCallbacks(): void {
    bot.action(sttCallbackRe, (ctx) => handleTap(ctx, async (key, messageId) => {
      const parsed = parseSttCallback(ctx.match[0]);
      if (!parsed) { await ctx.answerCbQuery(); return; }
      const dataDir = getDataDir();
      const settings = getResolvedSettings().settings;
      const pending = pendingInputs.get(keyToString(key));
      const outcome = reduceSttAction(parsed, {
        config: settings,
        isLocalInstalled: isGigaamInstalled(dataDir),
        isLocalInstalling: isGigaamInstalling(dataDir),
        pendingUrl: pending?.step === 'keyChoice' ? (pending.url ?? null) : null,
      });
      switch (outcome.kind) {
        case 'stale':
          await ctx.answerCbQuery(t('stt.stale'));
          await render(key, messageId, { id: 'main' });
          return;
        case 'show':
          await ctx.answerCbQuery();
          await render(key, messageId, outcome.screen);
          return;
        case 'save':
          if (!(await save(settings, outcome.config))) {
            await answerWith(ctx, key, buildSaveFailedNotice());
            return;
          }
          await answerWith(ctx, key, outcome.notice);
          await render(key, messageId, outcome.screen);
          return;
        case 'armKey':
          await ctx.answerCbQuery();
          await armPrompt(key, messageId, { step: 'key', target: outcome.target }, t('stt.prompt.key'));
          return;
        case 'armUrl':
          await ctx.answerCbQuery();
          await armPrompt(key, messageId, { step: 'url' }, t('stt.prompt.url'));
          return;
        case 'cancelInput':
          await ctx.answerCbQuery();
          clearPending(keyToString(key));
          await render(key, messageId, { id: 'main' });
          return;
        case 'effect':
          await runEffect(ctx, key, messageId, outcome.effect, settings, outcome.screen);
          return;
      }
    }));
  }

  async function runEffect(
    ctx: Context,
    key: SessionKey,
    messageId: number | null,
    effect: SttEffect,
    settings: SttConfigFile,
    screenAfter: SttScreenId = { id: 'main' },
  ): Promise<void> {
    switch (effect) {
      case 'close':
        await ctx.answerCbQuery();
        if (messageId !== null) await deleteThreadMessage(key, messageId);
        return;
      case 'resetGuard':
        owner.resetSpawnGuard();
        await ctx.answerCbQuery(t('stt.notice.guardReset'));
        await render(key, messageId, screenAfter);
        return;
      case 'install':
      case 'attachInstall':
        await ctx.answerCbQuery();
        if (messageId === null) return;
        // Minutes long: never hold the update handler (the topic's other taps and messages) for it.
        void runInstall(key, messageId, effect === 'attachInstall').catch((e) => {
          console.warn('[STT] install flow error:', e instanceof Error ? e.message : e);
        });
        return;
      case 'removeFiles': {
        const isRemoved = await removeLocalEngineFiles();
        if (!isRemoved) {
          // An install started between the tap and the removal: the files stay, the card (with its progress) is shown again.
          await ctx.answerCbQuery(t('stt.notice.busyInstalling'));
          await render(key, messageId, screenAfter);
          return;
        }
        const dropped = dropLocalSttEngine(settings);
        if (dropped.ok && dropped.config.engines.length !== settings.engines.length) await save(settings, dropped.config);
        await ctx.answerCbQuery(t('stt.notice.localRemoved'));
        await render(key, messageId, { id: 'main' });
        return;
      }
    }
  }

  return {
    registerSttCommands,
    registerSttCallbacks,
    startSttAutoInstall: startAutoInstall,
    resumeSttInstallAtBoot: resumeInstallAtBoot,
    getAwaitedSttStep: getAwaitedStep,
    checkIsAnySttInputAwaited: checkIsAnyInputAwaited,
    submitSttInput: submitInput,
    cancelSttInput: cancelInput,
  };
}
