import { keyToString, type SessionKey } from '../sessionKey';
import type { SessionTurnProbe } from '../requests/wakeUpRules';
import type { MidTurnInbox } from '../utils/midTurnInbox';
import type { LimitNotes } from './service';

/**
 * @description The timer side of the accounts note's MID-TURN delivery: a running Claude turn learns where the limits stand after its
 * next tool call, not only at its next prompt. Claude on the json-stream host (both lifecycles) only — OpenCode gets no mid-turn
 * note: its only channel is a prompt queued into the running turn, which the backend counts as unconsumed input and may turn into a
 * turn of its own.
 *
 * Every {@link limitNoteEnginePollMs} each conversation whose session is a live Claude json-stream agent is looked at: while it WORKS
 * (active, busy, its turn not held open) and a reminder is due (`LimitNotes.takeMidTurnNote`), the `accounts` section of its mid-turn
 * inbox (`utils/midTurnInbox.ts`) is written; the `PostToolUse` hook prints it after the agent's next tool call, and only then does
 * the note count as delivered (`markDelivered`: the record's time and fingerprint). A section whose turn ended, was held open
 * (a question, a compaction, an armed retry, a recovery, a session start) or whose session is gone is withdrawn unseen, and the note
 * stays due — it comes at the next moment the agent works anyway. A turn the bot started for its own bookkeeping (a retry's nudge, a
 * request wake-up, the todo reminder, the lost-work note, a question's answer — `LimitNotes.noteTurnStart`) is given no reminder:
 * its start carried none, and the engine must not take at its first tool call what that start was not to.
 *
 * A note is a passenger, never a cause (README § Lifecycle safety): this module has no way to stamp activity, write to an agent's
 * input, wake a session, set «working» or open a request. It READS the turn probe the wake-up and todo engines share and WRITES a
 * file through the inbox. A failure in one conversation is logged and never stops the others.
 */

/** How often the sessions are polled (a test shortens it with `CHARNESS_TEST_TIMINGS` `limitNoteEnginePollMs`). */
export const limitNoteEnginePollMs = 60_000;

export interface LimitNotesEngineDeps {
  listConversations: () => SessionKey[];
  /** The id of the conversation's Claude json-stream session; `null` for any other backend (and for none): such a conversation gets no mid-turn note. */
  getClaudeSessionId: (key: SessionKey) => string | null;
  probeTurn: (key: SessionKey) => SessionTurnProbe;
  notes: Pick<LimitNotes, 'takeMidTurnNote' | 'checkIsBookkeepingTurn'>;
  inbox: MidTurnInbox;
  pollIntervalMs?: number;
}

export class LimitNotesEngine {
  private timer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: LimitNotesEngineDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? limitNoteEnginePollMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().catch((error) => console.warn('[limit-notes] mid-turn poll failed:', error instanceof Error ? error.message : error));
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @description One poll over every conversation (exposed for tests). */
  async poll(): Promise<void> {
    // Sections the hook took since the last look count as delivered — whichever engine's poll finds them first.
    this.deps.inbox.reconcile();
    for (const key of this.deps.listConversations()) {
      try {
        this.pollConversation(key);
      } catch (error) {
        console.warn(`[limit-notes] mid-turn poll of ${keyToString(key)} failed:`, error instanceof Error ? error.message : error);
      }
    }
  }

  private pollConversation(key: SessionKey): void {
    const { inbox } = this.deps;
    const sessionId = this.deps.getClaudeSessionId(key);
    if (sessionId === null) {
      this.withdraw(key);
      return;
    }
    const probe = this.deps.probeTurn(key);
    // No tool call of this session can take the section: a turn that ended, a turn held open, a session that is gone.
    if (!probe.isActive || !probe.isBusy || probe.isTurnEndBlocked) {
      this.withdraw(key);
      return;
    }
    if (this.deps.notes.checkIsBookkeepingTurn(key)) {
      this.withdraw(key);
      return;
    }
    if (inbox.checkIsWaiting(key, 'accounts')) return;
    const note = this.deps.notes.takeMidTurnNote(key);
    if (note === null) return;
    // Delivered only when taken; withdrawn unseen, it is given back and stays due — also when the file could not be written.
    let isOffered = false;
    try {
      isOffered = inbox.offer(key, sessionId, 'accounts', { text: note.text, onTaken: note.markDelivered, onWithdrawn: note.release });
    } finally {
      if (!isOffered) note.release();
    }
  }

  private withdraw(key: SessionKey): void {
    if (this.deps.inbox.checkIsWaiting(key, 'accounts')) this.deps.inbox.withdraw(key, 'accounts');
  }
}
