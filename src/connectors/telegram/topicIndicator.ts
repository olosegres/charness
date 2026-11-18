/**
 * The status mark at the END of a topic's name — the part that touches Telegram. `utils/topicIndicatorPlan.ts` decides WHAT the name
 * is and WHEN it may change; this keeps, per topic, what the bot last wrote and since when it works, asks the plan at every change
 * signal, and writes the name — the NAME only, never the topic's icon — through the shared send gate. A topic whose own name the bot
 * does not know is never written. See `README.md` in `commands/` (`/topic_status`) and `docs/commands.md`.
 *
 * Failures never reach the owner as errors: a refused right stops the feature for the chat (one log line per boot, the picker says
 * why), anything else is logged once per distinct cause and tried again at the next change signal or sweep.
 */
import type { SessionKey } from '../../sessionKey';
import { keyToString } from '../../sessionKey';
import { KeyLock, type StateStore } from '../../state';
import { checkIsApiError, getErrorDescription } from '../../sendErrorClassifier';
import {
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
import type { ThreadMessageDeletion } from './commands/botCore';
import { checkIsMissingTopicRightsError } from './commands/topicCommand';

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
  /** The switches in force for the topic (its own set, else the instance's over the defaults). */
  getPrefs: (key: SessionKey) => TopicStatusPrefs;
  /** `editForumTopic` with the NAME alone, through the shared send gate; rejects with Telegram's error. */
  sendTopicName: (key: SessionKey, name: string) => Promise<void>;
  /** Delete a message of the topic: `stayed` when Telegram refused. */
  deleteMessage: (key: SessionKey, messageId: number) => Promise<ThreadMessageDeletion>;
  /** Whether the updates that waited while the bot was down have been handled (the boot wave writes only after). */
  checkIsBacklogHandled: () => boolean;
  windows: TopicIndicatorWindows;
  getNowMs: () => number;
  /** Run `callback` once after `delayMs`; a timer that is only waiting must not keep the process alive. */
  setTimer: (callback: () => void, delayMs: number) => TopicIndicatorTimer;
  log: (line: string) => void;
}

/** How a topic's status mark stands, for the picker's hints. */
export interface TopicIndicatorHealth {
  /** Telegram refused the rename for want of the «Manage topics» right: the marks are off for this chat. */
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
}

/** What the bot knows the topic shows and should show. */
interface TopicView {
  base: string;
  appliedName: string;
  desiredName: string;
  desiredStatus: TopicStatus | null;
}

const noStatusInputs: TopicStatusInputs = { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: false };
const noCounts: TopicIndicatorCounts = { agents: 0, queued: 0 };

/** How often the boot wave looks again whether the waiting updates are handled. */
const backlogPollMs = 500;
/** How long the boot wave waits for them at most. */
const backlogMaxWaitMs = 30_000;

/** Telegram's answer to a rename that changes nothing: the topic already has the name. */
const topicNotModifiedPattern = /TOPIC_NOT_MODIFIED/i;

/**
 * @description Build the status mark of topic names over its ports: the look at a topic (`requestRefresh`), the owner's change of a
 * switch (`requestRefresh(key, { isOwnerChange: true })`), the bot's own «renamed» line (`handleOwnRenameLine`), the name put back
 * (`restoreBaseName`), and the sweep and the boot wave (`start`).
 */
export function createTopicIndicator(ports: TopicIndicatorPorts) {
  const { getState, checkIsMarkableTopic, getPrefs, sendTopicName, deleteMessage, checkIsBacklogHandled, windows, getNowMs, setTimer, log } = ports;
  const runtimes = new Map<string, TopicRuntime>();
  /** One write at a time per topic: the look inside the lock is the latest, so a stale name is never written. */
  const writeLock = new KeyLock();
  const renameRefusedChats = new Set<number>();
  const lineDeletionRefusedChats = new Set<number>();
  /** The chats whose refusal is already logged (one line per boot, however often the sweep tries again). */
  const loggedRefusedChats = new Set<string>();
  let sweepTimer: TopicIndicatorTimer | null = null;
  let waveTimer: TopicIndicatorTimer | null = null;

  function getRuntime(keyString: string): TopicRuntime {
    let runtime = runtimes.get(keyString);
    if (!runtime) {
      runtime = { timer: null, isLookQueued: false, lastRenameAtMs: null, heldName: null, heldSinceMs: 0, isOwnerChangePending: false, lastLoggedFailure: null };
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
    if (!checkIsMarkableTopic(key)) return null;
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
    const inputs: IndicatorRenameInputs = {
      desiredName: view.desiredName,
      desiredStatus: view.desiredStatus,
      appliedName: view.appliedName,
      heldSinceMs: runtime.heldSinceMs,
      lastRenameAtMs: runtime.lastRenameAtMs,
      isOwnerChange: runtime.isOwnerChangePending,
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

  /** What a refused rename means: the right is missing → off for the chat (one line per boot); the name already is the one → fine; else a failure to log. */
  function handleRenameError(key: SessionKey, runtime: TopicRuntime, error: unknown): 'noChange' | 'failed' {
    if (checkIsMissingTopicRightsError(error)) {
      const chatId = getTelegramChatId(key);
      renameRefusedChats.add(chatId);
      if (!loggedRefusedChats.has(`rename:${chatId}`)) {
        loggedRefusedChats.add(`rename:${chatId}`);
        log(`[topic-indicator] chat ${chatId}: the bot may not rename topics (needs the «Manage topics» admin right) — no status marks there until it does`);
      }
      return 'failed';
    }
    const description = checkIsApiError(error) ? getErrorDescription(error) : error instanceof Error ? error.message : String(error);
    if (topicNotModifiedPattern.test(description)) return 'noChange';
    logFailureOnce(key, runtime, `renaming the topic failed: ${description}`);
    return 'failed';
  }

  /** Write the name the topic should show now, if the plan still says so inside the lock. Resolves whether a name was written. */
  async function writeDesiredName(key: SessionKey): Promise<boolean> {
    return writeLock.withLock(keyToString(key), async () => {
      const chatId = getTelegramChatId(key);
      if (renameRefusedChats.has(chatId)) return false;
      const view = observeTopic(key);
      if (view === null) return false;
      const runtime = getRuntime(keyToString(key));
      if (planRename(view, runtime).kind !== 'now') return false;
      try {
        await sendTopicName(key, view.desiredName);
      } catch (error) {
        if (handleRenameError(key, runtime, error) === 'failed') return false;
      }
      runtime.lastRenameAtMs = getNowMs();
      runtime.isOwnerChangePending = false;
      runtime.lastLoggedFailure = null;
      await getState().setBindingTopicNaming(key, { indicatorAppliedName: view.desiredName }).catch((error) => {
        log(`[topic-indicator] ${keyToString(key)}: saving the applied name failed: ${error instanceof Error ? error.message : error}`);
      });
      return true;
    });
  }

  /** The look at one topic: plan, and either write now, wait for the instant the plan names, or do nothing. */
  function look(key: SessionKey): void {
    const runtime = getRuntime(keyToString(key));
    dropTimer(runtime);
    if (renameRefusedChats.has(getTelegramChatId(key))) return;
    const view = observeTopic(key);
    if (view === null) return;
    const plan = planRename(view, runtime);
    if (plan.kind === 'none') {
      runtime.isOwnerChangePending = false;
      return;
    }
    if (plan.kind === 'at') {
      runtime.timer = setTimer(() => {
        runtime.timer = null;
        look(key);
      }, Math.max(0, plan.atMs - getNowMs()));
      return;
    }
    // The state may have moved while the call was in flight: look again — only after a name WAS written, or a failure would loop.
    void writeDesiredName(key).then((isWritten) => {
      if (isWritten) look(key);
    });
  }

  /**
   * @description Look at `key`'s topic: its status or its counts may have changed. Cheap and safe to call at every change signal — a
   * burst of calls in one tick is one look. `isOwnerChange`: the owner just changed what is shown, which skips the gap between
   * two renames. A key that cannot carry a mark, and a topic whose own name the bot does not know, are left alone.
   */
  function requestRefresh(key: SessionKey, options: { isOwnerChange?: boolean } = {}): void {
    if (!checkIsMarkableTopic(key)) return;
    const runtime = getRuntime(keyToString(key));
    if (options.isOwnerChange === true) runtime.isOwnerChangePending = true;
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
   * @description The bot's own «renamed the topic» service line came back as an update: delete it, so the topic shows no trace of a
   * status change. Best effort — without the right to delete the renames still happen and the lines stay (the picker says so).
   */
  async function handleOwnRenameLine(key: SessionKey, messageId: number): Promise<void> {
    const outcome = await deleteMessage(key, messageId);
    if (outcome !== 'stayed') return;
    const chatId = getTelegramChatId(key);
    lineDeletionRefusedChats.add(chatId);
    if (!loggedRefusedChats.has(`delete:${chatId}`)) {
      loggedRefusedChats.add(`delete:${chatId}`);
      log(`[topic-indicator] chat ${chatId}: a «renamed the topic» line of the bot stayed (the bot may not delete it) — each status change leaves one in the topic`);
    }
  }

  /**
   * @description Put the owner's own name back at once, whatever the plan says: the topic is leaving the feature (an unbind, a switch
   * turned off for it). Resolves when the name is written or nothing was to be done; never rejects.
   */
  async function restoreBaseName(key: SessionKey): Promise<void> {
    if (!checkIsMarkableTopic(key)) return;
    const runtime = getRuntime(keyToString(key));
    dropTimer(runtime);
    await writeLock.withLock(keyToString(key), async () => {
      const binding = getState().getBinding(key);
      if (!binding || binding.topicName === undefined || (binding.indicatorAppliedName ?? binding.topicName) === binding.topicName) return;
      if (renameRefusedChats.has(getTelegramChatId(key))) return;
      try {
        await sendTopicName(key, binding.topicName);
      } catch (error) {
        if (handleRenameError(key, runtime, error) === 'failed') return;
      }
      runtime.lastRenameAtMs = getNowMs();
      await getState().setBindingTopicNaming(key, { indicatorAppliedName: binding.topicName }).catch((error) => {
        log(`[topic-indicator] ${keyToString(key)}: saving the restored name failed: ${error instanceof Error ? error.message : error}`);
      });
    });
  }

  /** The topic's marks forgotten in memory (its binding is gone). */
  function forgetTopic(key: SessionKey): void {
    const keyString = keyToString(key);
    const runtime = runtimes.get(keyString);
    if (runtime) dropTimer(runtime);
    runtimes.delete(keyString);
  }

  /** @description How the marks stand in `key`'s chat, for the picker's hints. */
  function getHealth(key: SessionKey): TopicIndicatorHealth {
    const chatId = getTelegramChatId(key);
    return { isRenameRefused: renameRefusedChats.has(chatId), isLineDeletionRefused: lineDeletionRefusedChats.has(chatId) };
  }

  /** The sweep: a look at every topic, for the changes no event announces; a refused right is tried once more. */
  function armSweep(): void {
    sweepTimer = setTimer(() => {
      renameRefusedChats.clear();
      const boundKeys = new Set(getState().listBindings().map(({ key }) => keyToString(key)));
      for (const [keyString, runtime] of runtimes) {
        if (boundKeys.has(keyString)) continue;
        dropTimer(runtime);
        runtimes.delete(keyString);
      }
      refreshAll();
      armSweep();
    }, windows.sweepIntervalMs);
  }

  /** The boot wave: once the updates that waited are handled (an owner's rename made meanwhile is learned first), look at every topic. */
  function startBootWave(): void {
    const startedAtMs = getNowMs();
    const wave = (): void => {
      if (!checkIsBacklogHandled() && getNowMs() - startedAtMs < backlogMaxWaitMs) {
        waveTimer = setTimer(wave, backlogPollMs);
        return;
      }
      waveTimer = null;
      refreshAll();
    };
    waveTimer = setTimer(wave, windows.bootWaveDelayMs);
  }

  /** @description Start the boot wave and the sweep; called once the bot polls. */
  function start(): void {
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

  return { requestRefresh, refreshAll, handleOwnRenameLine, restoreBaseName, forgetTopic, getHealth, start, stop };
}

/** @name TopicIndicator @description The refresher `createTopicIndicator` builds. */
export type TopicIndicator = ReturnType<typeof createTopicIndicator>;
