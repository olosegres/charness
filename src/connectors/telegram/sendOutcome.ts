import type { GroupOutputSendResult } from '../../utils/groupOutputBacklog';
import type { ThreadMessageEdit } from './commands/botCore';
import { getUnsentRemainder } from './outputFlushPlan';

/**
 * @description How a send to a topic ended: `sent` with the message id; `failed` — it did not land, and `isRetryable` says
 * whether trying again later may help (a 429, a 5xx, no answer from the network) or not (a closed topic, another 4xx), and `isForbidden`
 * (set only when true) that Telegram answered 403 — the bot may not write to that chat at all (see `checkIsForbiddenError`);
 * `unknown` — the Bot API did not answer within the send queue's deadline (`rateLimiter.ts` `SendOutcomeUnknownError`): the
 * message may or may not be in the topic, so it must NOT be sent again.
 */
export type ThreadSendOutcome = { kind: 'sent'; messageId: number } | { kind: 'failed'; isRetryable: boolean; isForbidden?: boolean } | { kind: 'unknown' };

/** @description How an edit of a topic message ended, with `unknown` as for a send: it may or may not be applied. */
export type ThreadEditOutcome = ThreadMessageEdit | 'unknown';

/**
 * @description What an edit whose outcome is unknown means to the bot's callers: made. A caller answers a FAILED edit by posting
 * the content anew (a status or thinking frame gets a new message, a screen is posted again, the output flush sends the text
 * fresh) — and if the edit did land, the topic would then show it twice. A missed edit is the smaller harm: the next edit of
 * the same message rewrites it whole.
 */
export function getCallerEditResult(outcome: ThreadEditOutcome): ThreadMessageEdit {
  return outcome === 'unknown' ? 'edited' : outcome;
}

/** @description The message the topic's output continues: what the next continuation edits, and the text it appends to. */
export interface OutputMessageCursor {
  lastMessageId: number | null;
  lastMessageText: string | null;
}

/** @description The two Bot API moves of one output flush, bound to a topic by the bot. */
export interface OutputChunkPorts {
  /** Edit the last message to `chunk` (a continuation that grows it in place). */
  editLastMessage: (messageId: number, chunk: string) => Promise<ThreadEditOutcome>;
  /** Send `chunk` as a message of its own. */
  sendChunk: (chunk: string) => Promise<ThreadSendOutcome>;
}

/**
 * @description Land the chunks of one output flush (`getOutputFlushPlan`), in order, updating `cursor`. When `isFirstChunkAnEdit`
 * the first chunk grows the last message in place; an edit that failed sends every chunk fresh instead (the message was deleted,
 * say), but an edit whose outcome is UNKNOWN counts as made — sent fresh, the text could appear twice. A chunk that FAILS stops
 * the run (the cooldown would drop the rest too) and the rest is the remainder, with whether trying it again may help (the
 * backlog puts it back, or drops it when Telegram refused it for good). A chunk whose outcome is UNKNOWN counts as sent
 * and is never sent again; the next text opens a message of its own, since the message it would continue is not known.
 */
export async function sendOutputChunks(
  chunks: string[],
  isFirstChunkAnEdit: boolean,
  cursor: OutputMessageCursor,
  ports: OutputChunkPorts,
): Promise<GroupOutputSendResult> {
  let startIndex = 0;
  if (isFirstChunkAnEdit && cursor.lastMessageId !== null) {
    const editOutcome = chunks[0] === cursor.lastMessageText ? 'edited' : await ports.editLastMessage(cursor.lastMessageId, chunks[0]);
    if (editOutcome === 'edited' || editOutcome === 'unknown') {
      cursor.lastMessageText = chunks[0];
      startIndex = 1;
    }
  }
  for (let index = startIndex; index < chunks.length; index++) {
    const outcome = await ports.sendChunk(chunks[index]);
    if (outcome.kind === 'failed') {
      const unsentRemainder = getUnsentRemainder(chunks, index);
      return unsentRemainder === null ? { unsentRemainder: null } : { unsentRemainder, isRetryable: outcome.isRetryable };
    }
    if (outcome.kind === 'sent') {
      cursor.lastMessageId = outcome.messageId;
      cursor.lastMessageText = chunks[index];
    } else {
      cursor.lastMessageId = null;
      cursor.lastMessageText = null;
    }
  }
  return { unsentRemainder: null };
}
