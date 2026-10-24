import { keyToString, type SessionKey } from '../sessionKey';
import type { SessionTurnProbe } from '../requests/wakeUpRules';
import type { TodoStandaloneGate } from './nag';
import type { TodoRegistry } from './registry';

/**
 * @description The timer side of the staleness reminder (D10–D12): no adapter emits a turn-end event, so the
 * conversations' sessions are POLLED like the wake-up engine's watched turns. Each poll adds the busy time to the
 * conversation's work; a busy → idle edge is a turn end, which starts the reminder's clock (the first one after an
 * update) and, when the list is stale and every gate holds, posts the standalone reminder. Every decision is the
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
  /** Mid-turn delivery (D22): reconcile what the hooks took, and deliver to a busy session what changed. */
  midTurn?: { reconcile(): void; deliverIfPending(key: SessionKey): Promise<void> };
  now?: () => number;
  pollIntervalMs?: number;
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
      this.deps.registry.addTurnWork(key, elapsedMs);
      await this.deps.midTurn?.deliverIfPending(key);
      return;
    }
    const isTurnEnd = wasBusy && probe.isActive && !probe.isTurnEndBlocked && probe.hasUnconsumedInput !== true;
    if (!isTurnEnd) {
      // A turn whose end is held (a question, a compaction, unread input) ends at a later poll.
      if (wasBusy && probe.isActive) this.wasBusy.set(conversationKey, true);
      return;
    }
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
