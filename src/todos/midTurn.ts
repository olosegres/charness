import { keyToString, type SessionKey } from '../sessionKey';
import type { MidTurnInbox } from '../utils/midTurnInbox';
import type { TodoBoardChanges } from './board';

/**
 * @description Mid-turn delivery of the project board (D21, D22): a working agent learns of another topic's change
 * inside its turn, not only at its next prompt.
 *
 *   Claude    — the `todoBoard` section of the session's mid-turn INBOX (`utils/midTurnInbox.ts`, shared with the accounts note): a
 *               `PostToolUse` hook prints the inbox after the agent's next tool call. The board's changes count as seen once the
 *               hook took the file (the inbox's `onTaken`).
 *   OpenCode  — a note queued INTO the running turn (`AgentAdapter.queueNoteIntoRunningTurn`: `prompt_async`, read
 *               between steps, with nothing of the turn reset), never while a provider retry is waited out.
 *
 * The bot writes the section only while the session works (busy, its turn not held open) and something changed since the agent last
 * saw it. A waiting section is withdrawn wherever no tool call of the session can take it any more — a turn start the bot makes (that
 * prompt carries the changes itself), a turn's end, a turn held open, the session's start, stop or end — and its changes stay unseen
 * for the next prompt. A restart forgets what was written: at worst a change is delivered twice, never lost.
 */

/** What opens the note a running OpenCode turn reads (agent-facing English); the board's changes follow it. */
export const todoRunningTurnNoteHeader = '[Todo] Other topics of your project changed their lists while you work. No reply is needed.';

/**
 * @name TodoMidTurnDeps
 * @description The board's peek and seen marks, the shared mid-turn inbox, the conversation's live Claude session (`null` = no Claude
 * backend runs it), and the note into a running turn (`false` when the backend takes none, or the turn is not running now).
 */
export interface TodoMidTurnDeps {
  board: {
    peekChanges(key: SessionKey): TodoBoardChanges | null;
    markSeenRevisions(key: SessionKey, revisions: Readonly<Record<string, number>>): void;
  };
  inbox: MidTurnInbox;
  getClaudeSessionId: (key: SessionKey) => string | null;
  postRunningTurnNote: (key: SessionKey, text: string) => Promise<boolean>;
}

/** @name TodoMidTurn @description What the reminder poll and the prompt choke point call. */
export interface TodoMidTurn {
  /** The session is busy: deliver what changed since the agent last saw the board, if anything did. */
  deliverIfPending(key: SessionKey): Promise<void>;
  /** Inboxes the hook took since the last look count as seen (the shared inbox's, so a taken accounts note counts too). */
  reconcile(): void;
  /**
   * No tool call of the session can take the board's section any more (a turn start the bot makes, a turn's end, a turn held
   * open, the session's start, stop or end): it is withdrawn — counted as seen if the hook took it meanwhile. The accounts note's
   * section of the same inbox is not touched.
   */
  discardInbox(key: SessionKey): void;
}

/** @description Whether two revision maps name the same peers at the same revisions. */
function checkIsSameRevisions(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([conversationKey, revision]) => right[conversationKey] === revision);
}

export function createTodoMidTurn(deps: TodoMidTurnDeps): TodoMidTurn {
  const { board, inbox, getClaudeSessionId, postRunningTurnNote } = deps;
  /** The peer revisions of the board section each conversation's inbox waits with. */
  const offeredRevisions = new Map<string, Readonly<Record<string, number>>>();

  return {
    async deliverIfPending(key) {
      const conversationKey = keyToString(key);
      inbox.reconcile(key);
      const changes = board.peekChanges(key);
      if (changes === null) return;
      const sessionId = getClaudeSessionId(key);
      if (sessionId === null) {
        // Seen only once the note is in: a refused one (no running turn, a provider retry) waits for the next poll.
        if (await postRunningTurnNote(key, `${todoRunningTurnNoteHeader}\n\n${changes.text}`)) board.markSeenRevisions(key, changes.revisions);
        return;
      }
      const waitingRevisions = offeredRevisions.get(conversationKey);
      // The same changes already wait for the agent's next tool call.
      if (inbox.checkIsWaiting(key, 'todoBoard') && waitingRevisions !== undefined && checkIsSameRevisions(waitingRevisions, changes.revisions)) return;
      const { revisions } = changes;
      const isOffered = inbox.offer(key, sessionId, 'todoBoard', {
        text: changes.text,
        onTaken: () => {
          offeredRevisions.delete(conversationKey);
          board.markSeenRevisions(key, revisions);
        },
        onWithdrawn: () => { offeredRevisions.delete(conversationKey); },
      });
      if (isOffered) offeredRevisions.set(conversationKey, revisions);
    },

    reconcile() {
      inbox.reconcile();
    },

    discardInbox(key) {
      inbox.withdraw(key, 'todoBoard');
    },
  };
}
