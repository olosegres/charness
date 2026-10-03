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
 * ordinary output.
 */
export interface RequestHeaderOptions {
  requestId: string;
  originDescription: string;
  isPlainTextHidden: boolean;
}

/** @description The header block, ending with a blank line before the request's own text. */
export function buildRequestHeader(options: RequestHeaderOptions): string {
  const lines = [
    `[Request ${options.requestId} · from: ${options.originDescription}]`,
    `Answer it with the answer_request tool (requestId "${options.requestId}"): kind "final" with the full result at the end of your turn, ` +
      '"question" if you need the requester before you can go on, "progress" for an interim note.',
  ];
  if (options.isPlainTextHidden) {
    lines.push('The requester does not see your plain text output — only what you send through answer_request reaches them.');
  }
  return `${lines.join('\n')}\n\n`;
}

/** What the reminder tells the agent, per wake-up reason. */
const wakeUpReasonLines: Readonly<Record<RequestWakeUpReason, string>> = {
  silentTurn: 'Your last turn ended without answering it.',
  progressFollowUp: 'Some time has passed since your last progress note on it.',
  backstop: 'Nothing has been seen working on it for a long time (the session may have restarted).',
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
 * @description R21: a request whose prompt was never taken in by the session — its
 * post failed, a restart came first, a usage-limit wait held it — gets the prompt
 * itself; a bare reminder would name a request the agent never read.
 */
export function getWakeUpMessage(request: OpenRequestState, reason: RequestWakeUpReason): WakeUpMessage {
  if (request.prompt !== undefined && request.isPromptTakenIn !== true) {
    return { reason, text: request.prompt, isRequestPrompt: true };
  }
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
