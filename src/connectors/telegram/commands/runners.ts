/**
 * `/runners` — the machines that run the agents' tests and builds, paired from Telegram. In General only (admins): one message that
 * lists the machines (online or not, what they are, what they can do) with Pause / Resume / Remove per machine, and a button that pairs
 * another one — two one-time lines for the new machine (one for an admin account, one for the runner account itself), valid 10 minutes, in
 * two messages that turn into «paired» or «expired».
 * The hub itself is `src/runners/`; this file is only the screen, its buttons and the two background jobs (editing the pairing message,
 * refreshing a list with live data). See `src/runners/README.md` for the safety line and `utils/runnersScreenPlan.ts` for the texts.
 *
 * Two rules keep the screen true under concurrency. (1) A render is claimed BEFORE its Telegram edit is awaited: every message has a
 * generation, and a background job (the live probe) draws only if the message still carries the generation it started from — so a
 * question that replaced the list while its edit was still queued is never drawn over. (2) The messages that offer a pairing code are
 * this instance's own record (`runnerPairingMessages.ts`, an entry per message), each kept until the edit that settles it was accepted. A
 * message settles to «paired» (a runner carries its code), «closed» (the code was closed unused: its line was pasted for a machine that
 * was already paired) or «expired».
 */
import { Markup, type Context } from 'telegraf';
import { getCaughtErrnoCode } from '../../../configDirFile';
import { getActiveLang, t } from '../../../i18n';
import { escapeHtmlText } from '../renderAgentHtml';
import { keyFromString, keyToString, type SessionKey } from '../../../sessionKey';
import { checkIsNewConcern, createLinkNotice, readLinkNotices, writeLinkNotices, type LinkNotice } from '../runnerLinkNotices';
import { buildAdminBootstrapLine, defaultRunnerAccount } from '../../../runners/bootstrapLine';
import { checkHubAddress, parseHubAddress, type HostKeyScanner, type HubAddress, type HubAddressCheck } from '../../../runners/hubAddress';
import { findProposedHubAddress, formatHubAddress } from '../../../runners/hubAddressCandidates';
import type { HubContext } from '../../../runners/hubPaths';
import {
  createPairing,
  setPairedRunnerPaused,
} from '../../../runners/hubPairing';
import { HubRegistryError, readClosedCodes, readPairedFile, readPendingFile } from '../../../runners/hubRegistry';
import { pairingLifetimeMinutes } from '../../../runners/pairingTiming';
import { getLinkConcern } from '../../../runners/linkConcern';
import { readLinkState } from '../../../runners/linkControl';
import { removeRunnerAndEndItsWork } from '../../../runners/runnerRemoval';
import { readServiceRemovalForRunner } from '../../../runners/serviceRemoval';
import type { RunnersOverview } from '../../../runners/runnersOverview';
import {
  buildAddressStep,
  buildClosedText,
  buildExpiredText,
  buildPairedText,
  buildPairingIntro,
  buildRemoveConfirmation,
  buildLinkConcernNote,
  buildRemovalOutcomeText,
  buildServiceRemovalText,
  buildRunnersScreen,
  parseRunnersCallback,
  runnerActionCallbackRe,
  runnersAddressOtherCallback,
  runnersAddressUseCallback,
  runnersPageCallbackRe,
  runnersPairCallback,
  runnersRefreshCallback,
  type FormatTime,
  type RunnersCallback,
  type RunnersScreen,
} from '../../../utils/runnersScreenPlan';
import { addPairingMessage, getPairingMessageId, markPairingMessageFailed, readPairingMessages, removePairingMessages } from '../runnerPairingMessages';
import type { BotCore } from './botCore';
import { answerCallbackQuerySafely } from './callbackToast';
import { buildMessageSnapshotKey, getCallbackMessageId, rememberBoundedSnapshot } from './callbackMessage';

/** The pairing messages and screens of this many messages are remembered; an older keyboard answers «out of date». */
const messageSnapshotLimit = 50;
/** How long the next General message is read as an address after «Enter another address». */
const addressWaitMs = 10 * 60 * 1000;
/** How often the pairing messages are checked for «used» or «expired» (the registry is two small files). */
export const runnersWatchIntervalMs = 5 * 1000;
/** A pairing message whose edits have been failing for a day is given up on (the code lived 10 minutes). A message Telegram says is gone is settled at once, not waited out. */
const pairingMessageGiveUpAfterFailingMs = 24 * 60 * 60 * 1000;
/** After a failed edit of a pairing message the next try waits this long, doubling each time up to the cap. */
const settleRetryFirstDelayMs = 5 * 1000;
const settleRetryMaxDelayMs = 5 * 60 * 1000;
const logTag = 'runners';

/** What the module needs from the bot: the shared core, the hub and the few readings only the composition root has. */
export interface RunnersPorts extends Pick<BotCore, 'bot' | 'command' | 'replyToThread' | 'editThreadMessage' | 'editThreadMessageDetailed' | 'editThreadKeyboard' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'> {
  /** The hub registry of this OS user (`src/runners/`). */
  hub: HubContext;
  /** The address runners dial, as `settings.json` holds it; `null` = never chosen. */
  readRunnerHost: () => HubAddress | null;
  /** Remember the address; `null` on success, else the errno code of the failed write. */
  saveRunnerHost: (address: HubAddress) => string | null;
  /** Whose charness it is, as the runner shows it (`@ExampleBot`). */
  getBotLabel: () => string;
  /** The file this instance keeps its unsettled pairing messages in (`DATA_DIR/runner-pairing-messages.json`). */
  pairingMessagesPath: string;
  /** Where remote-run keeps the last report of each machine (`remoteRun/ssh.ts`): what says how a machine is kept running when its removal is told. */
  cacheDir: string;
  /** The file this instance keeps what it has told about the runners' links in (`DATA_DIR/runner-link-notices.json`). */
  linkNoticesPath: string;
  /** The key of the operator's General topic, where a runner's link that changed address is said; `null` when there is none to post in. */
  getGeneralKey: () => SessionKey | null;
  /** Pin a message of a topic, notifying (a pin is what pierces a muted topic); `false` when it could not. */
  pinMessage: (key: SessionKey, messageId: number) => Promise<boolean>;
  /** Drop the expired pairing codes (and their key lines) from the shared hub registry. */
  sweepExpiredCodes: (nowMs: number) => Promise<void>;
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

/** `1 Nov 14:02` in the bot's timezone (`process.env.TZ`) and the topic's language: the parts in one fixed order, so it reads the same in every locale. */
export const formatRunnersTime: FormatTime = (epochMs) => {
  const parts = new Intl.DateTimeFormat(getActiveLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(epochMs);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('day')} ${read('month')} ${read('hour')}:${read('minute')}`;
};

function buildKeyboard(screen: RunnersScreen): ReturnType<typeof Markup.inlineKeyboard> {
  return Markup.inlineKeyboard(screen.rows.map((row) => row.map((button) => Markup.button.callback(button.text, button.data))));
}

/**
 * @description What a message was last CLAIMED for: the list (the page it shows) or a question that replaced it. `generation` is
 * unique per claim: a background job that started from one claim draws only while the message still carries it.
 */
interface ShownScreen {
  kind: 'list' | 'question';
  generation: number;
  page: number;
}

/**
 * @description Build the `/runners` screen over its ports. `registerRunnersCommands` / `registerRunnersCallbacks` register the command and
 * the buttons; `handleRunnersAddressText` is called by the text handler for a General message (true = taken as the address) and
 * `cancelRunnersAddressWait` for a slash command (it ends the wait);
 * `startRunnersWatcher` starts the job that edits the pairing messages and returns the way to stop it (`watchPairingsOnce` is one
 * look of that job, for a test to run on its own clock).
 */
export function createRunners(ports: RunnersPorts) {
  const { bot, command, replyToThread, editThreadMessage, editThreadMessageDetailed, editThreadKeyboard, authoriseContext, withThreadLocale, checkIsGeneral, hub, now } = ports;

  const shownScreens = new Map<string, ShownScreen>();
  const addressProposals = new Map<string, HubAddress | null>();
  /** General keys whose next message is an address → when the wait began. */
  const addressWaits = new Map<string, number>();
  /** Pairing messages whose edit failed, by {@link getPairingMessageId}: when the next try may be, and the delay after it (in memory — a restart tries at once). */
  const settleRetries = new Map<string, { nextAttemptAtMs: number; delayMs: number }>();
  let isWatchTickRunning = false;
  let lastGeneration = 0;
  let lastStoreProblem: string | null = null;
  let lastClosedProblem: string | null = null;
  let lastNoticesProblem: string | null = null;
  /** What was told this run, by runner id: a record that cannot be written must not make the next look tell it again. */
  const toldThisRun = new Map<string, LinkNotice>();

  /** Claim `messageId` for a render: whatever started from an earlier claim no longer draws on it. Returns the claim. */
  function claimMessage(key: SessionKey, messageId: number, kind: ShownScreen['kind'], page: number): ShownScreen {
    lastGeneration += 1;
    const shown: ShownScreen = { kind, generation: lastGeneration, page };
    rememberBoundedSnapshot(shownScreens, buildMessageSnapshotKey(key, messageId), shown, messageSnapshotLimit);
    return shown;
  }

  /** The claim `messageId` carries now; `undefined` for a message this module never drew (or forgot). */
  function readClaim(key: SessionKey, messageId: number): ShownScreen | undefined {
    return shownScreens.get(buildMessageSnapshotKey(key, messageId));
  }

  /** The page of the list `messageId` shows — or showed, when a question has replaced it (the question keeps the page it came from); 0 for a message never drawn. */
  function readShownPage(key: SessionKey, messageId: number): number {
    return readClaim(key, messageId)?.page ?? 0;
  }

  async function reportRegistryError(key: SessionKey, caught: unknown): Promise<void> {
    await replyToThread(key, t('runners.registryErrorText', { reason: describeCaughtError(caught) }));
  }

  /**
   * Draw page `page` of `overview` — as a new message, or over `messageId` — and, when machines are online, ask them in the background and
   * draw again. A message that is edited is claimed BEFORE the edit is awaited, so a probe that started from an earlier claim cannot draw
   * over it; a new message is claimed once it exists (nothing can have started from it).
   */
  async function drawList(key: SessionKey, overview: RunnersOverview, page: number, target: { messageId: number | null }): Promise<void> {
    const isChecking = overview.entries.some((entry) => entry.isOnline);
    const screen = buildRunnersScreen({ ...overview, isChecking }, t, formatRunnersTime, page);
    let messageId: number | null;
    let claim: ShownScreen | null = null;
    if (target.messageId === null) {
      messageId = await replyToThread(key, screen.text, buildKeyboard(screen));
      if (messageId !== null) claim = claimMessage(key, messageId, 'list', screen.page);
    } else {
      claim = claimMessage(key, target.messageId, 'list', screen.page);
      messageId = (await editThreadMessage(key, target.messageId, screen.text, buildKeyboard(screen))) ? target.messageId : null;
    }
    if (messageId === null || claim === null || !isChecking) return;
    const startedFrom = claim;
    void probeAndRedraw(key, messageId, overview, startedFrom).catch((error) => console.warn(`[${logTag}] live check failed: ${describeCaughtError(error)}`));
  }

  async function probeAndRedraw(key: SessionKey, messageId: number, overview: RunnersOverview, startedFrom: ShownScreen): Promise<void> {
    const probed = await ports.probeOverview(overview, now());
    // No await between this check and the edit being queued: a claim made later queues its own edit behind this one.
    if (readClaim(key, messageId)?.generation !== startedFrom.generation) return;
    await withThreadLocale(key, async () => {
      const screen = buildRunnersScreen({ ...probed, isChecking: false }, t, formatRunnersTime, startedFrom.page);
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
      await drawList(key, overview, 0, { messageId: null });
    });
  }

  /** Draw the list over the message a button sits on — page `page`, else the page it already shows. */
  async function redrawList(key: SessionKey, messageId: number, page: number = readShownPage(key, messageId)): Promise<void> {
    let overview: RunnersOverview;
    try {
      overview = await ports.readOverview(now());
    } catch (error) {
      await reportRegistryError(key, error);
      return;
    }
    await drawList(key, overview, page, { messageId });
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

  /** `intro` and the line in a `<pre>` — the HTML of a pairing message, and the same words as plain text. */
  function renderPairingMessage(intro: string, line: string): { html: string; plain: string } {
    return {
      html: `${escapeHtmlText(intro)}\n\n<pre>${escapeHtmlText(line)}</pre>`,
      plain: `${intro}\n\n${line}`,
    };
  }

  /**
   * Post the message that carries a pairing line (a secret: the trace keeps only its length) and remember it so it can turn into «paired» / «expired».
   * If Telegram refuses the markup the message goes out as `message.plain`, never with the tags shown.
   */
  async function postPairingLine(key: SessionKey, pairId: string, message: { html: string; plain: string }): Promise<boolean> {
    const messageId = await replyToThread(key, message.html, { parse_mode: 'HTML' }, { isSecret: true, plainFallbackText: message.plain });
    if (messageId === null) return false;
    try {
      addPairingMessage(ports.pairingMessagesPath, { pairId, key: keyToString(key), messageId, offeredAtMs: now() });
    } catch (error) {
      // The line is out and works; only its turning into «paired» / «expired» is lost.
      console.warn(`[${logTag}] the pairing message could not be recorded (${getCaughtErrnoCode(error)}); it will not turn into «paired» or «expired»`);
    }
    return true;
  }

  /**
   * Make a code and post the one message that carries it: the line (it works for an admin account with its `sudo`, and for the runner account itself without it) under
   * its explanation. The message shows what became of the code — «paired», «expired», or that the line was used on a machine that was already paired.
   */
  async function offerPairing(key: SessionKey, address: HubAddress, knownCheck: Extract<HubAddressCheck, { ok: true }> | null): Promise<void> {
    const check = knownCheck ?? (await checkHubAddress(address, ports.scanHostKey));
    if (!check.ok) {
      await rejectAddress(key, check.error);
      return;
    }
    try {
      ports.ensureGateWrapper();
      const pairing = await createPairing(hub, { host: address.host, port: address.port, hostKey: check.hostKey, label: ports.getBotLabel(), nowMs: now() });
      const intro = buildPairingIntro(pairingLifetimeMinutes, defaultRunnerAccount, t);
      if (!(await postPairingLine(key, pairing.pairId, renderPairingMessage(intro, buildAdminBootstrapLine(pairing.payload, defaultRunnerAccount))))) {
        await replyToThread(key, t('runners.pairFailedText', { reason: 'the message could not be sent' }));
      }
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
        // Claimed first: a live check that finishes while this edit is still queued must not draw the list over the question.
        const listClaim = readClaim(key, messageId);
        claimMessage(key, messageId, 'question', listClaim?.page ?? 0);
        await editThreadMessage(key, messageId, question.text, buildKeyboard(question));
        return;
      }
      case 'removeNo':
        await answerCallbackQuerySafely(ctx);
        break;
      case 'removeYes': {
        // The tap is answered at once, without text: stopping the jobs on the machine can take 20 s and more, and a tap left unanswered for
        // long is «too old». What happened — including whether the jobs were stopped — is told in a message of its own once it is known.
        await answerCallbackQuerySafely(ctx);
        try {
          // Read BEFORE the removal, which deletes the machine's last report: the always-on service stays on the machine, and the commands that
          // remove it are made here, by the hub — not by the machine's own program, which the agents can change.
          const serviceCommands = readServiceRemovalForRunner(hub, ports.cacheDir, runner.id)?.commands ?? [];
          const removal = await removeRunnerAndEndItsWork(hub, runner.id, now());
          if (removal !== null) {
            await replyToThread(key, buildRemovalOutcomeText(removal.runner.name, removal.jobs, t));
            if (serviceCommands.length > 0) await replyToThread(key, buildServiceRemovalText(removal.runner.name, serviceCommands, t));
          }
        } catch (error) {
          await reportRegistryError(key, error);
          return;
        }
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
        case 'page':
          await answerCallbackQuerySafely(ctx);
          if (messageId === null) await showScreen(key);
          else await redrawList(key, messageId, callback.page);
          return;
        case 'runner':
          await handleRunnerAction(ctx, key, messageId, callback);
      }
    });
  }

  /**
   * @description One look at this instance's unsettled pairing messages (`runnerPairingMessages.ts`): a code that became a runner turns its
   * message into «paired», one that is no longer open (expired, swept) into «expired». An entry is dropped only after Telegram accepted
   * the edit, or said the message is gone (the operator deleted it by hand) — a failed one is tried again later (5 s, doubling to 5 min) and survives a restart; one whose edits have been failing for a
   * day is given up on (counted from the first failed attempt: a message older than that is still tried once). Expired credentials are
   * swept from the shared registry here too, but the messages never depend on what the sweep left (they are this instance's own record,
   * and another instance may have swept or even spent the code while this one was down).
   *
   * ORDER matters: the record is read FIRST, the registry right after, with no await between. A message is recorded after its code was
   * created, so a registry read after the record holds the code of every message in it — a message is never judged against a registry
   * older than itself (reading them the other way round, an offer that finishes while the sweep waits for the hub lock would be taken for
   * an expired code and its live line edited away).
   */
  async function watchPairingsOnce(): Promise<void> {
    const nowMs = now();
    const { messages, problem } = readPairingMessages(ports.pairingMessagesPath);
    const pending = readPendingFile(hub.dir).pending;
    const runners = readPairedFile(hub.dir).runners;
    // A broken record fails every look: say it once, not every five seconds.
    if (problem !== null && problem !== lastStoreProblem) console.warn(`[${logTag}] ${problem}; the pairing messages it held are not followed`);
    lastStoreProblem = problem;
    if (pending.some((pairing) => pairing.expiresAtMs <= nowMs)) await ports.sweepExpiredCodes(nowMs);
    const settledMessageIds = new Set<string>();
    /** The closed codes — read when a message first settles without a runner, and not before, and not on a look that has nothing to settle. */
    let closedPairIds: Set<string> | null = null;
    /** Is `pairId` a code that was closed unused AND is gone from the pending list? A trace of a code that is still listed (its write was followed by a failed one) is not a closing. */
    const checkIsClosed = (pairId: string): boolean => {
      if (pending.some((pairing) => pairing.pairId === pairId)) return false;
      if (closedPairIds === null) {
        // After the pending list: a code is noted as closed BEFORE it leaves that list, so a code seen gone from it is already noted here.
        const { codes, problem } = readClosedCodes(hub.dir);
        // A broken trace file fails every read: say it once, not at every look.
        if (problem !== null && problem !== lastClosedProblem) console.warn(`[${logTag}] ${problem}`);
        lastClosedProblem = problem;
        closedPairIds = new Set(codes.map((entry) => entry.pairId));
      }
      return closedPairIds.has(pairId);
    };
    for (const message of messages) {
      const messageId = getPairingMessageId(message);
      if ((settleRetries.get(messageId)?.nextAttemptAtMs ?? 0) > nowMs) continue;
      const runner = runners.find((candidate) => candidate.pairId === message.pairId);
      const isOpen = pending.some((pairing) => pairing.pairId === message.pairId && pairing.expiresAtMs > nowMs);
      if (runner === undefined && isOpen) continue;
      const key = keyFromString(message.key);
      // A message that is no longer there (the operator deleted it by hand) is settled all the same: there is nothing to edit and retrying would only fail for a day.
      const isSettled = await withThreadLocale(key, async () => (await editThreadMessageDetailed(key, message.messageId, runner !== undefined ? buildPairedText(runner.name, runner.pairedAtMs, t, formatRunnersTime) : checkIsClosed(message.pairId) ? buildClosedText(t) : buildExpiredText(t))) !== 'failed');
      if (isSettled) {
        settledMessageIds.add(messageId);
        settleRetries.delete(messageId);
        continue;
      }
      if (nowMs - (message.firstFailedAtMs ?? nowMs) > pairingMessageGiveUpAfterFailingMs) {
        console.warn(`[${logTag}] a pairing message could not be settled for a day; giving up on it`);
        settledMessageIds.add(messageId);
        settleRetries.delete(messageId);
        continue;
      }
      markPairingMessageFailed(ports.pairingMessagesPath, message, nowMs);
      const delayMs = Math.min((settleRetries.get(messageId)?.delayMs ?? settleRetryFirstDelayMs / 2) * 2, settleRetryMaxDelayMs);
      settleRetries.set(messageId, { nextAttemptAtMs: nowMs + delayMs, delayMs });
    }
    if (settledMessageIds.size > 0) removePairingMessages(ports.pairingMessagesPath, settledMessageIds);
  }

  /**
   * @description One look at where the runners' links come from (`runners/linkConcern.ts`): a link that came from another address than it did, or
   * links that keep replacing each other, is posted ONCE in General and pinned — the operator runs every topic muted, and a pin pierces it. A concern
   * is told apart by the time of its newest change (`runnerLinkNotices.ts`), so a look five seconds later, a restart or a longer fight tells nothing
   * again; with no General to post in, or a send that failed, it is simply tried again at the next look. The `/runners` screen and `ls` keep the note
   * until the runner is removed or paired again.
   */
  async function watchLinkConcernsOnce(): Promise<void> {
    const { runners } = readPairedFile(hub.dir);
    const { notices, problem } = readLinkNotices(ports.linkNoticesPath);
    if (problem !== null && problem !== lastNoticesProblem) console.warn(`[${logTag}] ${problem}; what was told about the links is not known`);
    lastNoticesProblem = problem;
    const kept = notices.filter((notice) => runners.some((runner) => runner.id === notice.runnerId));
    let record = kept;
    let isRecordChanged = kept.length !== notices.length;
    for (const runner of runners) {
      const concern = getLinkConcern(readLinkState(hub.dir, runner.id)?.sourceChanges);
      if (concern === null) continue;
      const announced = toldThisRun.get(runner.id) ?? record.find((notice) => notice.runnerId === runner.id);
      if (!checkIsNewConcern(concern, announced)) continue;
      const generalKey = ports.getGeneralKey();
      if (generalKey === null) continue;
      const text = withThreadLocale(generalKey, () => `${runner.name}: ${buildLinkConcernNote(concern, t, formatRunnersTime)}`);
      const messageId = await replyToThread(generalKey, text);
      if (messageId === null) continue;
      await ports.pinMessage(generalKey, messageId);
      const told = createLinkNotice(runner.id, concern);
      toldThisRun.set(runner.id, told);
      record = [...record.filter((notice) => notice.runnerId !== runner.id), told];
      isRecordChanged = true;
    }
    if (isRecordChanged) writeLinkNotices(ports.linkNoticesPath, record);
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
        .then(() => watchLinkConcernsOnce())
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
    for (const pattern of [runnersPageCallbackRe, runnerActionCallbackRe]) {
      bot.action(pattern, (ctx) => {
        const callback = parseRunnersCallback(ctx.match[0]);
        return callback === null ? Promise.resolve() : handleCallback(ctx, callback);
      });
    }
  }

  return { registerRunnersCommands, registerRunnersCallbacks, handleRunnersAddressText, cancelRunnersAddressWait, startRunnersWatcher, watchPairingsOnce, watchLinkConcernsOnce };
}
