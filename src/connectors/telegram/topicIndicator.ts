/**
 * The status mark at the END of a topic's name — the part that touches Telegram. `utils/topicIndicatorPlan.ts` decides WHAT the name
 * is and WHEN it may change; this keeps, per topic, what the bot last wrote and since when it works, asks the plan at every change
 * signal, and writes the name — the NAME only, never the topic's icon — through the shared send gate. A topic whose own name the bot
 * does not know is never written. See `README.md` in `commands/` (`/topic_status`) and `docs/commands.md`.
 *
 * Failures never reach the owner as errors. A refused right is remembered PER TOPIC (a topic the bot made itself needs no right and keeps
 * its marks) and kept with the binding, so a restart does not try those topics again: one log line per chat per boot, the picker says why,
 * and the sweep re-probes a refused chat with ONE of its topics — only a probe that succeeds lets the others try again, so a chat without
 * the right costs one failing call per sweep, not one per topic. Any other failure is logged once per distinct cause and tried again
 * after a bounded backoff, which no change signal skips (a ❓ edge and the owner's own change excepted).
 */
import type { SessionKey } from '../../sessionKey';
import { keyToString, tryKeyFromString } from '../../sessionKey';
import { KeyLock, type StateStore } from '../../state';
import { checkIsRateLimitedError } from '../../rateLimiter';
import { checkIsApiError, classifySendError, getErrorDescription } from '../../sendErrorClassifier';
import { checkIsMessageDeletionRefusedError, checkIsMessageNotFoundError } from '../../utils/telegramError';
import {
  checkIsNameReduction,
  composeIndicatorName,
  planIndicatorRename,
  resolveTopicStatus,
  type IndicatorRenameInputs,
  type TopicIndicatorCounts,
  type TopicStatus,
  type TopicStatusInputs,
  type TopicStatusPrefs,
} from '../../utils/topicIndicatorPlan';
import { getTelegramChatId } from './sessionKeyCodec';
import { checkIsMissingTopicRightsError } from './commands/topicCommand';
import { checkIsTelegramFailureRetryable } from './telegramFailureRetry';

/** What the status of a topic's name is built from, read live from the bot's own state when asked. */
export interface TopicIndicatorSources {
  /** The facts the status is chosen from (`resolveTopicStatus`). */
  getStatusInputs: (key: SessionKey) => TopicStatusInputs;
  /** The agents at work: the topic's own agent while it works, plus each worker it watches. Asked only while that count is switched on. */
  getAgentsCount: (key: SessionKey) => number;
  /** The tasks queued in the topic's published todo list. Asked only while that count is switched on. */
  getQueuedCount: (key: SessionKey) => number;
}

/** The windows the refresher works with: the plan's own constants in production, shorter ones in a flow. */
export interface TopicIndicatorWindows {
  settleMs: number;
  minGapMs: number;
  sweepIntervalMs: number;
  bootWaveDelayMs: number;
}

/** A timer the refresher can cancel. */
export interface TopicIndicatorTimer {
  cancel: () => void;
}

/** What the module needs from the bot: the sources, the two Telegram calls and the clock. */
export interface TopicIndicatorPorts extends TopicIndicatorSources {
  getState: () => StateStore;
  /** Whether `key` can carry a mark: a Telegram topic other than General (a Jira issue, General and a foreign key cannot). */
  checkIsMarkableTopic: (key: SessionKey) => boolean;
  /** Whether the topic is being unbound right now: nothing is looked at or written then, `restoreBaseName` is the last write. */
  checkIsUnbinding: (key: SessionKey) => boolean;
  /** The switches in force for the topic (its own set, else the instance's over the defaults). */
  getPrefs: (key: SessionKey) => TopicStatusPrefs;
  /** `editForumTopic` with the NAME alone, through the shared send gate; rejects with Telegram's error. */
  sendTopicName: (key: SessionKey, name: string) => Promise<void>;
  /** Delete a message of the topic through the shared send gate; rejects with Telegram's error. */
  deleteMessage: (key: SessionKey, messageId: number) => Promise<void>;
  /** Whether the updates that waited while the bot was down have been handled: until they are, no name is written (an owner's rename made meanwhile must be learned first). */
  checkIsBacklogHandled: () => boolean;
  windows: TopicIndicatorWindows;
  getNowMs: () => number;
  /** Run `callback` once after `delayMs`; a timer that is only waiting must not keep the process alive. */
  setTimer: (callback: () => void, delayMs: number) => TopicIndicatorTimer;
  log: (line: string) => void;
}

/** How a topic's status mark stands, for the picker's hints. */
export interface TopicIndicatorHealth {
  /** Telegram refused a rename in this chat for want of the «Manage topics» right: the topics it refused have no marks until a probe succeeds. */
  isRenameRefused: boolean;
  /** Telegram refused to delete the bot's own «renamed» line: each change leaves one in the topic. */
  isLineDeletionRefused: boolean;
}

/** What the bot keeps in memory about one topic's name. */
interface TopicRuntime {
  timer: TopicIndicatorTimer | null;
  /** A look at the topic is already queued for the end of this tick (a burst of events makes one). */
  isLookQueued: boolean;
  lastRenameAtMs: number | null;
  /** The name the topic was last found to want, and since when it has wanted it (the settle time counts from there). */
  heldName: string | null;
  heldSinceMs: number;
  /** The owner changed what is shown and the change has not been written yet. */
  isOwnerChangePending: boolean;
  /** The last failure logged for this topic: the same cause is not logged again. */
  lastLoggedFailure: string | null;
  /** Renames in a row that failed for a cause a later try may fix: the backoff grows with it. */
  failureCount: number;
  /** The end of the backoff after the last failed rename: until then only a ❓ edge and the owner's own change are written. */
  retryNotBeforeMs: number | null;
  /** The names the bot wrote last, newest first: an owner who saves a name while one of them still showed has not typed its mark. */
  recentAppliedNames: string[];
  /**
   * A name Telegram did NOT keep: it was asked for `desiredName` while the bot believed `appliedName`, and Telegram either answered
   * TOPIC_NOT_MODIFIED (the title already read as that name once the ending it drops — a ✅ was one — is gone: the topic never shows
   * `desiredName`, or the bot's belief was stale) or stored another name, which its own «renamed» line says (`isTitleKnown`: `appliedName`
   * IS what the topic shows). While the bot's belief and its wish are still this pair nothing is written (the same call would be answered
   * the same, for ever); a change of either — an owner's rename, another name written — ends it, and so does a change the owner makes
   * with a switch of `/topic_status` (he asked, so it is tried once more). A wish that is NOT this pair is planned against the name the
   * topic is known to read as — not against a belief that may be stale. In memory only: a restart tries once more.
   */
  unkept: { appliedName: string; desiredName: string; isTitleKnown: boolean } | null;
  /** The «not kept» names logged for this topic: each once per boot, however often the pair comes back. */
  loggedUnkeptNames: Set<string>;
  /**
   * The names asked for and answered ok whose «renamed» line has not come back yet, oldest first (the lines arrive in order): the line
   * carries the name Telegram STORED, which is compared with the one asked. An ask older than {@link ownLineWindowMs} is forgotten — its
   * line is lost, and a stale head must not be matched with a later line.
   */
  pendingAsks: PendingAsk[];
}

/** A name asked for and answered ok whose «renamed» line has not come back yet. */
interface PendingAsk {
  name: string;
  atMs: number;
}

/** What Telegram refused for want of the right, in one chat: the topics it refused, and the one topic the sweep probes again. */
interface RenameRefusal {
  /** Oldest refusal first: the sweep probes the oldest, and a probe that is refused again goes to the end. */
  topicKeys: Set<string>;
  probeKey: string | null;
  /**
   * The probe ended WITHOUT a verdict on the right: its look found nothing to write (the topic wants no mark), the topic is gone, or its
   * rename failed in a way no retry can change (`checkIsTelegramFailureRetryable` says no: a Bot API rejection other than 429 / 5xx, or
   * an error that is neither an answer nor the network's, such as a bug of ours). The next sweep drops it and probes the next refused topic. A probe that has no result yet — its call is still queued on the send gate, its name still waits
   * for the settle time, or its call failed with no answer / a 429 / a 5xx and its retry is armed — is NOT silent: dropping it would
   * release the chat (and its hint) while the answer is still to come.
   */
  isProbeSilent: boolean;
}

/** How a write of the wanted name ended: written; nothing to write; skipped (refused topic); failed (a later try may work). */
type WriteOutcome = 'written' | 'idle' | 'refused' | 'failed';

/** What a failed rename means. `noChange`: Telegram says the topic already has the name (see the «not kept» rule in `writeDesiredName`); `gone`: the topic is not there or closed — no retry. */
type RenameErrorKind = 'noChange' | 'refused' | 'gone' | 'failed';

/** How long after a rename its «renamed» line may still be matched with it: the line comes back within seconds (measured 0.1–14 s), a renames' gap is a minute. */
const ownLineWindowMs = 30_000;

/** How many of the names the bot wrote are remembered per topic. */
const recentAppliedNamesLimit = 3;

/** What the bot knows the topic shows and should show. */
interface TopicView {
  base: string;
  appliedName: string;
  desiredName: string;
  desiredStatus: TopicStatus | null;
}

const noStatusInputs: TopicStatusInputs = { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: false };
const noCounts: TopicIndicatorCounts = { agents: 0, queued: 0 };

/** How often a look that waits for the updates that waited while the bot was down looks again whether they are handled. */
const backlogPollMs = 500;
/** How long, counted from `start()`, no name is written for them at most. */
const backlogMaxWaitMs = 30_000;

/** Telegram's answer to a rename that changes nothing: the topic already has the name. */
const topicNotModifiedPattern = /TOPIC_NOT_MODIFIED/i;

/**
 * @description Build the status mark of topic names over its ports: the look at a topic (`requestRefresh`), the owner's change of a
 * switch (`requestRefresh(key, { isOwnerChange: true })`), the bot's own «renamed» line (`handleOwnRenameLine`), the name put back
 * (`restoreBaseName`), and the sweep and the boot wave (`start`).
 */
export function createTopicIndicator(ports: TopicIndicatorPorts) {
  const { getState, checkIsMarkableTopic, checkIsUnbinding, getPrefs, sendTopicName, deleteMessage, checkIsBacklogHandled, windows, getNowMs, setTimer, log } = ports;
  const runtimes = new Map<string, TopicRuntime>();
  /** One write at a time per topic: the look inside the lock is the latest, so a stale name is never written. */
  const writeLock = new KeyLock();
  const renameRefusals = new Map<number, RenameRefusal>();
  const lineDeletionRefusedChats = new Set<number>();
  /** The chats whose refusal is already logged (one line per boot, however often the sweep tries again). */
  const loggedRefusedChats = new Set<string>();
  let sweepTimer: TopicIndicatorTimer | null = null;
  let waveTimer: TopicIndicatorTimer | null = null;
  /** Opens once the updates that waited are handled (or the cap after `start()` ran out) and stays open: from then on nothing waits for them. */
  let isBootGateOpen = false;
  let bootStartedAtMs: number | null = null;
  let areRefusalsLoaded = false;

  function getRuntime(keyString: string): TopicRuntime {
    let runtime = runtimes.get(keyString);
    if (!runtime) {
      runtime = {
        timer: null,
        isLookQueued: false,
        lastRenameAtMs: null,
        heldName: null,
        heldSinceMs: 0,
        isOwnerChangePending: false,
        lastLoggedFailure: null,
        failureCount: 0,
        retryNotBeforeMs: null,
        recentAppliedNames: [],
        unkept: null,
        loggedUnkeptNames: new Set(),
        pendingAsks: [],
      };
      runtimes.set(keyString, runtime);
    }
    return runtime;
  }

  /**
   * What the topic shows and what it should show — `null` when it cannot carry a mark (not a topic, not bound, its own name unknown).
   * Notes, as a side effect, since when the wanted name has been the wanted one. A closed topic shows its owner's own name, like a topic
   * without an agent.
   */
  function observeTopic(key: SessionKey): TopicView | null {
    if (!checkIsMarkableTopic(key) || checkIsUnbinding(key)) return null;
    const binding = getState().getBinding(key);
    if (!binding || binding.topicName === undefined) return null;
    const prefs = getPrefs(key);
    const isShown = binding.closed !== true;
    const inputs = isShown ? ports.getStatusInputs(key) : noStatusInputs;
    const runtime = getRuntime(keyToString(key));
    const desiredStatus = resolveTopicStatus(inputs, prefs);
    const counts: TopicIndicatorCounts = isShown
      ? { agents: prefs.agents ? ports.getAgentsCount(key) : 0, queued: prefs.queued ? ports.getQueuedCount(key) : 0 }
      : noCounts;
    const desiredName = composeIndicatorName(binding.topicName, desiredStatus, counts, prefs);
    if (runtime.heldName !== desiredName) {
      runtime.heldName = desiredName;
      runtime.heldSinceMs = getNowMs();
    }
    return { base: binding.topicName, appliedName: binding.indicatorAppliedName ?? binding.topicName, desiredName, desiredStatus };
  }

  function planRename(view: TopicView, runtime: TopicRuntime): ReturnType<typeof planIndicatorRename> {
    let { appliedName } = view;
    const { unkept } = runtime;
    if (unkept !== null && unkept.appliedName === view.appliedName) {
      // The name was asked for and Telegram did not keep it: asking again changes nothing.
      if (unkept.desiredName === view.desiredName) return { kind: 'none' };
      // Any OTHER wish is planned against what the topic is known to read as — that name, less what Telegram drops from it — not against the
      // belief, which «not modified» may have shown stale: a wish equal to a stale belief would be taken for «already shown» and never written.
      if (!unkept.isTitleKnown) appliedName = unkept.desiredName;
    }
    const inputs: IndicatorRenameInputs = {
      desiredName: view.desiredName,
      desiredStatus: view.desiredStatus,
      appliedName,
      heldSinceMs: runtime.heldSinceMs,
      lastRenameAtMs: runtime.lastRenameAtMs,
      isOwnerChange: runtime.isOwnerChangePending,
      retryNotBeforeMs: runtime.retryNotBeforeMs,
      nowMs: getNowMs(),
      settleMs: windows.settleMs,
      minGapMs: windows.minGapMs,
    };
    return planIndicatorRename(inputs);
  }

  function dropTimer(runtime: TopicRuntime): void {
    runtime.timer?.cancel();
    runtime.timer = null;
  }

  /** Log a failure of `key`'s topic once per distinct cause. */
  function logFailureOnce(key: SessionKey, runtime: TopicRuntime, line: string): void {
    if (runtime.lastLoggedFailure === line) return;
    runtime.lastLoggedFailure = line;
    log(`[topic-indicator] ${keyToString(key)}: ${line}`);
  }

  /**
   * The refusals the bindings remember from before this boot (`indicatorRenameRefused`), loaded on first use: a restart does not send one
   * failing call per such topic — the sweep's probe is the first to try again.
   */
  function ensureRefusalsLoaded(): void {
    if (areRefusalsLoaded) return;
    areRefusalsLoaded = true;
    for (const { key, data } of getState().listBindings()) {
      if (data.indicatorRenameRefused === true && checkIsMarkableTopic(key)) recordRefusal(key, { isRemembered: true });
    }
  }

  /** Whether Telegram refused `key`'s topic a rename for want of the right and the sweep has not let it try again. */
  function checkIsRefused(key: SessionKey): boolean {
    ensureRefusalsLoaded();
    return renameRefusals.get(getTelegramChatId(key))?.topicKeys.has(keyToString(key)) === true;
  }

  /** Forget in the binding that the topic was refused (a rename went through, or the probe of it said nothing). Never rejects. */
  function clearRefusalFlag(key: SessionKey): void {
    void getState().setBindingTopicNaming(key, { indicatorRenameRefused: null }).catch((error) => {
      log(`[topic-indicator] ${keyToString(key)}: saving that the rename is no longer refused failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  /**
   * The topic was refused for want of the right: remember it in memory and with the binding (a probe that is refused again goes to the end),
   * and say so once per chat per boot. `isRemembered`: it is the binding's memory of an earlier boot being loaded — nothing to save.
   */
  function recordRefusal(key: SessionKey, options: { isRemembered?: boolean } = {}): void {
    const chatId = getTelegramChatId(key);
    const keyString = keyToString(key);
    const refusal = renameRefusals.get(chatId) ?? { topicKeys: new Set<string>(), probeKey: null, isProbeSilent: false };
    renameRefusals.set(chatId, refusal);
    refusal.topicKeys.delete(keyString);
    refusal.topicKeys.add(keyString);
    if (refusal.probeKey === keyString) {
      refusal.probeKey = null;
      refusal.isProbeSilent = false;
    }
    if (options.isRemembered !== true && getState().getBinding(key)?.indicatorRenameRefused !== true) {
      void getState().setBindingTopicNaming(key, { indicatorRenameRefused: true }).catch((error) => {
        log(`[topic-indicator] ${keyString}: saving the refused rename failed: ${error instanceof Error ? error.message : error}`);
      });
    }
    if (!loggedRefusedChats.has(`rename:${chatId}`)) {
      loggedRefusedChats.add(`rename:${chatId}`);
      log(`[topic-indicator] chat ${chatId}: the bot may not rename topics it did not make (needs the «Manage topics» admin right) — no status marks on those until it does`);
    }
  }

  /** The look at `key` found nothing to write: when it is the probe of a refused chat, the probe is silent (it says nothing about the right). */
  function noteProbeSilent(key: SessionKey): void {
    const refusal = renameRefusals.get(getTelegramChatId(key));
    if (refusal && refusal.probeKey === keyToString(key)) refusal.isProbeSilent = true;
  }

  /** A rename was written: when it was the probe of a refused chat, the right is back — the chat's other topics try again. */
  function noteRenameWritten(key: SessionKey): void {
    const chatId = getTelegramChatId(key);
    const refusal = renameRefusals.get(chatId);
    if (!refusal || refusal.probeKey !== keyToString(key)) return;
    renameRefusals.delete(chatId);
    for (const keyString of refusal.topicKeys) {
      const refusedKey = tryKeyFromString(keyString);
      if (refusedKey) requestRefresh(refusedKey);
    }
  }

  /** What a failed rename means: the right is missing → remembered for this topic; the name already is the one, or the topic is gone → no retry; else a failure to log and retry. */
  function classifyRenameError(key: SessionKey, runtime: TopicRuntime, error: unknown): RenameErrorKind {
    if (checkIsMissingTopicRightsError(error)) {
      recordRefusal(key);
      return 'refused';
    }
    const description = checkIsApiError(error) ? getErrorDescription(error) : error instanceof Error ? error.message : String(error);
    if (topicNotModifiedPattern.test(description)) return 'noChange';
    logFailureOnce(key, runtime, `renaming the topic failed: ${description}`);
    // A deleted or closed topic cannot be renamed: the reopen event and the sweep look again, no timer does.
    return classifySendError(error) === 'other' ? 'failed' : 'gone';
  }

  /** Remember the name just written, newest first. */
  function noteAppliedName(runtime: TopicRuntime, name: string): void {
    runtime.recentAppliedNames = [name, ...runtime.recentAppliedNames.filter((recent) => recent !== name)].slice(0, recentAppliedNamesLimit);
  }

  /** Look at the topic again after a backoff that grows with each failure in a row (a 429's own cooldown is the floor), at most one sweep. */
  function scheduleRetry(key: SessionKey, runtime: TopicRuntime, error: unknown): void {
    runtime.failureCount += 1;
    const backoffMs = Math.min(windows.minGapMs * 2 ** (runtime.failureCount - 1), windows.sweepIntervalMs);
    const delayMs = checkIsRateLimitedError(error) ? Math.max(backoffMs, error.retryAfterMs) : backoffMs;
    // A change signal looks at the topic before the timer fires: the plan holds every name but a ❓ edge back until this instant.
    runtime.retryNotBeforeMs = getNowMs() + delayMs;
    dropTimer(runtime);
    runtime.timer = setTimer(() => {
      runtime.timer = null;
      look(key);
    }, delayMs);
  }

  /** Note a name just asked for, forgetting the asks whose line is long overdue; resolves the note, which {@link dropAsk} takes back. */
  function noteAsk(runtime: TopicRuntime, name: string): PendingAsk {
    const nowMs = getNowMs();
    const ask: PendingAsk = { name, atMs: nowMs };
    runtime.pendingAsks = [...runtime.pendingAsks.filter((pending) => nowMs - pending.atMs <= ownLineWindowMs), ask];
    return ask;
  }

  /** The ask failed, so no line will come for it: its note is taken back (by identity — a line may have matched and removed it already). */
  function dropAsk(runtime: TopicRuntime, ask: PendingAsk): void {
    runtime.pendingAsks = runtime.pendingAsks.filter((pending) => pending !== ask);
  }

  /** The «not kept» line of a name, once per topic per boot. */
  function logUnkeptOnce(key: SessionKey, runtime: TopicRuntime, name: string, cause: string): void {
    if (runtime.loggedUnkeptNames.has(name)) return;
    runtime.loggedUnkeptNames.add(name);
    log(`[topic-indicator] ${keyToString(key)}: Telegram did not keep «${name}» as asked (${cause}) — not taken for applied, not asked again until the name or the status changes`);
  }

  /**
   * The name on the bot's own «renamed» line is the name Telegram STORED: compared with the one asked, it shows an ask that was answered ok
   * and kept altered (the title went `<name> 💤` → `<name>` for a ✅) — which no answer shows. The line is matched with its ask in order; one
   * whose ask is unknown (a line of an earlier life, an ask forgotten as overdue) or whose name is no reduction of the ask is nobody's to judge.
   * An altered ask is NOT kept: the stored name becomes the belief (unless a newer ask has taken the belief over already), and the pair is
   * not asked again.
   *
   * The match is synchronous (the lines come in order, and the order must hold); the BELIEF part runs under the topic's write lock, and is
   * not awaited — telegraf's polling waits for the handlers of a batch, and the lock may be held across a call that waits for the send gate.
   * The line can come back BEFORE the answer of its own call is read (measured 0.1–14 s after the call; a round trip can be longer): the
   * write still in flight stores the asked name as applied when its answer comes, and a verdict taken before that would be overwritten by
   * it. Under the lock the verdict runs after that write's success block, and a newer write queued ahead of it still makes the line history.
   */
  function judgeOwnRenameLine(key: SessionKey, storedName: string): void {
    const runtime = runtimes.get(keyToString(key));
    if (!runtime) return;
    const nowMs = getNowMs();
    runtime.pendingAsks = runtime.pendingAsks.filter((ask) => nowMs - ask.atMs <= ownLineWindowMs);
    const keptIndex = runtime.pendingAsks.findIndex((ask) => ask.name === storedName);
    if (keptIndex !== -1) {
      // Kept as asked; the asks before it, whose lines never came, are forgotten with it.
      runtime.pendingAsks.splice(0, keptIndex + 1);
      return;
    }
    const asked = runtime.pendingAsks[0];
    if (asked === undefined || !checkIsNameReduction(storedName, asked.name)) return;
    runtime.pendingAsks.shift();
    logUnkeptOnce(key, runtime, asked.name, `Telegram stored «${storedName}»`);
    void writeLock.withLock(keyToString(key), async () => {
      const binding = getState().getBinding(key);
      // The belief moved on already — a newer ask answered ok (its own line tells what the topic shows now), or an owner's rename — so this line is history.
      if (!binding || binding.indicatorAppliedName !== asked.name) return;
      runtime.unkept = { appliedName: storedName, desiredName: asked.name, isTitleKnown: true };
      await getState().setBindingTopicNaming(key, { indicatorAppliedName: storedName });
      requestRefresh(key);
    }).catch((error) => {
      log(`[topic-indicator] ${keyToString(key)}: saving the name Telegram stored failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  /** Write the name the topic should show now, if the plan still says so inside the lock. */
  async function writeDesiredName(key: SessionKey): Promise<{ outcome: WriteOutcome; error?: unknown }> {
    return writeLock.withLock(keyToString(key), async () => {
      if (checkIsRefused(key)) return { outcome: 'refused' };
      const view = observeTopic(key);
      if (view === null) {
        noteProbeSilent(key);
        return { outcome: 'idle' };
      }
      const runtime = getRuntime(keyToString(key));
      const plan = planRename(view, runtime);
      if (plan.kind !== 'now') {
        if (plan.kind === 'none') noteProbeSilent(key);
        return { outcome: 'idle' };
      }
      // The ask is noted BEFORE the call: its «renamed» line may come back before the answer is read (`judgeOwnRenameLine` waits for this lock).
      const ask = noteAsk(runtime, view.desiredName);
      try {
        await sendTopicName(key, view.desiredName);
      } catch (error) {
        dropAsk(runtime, ask);
        const kind = classifyRenameError(key, runtime, error);
        // A topic that is gone, or whose rename fails in a way no retry can change (`checkIsTelegramFailureRetryable`: a rejection other than
        // 429 / 5xx, or an error that is neither an answer nor the network's), gives no verdict on the right: were its probe kept for the
        // answer, one deleted topic would keep the chat's other refused topics from ever being probed again. A failure that is no answer (a
        // timeout, a reset), a 429 or a 5xx is no verdict either way: the probe is KEPT, and its armed retry decides — an outage hits every
        // topic alike, so dropping one probe per sweep would only spend a failing call on each.
        if (kind === 'failed') {
          if (!checkIsTelegramFailureRetryable(error)) noteProbeSilent(key);
          return { outcome: 'failed', error };
        }
        runtime.retryNotBeforeMs = null;
        if (kind === 'refused') return { outcome: 'refused' };
        if (kind === 'gone') {
          noteProbeSilent(key);
          return { outcome: 'idle' };
        }
        // «Not modified» for a name that differs from the one the bot believed (the plan only writes a name that does): the title already reads
        // as the asked name, and the bot's belief was another — so Telegram turned what it asked for into something else (it drops a trailing
        // ✅ from a topic name: ok when that is a change, «not modified» when it is none). Believing the asked name would show a mark the topic
        // does not carry. The one name that proves itself is the owner's plain base: «not modified» for it says the title IS the base.
        if (kind === 'noChange' && view.desiredName !== view.base) {
          runtime.unkept = { appliedName: view.appliedName, desiredName: view.desiredName, isTitleKnown: false };
          // The owner's ask WAS answered: were the flag kept, the next wish that is none of his would skip the settle time and the gap, and a
          // short reply would flash its ⏳ for a minute.
          runtime.isOwnerChangePending = false;
          logUnkeptOnce(key, runtime, view.desiredName, 'TOPIC_NOT_MODIFIED — Telegram dropped part of the name, or the bot\'s belief was stale');
          noteProbeSilent(key);
          return { outcome: 'idle' };
        }
      }
      runtime.lastRenameAtMs = getNowMs();
      runtime.isOwnerChangePending = false;
      runtime.lastLoggedFailure = null;
      runtime.failureCount = 0;
      runtime.retryNotBeforeMs = null;
      runtime.unkept = null;
      noteAppliedName(runtime, view.desiredName);
      await getState().setBindingTopicNaming(key, { indicatorAppliedName: view.desiredName, indicatorRenameRefused: null }).catch((error) => {
        log(`[topic-indicator] ${keyToString(key)}: saving the applied name failed: ${error instanceof Error ? error.message : error}`);
      });
      noteRenameWritten(key);
      return { outcome: 'written' };
    });
  }

  /**
   * Whether the updates that waited while the bot was down are handled — or the wait for them ran out. Until then NO look writes: a signal of
   * the boot itself (an agent that is gone, a question dropped) asks for a write that comes at once, and the owner's rename made during the
   * downtime — still waiting for its update — would be overwritten with the old name.
   */
  function checkIsBootGateOpen(): boolean {
    if (!isBootGateOpen && (checkIsBacklogHandled() || (bootStartedAtMs !== null && getNowMs() - bootStartedAtMs >= backlogMaxWaitMs))) isBootGateOpen = true;
    return isBootGateOpen;
  }

  /** The look at one topic: plan, and either write now, wait for the instant the plan names, or do nothing. */
  function look(key: SessionKey): void {
    const runtime = getRuntime(keyToString(key));
    dropTimer(runtime);
    if (checkIsRefused(key)) return;
    if (!checkIsBootGateOpen()) {
      runtime.timer = setTimer(() => {
        runtime.timer = null;
        look(key);
      }, backlogPollMs);
      return;
    }
    const view = observeTopic(key);
    if (view === null) {
      noteProbeSilent(key);
      return;
    }
    const plan = planRename(view, runtime);
    if (plan.kind === 'none') {
      runtime.isOwnerChangePending = false;
      noteProbeSilent(key);
      return;
    }
    if (plan.kind === 'at') {
      runtime.timer = setTimer(() => {
        runtime.timer = null;
        look(key);
      }, Math.max(0, plan.atMs - getNowMs()));
      return;
    }
    // The state may have moved while the call was in flight: look again after a name WAS written. A failure a later try may fix is tried
    // again after a backoff (the latest wanted name, not a stale one); a refused right is the sweep's probe's business.
    void writeDesiredName(key).then(({ outcome, error }) => {
      if (outcome === 'written') look(key);
      else if (outcome === 'failed') scheduleRetry(key, runtime, error);
    });
  }

  /**
   * @description Look at `key`'s topic: its status or its counts may have changed. Cheap and safe to call at every change signal — a
   * burst of calls in one tick is one look. `isOwnerChange`: the owner just changed what is shown, which skips the gap between
   * two renames. A key that cannot carry a mark, and a topic whose own name the bot does not know, are left alone.
   */
  function requestRefresh(key: SessionKey, options: { isOwnerChange?: boolean } = {}): void {
    if (!checkIsMarkableTopic(key) || checkIsUnbinding(key)) return;
    const runtime = getRuntime(keyToString(key));
    if (options.isOwnerChange === true) {
      runtime.isOwnerChangePending = true;
      runtime.unkept = null;
    }
    if (runtime.isLookQueued) return;
    runtime.isLookQueued = true;
    setImmediate(() => {
      runtime.isLookQueued = false;
      look(key);
    });
  }

  /** @description Look at every bound topic. */
  function refreshAll(options: { isOwnerChange?: boolean } = {}): void {
    for (const { key } of getState().listBindings()) requestRefresh(key, options);
  }

  /**
   * @description The bot's own «renamed the topic» service line came back as an update, carrying `storedName` — what Telegram stored for
   * the ask ({@link judgeOwnRenameLine}). Delete it, so the topic shows no trace of a status change. Best effort — without the right to delete the renames still happen and the lines stay (the picker says so); a line
   * that is already gone is fine, and any other failure (a reset, a 429 after its retry) is logged once and says nothing about the right.
   */
  async function handleOwnRenameLine(key: SessionKey, messageId: number, storedName: string): Promise<void> {
    judgeOwnRenameLine(key, storedName);
    try {
      await deleteMessage(key, messageId);
    } catch (error) {
      if (checkIsMessageNotFoundError(error)) return;
      if (!checkIsMessageDeletionRefusedError(error)) {
        const description = checkIsApiError(error) ? getErrorDescription(error) : error instanceof Error ? error.message : String(error);
        logFailureOnce(key, getRuntime(keyToString(key)), `deleting the «renamed the topic» line failed: ${description}`);
        return;
      }
      const chatId = getTelegramChatId(key);
      lineDeletionRefusedChats.add(chatId);
      if (!loggedRefusedChats.has(`delete:${chatId}`)) {
        loggedRefusedChats.add(`delete:${chatId}`);
        log(`[topic-indicator] chat ${chatId}: a «renamed the topic» line of the bot stayed (the bot may not delete it) — each status change leaves one in the topic`);
      }
    }
  }

  /**
   * @description Put the owner's own name back at once, whatever the plan says: the topic is leaving the feature (an unbind, a switch
   * turned off for it). Resolves when the name is written or nothing was to be done; never rejects. It is the last write of an unbind: a
   * look queued before it finds the topic unbinding and writes nothing.
   */
  async function restoreBaseName(key: SessionKey): Promise<void> {
    if (!checkIsMarkableTopic(key)) return;
    const runtime = getRuntime(keyToString(key));
    dropTimer(runtime);
    await writeLock.withLock(keyToString(key), async () => {
      const binding = getState().getBinding(key);
      if (!binding || binding.topicName === undefined || (binding.indicatorAppliedName ?? binding.topicName) === binding.topicName) return;
      if (checkIsRefused(key)) return;
      const ask = noteAsk(runtime, binding.topicName);
      try {
        await sendTopicName(key, binding.topicName);
      } catch (error) {
        dropAsk(runtime, ask);
        if (classifyRenameError(key, runtime, error) !== 'noChange') return;
      }
      runtime.lastRenameAtMs = getNowMs();
      runtime.retryNotBeforeMs = null;
      noteAppliedName(runtime, binding.topicName);
      await getState().setBindingTopicNaming(key, { indicatorAppliedName: binding.topicName, indicatorRenameRefused: null }).catch((error) => {
        log(`[topic-indicator] ${keyToString(key)}: saving the restored name failed: ${error instanceof Error ? error.message : error}`);
      });
    });
  }

  /** The topic's marks and its refusal forgotten in memory: its binding is gone. */
  function forgetKeyString(keyString: string): void {
    const runtime = runtimes.get(keyString);
    if (runtime) dropTimer(runtime);
    runtimes.delete(keyString);
    for (const [chatId, refusal] of renameRefusals) {
      refusal.topicKeys.delete(keyString);
      if (refusal.probeKey === keyString) {
        refusal.probeKey = null;
        refusal.isProbeSilent = false;
      }
      if (refusal.topicKeys.size === 0 && refusal.probeKey === null) renameRefusals.delete(chatId);
    }
  }

  /** @description The topic's marks forgotten in memory (its binding is gone): it is never probed again for the right. */
  function forgetTopic(key: SessionKey): void {
    forgetKeyString(keyToString(key));
  }

  /** @description How the marks stand in `key`'s chat, for the picker's hints. */
  function getHealth(key: SessionKey): TopicIndicatorHealth {
    ensureRefusalsLoaded();
    const chatId = getTelegramChatId(key);
    return { isRenameRefused: renameRefusals.has(chatId), isLineDeletionRefused: lineDeletionRefusedChats.has(chatId) };
  }

  /** @description The names the bot wrote to `key`'s topic last, newest first — what the owner may still have been looking at when he saved a name. */
  function getRecentAppliedNames(key: SessionKey): readonly string[] {
    return runtimes.get(keyToString(key))?.recentAppliedNames ?? [];
  }

  /**
   * Let ONE refused topic of each refused chat try again (the probe), the oldest first. A probe the last sweep left without a result —
   * nothing wanted writing, it said nothing about the right — is dropped from the refusal (and from its binding) and the next refused
   * topic is probed instead; the chat is released when no refused topic is left. The deletion refusals are forgotten: the next line tells.
   */
  function chooseRefusalProbes(): void {
    ensureRefusalsLoaded();
    lineDeletionRefusedChats.clear();
    for (const [chatId, refusal] of renameRefusals) {
      if (refusal.probeKey !== null) {
        // The probe has no result yet (its call waits on the send gate, or its name on the settle time): it stays the probe one more round.
        if (!refusal.isProbeSilent) continue;
        const silentProbeKey = tryKeyFromString(refusal.probeKey);
        refusal.probeKey = null;
        refusal.isProbeSilent = false;
        if (silentProbeKey) clearRefusalFlag(silentProbeKey);
      }
      const [probeKey] = refusal.topicKeys;
      if (probeKey === undefined) {
        renameRefusals.delete(chatId);
        continue;
      }
      refusal.topicKeys.delete(probeKey);
      refusal.probeKey = probeKey;
    }
  }

  /** The sweep: a look at every topic, for the changes no event announces; a refused chat is probed with one topic. */
  function armSweep(): void {
    sweepTimer = setTimer(() => {
      const boundKeys = new Set(getState().listBindings().map(({ key }) => keyToString(key)));
      for (const keyString of [...runtimes.keys()]) {
        if (!boundKeys.has(keyString)) forgetKeyString(keyString);
      }
      chooseRefusalProbes();
      refreshAll();
      armSweep();
    }, windows.sweepIntervalMs);
  }

  /** The boot wave: a look at every topic once the boot is over (each look waits for the updates that waited while the bot was down). */
  function startBootWave(): void {
    waveTimer = setTimer(() => {
      waveTimer = null;
      refreshAll();
    }, windows.bootWaveDelayMs);
  }

  /** @description Start the boot wave and the sweep; called once the bot polls. */
  function start(): void {
    bootStartedAtMs = getNowMs();
    startBootWave();
    armSweep();
  }

  /** @description Stop every timer (the bot shuts down). The names stay as they are; the next boot's wave re-syncs them. */
  function stop(): void {
    sweepTimer?.cancel();
    sweepTimer = null;
    waveTimer?.cancel();
    waveTimer = null;
    for (const runtime of runtimes.values()) dropTimer(runtime);
  }

  return { requestRefresh, refreshAll, handleOwnRenameLine, restoreBaseName, forgetTopic, getHealth, getRecentAppliedNames, start, stop };
}

/** @name TopicIndicator @description The refresher `createTopicIndicator` builds. */
export type TopicIndicator = ReturnType<typeof createTopicIndicator>;
