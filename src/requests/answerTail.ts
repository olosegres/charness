import type { OutboundHints } from '../platform/outbound';
import type { SessionTurnProbe } from './wakeUpRules';

/**
 * @description The answer tail: what the agent writes into its own stream AFTER
 * its final answer, as pure decisions (the wake-up engine holds the state and
 * acts). In a view that hides the stream the requester sees only the answers, so
 * work the agent goes on with after its final answer never reaches them, and the
 * request is closed: nothing else would ever remind the agent.
 *
 *   final answer                        → a fresh tail (any answer_request call ends the previous one)
 *   its own text after it               → counted in messages (a pause starts a new one)
 *   a message later than 30 s after it,
 *     or 2 messages in all              → the tail is worth a reminder
 *   that, and the turn ended            → remind the agent once, in the same session
 *   that, and 30 min with no new text   → remind it even if the turn still looks busy
 *
 * A short closing line right after the answer is no tail. The agent's reply to a
 * reminder is a final answer again, so its own tail is followed too (a result a
 * background job brings later still reaches the requester), up to
 * {@link answerTailMaxReminders} reminders per answered request: never a loop.
 */

/** After the answer, text later than this means the agent went on working. */
export const answerTailGraceMs = 30_000;
/** Messages after the answer that make a tail worth a reminder, however soon they came. */
export const answerTailMessageCount = 2;
/**
 * A pause in the agent's text longer than this starts a new message. The
 * adapters emit a message in chunks a fraction of a second apart (stream
 * batches, scrape polls), so one message never spans such a pause.
 */
export const answerTailMessageGapMs = 5_000;
/** With no new text for this long, a tail is reminded even if the session still reports a turn. */
export const answerTailSilenceMs = 30 * 60 * 1000;
/** Reminders one answered request may get; its later final answers start no tail. */
export const answerTailMaxReminders = 3;

/**
 * @name AnswerTail
 * @description The agent's own text after a final answer to `requestId`.
 * `lastOutputAt` is undefined until it writes anything.
 */
export interface AnswerTail {
  requestId: string;
  answeredAt: number;
  messageCount: number;
  lastOutputAt?: number;
  /** Some text came later than {@link answerTailGraceMs} after the answer. */
  hasLateOutput: boolean;
}

/**
 * @description Whether an `output` event is the agent's own text, the kind a
 * tail counts: not a sub-agent's chunk, a compaction summary, a native question
 * (shown in every view) or a whole block the bot made (the resume context, a
 * retry notice). The bot also leaves out spinner bursts and API-error lines.
 */
export function checkIsAgentProseOutput(output: string, hints: OutboundHints | undefined): boolean {
  if (!output.trim()) return false;
  return !hints?.isSubagent && !hints?.isCompactionSummary && !hints?.isQuestion && !hints?.isComplete;
}

/** @description The tail of a final answer just delivered. */
export function createAnswerTail(requestId: string, nowMs: number): AnswerTail {
  return { requestId, answeredAt: nowMs, messageCount: 0, hasLateOutput: false };
}

/** @description The tail after one more chunk of the agent's text. */
export function addAnswerTailOutput(tail: AnswerTail, nowMs: number): AnswerTail {
  const isNewMessage = tail.lastOutputAt === undefined || nowMs - tail.lastOutputAt > answerTailMessageGapMs;
  return {
    ...tail,
    messageCount: tail.messageCount + (isNewMessage ? 1 : 0),
    lastOutputAt: nowMs,
    hasLateOutput: tail.hasLateOutput || nowMs - tail.answeredAt > answerTailGraceMs,
  };
}

/** @description Whether the agent wrote enough after its answer to be reminded of it. */
export function checkIsAnswerTailWorthReminder(tail: AnswerTail): boolean {
  return tail.hasLateOutput || tail.messageCount >= answerTailMessageCount;
}

/**
 * @name AnswerTailDecision
 * @description `wait` — keep watching; `drop` — nothing can come of this tail
 * any more; `remind` — tell the agent now.
 */
export type AnswerTailDecision = 'wait' | 'drop' | 'remind';

/**
 * @description What to do with a tail, given the session now. Nothing while a
 * question, compaction, limit wait or session start holds the turn. A tail not
 * worth a reminder is dropped once the session stopped: no more text can come
 * without a new message, and a new message is a new request. One worth it is
 * reminded once the turn ended (an idle session, or one that stopped), or after
 * {@link answerTailSilenceMs} of quiet even if the session still reports a turn.
 */
export function decideAnswerTail(tail: AnswerTail, probe: SessionTurnProbe, nowMs: number): AnswerTailDecision {
  if (probe.isTurnEndBlocked) return 'wait';
  if (!checkIsAnswerTailWorthReminder(tail)) return probe.isActive ? 'wait' : 'drop';
  if (!probe.isBusy) return 'remind';
  return tail.lastOutputAt !== undefined && nowMs - tail.lastOutputAt >= answerTailSilenceMs ? 'remind' : 'wait';
}

/**
 * @description The reminder forwarded into the agent's session. Agent-facing,
 * English on every surface. It names the answered request: `answer_request`
 * still delivers an answer to a closed request.
 */
export function buildAnswerTailReminder(requestId: string): string {
  return [
    `[Reminder · after your final answer to request ${requestId}]`,
    'You kept working after that answer and wrote more in your own output. The requester does not see it: only answer_request reaches them.',
    `If any of it matters to them (a result, a change, a problem), send it with answer_request (requestId "${requestId}", kind "final"). ` +
      'If nothing new came of it, send nothing.',
  ].join('\n');
}
