import { keyToString, type SessionKey } from '../sessionKey';
import type { RequestLedger } from './requestLedger';
import { checkIsHeldBetweenTurns, pickRequestToArmUnder, type RequestScheduleWait } from './scheduleWait';
import type { OpenRequestState, RequestAlertReason, RequestAnswerKind, RequestWakeUpReason } from './types';
import { getPromptNotTakenIn, getWakeUpMessage, type WakeUpMessage } from './requestHeader';
import {
  addAnswerTailOutput,
  answerTailMaxReminders,
  buildAnswerTailReminder,
  createAnswerTail,
  decideAnswerTail,
  type AnswerTail,
} from './answerTail';
import {
  checkIsPromptNeverWritten,
  checkIsTurnInputConsumed,
  checkIsHeldByOwnWork,
  checkIsWakingStopped,
  checkIsWatchedTurnStale,
  decideRestartWake,
  decideTurnEnd,
  decideUnwatchedRequest,
  getPostRetryUpdate,
  getWatchedTurnState,
  type SessionTurnProbe,
  type WakeUpDecision,
  type WakeUpRuleSet,
  type WatchedTurn,
} from './wakeUpRules';

/**
 * @description The wake-up engine of the request/answer core (S4): it watches
 * the turn each request (or reminder) started until that turn ends — one watch
 * per REQUEST, so two requesters' open requests in one conversation are each
 * followed to their own turn end (`requestGroup.ts`) — and runs a
 * slower sweep over the open requests nobody is watching (the 15-minute
 * follow-up after a progress note, and the backstop). Every decision is made by
 * `wakeUpRules.ts`; this module only observes, persists and acts. The same sweep
 * follows the agent's text after a final answer in a view that hides the stream
 * (`answerTail.ts`), and reminds the agent once when that text is worth it.
 *
 * No adapter emits a turn-end event, so turns are POLLED through the injected
 * `probeTurn` (the precedent is the deferred-compaction poll). The watch state is
 * in memory: after a restart the persisted request times drive the sweep, and the
 * backstop covers a turn whose tracking was lost.
 *
 * A wake-up is a reminder forwarded into the SAME session — never a request.
 * The answer tails are in memory as well: a restart forgets them.
 *
 * A request waits for its schedule while a job armed under it counts (`scheduleWait.ts`, read through the optional
 * `getScheduleWait` port at every decision): the rules then neither prod it nor wake it at a restart, and a turn a scheduler
 * fire started (`isScheduledRun`) that ends without an answer is not silence. A request that owes a person an answer
 * (`checkIsAnswerOwed`) is never held: it is read from the persisted request, so a turn whose watch a restart lost still reaches the
 * backstop. The complete table is `README.md` § Wake-ups.
 */

/** How often a watched turn is polled for its end. */
export const watchedTurnPollMs = 10_000;
/** How often the unwatched open requests are swept (follow-ups, backstop). */
export const unwatchedSweepMs = 60_000;
/** A live turn's activity is persisted at most this often (it pushes the backstop back). */
export const turnActivityPersistStepMs = 60_000;
/**
 * The gap between two `restarted` wakes, and before the first: a boot that finds several tracker sessions gone does not
 * start their agents in the same second, and a connector's first poll — which opens a fresh request for a hand-over
 * whose post never settled, superseding the old one — has the time to run before anything is woken.
 */
export const restartWakeStaggerMs = 30_000;

/**
 * @name RequestWakeUpEngineDeps
 * @description `prepareWakeUpSession` makes sure the conversation has a live
 * session for `message` (resuming a dead one) and resolves `false` when it could
 * not; `forwardWakeUp` then writes the message into it. They are two steps because
 * a resume takes seconds, and the request may be answered, cancelled or
 * superseded meanwhile — the engine re-checks in between. `deliverAlert` tells a
 * person and resolves the platform's alert handle, `null` when nothing needs
 * releasing later (the ledger stores and releases it). `now` is injectable for tests.
 */
export interface RequestWakeUpEngineDeps {
  ledger: Pick<RequestLedger, 'getOpenRequestById' | 'listOpenRequestsOf' | 'listOpenRequests' | 'updateOpenRequest' | 'closeRequest' | 'recordAlert'>;
  probeTurn: (key: SessionKey) => SessionTurnProbe;
  /**
   * Bring what the bot knows of the conversation's live process up to what it wrote so far, right before
   * {@link RequestWakeUpEngine.readPromptsReachedOrHeld} probes it: the json-stream tail is polled with a backoff, so an echo the
   * process already wrote may not be read yet (review 28, own pass). Absent: the probe is current.
   */
  refreshProcessState?: (key: SessionKey) => void;
  prepareWakeUpSession: (key: SessionKey, message: WakeUpMessage) => Promise<boolean>;
  /** Forward the wake-up's message (the request's prompt again, or a reminder) into the session. */
  forwardWakeUp: (key: SessionKey, request: OpenRequestState, message: WakeUpMessage) => Promise<void>;
  deliverAlert: (key: SessionKey, request: OpenRequestState, reason: RequestAlertReason) => Promise<string | null>;
  backstopMs: number;
  /** How often the unwatched open requests are swept; absent: {@link unwatchedSweepMs} (a test instance shortens it). */
  sweepIntervalMs?: number;
  /** How often the watched turns are polled for their end; absent: {@link watchedTurnPollMs} (a test instance shortens it). */
  pollIntervalMs?: number;
  /** The first retry of a prompt that could not be posted; absent: `postRetryDelaysMs[0]` (a test instance shortens it). */
  firstPostRetryDelayMs?: number;
  /** How long after a progress note the agent is reminded; absent: {@link progressFollowUpDelayMs} (a test instance shortens it). */
  progressFollowUpMs?: number;
  /** The gap between two `restarted` wakes, and before the first; absent: {@link restartWakeStaggerMs} (a test instance shortens it). */
  restartWakeStaggerMs?: number;
  /** A `restarted` wake reached the conversation's session (the bot keeps the stamp its crash-loop guard reads). */
  noteRestartWakeDelivered?: (key: SessionKey) => void;
  /** Whether the conversation's view hides the agent's stream: only then is a final answer's tail followed. Absent: never. */
  checkIsAnswerTailWatched?: (key: SessionKey) => boolean;
  /** Bring the session up (resume only) and forward the answer-tail reminder; `false` when it could not be reached. */
  remindAnswerTail?: (key: SessionKey, text: string) => Promise<boolean>;
  /**
   * What the request's armed jobs say about it (`scheduleWait.ts`), read when a decision is made — never cached. Absent: a
   * request never waits for a schedule.
   */
  getScheduleWait?: (key: SessionKey, request: OpenRequestState) => RequestScheduleWait;
  /** The rule set a conversation's turns end under (`WakeUpRuleSet`: a tracker's has no follow-up on a clock). Absent: a topic's for every conversation. */
  getWakeUpRules?: (key: SessionKey) => WakeUpRuleSet;
  now?: () => number;
}

type WakeUpDeliveryOutcome = 'delivered' | 'failed' | 'requestGone';

interface WatchedRequestTurn extends WatchedTurn {
  key: SessionKey;
  /**
   * The forward that started this watch was THIS request's own (a request prompt, an issue update, a fire riding it, a reminder for
   * it), not one nudge or restart wake that carried several requests at once and watched them all. The request a job is armed under
   * is picked from the own-forward watches first (`pickRequestToArmUnder`): a conversation-wide forward «watches» every open
   * request, which says nothing about the one the agent is working on. A merge keeps `true` if either side was.
   */
  isOwnForward: boolean;
  /**
   * When the own forward that started this watch came (a merge keeps the earlier one; absent without one). The watches present all
   * belong to the session's current busy period — they end with their turn, and every new prompt first settles the watches whose turn
   * already ended (`settleEndedTurnsOf`) — so the OLDEST own-forward watch is the request whose forward started the running turn: what
   * the agent works on, whoever's words or fire joined it later.
   */
  ownForwardStartedAt?: number;
  /**
   * A tracker's watch that saw the agent's own work outlive its turn ({@link noteOwnWorkSeen}): pending at a poll or a settle while no
   * turn runs — a turn end the work held open — or a turn the CLI started by itself (that work woke it). Its end, with nothing of its own
   * pending, is the end of work that ended by itself (`TurnEndContext.ownWork` `ended`), and the CLI's own turns inside it are not the
   * request's activity — however soon the work ended after the turn that started it, before or between the polls. A merge keeps it.
   */
  hasSeenOwnWork?: boolean;
}

interface WatchedAnswerTail {
  key: SessionKey;
  tail: AnswerTail;
}

/**
 * R21's test: the live process the request prompt was written to has taken it in (a process that replaced it — a re-spawn — lists
 * nothing unread, and that is not the prompt read; one never written to any process is not taken in).
 */
function checkIsPromptConsumedByLiveProcess(turn: WatchedTurn, probe: SessionTurnProbe): boolean {
  const isAnotherProcess = turn.writtenToProcess !== undefined && probe.processGeneration !== undefined && turn.writtenToProcess !== probe.processGeneration;
  return turn.isRequestPrompt && probe.isActive && !isAnotherProcess && checkIsTurnInputConsumed(turn, probe);
}

/**
 * Whether a request prompt is in the conversation the agent had at this moment — what an ending command reads to tell a person whose
 * words nobody will read ({@link RequestWakeUpEngine.readPromptsReachedOrHeld}): taken in by the live process it was written to (R21, on
 * the backend's own unread signal — the json-stream Claude's echo, OpenCode's count of the prompts not yet seen as a user message), or,
 * on the one backend with no such signal (the tmux Claude), written to it — it keeps what was typed in its own conversation, where a
 * move's bridge or a later resume reads it, busy or output seen yet or not (review 27 nit 3).
 */
function checkIsPromptTakenInNow(turn: WatchedTurn, probe: SessionTurnProbe): boolean {
  if (probe.hasUnconsumedInput !== null) return checkIsPromptConsumedByLiveProcess(turn, probe);
  return turn.isRequestPrompt && probe.isActive && turn.writtenToProcess !== undefined && turn.writtenToProcess === probe.processGeneration;
}

/** Whether a request prompt waits in a start's or a stop's window (no process named yet): that window's end delivers or drops it. */
function checkIsPromptWaitingInWindow(turn: WatchedTurn, probe: SessionTurnProbe): boolean {
  return turn.isRequestPrompt && turn.writtenToProcess === undefined && probe.isWindowOpen === true;
}

/**
 * Marks a tracker's watch that sees the agent's own work outlive its turn (`WatchedRequestTurn.hasSeenOwnWork`): pending while no turn
 * runs, or a turn the CLI started by itself — that work woke it. Read at every poll AND every settle (the adapter's turn end): a short
 * command that ends, and starts its turn, inside one poll interval is still seen at the turn end it held open, or in the turn it started.
 * Work the agent starts and finishes inside a turn the bot started is not: it woke nothing, and counted, a nudged agent that ran such
 * a check in every turn would restart the stall count for ever and never be given up. Never under a topic's rules.
 */
function noteOwnWorkSeen(turn: WatchedRequestTurn, probe: SessionTurnProbe, rules: WakeUpRuleSet): void {
  if (rules !== 'tracker') return;
  const isOutlivingTurn = probe.hasOwnPendingWork === true && !probe.isBusy;
  if (isOutlivingTurn || (probe.isBusy && probe.isCliOwnTurn === true)) turn.hasSeenOwnWork = true;
}

export class RequestWakeUpEngine {
  private readonly deps: RequestWakeUpEngineDeps;
  private readonly now: () => number;
  /** The watched turns by REQUEST id (a conversation may hold one per requester). */
  private readonly watched = new Map<string, WatchedRequestTurn>();
  /**
   * The process the last prompt written into each conversation went to (serialized key → process), stamped at the write choke point
   * ({@link noteWrite}): a watch tracked after that process went down — a re-spawn takes it down right after a post's write, and the
   * post tracks several awaits later — is named from it, never left unnamed (review 22 nit 2).
   */
  private readonly writtenProcesses = new Map<string, number>();
  /** Last persisted live-turn activity per request id, for the persist step. */
  private readonly activityPersistedAt = new Map<string, number>();
  /** The tail after the latest final answer, by serialized conversation key. */
  private readonly answerTails = new Map<string, WatchedAnswerTail>();
  /** The request whose tail was last reminded and how often, by serialized conversation key (the reminder cap). */
  private readonly answerTailReminders = new Map<string, { requestId: string; count: number }>();
  /** How many posts are on their way to their write, by serialized conversation key ({@link notePostInFlight}). */
  private readonly postsInFlight = new Map<string, number>();
  /** The wake-up deliveries handed to a post in flight, by serialized conversation key, in the order they were decided. */
  private readonly wakesHandedToPost = new Map<string, Array<() => Promise<void>>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private isSweeping = false;
  /** The `restarted` wakes waiting for their turn, by serialized conversation key (one per conversation). */
  private readonly restartWakeTimers = new Map<string, NodeJS.Timeout>();
  /** Conversations whose pending restart wake was asked for by a LOST-WORK loss, not by a boot: no watch holds that one. */
  private readonly lostWorkWakes = new Set<string>();
  /** When the last scheduled `restarted` wake is due: the next one is a stagger after it. */
  private lastRestartWakeDueAt = 0;

  constructor(deps: RequestWakeUpEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * @description Start the poll and sweep timers (unref'd: they never keep the
   * process alive). A rejected tick is logged: unhandled, it would end the whole
   * process (Node's default for an unhandled rejection).
   */
  start(): void {
    this.pollTimer ??= setInterval(() => {
      void this.pollWatchedTurns().catch((e) => logWakeUpFailure('the watched-turn poll', e));
    }, this.deps.pollIntervalMs ?? watchedTurnPollMs);
    this.sweepTimer ??= setInterval(() => {
      void this.sweepUnwatchedRequests().catch((e) => logWakeUpFailure('the open-request sweep', e));
    }, this.deps.sweepIntervalMs ?? unwatchedSweepMs);
    this.pollTimer.unref?.();
    this.sweepTimer.unref?.();
  }

  /** @description Stop the timers (shutdown). The persisted request times survive; a `restarted` wake not yet due is dropped. */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = null;
    this.sweepTimer = null;
    for (const timer of this.restartWakeTimers.values()) clearTimeout(timer);
    this.restartWakeTimers.clear();
    this.lostWorkWakes.clear();
  }

  /**
   * @description The conversation's process is gone while it holds open requests (a boot that did not find it, or a
   * process that died with its own work pending): wake them `restarted`, a stagger after the last wake scheduled so,
   * instead of at the backstop. One wake per conversation at a time — a second call while one waits changes nothing.
   * Whether the requests still need it is decided when it is due (`decideRestartWake`). Returns `false` when one
   * was already waiting, or when every open request is held by a watch that is not failing and owes nobody an answer
   * (`checkIsHeldBetweenTurns`: a BOOT wakes nobody then, as in a topic). `isLostWork` — the process ended with the agent's own work
   * pending — is the other event: a topic resumes on it whatever is armed, so no watch holds the wake, and a boot wake already
   * waiting becomes one (the flag is remembered, the call still returns `false`). The timer is unref'd: it never keeps the process alive.
   */
  scheduleRestartWake(key: SessionKey, options: { isLostWork?: boolean } = {}): boolean {
    const conversationKey = keyToString(key);
    const isLostWork = options.isLostWork === true;
    if (this.restartWakeTimers.has(conversationKey)) {
      if (isLostWork) this.lostWorkWakes.add(conversationKey);
      return false;
    }
    // Every open request is held by a watch that is not failing and owes nobody an answer: nobody is woken at a boot, and no stagger slot is spent on it.
    const openRequests = this.deps.ledger.listOpenRequestsOf(key);
    if (!isLostWork && openRequests.length > 0 && openRequests.every((request) => checkIsHeldBetweenTurns(request, this.getScheduleWait(key, request)))) return false;
    if (isLostWork) this.lostWorkWakes.add(conversationKey);
    const staggerMs = this.deps.restartWakeStaggerMs ?? restartWakeStaggerMs;
    const dueAt = Math.max(this.now(), this.lastRestartWakeDueAt) + staggerMs;
    this.lastRestartWakeDueAt = dueAt;
    const timer = setTimeout(() => {
      this.restartWakeTimers.delete(conversationKey);
      const isLostWorkWake = this.lostWorkWakes.delete(conversationKey);
      void this.wakeAfterRestart(key, { isLostWork: isLostWorkWake }).catch((e) => logWakeUpFailure(`the restart wake of ${conversationKey}`, e));
    }, dueAt - this.now());
    timer.unref?.();
    this.restartWakeTimers.set(conversationKey, timer);
    return true;
  }

  /**
   * @description The `restarted` wake of `key`'s conversation, now: every open request nobody watches that the rule
   * lets be woken gets its wake-up counted, and ONE forward carries them all — the prompt of each request the session
   * never took in (R21), else its reminder — so one resumed session turn is watched for every one of them, as a
   * continuation nudge's turn is. A request at the cap gets its alert instead. A delivery that fails is logged and
   * left to the backstop (counted from now): no alert of its own. Exported for tests (the timer calls it).
   */
  async wakeAfterRestart(key: SessionKey, options: { isLostWork?: boolean } = {}): Promise<void> {
    const probe = this.deps.probeTurn(key);
    const nowMs = this.now();
    const woken: OpenRequestState[] = [];
    for (const request of this.deps.ledger.listOpenRequestsOf(key)) {
      if (this.watched.has(request.id)) continue;
      const decision = decideRestartWake(request, probe, nowMs, this.getScheduleWait(key, request), options.isLostWork === true);
      if (decision.kind === 'alert') {
        await this.applyDecision(key, request, decision);
        continue;
      }
      if (decision.kind !== 'wake') continue;
      let isStoppedMeanwhile = false;
      const updated = await this.deps.ledger.updateOpenRequest(request.id, (current) => {
        isStoppedMeanwhile = checkIsWakingStopped(current);
        return isStoppedMeanwhile ? {} : decision.update;
      });
      if (updated && !isStoppedMeanwhile) woken.push(updated);
    }
    if (woken.length === 0) {
      // The bot already said the conversation is woken for its lost work: when no request could be, say so (each skip is a decision of
      // `decideRestartWake`: a request given up on, at the cap, with a post retry or a follow-up that can still fire, busy or blocked).
      if (options.isLostWork === true) console.warn(`[requests] ${keyToString(key)}: the lost-work wake woke no request; the note rides the next prompt`);
      return;
    }
    // A lost-work wake of a request a passing watch holds and that owes nobody: the agent is asked to answer only with what the requester
    // must know (the fire header's wording). Every other request — a boot's, one that owes an answer — gets the plain «answer it».
    const isAnswerOptional = (request: OpenRequestState): boolean =>
      options.isLostWork === true && checkIsHeldBetweenTurns(request, this.getScheduleWait(key, request));
    const buildMessage = (requests: readonly OpenRequestState[]): WakeUpMessage => {
      const messages = requests.map((request) => getWakeUpMessage(request, 'restarted', { isAnswerOptional: isAnswerOptional(request) }));
      return {
        reason: 'restarted',
        text: messages.map((message) => message.text).join('\n\n'),
        isRequestPrompt: messages.some((message) => message.isRequestPrompt),
        // The one lost-work note rides the whole forward: optional only when EVERY request in it is.
        ...(messages.every((message) => message.isAnswerOptional === true) ? { isAnswerOptional: true } : {}),
      };
    };
    try {
      if (!(await this.deps.prepareWakeUpSession(key, buildMessage(woken)))) {
        console.warn(`[requests] the restart wake of ${keyToString(key)} could not reach a session; the backstop takes it`);
        return;
      }
      // The resume took a while: only what is still open and wakeable is forwarded.
      const current = woken
        .map((request) => this.getOpenRequestOf(key, request.id))
        .filter((request): request is OpenRequestState => request !== undefined && !checkIsWakingStopped(request));
      if (current.length === 0) return;
      await this.deps.forwardWakeUp(key, current[0], buildMessage(current));
      this.deps.noteRestartWakeDelivered?.(key);
      console.log(`[requests] ${keyToString(key)}: woken after a restart for ${current.map((request) => request.id).join(', ')}`);
      for (const request of current) {
        await this.trackForwardedTurn(key, request.id, {
          isRequestPrompt: getWakeUpMessage(request, 'restarted').isRequestPrompt,
          isConversationForward: current.length > 1,
        });
      }
    } catch (e) {
      logWakeUpFailure(`delivering the restart wake for ${keyToString(key)}`, e);
    }
  }

  /** The open request `requestId` when it belongs to `key`'s conversation, else `undefined`. */
  private getOpenRequestOf(key: SessionKey, requestId: string): OpenRequestState | undefined {
    const entry = this.deps.ledger.getOpenRequestById(requestId);
    return entry && keyToString(entry.key) === keyToString(key) ? entry.request : undefined;
  }

  /** The ids of the requests whose turns the engine watches in `key`'s conversation: the requests the agent is working on right now. */
  getWatchedRequestIdsOf(key: SessionKey): string[] {
    return this.getWatchedTurnsOf(key).map((turn) => turn.requestId);
  }

  /**
   * The watched requests of `key`'s conversation whose watch a forward of their OWN started (not a conversation-wide nudge), the
   * oldest own forward first: the first is the request whose forward started the running turn.
   */
  getOwnForwardWatchedRequestIdsOf(key: SessionKey): string[] {
    return this.getWatchedTurnsOf(key)
      .filter((turn) => turn.isOwnForward)
      .sort((first, second) => (first.ownForwardStartedAt ?? 0) - (second.ownForwardStartedAt ?? 0))
      .map((turn) => turn.requestId);
  }

  /**
   * @description The request a job armed NOW in `key`'s conversation is armed under (`pickRequestToArmUnder` over the ledger's open
   * requests and this engine's watches); `undefined` when no request is open.
   */
  getArmingRequestIdOf(key: SessionKey): string | undefined {
    return pickRequestToArmUnder(this.deps.ledger.listOpenRequestsOf(key), this.getWatchedRequestIdsOf(key), this.getOwnForwardWatchedRequestIdsOf(key));
  }

  /** The watched turns of `key`'s conversation. */
  private getWatchedTurnsOf(key: SessionKey): WatchedRequestTurn[] {
    const conversationKey = keyToString(key);
    return [...this.watched.values()].filter((turn) => keyToString(turn.key) === conversationKey);
  }

  /**
   * @description A request's message (or a reminder for it) was just forwarded to
   * the conversation's session: watch the turn it starts. A watch already there
   * for the SAME request is MERGED with it (the forward joined a turn that still runs: one that ended was settled before the write,
   * `settleEndedTurnsOf`): the progress count keeps
   * its earlier start, and the turn is the alarm's only if both were — except for the bot's own «continue»
   * (`isContinuation`: the nudge after an API error or a limit wait), which keeps the alarm's kind but
   * starts the progress count afresh: a note sent before the error is not this turn's — and for a person's
   * words that join the running turn, which start the count afresh too: a note sent before them is not their answer. Another requester's
   * request in the conversation keeps its own watch. Whether the turn is a scheduled run's (`isScheduledRun`) is said by the FORWARD
   * that started it — a fire riding the request, or the fire that opened the scheduler's request — and never read from the request's
   * state: an answered request's fire turn is a fire's as much as an unanswered one's (`src/requests/README.md` § Scheduled runs).
   * A fire of ANOTHER job that only rides the request (`isRequestJob` false) is not the request's activity: its forward records none,
   * and its watch keeps that (a merge is the request's own if either side is; a «continue» keeps what the turn was), so its busy time and
   * its quiet end leave the request's follow-up and backstop alone (`src/requests/README.md` § Scheduled runs).
   * A post retry still pending is moot from now on (R28): the session has the request — unless the forward is a fire riding the
   * request, which carries none of its prompt. A forward that carries a person's words (a request prompt, an issue update) marks the
   * request as owing an answer (`isPersonInputUnanswered`, persisted): that, not the kind of the turn, is
   * what stops the turn's end from reading as a quiet one (`decideTurnEnd`).
   */
  async trackForwardedTurn(
    key: SessionKey,
    requestId: string,
    options: { isRequestPrompt: boolean; isScheduledRun?: boolean; isRequestJob?: boolean; isPersonInput?: boolean; isContinuation?: boolean; isConversationForward?: boolean } = { isRequestPrompt: false },
  ): Promise<void> {
    const request = this.getOpenRequestOf(key, requestId);
    if (!request) return;
    // The agent works on an open request now: what it writes is owed to that one, not a tail.
    this.answerTails.delete(keyToString(key));
    const previous = this.watched.get(requestId);
    const isFireForward = options.isScheduledRun === true;
    // The scheduler's request (a Telegram topic's `scheduledRun`) is no person's: its prompt carries no person's words.
    const isSchedulerRequest = request.origin.kind === 'scheduledRun';
    const carriesPersonWords = options.isRequestPrompt || options.isPersonInput === true;
    // A person's words that reach the agent — not a fire's prompt, not the scheduler's request's.
    const isPersonWordsForward = carriesPersonWords && !isFireForward && !isSchedulerRequest;
    const isOwnForward = options.isConversationForward !== true || previous?.isOwnForward === true;
    const ownForwardStartedAt = previous?.ownForwardStartedAt ?? (isOwnForward ? this.now() : undefined);
    // A fire's turn stays one through a fire that joins it and through the bot's «continue»; a person's words or a reminder that joined
    // it make it theirs.
    const isScheduledRun = previous === undefined
      ? isFireForward
      : previous.isScheduledRun === true && (isFireForward || (options.isContinuation === true && !isPersonWordsForward));
    // Whose turn it is: another job's fire says «not the request's own», a «continue» says nothing (it continues the turn it joins), any
    // other forward — a person's words, a reminder, the request's own job's fire — is the request's own.
    const isOtherJobFireForward = isFireForward && options.isRequestJob === false;
    const isForwardOwn = options.isContinuation === true && !isPersonWordsForward ? undefined : !isOtherJobFireForward;
    const isRequestJob = previous === undefined ? isForwardOwn !== false : previous.isRequestJob !== false || isForwardOwn === true;
    // Where the request's prompt now is: a forward that carries it was written to the live process (none named while a window holds it
    // in the buffer, for its replay to name); one that does not carry it leaves the prompt where it was. A process that went down since
    // the write — no live one, and no window — is the one the write stamped.
    const probe = this.deps.probeTurn(key);
    const writtenNow = probe.processGeneration ?? (probe.isWindowOpen === true ? undefined : this.writtenProcesses.get(keyToString(key)));
    const writtenToProcess = previous === undefined || options.isRequestPrompt ? writtenNow : previous.writtenToProcess;
    this.watched.set(requestId, {
      key,
      requestId,
      // The progress count starts afresh at a «continue» and at words that join a turn already running: a note sent before them is
      // not their answer (it would end the turn as a «progress» one — quiet under a watch, and the words left to the 90-minute backstop).
      progressCountAtTurnStart: options.isContinuation === true || (previous !== undefined && isPersonWordsForward)
        ? request.progressAnswerCount
        : (previous?.progressCountAtTurnStart ?? request.progressAnswerCount),
      hasSeenBusy: false,
      hasSeenOutput: false,
      isRequestPrompt: options.isRequestPrompt || previous?.isRequestPrompt === true,
      isScheduledRun,
      isRequestJob,
      isOwnForward,
      ...(ownForwardStartedAt === undefined ? {} : { ownForwardStartedAt }),
      ...(previous?.hasSeenOwnWork === true ? { hasSeenOwnWork: true } : {}),
      ...(writtenToProcess === undefined ? {} : { writtenToProcess }),
    });
    // A fire RIDING the request carries none of its prompt; the fire that opened the scheduler's request carries its own.
    const isMoot = request.nextPostRetryAt !== undefined && (!isFireForward || options.isRequestPrompt);
    const isPersonWordsOwed = isPersonWordsForward && request.isPersonInputUnanswered !== true;
    // A person's words start a tracker request's stall count again: the turn they start is a new chance, nudged on its own if it stalls.
    const isStallCountReset = isPersonWordsForward && (request.stalledTurnCount ?? 0) > 0;
    if (isMoot || isPersonWordsOwed || isStallCountReset) {
      await this.deps.ledger.updateOpenRequest(request.id, {
        ...(isMoot ? { nextPostRetryAt: undefined } : {}),
        ...(isPersonWordsOwed ? { isPersonInputUnanswered: true } : {}),
        ...(isStallCountReset ? { stalledTurnCount: undefined } : {}),
      });
    }
    // Keyed on the watch just stored, so a fire of another job AND a «continue» of its turn alike write nothing on the request.
    if (isRequestJob) await this.recordTurnActivity(request, true);
  }

  /**
   * @description A person's words for the request were HELD — an armed usage-limit wait keeps them back, and they reach the agent
   * only inside whatever prompt the wait's end forwards first (a «continue», a scheduled run, the operator's next message). No
   * turn starts for them now, so nothing is tracked, but the request owes an answer from this moment: persisted, so the turn
   * that finally carries the words — under any watch, or none after a restart during the wait — is read against it
   * (`checkIsAnswerOwed`). A request that owes it already, and a scheduler fire's own request, are left as they are.
   */
  async notePersonInputHeld(key: SessionKey, requestId: string): Promise<void> {
    const request = this.getOpenRequestOf(key, requestId);
    if (!request || request.isPersonInputUnanswered === true || request.origin.kind === 'scheduledRun') return;
    await this.deps.ledger.updateOpenRequest(request.id, { isPersonInputUnanswered: true });
  }

  /**
   * @description The request's prompt could not be posted to the session (no
   * session came up, the forward failed): try again soon (R28). Once the retries
   * are spent nothing is scheduled — the backstop and its alert take over. Never
   * rejects: its caller is a post that already failed.
   */
  async notePostFailed(key: SessionKey, requestId: string): Promise<void> {
    const request = this.getOpenRequestOf(key, requestId);
    if (!request) return;
    const retry = getPostRetryUpdate(request, this.now(), this.deps.firstPostRetryDelayMs);
    if (!retry) return;
    try {
      await this.deps.ledger.updateOpenRequest(request.id, retry);
    } catch (e) {
      logWakeUpFailure(`scheduling a post retry of ${request.id}`, e);
    }
  }

  /** @description The agent produced output in this conversation (a turn is under way). */
  noteAgentOutput(key: SessionKey): void {
    for (const turn of this.getWatchedTurnsOf(key)) turn.hasSeenOutput = true;
  }

  /**
   * @description An answer to `requestId` was delivered. Any answer ends the
   * tail of the one before: the agent spoke to the requester. A final answer
   * starts a fresh tail where the view hides the stream, unless its request
   * already had all its reminders.
   */
  noteAnswerDelivered(key: SessionKey, requestId: string, kind: RequestAnswerKind): void {
    const conversationKey = keyToString(key);
    this.answerTails.delete(conversationKey);
    if (kind !== 'final') return;
    const reminded = this.answerTailReminders.get(conversationKey);
    if (reminded?.requestId === requestId && reminded.count >= answerTailMaxReminders) return;
    if (this.deps.checkIsAnswerTailWatched?.(key) !== true) return;
    this.answerTails.set(conversationKey, { key, tail: createAnswerTail(requestId, this.now()) });
  }

  /** @description Whether the agent's text after a final answer is being followed in this conversation. */
  checkIsAnswerTailFollowed(key: SessionKey): boolean {
    return this.answerTails.has(keyToString(key));
  }

  /** @description The agent wrote text of its own in this conversation (not a sub-agent's, not a block the bot made). */
  noteAnswerTailOutput(key: SessionKey): void {
    const entry = this.answerTails.get(keyToString(key));
    if (entry) entry.tail = addAnswerTailOutput(entry.tail, this.now());
  }

  /** Drop every watch of `key`'s conversation, its answer tail included. */
  private unwatchConversation(key: SessionKey): void {
    for (const turn of this.getWatchedTurnsOf(key)) this.watched.delete(turn.requestId);
    this.answerTails.delete(keyToString(key));
  }

  /**
   * @description The requests of `key` whose prompt is NOT lost if the conversation ends now, read off its live process at this moment:
   * a prompt the process took in — R21's own test ({@link checkIsPromptTakenInNow}) on a probe taken now, once what the process wrote so
   * far is read (`refreshProcessState`), which the persisted mark lags behind until a settle or the 10-second poll (review 26 #1) — and a
   * prompt still waiting in a start's or a stop's window, whose window's drop tells its person. Synchronous: a command reads it BEFORE it
   * stops or replaces the process (the default of {@link cancelConversation}; the `/resume` pick ahead of its resume).
   */
  readPromptsReachedOrHeld(key: SessionKey): ReadonlySet<string> {
    // What the process already wrote counts: a switch moments after a message, before the poll read its echo, told its person the
    // agent never read it while the bridge carried it.
    this.deps.refreshProcessState?.(key);
    const probe = this.deps.probeTurn(key);
    const requestIds = new Set<string>();
    for (const turn of this.getWatchedTurnsOf(key)) {
      if (checkIsPromptTakenInNow(turn, probe) || checkIsPromptWaitingInWindow(turn, probe)) requestIds.add(turn.requestId);
    }
    return requestIds;
  }

  /**
   * @description The person took over (interrupted, quit, restarted, switched or
   * resumed the session, left the folder): every open request of the
   * conversation closes and nothing wakes them. Resolves the ids of the requests
   * this call closed that carry a person's words the agent never took in (not the
   * scheduler's request, whose prompt is no person's): a command that ends or replaces the
   * conversation tells those people, since nobody reads their words (review 25 #3, review 26 #2);
   * an interrupt closes silently. «Never taken in» reads the persisted mark and `reachedOrHeld`
   * ({@link readPromptsReachedOrHeld}), read by default when this is called — synchronously, before
   * the first await, so off the process the command has not stopped yet.
   */
  async cancelConversation(key: SessionKey, reachedOrHeld: ReadonlySet<string> = this.readPromptsReachedOrHeld(key)): Promise<string[]> {
    this.unwatchConversation(key);
    // The conversation's writes end with it: its next watch is named from a write of the next conversation (review 23 nit 6).
    this.writtenProcesses.delete(keyToString(key));
    const unreadRequestIds: string[] = [];
    for (const request of this.deps.ledger.listOpenRequestsOf(key)) {
      const isUnreadPersonWords = request.origin.kind !== 'scheduledRun' && getPromptNotTakenIn(request) !== undefined && !reachedOrHeld.has(request.id);
      // Named only when THIS close closed it: one another path closed meanwhile is that path's to tell.
      const closed = await this.deps.ledger.closeRequest(request.id, 'cancelled');
      if (closed !== null && isUnreadPersonWords) unreadRequestIds.push(request.id);
    }
    return unreadRequestIds;
  }

  /**
   * @description The bot itself forwarded a "continue" nudge into the session (an
   * API-error retry fired, or a usage-limit wait ended): watch the turn it starts, so the idle the
   * error left behind is never read as its end. The nudge carries no person's words and is no alarm,
   * so it KEEPS the alarm's kind of the turn it continues but its progress count starts afresh: a progress
   * note sent before the error does not make a silent continuation a «progress» turn. What the turn owes a
   * person is not its kind but the persisted request (`checkIsAnswerOwed`): words answered before the error
   * are owed no more, words still unanswered stay owed.
   * `isCountersReset` (the end of a limit wait) starts every open request's
   * wake-up bookkeeping from zero — the wait was not the agent's silence — and
   * lifts a limit stop: the work continues, so does the waking. A request the
   * rules already gave up on stays given up. The one session turn the nudge
   * starts is watched for every open request of the conversation.
   * `carriedRequestIds` — the requests whose prompts the message carries, never taken in (R21: a limit or account resume re-posts
   * them) — is a fact about EACH request, named when the message was BUILT (`getPromptsNotTakenIn`): only such a request has its words
   * in the message (they are owed an answer, as any request prompt's), every other open request gets the plain «continue». It is
   * never read again here: a buffered message is tracked at its replay, and a request opened in between did not ride it (review 21
   * nit 3). A carried request whose prompt the session took in meanwhile is a plain «continue» too.
   */
  async trackContinuationTurn(key: SessionKey, options: { isCountersReset: boolean; carriedRequestIds?: readonly string[] }): Promise<void> {
    for (const request of this.deps.ledger.listOpenRequestsOf(key)) {
      // Read before the counters update below: it never touches `isPromptTakenIn`, but the request's words are what is asked here.
      const isOwnPromptCarried = options.carriedRequestIds?.includes(request.id) === true && getPromptNotTakenIn(request) !== undefined;
      if (options.isCountersReset) {
        await this.deps.ledger.updateOpenRequest(request.id, {
          silentTurnCount: 0,
          wakeCount: 0,
          stalledTurnCount: undefined,
          nextWakeAt: undefined,
          isLimitStopped: undefined,
          limitWaitAnsweredFor: undefined,
        });
      }
      await this.trackForwardedTurn(key, request.id, { isRequestPrompt: isOwnPromptCarried, isContinuation: true, isConversationForward: true });
    }
  }

  /**
   * @description A usage-limit wait will not end by itself (auto-resume is off,
   * the operator skipped or disabled this resume, or the bot gave up after its
   * last attempt): nothing wakes the open request, the backstop included — a
   * reminder would only spend an attempt against the same limit — until a limit
   * wait ends with a resume or the operator's next message supersedes it. Never
   * rejects: its callers are command handlers and the error path, and a failed
   * write is logged instead.
   */
  async stopWakingForLimitWait(key: SessionKey): Promise<void> {
    this.unwatchConversation(key);
    for (const request of this.deps.ledger.listOpenRequestsOf(key)) {
      try {
        await this.deps.ledger.updateOpenRequest(request.id, { isLimitStopped: true, nextWakeAt: undefined });
      } catch (e) {
        logWakeUpFailure(`stopping the wake-ups of ${request.id}`, e);
      }
    }
  }

  /** @description One poll over the watched turns; exported for tests (the timer calls it). */
  async pollWatchedTurns(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      for (const turn of [...this.watched.values()]) {
        // One request's failure must not stop the others from being polled.
        await this.pollWatchedTurn(turn).catch((e) => logWakeUpFailure(`polling ${turn.requestId}`, e));
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * @description A new prompt is about to be written into `key`'s conversation: settle every watch of it whose turn has already
   * ENDED, on a probe taken now — before the write — exactly as the poll's next tick would have. A prompt that waited behind a running
   * turn is forwarded within seconds of its end (`postToSession` polls busy every 5 s, this engine every 10 s), usually before the tick
   * saw the idle; the old watch would then read the NEW turn as its own: arm its jobs under the old request, count its busy time as
   * the old request's activity, and decide the old request only at the new turn's end. A watch whose turn still runs is left — the
   * forward joins it (`trackForwardedTurn` merges), its prompt marked taken in if the live process took it (R21, as the poll marks); a
   * session that is gone is left to the poll.
   * Synchronous up to the decisions: the ended watches are dropped and decided against the request as it is NOW, so a forward that
   * does not await (a write must run in its caller's tick) is never read into them. The decisions are persisted after, in order; the
   * returned promise resolves once they are (a post that picks a request awaits it first, so the pick and the header see the result)
   * with the delivery of the wake-ups they decided. The CALLER delivers them — after its own write, so the prompt it writes starts the
   * turn and a reminder joins it, as the tick would have reminded seconds later; a call with no write of its own (the adapter's turn end)
   * hands them to a post on its way to its write, else delivers them at once ({@link deliverOrHandOverWake}). Never rejects, and neither
   * does the delivery.
   */
  settleEndedTurnsOf(key: SessionKey): Promise<() => Promise<void>> {
    const probe = this.deps.probeTurn(key);
    const persisting: Array<Promise<(() => Promise<void>) | null>> = [];
    for (const turn of this.getWatchedTurnsOf(key)) {
      const request = this.getOpenRequestOf(key, turn.requestId);
      if (!request) {
        this.watched.delete(turn.requestId);
        continue;
      }
      if (probe.isBusy) turn.hasSeenBusy = true;
      const rules = this.getRules(key);
      noteOwnWorkSeen(turn, probe, rules);
      const isHeldByOwnWork = checkIsHeldByOwnWork(request, probe, rules, this.now());
      if (getWatchedTurnState(turn, probe, isHeldByOwnWork) !== 'ended') {
        // A turn still running, or held, may have taken its prompt in already: marked now (R21), as the poll would. The process that took
        // it may be gone before the poll's next tick — a deferred account switch re-spawns it one timer tick after the turn's end, the
        // per-turn stop ends it — and a prompt is read as taken in only off the process it was written to.
        persisting.push(this.markPromptTakenIn(turn, request, probe).then(() => null, (e) => {
          logWakeUpFailure(`marking the prompt of ${turn.requestId} taken in`, e);
          return null;
        }));
        continue;
      }
      this.watched.delete(turn.requestId);
      const decision = this.decideWatchedTurnEnd(turn, request, probe);
      persisting.push(this.persistEndedTurn(turn, request, probe, decision).catch((e) => {
        logWakeUpFailure(`settling the turn of ${turn.requestId}`, e);
        return null;
      }));
    }
    return Promise.all(persisting).then((deliveries) => async () => {
      for (const deliver of deliveries) await deliver?.().catch((e) => logWakeUpFailure(`delivering a settled turn's wake-up in ${keyToString(key)}`, e));
    });
  }

  /**
   * @description A post (`postToSession`) is on its way to write a prompt into `key`'s conversation, waiting for the running turn's
   * idle maybe. Until the returned release, a wake-up decided for the conversation — at the adapter's turn end, by the poll, by the sweep
   * ({@link deliverOrHandOverWake}) — is HANDED to the post instead of written at once: the post takes it with its settle
   * ({@link settleEndedTurnsForPost}) and delivers it after its own write, so the prompt that waited for the turn starts the next one and
   * the reminder joins it (written first, the reminder would start that turn and the reminded request would read as its starter). The
   * release delivers what is still handed over once the last post in flight is done: one that never took it (held over a limit wait,
   * an ensure that failed) or a wake decided after its settle. It never rejects, and a second call does nothing.
   */
  notePostInFlight(key: SessionKey): () => Promise<void> {
    const conversationKey = keyToString(key);
    this.postsInFlight.set(conversationKey, (this.postsInFlight.get(conversationKey) ?? 0) + 1);
    let isReleased = false;
    return async () => {
      if (isReleased) return;
      isReleased = true;
      const count = (this.postsInFlight.get(conversationKey) ?? 1) - 1;
      if (count > 0) {
        this.postsInFlight.set(conversationKey, count);
        return;
      }
      this.postsInFlight.delete(conversationKey);
      await this.takeWakesHandedToPost(conversationKey)();
    };
  }

  /** @description Deliver a decided wake-up now, or hand it to a post in flight in `key`'s conversation ({@link notePostInFlight}). Never rejects. */
  async deliverOrHandOverWake(key: SessionKey, deliver: () => Promise<void>): Promise<void> {
    const conversationKey = keyToString(key);
    if (this.postsInFlight.has(conversationKey)) {
      this.wakesHandedToPost.set(conversationKey, [...(this.wakesHandedToPost.get(conversationKey) ?? []), deliver]);
      return;
    }
    await deliver().catch((e) => logWakeUpFailure(`delivering a wake-up in ${conversationKey}`, e));
  }

  /**
   * @description A write into `key`'s live process (the write choke point, synchronously before the adapter write): the process it goes
   * to is stamped, for a watch that is tracked only after that process went down ({@link writtenProcesses}). Synchronous; a probe that
   * names no process (a window holds the prompt) stamps nothing.
   */
  noteWrite(key: SessionKey): void {
    const { processGeneration } = this.deps.probeTurn(key);
    if (processGeneration !== undefined) this.writtenProcesses.set(keyToString(key), processGeneration);
  }

  /**
   * @description A write into `key`'s live process during the replay of a start's buffer (the write choke point, right after its settle;
   * the bot calls it at every write while `StartupPromptBuffer.checkIsReplaying`: a replayed prompt, the held prompts after them, a prompt
   * written at once while the replay runs — all go to the process the replay writes into). A watch tracked while its prompt waited in that
   * buffer names no process yet, and the replay took the whole buffer to write it into this process, so its prompt is in this one. Never
   * called for a write outside a replay: a watch whose buffer was DROPPED stays unnamed — its prompt reached no process
   * (`checkIsPromptNeverWritten`) — and the request it opened is closed with the person told (`bot.ts`, the person's buffered prompt's
   * settle). Only a person's prompt is tracked before its replay: every bot-made caller watches its turn once its prompt reached a session
   * (`src/requests/README.md`, the callers table). Synchronous; a session with no process named does nothing.
   */
  noteReplayedWrite(key: SessionKey): void {
    const { processGeneration } = this.deps.probeTurn(key);
    if (processGeneration === undefined) return;
    for (const turn of this.getWatchedTurnsOf(key)) {
      if (turn.writtenToProcess === undefined) turn.writtenToProcess = processGeneration;
    }
  }

  /**
   * @description The settle of a post about to write ({@link settleEndedTurnsOf}): resolves ONE delivery for the post to run after its
   * write — the wake-ups handed to it so far, in order, then this settle's own. Never rejects, and neither does the delivery.
   */
  settleEndedTurnsForPost(key: SessionKey): Promise<() => Promise<void>> {
    const deliverHandedOver = this.takeWakesHandedToPost(keyToString(key));
    return this.settleEndedTurnsOf(key).then((deliverSettled) => async () => {
      await deliverHandedOver();
      await deliverSettled();
    });
  }

  /** The delivery of the wake-ups handed to a post in `conversationKey`, taken (a later post or release finds none of them). */
  private takeWakesHandedToPost(conversationKey: string): () => Promise<void> {
    const handedOver = this.wakesHandedToPost.get(conversationKey) ?? [];
    this.wakesHandedToPost.delete(conversationKey);
    return async () => {
      for (const deliver of handedOver) await deliver().catch((e) => logWakeUpFailure(`delivering a wake-up handed to a post in ${conversationKey}`, e));
    };
  }

  /** The decision at the end of `turn`, read against `request` and its jobs as they are now. */
  private decideWatchedTurnEnd(turn: WatchedRequestTurn, request: OpenRequestState, probe: SessionTurnProbe): WakeUpDecision {
    return decideTurnEnd(request, turn.progressCountAtTurnStart, this.now(), {
      isScheduledRun: turn.isScheduledRun === true,
      isRequestJob: turn.isRequestJob !== false,
      scheduleWait: this.getScheduleWait(turn.key, request),
      progressFollowUpMs: this.deps.progressFollowUpMs,
      rules: this.getRules(turn.key),
      // Still pending: the hold no longer applies (an owed answer, or it lapsed). Gone after a hold: it ended by itself.
      ...(probe.hasOwnPendingWork === true ? { ownWork: 'pending' as const } : turn.hasSeenOwnWork === true ? { ownWork: 'ended' as const } : {}),
    });
  }

  /** R21 for a request prompt the ended turn took in (a later wake-up is a reminder), then `decision` persisted; resolves its wake's delivery. */
  private async persistEndedTurn(turn: WatchedRequestTurn, request: OpenRequestState, probe: SessionTurnProbe, decision: WakeUpDecision): Promise<(() => Promise<void>) | null> {
    await this.markPromptTakenIn(turn, request, probe);
    return this.persistDecision(turn.key, request, decision);
  }

  /**
   * R21: once the backend took a request prompt in, a wake-up is a reminder — the agent has read the request. A held turn end is read like
   * any other: what the backend still lists as unread is unread. A prompt queued behind a turn that ended in an error result stays listed
   * until its own echo (the json-stream adapter keeps it; the CLI runs it as its next turn, measured), and the prompt of the turn that
   * failed was read by it — a resume that posted it again would repeat words the agent already has.
   * Read only off the process the prompt was written to (`writtenToProcess`): a re-spawn that replaced it — an account move after a limit,
   * a model change — kills a message still queued there, and the new process lists nothing unread. Left unmarked, the prompt is posted
   * again: by the resume's «continue» (`getPromptNotTakenIn`), or as the wake-up of the turn's end. A prompt that names no process while
   * one is live never reached any (`checkIsTurnInputConsumed`): nothing is marked.
   */
  private async markPromptTakenIn(turn: WatchedRequestTurn, request: OpenRequestState, probe: SessionTurnProbe): Promise<void> {
    if (request.isPromptTakenIn !== true && checkIsPromptConsumedByLiveProcess(turn, probe)) {
      await this.deps.ledger.updateOpenRequest(request.id, { isPromptTakenIn: true });
    }
  }

  private async pollWatchedTurn(turn: WatchedRequestTurn): Promise<void> {
    // Replaced or dropped since this poll took its snapshot: the newer watch (if any) decides.
    if (this.watched.get(turn.requestId) !== turn) return;
    const request = this.getOpenRequestOf(turn.key, turn.requestId);
    if (!request) {
      // Answered, cancelled or superseded meanwhile — nothing left to watch.
      this.watched.delete(turn.requestId);
      return;
    }
    const probe = this.deps.probeTurn(turn.key);
    if (probe.isBusy) turn.hasSeenBusy = true;
    await this.markPromptTakenIn(turn, request, probe);
    // Settled by a forward, or replaced by a new watch, during that write: the watch present now decides, not this one.
    if (this.watched.get(turn.requestId) !== turn) return;
    const rules = this.getRules(turn.key);
    noteOwnWorkSeen(turn, probe, rules);
    const isHeldByOwnWork = checkIsHeldByOwnWork(request, probe, rules, this.now());
    const turnState = getWatchedTurnState(turn, probe, isHeldByOwnWork);
    if (turnState === 'running') {
      if (probe.isBusy) {
        // Another job's fire that only rides the request keeps the session busy for its own work, not for this request's — and so does
        // any turn while this request's prompt has reached no process (`checkIsPromptNeverWritten`): that busy time is another turn's.
        // A tracker's turn the CLI started by itself (the agent's own work's, a loop's fire) is no activity either: counted, a
        // self-renewing job would renew the hold it bounds (`ownWorkHoldMaxMs`).
        const isOwnWorkTurn = turn.hasSeenOwnWork === true && probe.isCliOwnTurn === true;
        if (turn.isRequestJob !== false && !checkIsPromptNeverWritten(turn, probe) && !isOwnWorkTurn) await this.recordTurnActivity(request, false);
      } else if (checkIsWatchedTurnStale(request, probe, this.now(), this.deps.backstopMs, rules)) {
        // Its end can no longer be seen: the sweep's backstop takes the request over.
        this.watched.delete(turn.requestId);
      }
      return;
    }
    this.watched.delete(turn.requestId);
    // A dead session is not a turn end: the backstop resumes it later.
    if (turnState === 'sessionGone') return;
    await this.applyDecision(turn.key, request, this.decideWatchedTurnEnd(turn, request, probe));
  }

  /** @description One sweep over the open requests nobody watches; exported for tests. */
  async sweepUnwatchedRequests(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;
    try {
      const openRequests = this.deps.ledger.listOpenRequests();
      const openIds = new Set(openRequests.map(({ request }) => request.id));
      for (const requestId of [...this.activityPersistedAt.keys()]) {
        if (!openIds.has(requestId)) this.activityPersistedAt.delete(requestId);
      }
      for (const { key, request } of openRequests) {
        if (this.watched.has(request.id)) continue;
        // One conversation's failure must not stop the others from being swept.
        await this.sweepOpenRequest(key, request).catch((e) => logWakeUpFailure(`sweeping ${keyToString(key)}`, e));
      }
      for (const [conversationKey, entry] of [...this.answerTails]) {
        await this.sweepAnswerTail(conversationKey, entry).catch((e) => logWakeUpFailure(`the answer tail of ${conversationKey}`, e));
      }
    } finally {
      this.isSweeping = false;
    }
  }

  private async sweepOpenRequest(key: SessionKey, request: OpenRequestState): Promise<void> {
    const probe = this.deps.probeTurn(key);
    if (probe.isBusy) {
      // A busy session is activity of THIS request's own lost turn — so a long-running one is not prodded mid-work — but only while no
      // turn is watched in the conversation: then the busy time is that turn's, never this request's, whatever it owes. A recurring
      // job's fires keep the session busy every few minutes, so recorded they would push this request's backstop ahead for good — a
      // requester's lost message, or a watch that fired and nobody handled (`armed`), would never be taken back. A request a watch
      // holds ignores the backstop anyway, and a due follow-up is woken by `nextWakeAt`, which activity does not move. The same for a
      // turn the CLI started by itself (`isCliOwnTurn`: a finished task's, a session `CronCreate` job's): only a turn the bot wrote can
      // be the request's lost one, and a looping job would otherwise push an owed request's backstop ahead for as long as it loops.
      if (this.getWatchedTurnsOf(key).length === 0 && probe.isCliOwnTurn !== true) await this.recordTurnActivity(request, false);
      return;
    }
    if (checkIsHeldByOwnWork(request, probe, this.getRules(key), this.now()) && this.watchTurnOfOwnWork(key, request, probe)) return;
    await this.applyDecision(key, request, decideUnwatchedRequest(request, probe, this.now(), this.deps.backstopMs, this.getScheduleWait(key, request)));
  }

  /**
   * ANY tracker request of the conversation nobody watches while the agent's own pending work holds it (`checkIsHeldByOwnWork`) — a
   * restart dropped the watch that held it, or the work is another request's (one request's work holds every open request of the
   * conversation that owes nobody an answer; the work's end nudges each one left open with nothing armed): watch it, so the turn that
   * work starts by itself is decided when it ends, not left to the backstop. Not while its prompt waits for a post retry (that forward
   * is watched: the sweep's decision runs it), nor once nothing may wake it. `true` — it is watched now.
   */
  private watchTurnOfOwnWork(key: SessionKey, request: OpenRequestState, probe: SessionTurnProbe): boolean {
    if (!probe.isActive || request.nextPostRetryAt !== undefined || checkIsWakingStopped(request)) return false;
    this.watched.set(request.id, {
      key,
      requestId: request.id,
      progressCountAtTurnStart: request.progressAnswerCount,
      hasSeenBusy: false,
      hasSeenOutput: false,
      isRequestPrompt: false,
      isOwnForward: false,
      hasSeenOwnWork: true,
    });
    return true;
  }

  /** The rule set `key`'s conversation is woken under; a topic's when the port is not wired. */
  private getRules(key: SessionKey): WakeUpRuleSet {
    return this.deps.getWakeUpRules?.(key) ?? 'topic';
  }

  /** The request's reading of its armed jobs now; `none` when the port is not wired. */
  private getScheduleWait(key: SessionKey, request: OpenRequestState): RequestScheduleWait {
    return this.deps.getScheduleWait?.(key, request) ?? 'none';
  }

  private async sweepAnswerTail(conversationKey: string, entry: WatchedAnswerTail): Promise<void> {
    if (this.answerTails.get(conversationKey) !== entry) return;
    if (this.deps.checkIsAnswerTailWatched?.(entry.key) !== true || this.deps.ledger.listOpenRequestsOf(entry.key).length > 0) {
      // The stream is shown again, or a newer request is open and its own answer is owed.
      this.answerTails.delete(conversationKey);
      return;
    }
    const decision = decideAnswerTail(entry.tail, this.deps.probeTurn(entry.key), this.now());
    if (decision === 'wait') return;
    this.answerTails.delete(conversationKey);
    if (decision === 'drop') return;
    const { requestId } = entry.tail;
    const reminded = this.answerTailReminders.get(conversationKey);
    this.answerTailReminders.set(conversationKey, { requestId, count: reminded?.requestId === requestId ? reminded.count + 1 : 1 });
    const isDelivered = (await this.deps.remindAnswerTail?.(entry.key, buildAnswerTailReminder(requestId))) ?? false;
    console.log(`[requests] answer-tail reminder for ${requestId} ${isDelivered ? 'forwarded' : 'NOT delivered (the session could not be reached)'}`);
  }

  /** Persist that the agent is working on it, at most once per step unless forced. */
  private async recordTurnActivity(request: OpenRequestState, isForced: boolean): Promise<void> {
    const nowMs = this.now();
    const persistedAt = this.activityPersistedAt.get(request.id);
    if (!isForced && persistedAt !== undefined && nowMs - persistedAt < turnActivityPersistStepMs) return;
    this.activityPersistedAt.set(request.id, nowMs);
    await this.deps.ledger.updateOpenRequest(request.id, { lastTurnActivityAt: nowMs });
  }

  private async applyDecision(key: SessionKey, request: OpenRequestState, decision: WakeUpDecision): Promise<void> {
    const deliverWake = await this.persistDecision(key, request, decision);
    // A post on its way to its write takes it and writes it after its own prompt (`notePostInFlight`).
    if (deliverWake) await this.deliverOrHandOverWake(key, deliverWake);
  }

  /**
   * Persist `decision` (an alert is raised here too) and resolve the delivery of its wake-up, or `null` when it decided none or the
   * request changed meanwhile. Split from the delivery so a settle before a write can persist at once and deliver after the write.
   */
  private async persistDecision(key: SessionKey, request: OpenRequestState, decision: WakeUpDecision): Promise<(() => Promise<void>) | null> {
    if (decision.kind === 'none') return null;
    if (decision.kind === 'quiet' && decision.isRequestSettled === true) {
      // The alarm's own request, left unanswered by an agent with nothing to report: closed without a word, never woken at the backstop.
      await this.deps.ledger.closeRequest(request.id, 'cancelled');
      return null;
    }
    let isStoppedMeanwhile = false;
    const updated = await this.deps.ledger.updateOpenRequest(request.id, (current) => {
      // `request` is a snapshot: a limit wait may have stopped the wake-ups since (no alert either).
      isStoppedMeanwhile = checkIsWakingStopped(current);
      return isStoppedMeanwhile ? {} : decision.update;
    });
    // Closed or superseded while we decided: the decision belonged to the old one.
    if (!updated || isStoppedMeanwhile) return null;
    if (decision.kind === 'followUpLater' || decision.kind === 'quiet') return null;
    if (decision.kind === 'alert') {
      await this.raiseAlert(key, updated, decision.reason);
      return null;
    }
    const { reason } = decision;
    return () => this.deliverWake(key, updated, reason);
  }

  /** Deliver a persisted wake-up: the reminder (or the request's prompt again, R21), then its turn watched, or the failure handled. */
  private async deliverWake(key: SessionKey, updated: OpenRequestState, reason: RequestWakeUpReason): Promise<void> {
    const message = getWakeUpMessage(updated, reason);
    const outcome = await this.deliverWakeUpSafely(key, updated, message);
    if (outcome === 'delivered') {
      await this.trackForwardedTurn(key, updated.id, { isRequestPrompt: message.isRequestPrompt });
      return;
    }
    if (outcome === 'requestGone') return;
    if (reason === 'postRetry') {
      // R28: a retry that failed again tries later; once spent, the backstop decides — no alert yet.
      const retry = getPostRetryUpdate(updated, this.now(), this.deps.firstPostRetryDelayMs);
      if (retry) await this.deps.ledger.updateOpenRequest(updated.id, retry);
      return;
    }
    const stopped = await this.deps.ledger.updateOpenRequest(updated.id, { isWakeStopped: true, nextWakeAt: undefined });
    if (stopped) await this.raiseAlert(key, stopped, 'wakeFailed');
  }

  /**
   * Resume the session if needed, re-check the request, forward the reminder. A
   * step that threw did not reach the session: same as one that could not.
   */
  private async deliverWakeUpSafely(
    key: SessionKey,
    request: OpenRequestState,
    message: WakeUpMessage,
  ): Promise<WakeUpDeliveryOutcome> {
    try {
      if (!(await this.deps.prepareWakeUpSession(key, message))) return 'failed';
      // The resume took a while: a reminder for a request that closed, was replaced
      // or stopped being woken meanwhile is stale.
      const current = this.getOpenRequestOf(key, request.id);
      if (!current || checkIsWakingStopped(current)) return 'requestGone';
      // A tracker's nudge is moot once a person's words for the request reached the agent after it was decided (a comment that waited
      // for the stalled turn and was written right before the nudge's delivery): their turn is the request's next, decided on its own.
      if (message.reason === 'nothingArmed' && current.isPersonInputUnanswered === true) return 'requestGone';
      await this.deps.forwardWakeUp(key, request, message);
      return 'delivered';
    } catch (e) {
      logWakeUpFailure(`delivering the reminder for ${request.id}`, e);
      return 'failed';
    }
  }

  private async raiseAlert(key: SessionKey, request: OpenRequestState, reason: RequestAlertReason): Promise<void> {
    const alertRef = await this.deps.deliverAlert(key, request, reason);
    if (alertRef !== null) await this.deps.ledger.recordAlert(key, request.id, alertRef);
  }
}

/** Log a wake-up step that failed; the engine keeps running for every other request. */
function logWakeUpFailure(step: string, error: unknown): void {
  console.warn(`[requests] ${step} failed:`, error instanceof Error ? error.message : error);
}
