import type { OpenRequestState, RequestWakeUpReason } from './types';

/**
 * @description The per-request header that rides inside the prompt text of every
 * request (request/answer core S3). The standing rule lives in the bot MCP's
 * connect-time instructions; the header is still needed per request because it
 * names THIS request's id, and because whether the requester sees the agent's
 * plain text can change mid-session (a Telegram view switch) or never holds
 * (a tracker). Agent-facing, so English on every surface.
 */

/**
 * @name RequestHeaderOptions
 * @description `originDescription` says where the request came from in a few
 * words ("a message in this topic", "PROJ-123 assigned to you by …").
 * `isPlainTextHidden` adds the line that the requester never sees the agent's
 * ordinary output or its thinking. `supersededRequestIds` are the same requester's earlier
 * requests this one replaced while they were still open (`requestGroup.ts`);
 * when given, the header names them and asks for only what THIS request adds.
 * The line holds in both timings (owner decision 2026-10-05): the agent reads it
 * mid-turn and gives one answer, or — Claude Code delivers a message written
 * mid-turn only after that turn ends — it has already answered the replaced
 * request and must not do the work twice.
 */
export interface RequestHeaderOptions {
  requestId: string;
  originDescription: string;
  isPlainTextHidden: boolean;
  supersededRequestIds?: readonly string[];
}

/** @description The header's line naming the requests this one replaced; empty when it replaced none. */
export function buildSupersededRequestsLine(supersededRequestIds: readonly string[]): string {
  if (supersededRequestIds.length === 0) return '';
  const isOne = supersededRequestIds.length === 1;
  return `It replaces the same requester's earlier ${isOne ? 'request' : 'requests'} ${supersededRequestIds.join(', ')}. ` +
    `If you already answered ${isOne ? 'it' : 'them'}, do not repeat that answer: reply only to what this message adds. ` +
    'If it adds nothing new, say briefly that the answer is above.';
}

/** @description The header block, ending with a blank line before the request's own text. */
export function buildRequestHeader(options: RequestHeaderOptions): string {
  const lines = [
    `[Request ${options.requestId} · from: ${options.originDescription}]`,
    `Answer it with the answer_request tool (requestId "${options.requestId}"): kind "final" with the full result at the end of your turn, ` +
      '"question" if you need the requester before you can go on, "progress" for an interim note.',
  ];
  const supersededLine = buildSupersededRequestsLine(options.supersededRequestIds ?? []);
  if (supersededLine !== '') lines.push(supersededLine);
  if (options.isPlainTextHidden) {
    lines.push('The requester does not see your plain text output or your thinking — only what you send through answer_request reaches them.');
  }
  return `${lines.join('\n')}\n\n`;
}

/** What the reminder tells the agent, per wake-up reason. */
const wakeUpReasonLines: Readonly<Record<RequestWakeUpReason, string>> = {
  silentTurn: 'Your last turn ended without answering it.',
  progressFollowUp: 'Some time has passed since your last progress note on it.',
  backstop: 'Nothing has been seen working on it for a long time (the session may have restarted).',
  postRetry: 'It could not be delivered to you earlier.',
};

/**
 * @name WakeUpMessage
 * @description What a wake-up forwards: the request's own prompt when it never
 * reached the agent (R21), else the reminder for `reason`.
 */
export interface WakeUpMessage {
  reason: RequestWakeUpReason;
  text: string;
  isRequestPrompt: boolean;
}

/**
 * @description The request's own prompt while the session never took it in — its
 * post failed, a restart came first, a usage-limit wait held it (R21); `undefined`
 * once it was taken in, or when the request keeps no prompt.
 */
export function getPromptNotTakenIn(request: OpenRequestState | null | undefined): string | undefined {
  return request?.isPromptTakenIn === true ? undefined : request?.prompt;
}

/** Between two requests' prompts re-posted in one message (each prompt ends with its own text, not a blank line). */
const joinedPromptsSeparator = '\n\n';

/**
 * @description The prompts of every request in `requests` the session never took
 * in, in the given order, as ONE text to post — a conversation may hold one open
 * request per requester, and a resume must re-post each of them. `undefined` when
 * none is left to post.
 */
export function joinPromptsNotTakenIn(requests: readonly OpenRequestState[]): string | undefined {
  const prompts = requests.map(getPromptNotTakenIn).filter((prompt): prompt is string => prompt !== undefined);
  return prompts.length === 0 ? undefined : prompts.join(joinedPromptsSeparator);
}

/**
 * @description R21: a request whose prompt was never taken in by the session gets
 * the prompt itself; a bare reminder would name a request the agent never read.
 */
export function getWakeUpMessage(request: OpenRequestState, reason: RequestWakeUpReason): WakeUpMessage {
  const prompt = getPromptNotTakenIn(request);
  if (prompt !== undefined) return { reason, text: prompt, isRequestPrompt: true };
  return { reason, text: buildWakeUpReminder({ requestId: request.id, reason }), isRequestPrompt: false };
}

/**
 * @description The reminder the wake-up engine forwards into the SAME session for
 * an open request. It is not a request itself: it names the open one and asks
 * for the answer through `answer_request`.
 */
export function buildWakeUpReminder(options: { requestId: string; reason: RequestWakeUpReason }): string {
  return [
    `[Reminder · request ${options.requestId} is still open]`,
    wakeUpReasonLines[options.reason],
    `Answer it with answer_request (requestId "${options.requestId}"): kind "final" if the work is done, ` +
      '"question" if you need the requester, or a short "progress" note if you are still working — then continue.',
  ].join('\n');
}
