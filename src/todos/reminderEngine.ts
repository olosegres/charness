import { keyToString, type SessionKey } from '../sessionKey';
import type { SessionTurnProbe } from '../requests/wakeUpRules';
import type { TodoStandaloneGate } from './nag';
import type { TodoRegistry } from './registry';

/**
 * @description The timer side of the staleness reminder (D10–D12). The conversations' sessions are POLLED like the
 * wake-up engine's watched turns: each poll adds the WORKING time to the conversation's work — busy, and nothing
 * holding the turn (a session waiting on a question is busy, but its agent does nothing) —, and a busy → idle edge is
 * a turn end. The adapter's own turn end (`noteAdapterTurnEnd`, json-stream's `turnEnded`) is one too: the per-turn
 * lifecycle stops the process right after it, before a poll could find it idle. A turn end starts the reminder's
 * clock (the first one after an update) and, when the list is stale and every gate holds, posts the standalone
 * reminder. Every decision is the
 * registry's (`nag.ts`); this module only observes and acts. A failure in one conversation is logged and never stops
 * the others. The same poll hands a busy session the project board's changes mid-turn (`midTurn.ts`) — it runs while
 * the shared lists are on, the reminder off or not.
 */

/** How often the sessions are polled — the wake-up engine's turn poll. */
export const todoReminderPollMs = 10_000;
/**
 * A poll that comes much later than due (a suspended host, a blocked event loop) counts at most this many intervals
 * of work: the gap was not observed as work.
 */
const maxCountedPollIntervals = 3;

/**
 * @name TodoReminderEngineDeps
 * @description `listConversations` = the conversations whose sessions are polled; `getGate` adds what the turn probe
 * does not know (an open request, the answer tail, a limit, an API-billed account); `getIntervalMs` = the reminder's
 * interval now (`null` = off); `postReminder` writes the standalone reminder into the idle session and resolves
 * whether it was written.
 */
export interface TodoReminderEngineDeps {
  registry: Pick<TodoRegistry, 'addTurnWork' | 'noteTurnEnd' | 'decideStandaloneReminder' | 'noteReminderDelivered'>;
  listConversations: () => SessionKey[];
  probeTurn: (key: SessionKey) => SessionTurnProbe;
  getGate: (key: SessionKey) => Omit<TodoStandaloneGate, keyof SessionTurnProbe>;
  getIntervalMs: () => number | null;
  /** Whether the shared lists are on at all; off, the poll does nothing. */
  checkIsEnabled: () => boolean;
  postReminder: (key: SessionKey, text: string) => Promise<boolean>;
  /**
   * Mid-turn delivery (D22): reconcile what the hooks took, deliver to a working session what changed, and withdraw a
   * waiting inbox when no tool call can take it (a turn's end, a turn held open).
   */
  midTurn?: { reconcile(): void; deliverIfPending(key: SessionKey): Promise<void>; discardInbox(key: SessionKey): void };
  now?: () => number;
  pollIntervalMs?: number;
}

/** @description Whether the session stands at a settled turn end: live, idle, nothing holding the turn, nothing unread. */
function checkIsSettledTurnEnd(probe: SessionTurnProbe): boolean {
  return probe.isActive && !probe.isBusy && !probe.isTurnEndBlocked && probe.hasUnconsumedInput !== true;
}

export class TodoReminderEngine {
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt: number | null = null;
  /** Whether each conversation's session was busy at the previous poll. */
  private readonly wasBusy = new Map<string, boolean>();
  /** Conversations whose reminder post is under way: never two at once. */
  private readonly posting = new Set<string>();
  private readonly now: () => number;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: TodoReminderEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.pollIntervalMs = deps.pollIntervalMs ?? todoReminderPollMs;
  }

  start(): void {
    if (this.timer) return;
    this.lastPollAt = this.now();
    this.timer = setInterval(() => {
      void this.poll().catch((e) => console.warn('[todos] reminder poll failed:', e instanceof Error ? e.message : e));
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  /** @description The conversation's agent produced output: a turn is under way, even one shorter than a poll. */
  noteAgentOutput(key: SessionKey): void {
    this.wasBusy.set(keyToString(key), true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @description One poll over every conversation (exposed for tests). */
  async poll(): Promise<void> {
    const nowMs = this.now();
    const elapsedMs = Math.min(nowMs - (this.lastPollAt ?? nowMs), maxCountedPollIntervals * this.pollIntervalMs);
    this.lastPollAt = nowMs;
    // Off: nothing is counted, and a turn seen busy now is not an end later.
    if (!this.deps.checkIsEnabled()) {
      this.wasBusy.clear();
      return;
    }
    const intervalMs = this.deps.getIntervalMs();
    this.deps.midTurn?.reconcile();
    for (const key of this.deps.listConversations()) {
      try {
        await this.pollConversation(key, nowMs, elapsedMs, intervalMs);
      } catch (e) {
        console.warn(`[todos] reminder poll of ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  private async pollConversation(key: SessionKey, nowMs: number, elapsedMs: number, intervalMs: number | null): Promise<void> {
    const conversationKey = keyToString(key);
    const probe = this.deps.probeTurn(key);
    const wasBusy = this.wasBusy.get(conversationKey) === true;
    this.wasBusy.set(conversationKey, probe.isBusy);
    if (probe.isBusy) {
      // A turn held open (a question waiting for the operator, a compaction) is no work of the agent's, and makes no
      // tool call that could take an inbox: the changes wait for the turn to go on.
      if (probe.isTurnEndBlocked) {
        this.discardInbox(key);
        return;
      }
      this.deps.registry.addTurnWork(key, elapsedMs);
      await this.deps.midTurn?.deliverIfPending(key);
      return;
    }
    const isTurnEnd = wasBusy && checkIsSettledTurnEnd(probe);
    if (!isTurnEnd) {
      // A turn whose end is held (a question, a compaction, unread input) ends at a later poll.
      if (wasBusy && probe.isActive) this.wasBusy.set(conversationKey, true);
      return;
    }
    await this.handleTurnEnd(key, probe, nowMs, intervalMs);
  }

  /**
   * @description The adapter reported a turn's end (json-stream `turnEnded`, every terminal `result`). A poll can miss
   * it — the per-turn lifecycle stops the process right after, before the next poll finds it idle — so the event is a
   * turn end of its own; a turn whose end is held (unread input, a compaction) is left to the poll.
   */
  async noteAdapterTurnEnd(key: SessionKey): Promise<void> {
    if (!this.deps.checkIsEnabled()) return;
    const probe = this.deps.probeTurn(key);
    if (!checkIsSettledTurnEnd(probe)) return;
    this.wasBusy.set(keyToString(key), false);
    await this.handleTurnEnd(key, probe, this.now(), this.deps.getIntervalMs());
  }

  /**
   * A waiting inbox is withdrawn: its changes stay unseen and ride the next prompt. So the inbox dir is empty between
   * turns, and the hook starts no `node` for any other session's tool call meanwhile.
   */
  private discardInbox(key: SessionKey): void {
    try {
      this.deps.midTurn?.discardInbox(key);
    } catch (e) {
      console.warn(`[todos] ${keyToString(key)}: the mid-turn inbox could not be withdrawn:`, e instanceof Error ? e.message : e);
    }
  }

  private async handleTurnEnd(key: SessionKey, probe: SessionTurnProbe, nowMs: number, intervalMs: number | null): Promise<void> {
    const conversationKey = keyToString(key);
    this.discardInbox(key);
    this.deps.registry.noteTurnEnd(key, nowMs);
    if (this.posting.has(conversationKey)) return;
    const decision = this.deps.registry.decideStandaloneReminder(key, intervalMs, { ...probe, ...this.deps.getGate(key) }, nowMs);
    if (!decision.shouldRemind) {
      // A due reminder that a gate holds back is worth one line per turn end; a list that is not due is not.
      if (decision.isStale) console.log(`[todos] ${conversationKey}: stale list, no reminder: ${decision.skipReasons.join(', ')}`);
      return;
    }
    this.posting.add(conversationKey);
    try {
      if (await this.deps.postReminder(key, decision.text)) {
        this.deps.registry.noteReminderDelivered(key, this.now());
        console.log(`[todos] ${conversationKey}: stale list — reminded the agent`);
      }
    } finally {
      this.posting.delete(conversationKey);
    }
  }
}
