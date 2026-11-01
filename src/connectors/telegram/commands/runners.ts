/**
 * `/runners` — the machines that run the agents' tests and builds, paired from Telegram. In General only (admins): one message that
 * lists the machines (online or not, what they are, what they can do) with Pause / Resume / Remove per machine, and a button that pairs
 * another one — a one-time line to paste on the new machine, valid 10 minutes, shown as a message that turns into «paired» or «expired».
 * The hub itself is `src/runners/`; this file is only the screen, its buttons and the two background jobs (editing the pairing message,
 * refreshing a list with live data). See `src/runners/README.md` for the safety line and `utils/runnersScreenPlan.ts` for the texts.
 */
import { Markup, type Context } from 'telegraf';
import { getActiveLang, t } from '../../../i18n';
import { escapeHtmlText } from '../renderAgentHtml';
import { keyFromString, keyToString, type SessionKey } from '../../../sessionKey';
import { buildBootstrapLine } from '../../../runners/bootstrapLine';
import { checkHubAddress, parseHubAddress, type HostKeyScanner, type HubAddress, type HubAddressCheck } from '../../../runners/hubAddress';
import { findProposedHubAddress, formatHubAddress } from '../../../runners/hubAddressCandidates';
import type { HubContext } from '../../../runners/hubPaths';
import {
  createPairing,
  pairingLifetimeMinutes,
  removePairedRunner,
  setPairedRunnerPaused,
  setPairingMessageRef,
  sweepExpiredPairings,
} from '../../../runners/hubPairing';
import { HubRegistryError, readPairedFile, readPendingFile } from '../../../runners/hubRegistry';
import { cutRunnerLink } from '../../../runners/linkControl';
import type { RunnersOverview } from '../../../runners/runnersOverview';
import {
  buildAddressStep,
  buildExpiredText,
  buildPairedText,
  buildPairingMessageParts,
  buildRemoveConfirmation,
  buildRunnersScreen,
  parseRunnersCallback,
  runnerActionCallbackRe,
  runnersAddressOtherCallback,
  runnersAddressUseCallback,
  runnersPairCallback,
  runnersRefreshCallback,
  type FormatTime,
  type RunnersCallback,
  type RunnersScreen,
} from '../../../utils/runnersScreenPlan';
import type { BotCore } from './botCore';
import { answerCallbackQuerySafely } from './callbackToast';
import { buildMessageSnapshotKey, getCallbackMessageId, rememberBoundedSnapshot } from './callbackMessage';

/** The pairing messages and screens of this many messages are remembered; an older keyboard answers «out of date». */
const messageSnapshotLimit = 50;
/** How long the next General message is read as an address after «Enter another address». */
const addressWaitMs = 10 * 60 * 1000;
/** How often the pairing messages are checked for «used» or «expired» (the registry is two small files). */
export const runnersWatchIntervalMs = 5 * 1000;
/** The registry's note of which message offers a code: `tg:<telegram key>#<message id>`. */
const messageRefPattern = /^tg:(-?\d+:\d+)#(\d+)$/;
const logTag = 'runners';

/** What the module needs from the bot: the shared core, the hub and the few readings only the composition root has. */
export interface RunnersPorts extends Pick<BotCore, 'bot' | 'command' | 'replyToThread' | 'editThreadMessage' | 'editThreadKeyboard' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** The hub registry of this OS user (`src/runners/`). */
  hub: HubContext;
  /** The address runners dial, as `settings.json` holds it; `null` = never chosen. */
  readRunnerHost: () => HubAddress | null;
  /** Remember the address; `null` on success, else the errno code of the failed write. */
  saveRunnerHost: (address: HubAddress) => string | null;
  /** Whose charness it is, as the runner shows it (`@ExampleBot`). */
  getBotLabel: () => string;
  /** The registry, the links and the last snapshots — no ssh. */
  readOverview: (nowMs: number) => Promise<RunnersOverview>;
  /** The same with the machines that are online asked what they are like right now. */
  probeOverview: (overview: RunnersOverview, nowMs: number) => Promise<RunnersOverview>;
  /** The routable addresses of this machine; the first that answers with its own sshd is proposed. */
  listAddressCandidates: () => string[];
  scanHostKey: HostKeyScanner;
  /** Writes the `gate` wrapper the `authorized_keys` lines run. */
  ensureGateWrapper: () => void;
  now: () => number;
  watchIntervalMs?: number;
}

/** @description What a caught failure says to the operator: a registry error names its file and field, anything else its kind and message. */
function describeCaughtError(caught: unknown): string {
  if (caught instanceof HubRegistryError) return caught.message;
  return caught instanceof Error ? `${caught.name}: ${caught.message}` : 'unknown error';
}

/** @description The registry's note of the message that offers a code. */
export function buildPairingMessageRef(key: SessionKey, messageId: number): string {
  return `tg:${keyToString(key)}#${messageId}`;
}

/** @description The message a registry note points to; `null` for a note this module did not write. */
export function parsePairingMessageRef(messageRef: string | null): { key: SessionKey; messageId: number } | null {
  const match = messageRef === null ? null : messageRefPattern.exec(messageRef);
  return match === null ? null : { key: keyFromString(match[1]), messageId: Number(match[2]) };
}

/** `1 Nov 14:02` in the bot's timezone (`process.env.TZ`) and the topic's language: the parts in one fixed order, so it reads the same in every locale. */
export const formatRunnersTime: FormatTime = (epochMs) => {
  const parts = new Intl.DateTimeFormat(getActiveLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(epochMs);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('day')} ${read('month')} ${read('hour')}:${read('minute')}`;
};

function buildKeyboard(screen: RunnersScreen): ReturnType<typeof Markup.inlineKeyboard> {
  return Markup.inlineKeyboard(screen.rows.map((row) => row.map((button) => Markup.button.callback(button.text, button.data))));
}

/** @description What the screen was last drawn as on a message: the list (with the revision it came from) or a question that replaced it. */
interface ShownScreen {
  kind: 'list' | 'question';
  revision: number;
}

/**
 * @description Build the `/runners` screen over its ports. `registerRunnersCommands` / `registerRunnersCallbacks` register the command and
 * the buttons; `handleRunnersAddressText` is called by the text handler for a General message (true = taken as the address) and
 * `cancelRunnersAddressWait` for a slash command (it ends the wait);
 * `startRunnersWatcher` starts the job that edits the pairing messages and returns the way to stop it (`watchPairingsOnce` is one
 * look of that job, for a test to run on its own clock).
 */
export function createRunners(ports: RunnersPorts) {
  const { bot, command, replyToThread, editThreadMessage, editThreadKeyboard, authoriseContext, withThreadLocale, checkIsGeneral, hub, now } = ports;

  const shownScreens = new Map<string, ShownScreen>();
  const addressProposals = new Map<string, HubAddress | null>();
  /** General keys whose next message is an address → when the wait began. */
  const addressWaits = new Map<string, number>();
  /** Pairing messages being watched, by code. */
  const watchedPairings = new Map<string, { key: SessionKey; messageId: number }>();
  let isWatchTickRunning = false;

  function rememberScreen(key: SessionKey, messageId: number, shown: ShownScreen): void {
    rememberBoundedSnapshot(shownScreens, buildMessageSnapshotKey(key, messageId), shown, messageSnapshotLimit);
  }

  /** The list on `messageId` is still the list it was drawn as, from the registry revision it was drawn from. */
  function checkIsListShown(key: SessionKey, messageId: number, revision: number): boolean {
    const shown = shownScreens.get(buildMessageSnapshotKey(key, messageId));
    return shown !== undefined && shown.kind === 'list' && shown.revision === revision;
  }

  async function reportRegistryError(key: SessionKey, caught: unknown): Promise<void> {
    await replyToThread(key, t('runners.registryErrorText', { reason: describeCaughtError(caught) }));
  }

  /** Draw `overview` on `messageId` and, when machines are online, ask them in the background and draw again. */
  async function drawList(key: SessionKey, overview: RunnersOverview, draw: (screen: RunnersScreen) => Promise<number | null>): Promise<void> {
    const isChecking = overview.entries.some((entry) => entry.isOnline);
    const screen = buildRunnersScreen({ ...overview, isChecking }, t, formatRunnersTime);
    const messageId = await draw(screen);
    if (messageId === null) return;
    rememberScreen(key, messageId, { kind: 'list', revision: overview.revision });
    if (!isChecking) return;
    void probeAndRedraw(key, messageId, overview).catch((error) => console.warn(`[${logTag}] live check failed: ${describeCaughtError(error)}`));
  }

  async function probeAndRedraw(key: SessionKey, messageId: number, overview: RunnersOverview): Promise<void> {
    const probed = await ports.probeOverview(overview, now());
    if (!checkIsListShown(key, messageId, overview.revision)) return;
    await withThreadLocale(key, async () => {
      const screen = buildRunnersScreen({ ...probed, isChecking: false }, t, formatRunnersTime);
      await editThreadMessage(key, messageId, screen.text, buildKeyboard(screen));
    });
  }

  async function showScreen(key: SessionKey): Promise<void> {
    await withThreadLocale(key, async () => {
      let overview: RunnersOverview;
      try {
        overview = await ports.readOverview(now());
      } catch (error) {
        await reportRegistryError(key, error);
        return;
      }
      await drawList(key, overview, (screen) => replyToThread(key, screen.text, buildKeyboard(screen)));
    });
  }

  /** Draw the list over the message a button sits on. */
  async function redrawList(key: SessionKey, messageId: number): Promise<void> {
    let overview: RunnersOverview;
    try {
      overview = await ports.readOverview(now());
    } catch (error) {
      await reportRegistryError(key, error);
      return;
    }
    await drawList(key, overview, async (screen) => ((await editThreadMessage(key, messageId, screen.text, buildKeyboard(screen))) ? messageId : null));
  }

  async function showAddressStep(key: SessionKey): Promise<void> {
    const proposed = await findProposedHubAddress(ports.listAddressCandidates(), ports.scanHostKey);
    const step = buildAddressStep(proposed === null ? null : formatHubAddress(proposed.address), t);
    const messageId = await replyToThread(key, step.text, buildKeyboard(step));
    if (messageId === null) return;
    rememberBoundedSnapshot(addressProposals, buildMessageSnapshotKey(key, messageId), proposed === null ? null : proposed.address, messageSnapshotLimit);
    if (proposed === null) addressWaits.set(keyToString(key), now());
  }

  /** The next General message is the address. */
  function armAddressWait(key: SessionKey): void {
    addressWaits.set(keyToString(key), now());
  }

  /** The address was refused: say why and keep listening for another. */
  async function rejectAddress(key: SessionKey, reason: string): Promise<void> {
    armAddressWait(key);
    await replyToThread(key, t('runners.addressRejected', { reason }));
  }

  /** Make a code and post the line that carries it — a secret: the trace keeps only the message's length. */
  async function offerPairing(key: SessionKey, address: HubAddress, knownCheck: Extract<HubAddressCheck, { ok: true }> | null): Promise<void> {
    const check = knownCheck ?? (await checkHubAddress(address, ports.scanHostKey));
    if (!check.ok) {
      await rejectAddress(key, check.error);
      return;
    }
    try {
      ports.ensureGateWrapper();
      const pairing = await createPairing(hub, { host: address.host, port: address.port, hostKey: check.hostKey, label: ports.getBotLabel(), nowMs: now() });
      const parts = buildPairingMessageParts(pairingLifetimeMinutes, t);
      const text = `${escapeHtmlText(parts.intro)}\n\n<pre>${escapeHtmlText(buildBootstrapLine(pairing.payload))}</pre>\n\n${escapeHtmlText(parts.outro)}`;
      const messageId = await replyToThread(key, text, { parse_mode: 'HTML' }, { isSecret: true });
      if (messageId === null) {
        await replyToThread(key, t('runners.pairFailedText', { reason: 'the message could not be sent' }));
        return;
      }
      await setPairingMessageRef(hub, pairing.pairId, buildPairingMessageRef(key, messageId));
      watchedPairings.set(pairing.pairId, { key, messageId });
    } catch (error) {
      await replyToThread(key, t('runners.pairFailedText', { reason: describeCaughtError(error) }));
    }
  }

  async function startPairing(key: SessionKey): Promise<void> {
    const address = ports.readRunnerHost();
    if (address === null) await showAddressStep(key);
    else await offerPairing(key, address, null);
  }

  async function useAddress(key: SessionKey, messageId: number | null): Promise<void> {
    const address = messageId === null ? undefined : addressProposals.get(buildMessageSnapshotKey(key, messageId));
    if (address === undefined || address === null) {
      await replyToThread(key, t('runners.addressExpired'));
      return;
    }
    if (messageId !== null) await editThreadKeyboard(key, messageId, null, logTag);
    const saveError = ports.saveRunnerHost(address);
    if (saveError !== null) console.warn(`[${logTag}] the address could not be saved (${saveError}); it is used for this pairing only`);
    await offerPairing(key, address, null);
  }

  /** A slash command ends the wait for the address (the command itself runs normally); the text handler calls it before a bot command returns. */
  function cancelRunnersAddressWait(key: SessionKey): void {
    addressWaits.delete(keyToString(key));
  }

  /**
   * @description A General message while the address is awaited: parse it, check that it answers with this machine's own sshd, keep it
   * and make the pairing line. A failed check keeps the wait (the reason is posted). A slash command ends the wait and runs normally.
   * Resolves to whether the message was taken here.
   */
  async function handleRunnersAddressText(key: SessionKey, text: string): Promise<boolean> {
    const keyText = keyToString(key);
    const waitStartedAt = addressWaits.get(keyText);
    if (waitStartedAt === undefined || !checkIsGeneral(key)) return false;
    if (now() - waitStartedAt > addressWaitMs || text.startsWith('/')) {
      cancelRunnersAddressWait(key);
      return false;
    }
    await withThreadLocale(key, async () => {
      const parsed = parseHubAddress(text);
      if (!parsed.ok) {
        await rejectAddress(key, parsed.error);
        return;
      }
      const check = await checkHubAddress(parsed.address, ports.scanHostKey);
      if (!check.ok) {
        await rejectAddress(key, check.error);
        return;
      }
      addressWaits.delete(keyText);
      const saveError = ports.saveRunnerHost(parsed.address);
      if (saveError !== null) console.warn(`[${logTag}] the address could not be saved (${saveError}); it is used for this pairing only`);
      if (check.note !== null) await replyToThread(key, t('runners.addressNote', { note: check.note }));
      await offerPairing(key, parsed.address, check);
    });
    return true;
  }

  async function handleRunnerAction(ctx: Context, key: SessionKey, messageId: number | null, callback: Extract<RunnersCallback, { kind: 'runner' }>): Promise<void> {
    let paired: ReturnType<typeof readPairedFile>;
    try {
      paired = readPairedFile(hub.dir);
    } catch (error) {
      await answerCallbackQuerySafely(ctx);
      await reportRegistryError(key, error);
      return;
    }
    const runner = paired.rev === callback.revision ? paired.runners[callback.index] : undefined;
    if (runner === undefined) {
      await answerCallbackQuerySafely(ctx, t('runners.staleToast'));
      if (messageId !== null) await redrawList(key, messageId);
      return;
    }
    switch (callback.action) {
      case 'remove': {
        await answerCallbackQuerySafely(ctx);
        if (messageId === null) return;
        const question = buildRemoveConfirmation(runner.name, paired.rev, callback.index, t);
        if (await editThreadMessage(key, messageId, question.text, buildKeyboard(question))) rememberScreen(key, messageId, { kind: 'question', revision: paired.rev });
        return;
      }
      case 'removeNo':
        await answerCallbackQuerySafely(ctx);
        break;
      case 'removeYes': {
        const removed = await removePairedRunner(hub, runner.id, now());
        if (removed !== null) cutRunnerLink(hub.dir, removed.id);
        await answerCallbackQuerySafely(ctx, t('runners.removedToast', { name: runner.name }));
        break;
      }
      case 'pause':
      case 'resume': {
        await setPairedRunnerPaused(hub, runner.id, callback.action === 'pause');
        await answerCallbackQuerySafely(ctx, t(callback.action === 'pause' ? 'runners.pausedToast' : 'runners.resumedToast', { name: runner.name }));
        break;
      }
    }
    if (messageId === null) await showScreen(key);
    else await redrawList(key, messageId);
  }

  async function handleCallback(ctx: Context, callback: RunnersCallback): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) {
      await ctx.answerCbQuery(t('cb.access_denied'));
      return;
    }
    const messageId = getCallbackMessageId(ctx);
    await withThreadLocale(key, async () => {
      // The screen only ever stands in General, but a tap is checked where it lands.
      if (!checkIsGeneral(key)) {
        await answerCallbackQuerySafely(ctx, t('runners.generalOnlyText'));
        return;
      }
      switch (callback.kind) {
        case 'pair':
          await answerCallbackQuerySafely(ctx);
          await startPairing(key);
          return;
        case 'refresh':
          await answerCallbackQuerySafely(ctx);
          if (messageId === null) await showScreen(key);
          else await redrawList(key, messageId);
          return;
        case 'addressUse':
          await answerCallbackQuerySafely(ctx);
          await useAddress(key, messageId);
          return;
        case 'addressOther':
          await answerCallbackQuerySafely(ctx);
          if (messageId !== null) await editThreadKeyboard(key, messageId, null, logTag);
          armAddressWait(key);
          await replyToThread(key, t('runners.addressAsk'));
          return;
        case 'runner':
          await handleRunnerAction(ctx, key, messageId, callback);
      }
    });
  }

  /** Edit one watched pairing message to what became of its code. */
  async function settlePairingMessage(pairId: string, text: string): Promise<void> {
    const watched = watchedPairings.get(pairId);
    if (watched === undefined) return;
    watchedPairings.delete(pairId);
    if (!(await editThreadMessage(watched.key, watched.messageId, text))) console.warn(`[${logTag}] the pairing message could not be edited`);
  }

  /**
   * @description One look at the registry: a code that became a runner turns its message into «paired», one that is no longer open (expired)
   * into «expired». Messages are adopted from `pending.json`'s notes, so a restart loses none; a code used while the bot was down keeps
   * its (spent) message.
   */
  async function watchPairingsOnce(): Promise<void> {
    const nowMs = now();
    const pending = readPendingFile(hub.dir).pending;
    const runners = readPairedFile(hub.dir).runners;
    for (const pairing of pending) {
      const target = parsePairingMessageRef(pairing.messageRef);
      if (target !== null && !watchedPairings.has(pairing.pairId)) watchedPairings.set(pairing.pairId, target);
    }
    if (pending.some((pairing) => pairing.expiresAtMs <= nowMs)) await sweepExpiredPairings(hub, nowMs);
    for (const [pairId, target] of [...watchedPairings]) {
      const runner = runners.find((candidate) => candidate.pairId === pairId);
      const isOpen = pending.some((pairing) => pairing.pairId === pairId && pairing.expiresAtMs > nowMs);
      if (runner !== undefined) await withThreadLocale(target.key, () => settlePairingMessage(pairId, buildPairedText(runner.name, runner.pairedAtMs, t, formatRunnersTime)));
      else if (!isOpen) await withThreadLocale(target.key, () => settlePairingMessage(pairId, buildExpiredText(t)));
    }
  }

  /**
   * Keep the `gate` wrapper that the runners' `authorized_keys` lines run pointing at THIS install (a Node upgrade or a moved checkout would
   * leave them pointing at nothing). Done only for an instance that has runners or open codes: another one touches nothing under `~/.config`.
   */
  function refreshGateWrapper(): void {
    try {
      if (readPairedFile(hub.dir).runners.length > 0 || readPendingFile(hub.dir).pending.length > 0) ports.ensureGateWrapper();
    } catch (error) {
      console.warn(`[${logTag}] the gate wrapper could not be refreshed: ${describeCaughtError(error)}`);
    }
  }

  /** @description Start the watch (one look now, then every interval); returns the way to stop it. */
  function startRunnersWatcher(): () => void {
    refreshGateWrapper();
    let lastFailure = '';
    const look = (): void => {
      if (isWatchTickRunning) return;
      isWatchTickRunning = true;
      watchPairingsOnce()
        .then(() => { lastFailure = ''; })
        .catch((error) => {
          // A broken registry file fails every look: say it once, not every five seconds.
          const failure = describeCaughtError(error);
          if (failure !== lastFailure) console.warn(`[${logTag}] pairing watch failed: ${failure}`);
          lastFailure = failure;
        })
        .finally(() => { isWatchTickRunning = false; });
    };
    look();
    const timer = setInterval(look, ports.watchIntervalMs ?? runnersWatchIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  function registerRunnersCommands(): void {
    // `/runners` — in General the list with its buttons; anywhere else a pointer to General. Not gated on an adapter or a session:
    // the machines belong to the whole bot.
    command('runners', async (_ctx, key) => {
      if (!checkIsGeneral(key)) {
        await replyToThread(key, t('runners.generalOnlyText'));
        return;
      }
      await showScreen(key);
    });
  }

  function registerRunnersCallbacks(): void {
    for (const data of [runnersPairCallback, runnersRefreshCallback, runnersAddressUseCallback, runnersAddressOtherCallback]) {
      bot.action(data, (ctx) => {
        const callback = parseRunnersCallback(data);
        return callback === null ? Promise.resolve() : handleCallback(ctx, callback);
      });
    }
    bot.action(runnerActionCallbackRe, (ctx) => {
      const callback = parseRunnersCallback(ctx.match[0]);
      return callback === null ? Promise.resolve() : handleCallback(ctx, callback);
    });
  }

  return { registerRunnersCommands, registerRunnersCallbacks, handleRunnersAddressText, cancelRunnersAddressWait, startRunnersWatcher, watchPairingsOnce };
}
